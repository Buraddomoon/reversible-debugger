import { programVM, knownVM } from './vm-version';
import { LEGACY_MAX_STEPS, MAX_EXECUTION_STEPS, extendedLimits, validateExecutionLimits } from './execution-limits';
import { compile } from './compiler';
import { DebugSession, recordingYield, type RecordingJob } from './debugger';
import { MAX_SOURCE_CHARS } from './language';
import { initialState, type DeepReadonly, type Step } from './machine';
import { decode, digest, encode, metadata, MAX_TRACE_BYTES, type TraceMetadata } from './portable-history';
import { getRuntime } from './runtime';
import { fields, integer, requireTrace, same, text } from './trace-validation';

export const BLOCK_VERSION = 1;
export const BLOCK_STEPS = 256;
export const BLOCK_BYTES = 512 * 1024;
export const utf8Bytes = (content: string) => new TextEncoder().encode(content).byteLength;
export interface BlockDescriptor { index: number; first: number; count: number; bytes: number; checksum: string }
export interface ExecutionHeader {
  format: 'rewind-blocks'; version: number; vm: string; id: string; createdAt: number;
  metadata: TraceMetadata; source: string; runtime: { language: string; version: string };
  programHash: string; limits: { maxSteps: number; maxFrames: number }; initial: unknown; cursor: number; count: number;
}
export interface ExecutionBlock extends BlockDescriptor { runId: string; content: string }
export interface ExecutionManifest { header: ExecutionHeader; blocks: BlockDescriptor[] }
export interface RecordingSnapshot { header: ExecutionHeader; records: readonly DeepReadonly<Step>[] }

/** Capture before the first await: edits, restart and navigation cannot change this save. */
export async function captureRecording(session: DebugSession, details: TraceMetadata, id: string, createdAt: number): Promise<RecordingSnapshot> {
  metadata(details); validateExecutionLimits(session);
  const records = [...session.history], cursor = session.cursor, program = session.program, limits = { maxSteps: session.maxSteps, maxFrames: session.maxFrames };
  const header: ExecutionHeader = { format: 'rewind-blocks', version: extendedLimits(limits) ? 2 : BLOCK_VERSION, vm: programVM(program), id, createdAt, metadata: { ...details }, source: program.source, runtime: session.runtime, programHash: await digest(JSON.stringify(encode(program))), limits, initial: encode(initialState()), cursor, count: records.length };
  return { header, records };
}
/** A transaction is indivisible. A single large delta occupies its own block. */
export async function* encodeBlocks(snapshot: RecordingSnapshot, job: RecordingJob = {}): AsyncGenerator<ExecutionBlock> {
  let parts: string[] = [], bytes = 2, first = 0, index = 0, started = performance.now();
  const pack = async (): Promise<ExecutionBlock> => {
    const content = `[${parts.join(',')}]`;
    return { runId: snapshot.header.id, index: index++, first, count: parts.length, bytes: utf8Bytes(content), checksum: await digest(content), content };
  };
  for (let i = 0; i < snapshot.records.length; i++) {
    job.signal?.throwIfAborted();
    const part = JSON.stringify(encode(snapshot.records[i])), size = utf8Bytes(part);
    requireTrace(size + 2 <= MAX_TRACE_BYTES, 'uma transação excede 32 MiB');
    if (parts.length && (parts.length === BLOCK_STEPS || bytes + size + 1 > BLOCK_BYTES)) {
      yield await pack(); first = i; parts = []; bytes = 2;
      await recordingYield(job); started = performance.now();
    }
    bytes += size + (parts.length ? 1 : 0); parts.push(part);
    if (performance.now() - started >= 6) { await recordingYield(job); started = performance.now(); }
  }
  if (parts.length) yield await pack();
  job.signal?.throwIfAborted();
}
function checksum(value: unknown): asserts value is string { text(value, 64); requireTrace(/^[a-f0-9]{64}$/.test(value), 'checksum de bloco inválido'); }
export async function validateManifest(content: string, hash: string, id: string): Promise<ExecutionManifest> {
  text(content, MAX_TRACE_BYTES); requireTrace(utf8Bytes(content) <= MAX_TRACE_BYTES, 'manifesto excede 32 MiB'); checksum(hash);
  requireTrace(await digest(content) === hash, 'checksum do manifesto não confere');
  const envelope = fields(JSON.parse(content), ['header', 'blocks']);
  const h = fields(envelope.header, ['format', 'version', 'vm', 'id', 'createdAt', 'metadata', 'source', 'runtime', 'programHash', 'limits', 'initial', 'cursor', 'count']);
  requireTrace(h.format === 'rewind-blocks' && (h.version === BLOCK_VERSION || h.version === 2) && knownVM(h.vm), 'versão de blocos/VM incompatível; os dados foram preservados');
  requireTrace(h.id === id, 'identidade da execução não confere'); text(h.id, 100); integer(h.createdAt, 0, Number.MAX_SAFE_INTEGER);
  const details = metadata(h.metadata); text(h.source, MAX_SOURCE_CHARS);
  const rt = fields(h.runtime, ['language', 'version']); text(rt.language, 20); text(rt.version, 20); const runtime = getRuntime(rt.language, rt.version);
  const limits = fields(h.limits, ['maxSteps', 'maxFrames']); integer(limits.maxSteps, 1, h.version === 2 ? MAX_EXECUTION_STEPS : LEGACY_MAX_STEPS); integer(limits.maxFrames, 2, 256);
  integer(h.count, 0, limits.maxSteps); integer(h.cursor, 0, h.count);
  requireTrace(same(decode(h.initial), initialState()), 'estado inicial incompatível'); checksum(h.programHash);
  requireTrace(await digest(JSON.stringify(encode(compile(h.source, runtime, h.vm)))) === h.programHash, 'identidade do programa compilado não confere');
  requireTrace(Array.isArray(envelope.blocks) && envelope.blocks.length <= h.count, 'índice de blocos inválido');
  let next = 0, bytes = utf8Bytes(content);
  const blocks = envelope.blocks.map((raw, index) => {
    const b = fields(raw, ['index', 'first', 'count', 'bytes', 'checksum']); integer(b.index, index, index); integer(b.first, next, next); integer(b.count, 1, BLOCK_STEPS); integer(b.bytes, 2, MAX_TRACE_BYTES); checksum(b.checksum);
    requireTrace(b.bytes <= BLOCK_BYTES || b.count === 1, 'bloco grande deve conter uma única transação');
    next += b.count; bytes += b.bytes;
    return b as unknown as BlockDescriptor;
  });
  requireTrace(next === h.count && bytes <= MAX_TRACE_BYTES, 'blocos incompletos ou execução excede 32 MiB');
  return { header: { ...(h as unknown as ExecutionHeader), metadata: details, runtime }, blocks };
}
export async function decodeBlock(input: unknown, expected: BlockDescriptor, runId: string): Promise<unknown[]> {
  const block = fields(input, ['runId', 'index', 'first', 'count', 'bytes', 'checksum', 'content']);
  requireTrace(block.runId === runId && Object.entries(expected).every(([key, value]) => block[key] === value), 'bloco pertence a outra execução ou posição');
  text(block.content, MAX_TRACE_BYTES); requireTrace(utf8Bytes(block.content) === expected.bytes, 'tamanho do bloco não confere');
  requireTrace(await digest(block.content) === expected.checksum, 'checksum do bloco não confere');
  const records: unknown = JSON.parse(block.content); requireTrace(Array.isArray(records) && records.length === expected.count, 'quantidade de transações do bloco não confere');
  return records.map(record => decode(record, 2));
}
