import { ExecutionLibrary } from '../core/execution-library';
import { CheckpointCache } from '../core/checkpoint-cache';
import { PagedHistoryStore, type PagedPreparedState, type PagedSeekJob } from '../core/paged-history';
import { PagedExecutionControl } from '../core/paged-execution-control';
import type { PagedRequest, PagedResponse, PagedSnapshot } from '../core/paged-transfer';
import { explainStep, type StepExplanation } from '../core/explanations';
import type { DeepReadonly, Step } from '../core/machine';

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<PagedRequest>) => void) | null; postMessage: (message: PagedResponse) => void };
const library = new ExecutionLibrary(), checkpoints = new CheckpointCache();
interface Task { message: PagedRequest; abort: AbortController; committed: boolean }
let store: PagedHistoryStore | null = null, control: PagedExecutionControl | null = null;
let active: Task | null = null, waiting: PagedRequest | null = null, acknowledge: (() => void) | null = null;
function snapshot(step: DeepReadonly<Step> | null = null, reverse = false, prepared?: PagedPreparedState): PagedSnapshot {
  const current = store!, state = prepared?.state ?? current.state, cursor = prepared?.cursor ?? current.cursor, lastStep = prepared ? prepared.lastStep : current.lastStep;
  let evidence: StepExplanation | null = null;
  if (step) {
    evidence = explainStep(current.program, [step], 0, reverse ? 'backward' : 'forward');
    if (evidence.kind === 'read') {
      const instruction = current.program.instructions[step.index]!;
      if (instruction.op === 'LOAD') {
        const caller = state.frames.at(-1)!;
        const origin = instruction.scope !== 'global' && Object.hasOwn(caller.locals, instruction.name) ? caller : Object.hasOwn(state.frames[0]!.locals, instruction.name) ? state.frames[0]! : null;
        evidence = { ...evidence, frameId: origin?.id ?? null, scope: origin?.name ?? 'builtins do Python' };
      }
    }
  }
  return { cursor, count: current.count, state, step: lastStep ? { span: lastStep.span, op: lastStep.op, description: lastStep.description } : null, evidence, reverse, changedNames: step?.changes.flatMap(c => c.kind === 'binding' ? [c.name] : []) ?? [], stats: current.stats, debug: control?.snapshot };
}
async function confirm(task: Task, prepared?: PagedPreparedState): Promise<void> {
  task.abort.signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { acknowledge = null; task.abort.signal.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); reject(task.abort.signal.reason); };
    acknowledge = () => { task.committed = true; cleanup(); resolve(); };
    task.abort.signal.addEventListener('abort', cancel, { once: true });
    scope.postMessage({ id: task.message.id, kind: 'prepared', snapshot: snapshot(null, false, prepared) });
  });
}
function start(message: PagedRequest): void {
  const task: Task = { message, abort: new AbortController(), committed: false }; active = task;
  const job: PagedSeekJob = { signal: task.abort.signal, onProgress: (done, total) => scope.postMessage({ id: message.id, kind: 'index-progress', done, total }), onSeekProgress: progress => scope.postMessage({ id: message.id, kind: 'seek-progress', progress }), beforePublish: prepared => confirm(task, prepared) };
  void (async () => {
    try {
      let step: DeepReadonly<Step> | null = null, reverse = false;
      if (message.kind === 'open') {
        const opened = await PagedHistoryStore.open(library, checkpoints, message.recordingId, message.options, { ...job, beforePublish: undefined }); task.abort.signal.throwIfAborted();
        store?.dispose(); store = opened; control = new PagedExecutionControl(store); await confirm(task);
        scope.postMessage({ id: message.id, kind: 'state', header: { entry: opened.recording.entry, program: opened.program, events: opened.index.events }, snapshot: snapshot() });
      } else {
        if (!store) throw new Error('Abra uma execução salva antes de navegar');
        if (message.kind === 'seek') {
          const from = store.cursor, before = store.lastStep;
          await store.seek(message.target, job); control!.cancel();
          if (message.target === from - 1) { step = before; reverse = true; } else if (message.target === from + 1) step = store.lastStep;
        } else {
          if (message.kind === 'control' && message.mode !== undefined) control!.validateMode(message.mode);
          if (message.kind === 'breakpoints') control!.validateConfiguration(message.lines, message.enabled);
          await confirm(task);
          if (message.kind === 'cache') store.setCacheBudget(message.bytes);
          if (message.kind === 'pause') control!.pause();
          if (message.kind === 'breakpoints') control!.configure(message.lines, message.enabled);
          if (message.kind === 'control') { if (message.mode) control!.start(message.mode); const result = await control!.runBatch(); step = result.lastStep; reverse = result.direction === 'backward'; }
        }
        scope.postMessage({ id: message.id, kind: 'state', snapshot: snapshot(step, reverse) });
      }
    } catch (cause) {
      // After ACK the valid prefix belongs to the UI, including a read failure.
      // Never roll the worker back behind a state the client already accepted.
      if (task.committed && store) { control?.fail(cause); scope.postMessage({ id: message.id, kind: 'state', snapshot: snapshot() }); }
      else scope.postMessage({ id: message.id, kind: 'error', aborted: task.abort.signal.aborted, message: cause instanceof Error ? cause.message : String(cause) });
    } finally { if (active === task) active = null; const next = waiting; waiting = null; if (next) start(next); }
  })();
}
scope.onmessage = event => {
  const message = event.data;
  if (message.kind === 'ack') { if (active?.message.id === message.id) acknowledge?.(); return; }
  if (message.kind === 'cancel') {
    if (active?.message.id === message.id && !active.committed) { active.abort.abort(); store?.cancel(); }
    if (waiting?.id === message.id) { scope.postMessage({ id: message.id, kind: 'error', aborted: true, message: 'Pedido cancelado' }); waiting = null; } return;
  }
  if (active) {
    if (waiting) scope.postMessage({ id: waiting.id, kind: 'error', aborted: true, message: 'Pedido substituído' }); waiting = message;
    if (!active.committed) { active.abort.abort(); store?.cancel(); }
  } else start(message);
};
