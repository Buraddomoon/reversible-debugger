import { RecordingJournal } from '../core/recording-journal';
import { LiveRecording } from '../core/live-recording';
import { ExecutionLibrary } from '../core/execution-library';
import { CheckpointCache } from '../core/checkpoint-cache';
import { PagedHistoryStore } from '../core/paged-history';
import { PagedExecutionComparison, type ComparisonReader, type ComparisonRecording, type PagedComparisonSnapshot } from '../core/paged-comparison';
import type { ComparisonRequest, ComparisonResponse, ComparisonRunHeader } from '../core/comparison-transfer';
import type { ComparisonRunView } from '../core/comparison-types';
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<ComparisonRequest>) => void) | null; postMessage: (message: ComparisonResponse) => void };
const journal = new RecordingJournal(), library = new ExecutionLibrary(), checkpoints = new CheckpointCache();
let comparison: PagedExecutionComparison | null = null, active: Task | null = null, waiting: ComparisonRequest | null = null, ack: (() => void) | null = null;
interface Task { message: ComparisonRequest; abort: AbortController; accepted: boolean }
async function reader(ref: ComparisonRecording, budget: number, signal: AbortSignal): Promise<ComparisonReader> {
  if (ref.kind === 'journal') {
    const live = await LiveRecording.resume(journal, ref.id, { readOnly: true, maxHistoryBytes: budget, cacheBytes: Math.min(512 * 1024, Math.floor(budget / 4)) }, { signal });
    return { name: ref.name, program: live.program, count: live.count, maxSteps: live.source.maxSteps, maxFrames: live.source.maxFrames, get state() { return live.state; }, get cursor() { return live.cursor; }, get stats() { return live.stats; }, seek: (target, job) => live.seek(target, job), readRange: (first, count, job) => live.readRange(first, count, job), cancel: () => live.cancel() };
  }
  const store = await PagedHistoryStore.open(library, checkpoints, ref.id, { maxHistoryBytes: budget, cacheBytes: Math.min(512 * 1024, Math.floor(budget / 4)) }, { signal });
  return { name: ref.name, program: store.program, count: store.count, maxSteps: store.recording.manifest.header.limits.maxSteps, maxFrames: store.recording.manifest.header.limits.maxFrames, get state() { return store.state; }, get cursor() { return store.cursor; }, get stats() { return store.stats; }, seek: (target, job) => store.seek(target, job), readRange: (first, count, job) => store.readRange(first, count, job), cancel: () => store.cancel() };
}
function pack(run: ComparisonRunView): ComparisonRunHeader { return { name: run.name, identity: run.identity, program: run.program, history: run.history, points: run.points, limitReached: run.limitReached, finalResult: run.finalResult }; }
async function confirm(task: Task, snapshot: PagedComparisonSnapshot): Promise<void> {
  task.abort.signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const clean = () => { ack = null; task.abort.signal.removeEventListener('abort', cancel); }, cancel = () => { clean(); reject(task.abort.signal.reason); };
    ack = () => { task.accepted = true; clean(); resolve(); }; task.abort.signal.addEventListener('abort', cancel, { once: true }); scope.postMessage({ id: task.message.id, kind: 'prepared', snapshot });
  });
}
function start(message: ComparisonRequest): void {
  const task: Task = { message, abort: new AbortController(), accepted: false }; active = task;
  const job = { signal: task.abort.signal, onStage: (stage: string, done: number, total: number) => scope.postMessage({ id: message.id, kind: 'progress', stage, done, total }) };
  void (async () => {
    try {
      if (message.kind === 'open') {
        const left = await reader(message.left, message.budget, job.signal), right = await reader(message.right, message.budget, job.signal);
        const prepared = await PagedExecutionComparison.prepare(left, right, message.budget, job); await confirm(task, prepared.snapshot); comparison = prepared;
        scope.postMessage({ id: message.id, kind: 'state', snapshot: comparison.snapshot, header: { left: pack(comparison.left), right: pack(comparison.right), rows: comparison.rows, firstDifference: comparison.firstDifference } });
      } else if (message.kind === 'seek') {
        if (!comparison) throw new Error('Prepare a comparação antes de navegar');
        await comparison.seekRow(message.target, { ...job, beforePublish: snapshot => confirm(task, snapshot) }); scope.postMessage({ id: message.id, kind: 'state', snapshot: comparison.snapshot });
      }
    } catch (cause) { scope.postMessage({ id: message.id, kind: 'error', message: cause instanceof Error ? cause.message : String(cause), aborted: task.abort.signal.aborted || cause instanceof Error && cause.name === 'AbortError' }); }
    finally { if (active === task) active = null; const next = waiting; waiting = null; if (next) start(next); }
  })();
}
scope.onmessage = event => {
  const message = event.data;
  if (message.kind === 'ack') { if (active?.message.id === message.id) ack?.(); return; }
  if (message.kind === 'cancel') { if (active?.message.id === message.id && !active.accepted) { active.abort.abort(); comparison?.cancel(); } if (waiting?.id === message.id) { scope.postMessage({ id: message.id, kind: 'error', message: 'Pedido cancelado', aborted: true }); waiting = null; } return; }
  if (active) { if (waiting) scope.postMessage({ id: waiting.id, kind: 'error', message: 'Pedido substituído', aborted: true }); waiting = message; if (!active.accepted) { active.abort.abort(); comparison?.cancel(); } } else start(message);
};
