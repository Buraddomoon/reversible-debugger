import type { ComparisonHeader, ComparisonRequest, ComparisonResponse } from '../core/comparison-transfer';
import type { ComparisonRecording, PagedComparisonSnapshot } from '../core/paged-comparison';
import type { ComparisonRunView } from '../core/comparison-types';
interface Job { signal?: AbortSignal; onProgress?: (stage: string, done: number, total: number) => void }
interface Pending { resolve: (snapshot: PagedComparisonSnapshot) => void; reject: (cause: unknown) => void; clean: () => void; job: Job; accepted: boolean }
export class PagedComparisonClient {
  private worker = new Worker(new URL('../workers/paged-comparison.worker.ts', import.meta.url), { type: 'module' });
  private sequence = 0;
  private disposed = false;
  private pending = new Map<number, Pending>();
  header!: ComparisonHeader;
  snapshot!: PagedComparisonSnapshot;
  private constructor() {
    this.worker.onerror = event => { event.preventDefault(); this.fail(new Error('Não foi possível iniciar a comparação neste navegador')); this.disposed = true; this.worker.terminate(); };
    this.worker.onmessage = (event: MessageEvent<ComparisonResponse>) => {
      const message = event.data, pending = this.pending.get(message.id); if (!pending) return;
      if (message.kind === 'progress') { pending.job.onProgress?.(message.stage, message.done, message.total); return; }
      if (message.kind === 'prepared') { if (message.id !== this.sequence || pending.job.signal?.aborted) this.worker.postMessage({ id: message.id, kind: 'cancel' }); else { pending.accepted = true; this.worker.postMessage({ id: message.id, kind: 'ack' }); } return; }
      this.pending.delete(message.id); pending.clean();
      if (message.kind === 'error') pending.reject(message.aborted ? new DOMException(message.message, 'AbortError') : new Error(message.message));
      else { if (message.header) this.header = message.header; if (message.id === this.sequence) this.snapshot = message.snapshot; pending.resolve(message.snapshot); }
    };
  }
  static async open(left: ComparisonRecording, right: ComparisonRecording, budget: number, job: Job = {}) { const client = new PagedComparisonClient(); try { await client.request({ kind: 'open', left, right, budget }, job); return client; } catch (cause) { client.dispose(); throw cause; } }
  private request(input: Omit<Extract<ComparisonRequest, { kind: 'open' }>, 'id'> | Omit<Extract<ComparisonRequest, { kind: 'seek' }>, 'id'>, job: Job = {}): Promise<PagedComparisonSnapshot> {
    if (this.disposed) return Promise.reject(new DOMException('Comparação fechada', 'AbortError')); job.signal?.throwIfAborted(); const id = ++this.sequence;
    return new Promise((resolve, reject) => { const cancel = () => { if (!this.pending.get(id)?.accepted) this.worker.postMessage({ id, kind: 'cancel' }); }; job.signal?.addEventListener('abort', cancel, { once: true }); this.pending.set(id, { resolve, reject, job, accepted: false, clean: () => job.signal?.removeEventListener('abort', cancel) }); this.worker.postMessage({ ...input, id }); });
  }
  seek(target: number, job: Job = {}) { return this.request({ kind: 'seek', target }, job); }
  view(side: 'left' | 'right'): ComparisonRunView { const header = this.header[side], snapshot = this.snapshot[side], labels = new Map(snapshot.labels), contexts = new Map(snapshot.contexts); return { ...header, state: snapshot.state, cursor: snapshot.cursor, frameLabel: id => labels.get(id)!, contextForFrame: id => contexts.get(id)! }; }
  private fail(cause: unknown) { for (const pending of this.pending.values()) { pending.clean(); pending.reject(cause); } this.pending.clear(); }
  dispose() { if (this.disposed) return; this.disposed = true; this.worker.terminate(); this.fail(new DOMException('Comparação fechada', 'AbortError')); }
}
