import type { PagedOptions, PagedSeekProgress } from '../core/paged-history';
import type { PagedHeader, PagedRequest, PagedResponse, PagedSnapshot } from '../core/paged-transfer';
import type { RecordingJob } from '../core/debugger';

interface ClientJob extends RecordingJob { onSeekProgress?: (progress: PagedSeekProgress) => void }
interface Pending { resolve: (message: Extract<PagedResponse, { kind: 'state' }>) => void; reject: (cause: unknown) => void; job: ClientJob; cleanup: () => void }
export class PagedRecordingClient {
  private worker: Worker;
  private sequence = 0;
  private latest = 0;
  private disposed = false;
  private pending = new Map<number, Pending>();
  header!: PagedHeader;
  snapshot!: PagedSnapshot;
  private constructor() {
    this.worker = new Worker(new URL('../workers/paged-history.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onerror = event => { event.preventDefault(); this.failAll(new Error('Não foi possível iniciar o histórico paginado neste navegador')); };
    this.worker.onmessage = (event: MessageEvent<PagedResponse>) => {
      if (this.disposed) return;
      const message = event.data, pending = this.pending.get(message.id); if (!pending) return;
      if (message.kind === 'index-progress') pending.job.onProgress?.(message.done, message.total);
      else if (message.kind === 'seek-progress') pending.job.onSeekProgress?.(message.progress);
      else {
        this.pending.delete(message.id); pending.cleanup();
        if (message.kind === 'error') pending.reject(message.aborted ? new DOMException(message.message, 'AbortError') : new Error(message.message));
        else if (message.id !== this.latest || pending.job.signal?.aborted) { this.worker.postMessage({ kind: 'cancel', id: message.id } satisfies PagedRequest); pending.reject(new DOMException('Pedido substituído ou cancelado', 'AbortError')); }
        else { this.worker.postMessage({ kind: 'ack', id: message.id } satisfies PagedRequest); if (message.header) this.header = message.header; this.snapshot = message.snapshot; pending.resolve(message); }
      }
    };
  }
  static async open(id: string, options: PagedOptions, job: ClientJob = {}): Promise<PagedRecordingClient> {
    job.signal?.throwIfAborted(); const client = new PagedRecordingClient();
    try { await client.request({ kind: 'open', recordingId: id, options }, job); return client; }
    catch (cause) { client.dispose(); throw cause; }
  }
  private request(input: Omit<Extract<PagedRequest, { kind: 'open' }>, 'id'> | Omit<Extract<PagedRequest, { kind: 'seek' }>, 'id'> | Omit<Extract<PagedRequest, { kind: 'cache' }>, 'id'>, job: ClientJob = {}): Promise<Extract<PagedResponse, { kind: 'state' }>> {
    if (this.disposed) return Promise.reject(new Error('Histórico fechado')); job.signal?.throwIfAborted();
    const id = ++this.sequence; this.latest = id;
    return new Promise((resolve, reject) => {
      const cancel = () => this.worker.postMessage({ kind: 'cancel', id } satisfies PagedRequest);
      this.pending.set(id, { resolve, reject, job, cleanup: () => job.signal?.removeEventListener('abort', cancel) }); job.signal?.addEventListener('abort', cancel, { once: true });
      this.worker.postMessage({ ...input, id } satisfies PagedRequest);
    });
  }
  async seek(target: number, job: ClientJob = {}): Promise<PagedSnapshot> { return (await this.request({ kind: 'seek', target }, job)).snapshot; }
  async setCacheBudget(bytes: number): Promise<PagedSnapshot> { return (await this.request({ kind: 'cache', bytes })).snapshot; }
  cancel(): void { this.worker.postMessage({ kind: 'cancel', id: this.latest } satisfies PagedRequest); }
  private failAll(cause: unknown): void { for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(cause); } this.pending.clear(); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.worker.terminate(); this.failAll(new DOMException('Histórico fechado', 'AbortError')); }
}
