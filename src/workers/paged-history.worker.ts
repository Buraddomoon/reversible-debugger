import { ExecutionLibrary } from '../core/execution-library';
import { CheckpointCache } from '../core/checkpoint-cache';
import { PagedHistoryStore } from '../core/paged-history';
import type { PagedRequest, PagedResponse, PagedSnapshot } from '../core/paged-transfer';
import { explainStep, type StepExplanation } from '../core/explanations';
import type { DeepReadonly, Step } from '../core/machine';
import type { PagedPreparedState } from '../core/paged-history';

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<PagedRequest>) => void) | null; postMessage: (message: PagedResponse) => void };
const library = new ExecutionLibrary(), checkpoints = new CheckpointCache();
let store: PagedHistoryStore | null = null, active: { id: number; abort: AbortController } | null = null;
const acknowledgements = new Map<number, () => void>();
async function confirm(message: Extract<PagedResponse, { kind: 'state' }>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { acknowledgements.delete(message.id); signal.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); reject(signal.reason); };
    acknowledgements.set(message.id, () => { cleanup(); resolve(); }); signal.addEventListener('abort', cancel, { once: true }); scope.postMessage(message);
  }); signal.throwIfAborted();
}
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
  return { cursor, count: current.count, state, step: lastStep ? { span: lastStep.span, op: lastStep.op, description: lastStep.description } : null, evidence, reverse, changedNames: step?.changes.flatMap(c => c.kind === 'binding' ? [c.name] : []) ?? [], stats: current.stats };
}
scope.onmessage = event => {
  const message = event.data;
  if (message.kind === 'ack') { acknowledgements.get(message.id)?.(); return; }
  if (message.kind === 'cancel') { if (active?.id === message.id) { active.abort.abort(); store?.cancel(); } return; }
  active?.abort.abort(); store?.cancel(); const abort = new AbortController(), task = { id: message.id, abort }; active = task;
  const job = { signal: abort.signal, onProgress: (done: number, total: number) => scope.postMessage({ id: message.id, kind: 'index-progress', done, total }), onSeekProgress: (progress: import('../core/paged-history').PagedSeekProgress) => scope.postMessage({ id: message.id, kind: 'seek-progress', progress }) };
  void (async () => {
    try {
      if (message.kind === 'open') {
        const opened = await PagedHistoryStore.open(library, checkpoints, message.recordingId, message.options, job); abort.signal.throwIfAborted();
        store?.dispose(); store = opened;
        await confirm({ id: message.id, kind: 'state', header: { entry: opened.recording.entry, program: opened.program, events: opened.index.events }, snapshot: snapshot() }, abort.signal);
      } else {
        if (!store) throw new Error('Abra uma execução salva antes de navegar');
        let step: DeepReadonly<Step> | null = null, reverse = false;
        if (message.kind === 'cache') { store.setCacheBudget(message.bytes); await confirm({ id: message.id, kind: 'state', snapshot: snapshot() }, abort.signal); }
        else {
          const from = store.cursor, before = store.lastStep;
          await store.seek(message.target, { ...job, beforePublish: async prepared => {
            if (message.target === from - 1) { step = before; reverse = true; } else if (message.target === from + 1) step = prepared.lastStep;
            await confirm({ id: message.id, kind: 'state', snapshot: snapshot(step, reverse, prepared) }, abort.signal);
          } });
        }
      }
    } catch (cause) { scope.postMessage({ id: message.id, kind: 'error', aborted: abort.signal.aborted || cause instanceof Error && cause.name === 'AbortError', message: cause instanceof Error ? cause.message : String(cause) }); }
    finally { if (active === task) active = null; }
  })();
};
