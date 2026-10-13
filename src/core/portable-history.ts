import { DebugSession, recordingYield, type RecordingJob } from './debugger';
import { initialState } from './machine';
import { compile } from './compiler';
import { getRuntime } from './runtime';
import { MAX_SOURCE_CHARS } from './language';
import { fields, integer, object, requireTrace, same, text } from './trace-validation';

export const TRACE_FORMAT = 'rewind-trace';
export const TRACE_VERSION = 1;
export const TRACE_VM = 'rewind-vm/1';
export const MAX_TRACE_BYTES = 32 * 1024 * 1024;
export const MAX_IMPORTED_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORTED_TRACES = 8;
export interface TraceMetadata { name: string; filename: string }
export interface ImportedHistory extends TraceMetadata { session: DebugSession; bytes: number; checksum: string }
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Reserved tags occur only in VM value positions; dictionary names cannot contain $. */
function encode(input: unknown): Json {
  if (typeof input === 'bigint') return { $bigint: input.toString() };
  if (typeof input === 'number') {
    if (Object.is(input, -0)) return { $number: '-0' };
    if (!Number.isFinite(input)) return { $number: Number.isNaN(input) ? 'NaN' : input < 0 ? '-Infinity' : 'Infinity' };
    return input;
  }
  if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
  if (Array.isArray(input)) return input.map(encode);
  requireTrace(typeof input === 'object' && input !== null, 'tipo não serializável');
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, encode(value)]));
}
function decode(input: unknown, depth = 0): unknown {
  requireTrace(depth <= 32, 'estrutura muito profunda');
  if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
  if (typeof input === 'number') { requireTrace(Number.isFinite(input) && !Object.is(input, -0), 'número especial sem tag'); return input; }
  if (Array.isArray(input)) return input.map(value => decode(value, depth + 1));
  const item = object(input);
  if (Object.hasOwn(item, '$bigint')) {
    fields(item, ['$bigint']); text(item.$bigint, 30_105);
    requireTrace(/^(?:0|-?[1-9]\d*)$/.test(item.$bigint), 'inteiro codificado incorretamente');
    const value = BigInt(item.$bigint);
    requireTrace((value < 0n ? -value : value).toString(2).length <= 100_000, 'inteiro excede 100.000 bits'); return value;
  }
  if (Object.hasOwn(item, '$number')) {
    fields(item, ['$number']);
    switch (item.$number) { case '-0': return -0; case 'NaN': return NaN; case 'Infinity': return Infinity; case '-Infinity': return -Infinity; default: throw new Error('Histórico inválido: tag numérica desconhecida'); }
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(item)) result[key] = decode(value, depth + 1);
  return result;
}
async function digest(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}
function byteLength(content: string): number {
  requireTrace(content.length <= MAX_TRACE_BYTES, 'arquivo excede 32 MiB');
  const bytes = new TextEncoder().encode(content).byteLength;
  requireTrace(bytes <= MAX_TRACE_BYTES, 'arquivo excede 32 MiB'); return bytes;
}
function metadata(input: unknown): TraceMetadata {
  const data = fields(input, ['name', 'filename']); text(data.name, 160); text(data.filename, 240);
  requireTrace(data.name.trim().length > 0 && data.filename.trim().length > 0, 'nome/arquivo vazios');
  return { name: data.name, filename: data.filename };
}
/** Captures the current cursor and all recorded steps, including its recorded future.
 * Full states/checkpoints are omitted; the importer rebuilds sparse checkpoints. */
