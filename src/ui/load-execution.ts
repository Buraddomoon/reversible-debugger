import { DebugSession, recordingYield, type RecordingBuilder, type RecordingJob } from '../core/debugger';
import type { TransferHeader, TransferResponse } from '../core/history-transfer';
import type { ImportedHistory } from '../core/portable-history';
import type { LibraryWorkerRequest } from '../workers/execution-library.worker';

/** Receive directly into a staging VM, never accumulate a second full decoded trace. */
export async function loadExecutionInWorker(id: string, job: RecordingJob & { maxHistoryBytes: number }): Promise<ImportedHistory> {
  job.signal?.throwIfAborted();
  const worker = new Worker(new URL('../workers/execution-library.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    let settled = false, finishing = false;
    let header: TransferHeader | null = null, builder: RecordingBuilder | null = null;
    const cleanup = () => { settled = true; worker.terminate(); job.signal?.removeEventListener('abort', cancel); };
    const fail = (cause: unknown) => { if (!settled) { cleanup(); reject(cause); } };
    const cancel = () => fail(job.signal?.reason ?? new DOMException('Leitura cancelada', 'AbortError'));
    worker.onerror = event => { event.preventDefault(); fail(new Error('Não foi possível carregar a execução neste navegador')); };
    worker.onmessage = (event: MessageEvent<TransferResponse>) => {
      if (settled || finishing) return;
      const message = event.data;
      void (async () => {
        try {
          if (message.kind === 'error') throw new Error(message.message);
          if (message.kind === 'header') {
            if (header) throw new Error('Cabeçalho repetido');
            header = message.header;
            builder = DebugSession.recordingBuilder(header.source, { ...header.runtime, maxSteps: header.maxSteps, maxFrames: header.maxFrames, maxHistoryBytes: job.maxHistoryBytes }, header.count, header.cursor);
          } else if (message.kind === 'progress') job.onProgress?.(message.done, message.total);
          else if (message.kind === 'chunk') {
            if (!builder || !header || message.records.length < 1 || message.records.length > 16) throw new Error('Transferência de blocos inconsistente');
            builder.append(message.records); await recordingYield(job);
            if (!settled) worker.postMessage({ kind: 'ack' } satisfies LibraryWorkerRequest);
          } else if (message.kind === 'done') {
            if (!header || !builder || builder.count !== header.count) throw new Error('Transferência de blocos incompleta');
            finishing = true;
            const session = await builder.finish(job); job.signal?.throwIfAborted();
            if (!settled) { cleanup(); resolve({ name: header.name, filename: header.filename, bytes: header.bytes, checksum: header.checksum, session }); }
          }
        } catch (cause) { fail(cause); }
      })();
    };
    job.signal?.addEventListener('abort', cancel, { once: true });
    worker.postMessage({ kind: 'load', id, maxHistoryBytes: job.maxHistoryBytes } satisfies LibraryWorkerRequest);
  });
}
