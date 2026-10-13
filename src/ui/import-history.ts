import { DebugSession, type RecordingJob } from '../core/debugger';
import type { TransferHeader, TransferRequest, TransferResponse } from '../core/history-transfer';
import type { ImportedHistory } from '../core/portable-history';
import type { DeepReadonly, Step } from '../core/machine';

/** The worker owns parsing/checksum validation and its staging VM. It only sends
 * verified records in acknowledged chunks; the active VM is never touched. */
export async function importHistoryInWorker(content: string, job: RecordingJob & { maxHistoryBytes?: number } = {}): Promise<ImportedHistory> {
  job.signal?.throwIfAborted();
  const worker = new Worker(new URL('../workers/history-import.worker.ts', import.meta.url), { type: 'module' });
  const records: DeepReadonly<Step>[] = [];
  const header = await new Promise<TransferHeader>((resolve, reject) => {
    let received: TransferHeader | null = null;
    let settled = false;
    const cleanup = () => { settled = true; worker.terminate(); job.signal?.removeEventListener('abort', cancel); };
    const fail = (cause: unknown) => { if (!settled) { cleanup(); reject(cause); } };
    const cancel = () => fail(job.signal?.reason ?? new DOMException('Importação cancelada', 'AbortError'));
    worker.onerror = event => { event.preventDefault(); fail(new Error('Não foi possível iniciar a validação do histórico neste navegador')); };
    worker.onmessage = (event: MessageEvent<TransferResponse>) => {
      if (settled) return;
      const message = event.data;
      if (message.kind === 'error') fail(new Error(message.message));
      else if (message.kind === 'header') received = message.header;
      else if (message.kind === 'progress') job.onProgress?.(message.done, message.total);
      else if (message.kind === 'chunk') {
        if (!received || records.length + message.records.length > received.count || message.records.length > 256) { fail(new Error('Transferência do histórico inconsistente')); return; }
        records.push(...message.records);
        worker.postMessage({ kind: 'ack' } satisfies TransferRequest);
      } else if (message.kind === 'done') {
        if (!received || records.length !== received.count) { fail(new Error('Transferência do histórico incompleta')); return; }
        cleanup(); resolve(received);
      }
    };
    job.signal?.addEventListener('abort', cancel, { once: true });
    worker.postMessage({ kind: 'import', content, maxHistoryBytes: job.maxHistoryBytes } satisfies TransferRequest);
  });
  job.signal?.throwIfAborted();
  // Replay/verify again into a detached UI session in bounded batches; no JSON
  // parsing, digest or unbounded transfer is performed by the main thread.
  const session = await DebugSession.restoreRecording(header.source, { ...header.runtime, maxSteps: header.maxSteps, maxFrames: header.maxFrames, maxHistoryBytes: header.maxHistoryBytes }, records, header.cursor, { ...job, onProgress: done => job.onProgress?.(header.count * 3 + done, header.count * 4) });
  return { name: header.name, filename: header.filename, bytes: header.bytes, checksum: header.checksum, session };
}