export async function exportHistory(session: DebugSession, details: TraceMetadata, job: RecordingJob = {}): Promise<string> {
  metadata(details); integer(session.maxSteps, 1, 20_000); integer(session.maxFrames, 2, 256);
  const records = [...session.history], cursor = session.cursor;
  const steps: string[] = [];
  let stepBytes = 0;
  let batchStart = performance.now();
  for (let i = 0; i < records.length; i++) {
    const step = JSON.stringify(encode(records[i])); stepBytes += step.length + 1;
    requireTrace(stepBytes <= MAX_TRACE_BYTES, 'histórico excede 32 MiB; nenhum registro foi descartado');
    steps.push(step);
    if ((i + 1) % 256 === 0 || performance.now() - batchStart >= 8) { job.onProgress?.(i + 1, records.length); await recordingYield(job); batchStart = performance.now(); }
  }
  job.signal?.throwIfAborted();
  const header = { vm: TRACE_VM, metadata: details, source: session.program.source, runtime: session.runtime, programHash: await digest(JSON.stringify(encode(session.program))), limits: { maxSteps: session.maxSteps, maxFrames: session.maxFrames }, initial: encode(initialState()), cursor };
  await recordingYield(job);
  // Each record was already encoded in a bounded batch. Join its JSON without
  // traversing/encoding the whole trace a second time in a single task.
  const content = `${JSON.stringify(header).slice(0, -1)},"steps":[${steps.join(',')}]}`, checksum = await digest(content);
  const result = `{"format":"${TRACE_FORMAT}","version":${TRACE_VERSION},"checksum":"${checksum}","payload":${content}}`;
  byteLength(result); job.signal?.throwIfAborted(); job.onProgress?.(records.length, records.length);
  return result;
}
export async function importHistory(content: string, job: RecordingJob = {}): Promise<ImportedHistory> {
  job.signal?.throwIfAborted(); const bytes = byteLength(content);
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('Histórico inválido: arquivo JSON corrompido'); }
  const envelope = fields(parsed, ['format', 'version', 'checksum', 'payload']);
  requireTrace(envelope.format === TRACE_FORMAT, 'formato desconhecido');
  requireTrace(envelope.version === TRACE_VERSION, 'versão de arquivo incompatível');
  text(envelope.checksum, 64); requireTrace(/^[a-f0-9]{64}$/.test(envelope.checksum), 'checksum inválido');
  const expectedFields = ['vm', 'metadata', 'source', 'runtime', 'programHash', 'limits', 'initial', 'cursor', 'steps'];
  const encoded = fields(envelope.payload, expectedFields);
  // Bound nesting and decode records in batches before stringify/digest can
  // traverse untrusted nesting. Header decoding never walks the entire trace.
  const payload = fields(decode({ ...encoded, steps: [] }), expectedFields);
  requireTrace(payload.vm === TRACE_VM, 'versão de compilador/VM incompatível');
  const details = metadata(payload.metadata); text(payload.source, MAX_SOURCE_CHARS);
  const runtimeFields = fields(payload.runtime, ['language', 'version']); text(runtimeFields.language, 20); text(runtimeFields.version, 20);
  const runtime = getRuntime(runtimeFields.language, runtimeFields.version);
  const limits = fields(payload.limits, ['maxSteps', 'maxFrames']); integer(limits.maxSteps, 1, 20_000); integer(limits.maxFrames, 2, 256);
  requireTrace(Array.isArray(encoded.steps) && encoded.steps.length <= limits.maxSteps, 'passos excedem o limite');
  integer(payload.cursor, 0, encoded.steps.length);
  requireTrace(same(payload.initial, initialState()), 'estado inicial incompatível');
  const records: unknown[] = [], total = encoded.steps.length;
  let batchStart = performance.now();
  for (let i = 0; i < total; i++) {
    records.push(decode(encoded.steps[i], 2));
    if ((i + 1) % 256 === 0 || performance.now() - batchStart >= 8) { job.onProgress?.(i + 1, total * 2); await recordingYield(job); batchStart = performance.now(); }
  }
  requireTrace(envelope.checksum === await digest(JSON.stringify(envelope.payload)), 'checksum não confere; arquivo alterado ou corrompido');
  await recordingYield(job);
  text(payload.programHash, 64);
  const program = compile(payload.source, runtime);
  requireTrace(payload.programHash === await digest(JSON.stringify(encode(program))), 'identidade do programa compilado não confere');
  await recordingYield(job);
  const session = await DebugSession.restoreRecording(payload.source, { ...runtime, maxSteps: limits.maxSteps, maxFrames: limits.maxFrames }, records, payload.cursor, { ...job, onProgress: done => job.onProgress?.(total + done, total * 2) });
  return { ...details, session, bytes, checksum: envelope.checksum };
}
export function checkImportBudget(existing: readonly { bytes: number }[], incomingBytes: number): void {
  integer(incomingBytes, 0, MAX_TRACE_BYTES);
  requireTrace(existing.length < MAX_IMPORTED_TRACES, 'até 8 históricos abertos; remova um antes de importar outro');
  requireTrace(existing.reduce((total, item) => total + item.bytes, incomingBytes) <= MAX_IMPORTED_BYTES, 'históricos abertos excedem 64 MiB; remova um antes de importar outro');
}
