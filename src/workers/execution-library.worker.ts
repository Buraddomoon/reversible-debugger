import { ExecutionLibrary } from '../core/execution-library';
import type { TransferResponse } from '../core/history-transfer';

export type LibraryWorkerRequest = { kind: 'load'; id: string; maxHistoryBytes: number } | { kind: 'ack' };
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<LibraryWorkerRequest>) => void) | null; postMessage: (message: TransferResponse) => void };
let active = false, acknowledge: (() => void) | null = null;
scope.onmessage = event => {
  if (event.data.kind === 'ack') { acknowledge?.(); acknowledge = null; return; }
  if (active) return; active = true;
  const { id, maxHistoryBytes } = event.data;
  void (async () => {
    let library: ExecutionLibrary | null = null;
    try {
      library = new ExecutionLibrary();
      await library.load(id, {
        maxHistoryBytes,
        onHeader: (h, bytes, checksum) => scope.postMessage({ kind: 'header', header: { ...h.metadata, bytes, checksum, source: h.source, runtime: h.runtime as import('../core/runtime').RuntimeSelection, maxSteps: h.limits.maxSteps, maxFrames: h.limits.maxFrames, maxHistoryBytes, cursor: h.cursor, count: h.count } }),
        onChunk: records => new Promise<void>(resolve => { acknowledge = resolve; scope.postMessage({ kind: 'chunk', records }); }),
        onProgress: (done, total) => scope.postMessage({ kind: 'progress', done, total }),
      });
      scope.postMessage({ kind: 'done' });
    } catch (cause) { scope.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }); }
    finally { await library?.close(); }
  })();
};
