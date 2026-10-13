import { importHistory } from '../core/portable-history';
import { transferHeader, type TransferRequest, type TransferResponse } from '../core/history-transfer';

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<TransferRequest>) => void) | null; postMessage: (message: TransferResponse) => void };
let active = false;
let acknowledge: (() => void) | null = null;
scope.onmessage = event => {
  if (event.data.kind === 'ack') { acknowledge?.(); acknowledge = null; return; }
  if (active) return;
  active = true;
  const content = event.data.content;
  const maxHistoryBytes = event.data.maxHistoryBytes;
  void (async () => {
    try {
      const imported = await importHistory(content, { maxHistoryBytes, onProgress: (done, total) => scope.postMessage({ kind: 'progress', done, total: total * 2 }) });
      const header = transferHeader(imported), records = imported.session.history;
      scope.postMessage({ kind: 'header', header });
      for (let i = 0; i < records.length; i += 256) {
        // Backpressure bounds queued messages and lets the main thread paint.
        await new Promise<void>(resolve => { acknowledge = resolve; scope.postMessage({ kind: 'chunk', records: records.slice(i, i + 256) }); });
        scope.postMessage({ kind: 'progress', done: records.length * 2 + Math.min(i + 256, records.length), total: records.length * 4 });
      }
      scope.postMessage({ kind: 'done' });
    } catch (cause) { scope.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }); }
  })();
};
