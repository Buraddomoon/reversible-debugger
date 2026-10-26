import { PagedExecutionControl } from '../core/paged-execution-control';
import { RecordingJournal } from '../core/recording-journal';
import { LiveRecording } from '../core/live-recording';
import { explainStep, type StepExplanation } from '../core/explanations';
import type { DeepReadonly, Step } from '../core/machine';
import type { LiveRequest, LiveResponse, PagedSnapshot } from '../core/paged-transfer';
import type { PagedSeekJob } from '../core/paged-history';
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<LiveRequest>) => void) | null; postMessage: (message: LiveResponse) => void };
const journal = new RecordingJournal(); let store: LiveRecording | null = null, control: PagedExecutionControl | null = null;
interface Task { message: LiveRequest; abort: AbortController; committed: boolean }
let active: Task | null = null, waiting: LiveRequest | null = null, acknowledge: (() => void) | null = null, heartbeat: ReturnType<typeof setInterval> | null = null, renewing = false;
function snapshot(step: DeepReadonly<Step> | null = null, reverse = false): PagedSnapshot {
  const live = store!, state = live.state, cursor = live.cursor, last = live.lastStep; let evidence: StepExplanation | null = null;
  if (step) { evidence = explainStep(live.program, [step], 0, reverse ? 'backward' : 'forward'); if (evidence.kind === 'read') { const instruction = live.program.instructions[step.index]!; if (instruction.op === 'LOAD') { const caller = state.frames.at(-1)!, origin = instruction.scope !== 'global' && Object.hasOwn(caller.locals, instruction.name) ? caller : Object.hasOwn(state.frames[0]!.locals, instruction.name) ? state.frames[0]! : null; evidence = { ...evidence, frameId: origin?.id ?? null, scope: origin?.name ?? 'builtins do Python' }; } } }
  return { cursor, count: live.count, state, step: last ? { span: last.span, op: last.op, description: last.description } : null, evidence, reverse, changedNames: step?.changes.flatMap(c => c.kind === 'binding' ? [c.name] : []) ?? [], stats: live.stats, recording: live.ledger, debug: control?.snapshot };
}
async function confirm(task: Task): Promise<void> {
  task.abort.signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => { const cleanup = () => { acknowledge = null; task.abort.signal.removeEventListener('abort', cancel); }, cancel = () => { cleanup(); reject(task.abort.signal.reason); }; acknowledge = () => { task.committed = true; cleanup(); resolve(); }; task.abort.signal.addEventListener('abort', cancel, { once: true }); scope.postMessage({ id: task.message.id, kind: 'prepared' }); });
}
function start(message: LiveRequest): void {
  const task: Task = { message, abort: new AbortController(), committed: false }; active = task;
  const job: PagedSeekJob = { signal: task.abort.signal, onProgress: (done, total) => scope.postMessage({ id: message.id, kind: 'index-progress', done, total }), onSeekProgress: progress => scope.postMessage({ id: message.id, kind: 'seek-progress', progress }), beforePublish: () => confirm(task) };
  void (async () => {
    let step: DeepReadonly<Step> | null = null, reverse = false; const priorEvents = store?.events.length ?? 0;
    try {
      if (message.kind === 'start' || message.kind === 'resume') {
        store = message.kind === 'start' ? await LiveRecording.start(journal, message.source, message.runtime, message.metadata, message.options, { ...job, beforePublish: undefined }) : await LiveRecording.resume(journal, message.recordingId, message.options, { ...job, beforePublish: undefined });
        control = new PagedExecutionControl(store);
        await confirm(task); heartbeat = setInterval(() => { if (!store || renewing) return; renewing = true; void store.renew().finally(() => { renewing = false; }); }, 1500);
        scope.postMessage({ id: message.id, kind: 'state', header: { entry: store.entry, program: store.program, events: [...store.events], limits: { maxSteps: store.source.maxSteps, maxFrames: store.source.maxFrames } }, snapshot: snapshot() });
      } else {
        if (!store) throw new Error('Abra uma sessão para gravar');
        if (message.kind === 'range') { const records = await store.readRange(message.first, message.count, job); task.abort.signal.throwIfAborted(); scope.postMessage({ id: message.id, kind: 'records', records }); return; }
        if (message.kind === 'seek') { const from = store.cursor, before = store.lastStep; await store.seek(message.target, job); control!.cancel(); if (message.target === from + 1) step = store.lastStep; else if (message.target === from - 1) { step = before; reverse = true; } }
        else {
          if (message.kind === 'control' && message.mode !== undefined) control!.validateMode(message.mode);
          if (message.kind === 'breakpoints') control!.validateConfiguration(message.lines, message.enabled);
          await confirm(task);
          if (message.kind === 'control') { if (message.mode) control!.start(message.mode); const result = await control!.runBatch(); step = result.lastStep; reverse = result.direction === 'backward'; }
          if (message.kind === 'breakpoints') control!.configure(message.lines, message.enabled);
          if (message.kind === 'pause') control!.pause();
          if (message.kind === 'cache') store.setCacheBudget(message.bytes);
          if (message.kind === 'flush') await store.flush();
          if (message.kind === 'close') { await store.close(); if (heartbeat) clearInterval(heartbeat); heartbeat = null; }
          if (message.kind === 'run') {
            control!.cancel();
            for (let i = 0; i < 16 && (store.cursor < store.count || store.ledger.canRecord); i++) { await store.seek(store.cursor + 1); if (store.ledger.pauseReason) break; }
          }
        }
        scope.postMessage({ id: message.id, kind: 'state', snapshot: snapshot(step, reverse), events: store.events.slice(priorEvents) });
      }
    } catch (cause) {
      if (task.committed && store) { control?.fail(cause); store.stop(cause instanceof Error ? cause.message : String(cause)); scope.postMessage({ id: message.id, kind: 'state', snapshot: snapshot(), events: store.events.slice(priorEvents) }); }
      else scope.postMessage({ id: message.id, kind: 'error', aborted: task.abort.signal.aborted, message: cause instanceof Error ? cause.message : String(cause) });
      if ((message.kind === 'start' || message.kind === 'resume') && store && !task.committed) { await journal.release(store.entry.id, store.owner).catch(() => {}); }
    } finally { if (active === task) active = null; const next = waiting; waiting = null; if (next) start(next); }
  })();
}
scope.onmessage = event => {
  const message = event.data;
  if (message.kind === 'ack') { if (active?.message.id === message.id) acknowledge?.(); return; }
  if (message.kind === 'cancel') { if (active?.message.id === message.id && !active.committed) { active.abort.abort(); store?.cancel(); } if (waiting?.id === message.id) { scope.postMessage({ id: message.id, kind: 'error', aborted: true, message: 'Pedido cancelado' }); waiting = null; } return; }
  if (active) { if (waiting) scope.postMessage({ id: waiting.id, kind: 'error', aborted: true, message: 'Pedido substituído' }); waiting = message; if (!active.committed) { active.abort.abort(); store?.cancel(); } }
  else start(message);
};
