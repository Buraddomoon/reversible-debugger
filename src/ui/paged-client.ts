import type { PagedOptions, PagedSeekProgress } from '../core/paged-history';
import type { PagedHeader, PagedRequest, PagedSnapshot, LiveRequest, LiveResponse } from '../core/paged-transfer';
import { DebugSession, recordingYield, type RecordingJob } from '../core/debugger';
import { digest, type ImportedHistory, type TraceMetadata } from '../core/portable-history';
import type { RuntimeSelection } from '../core/runtime';
import type { LiveOptions } from '../core/live-recording';

interface ClientJob extends RecordingJob { onSeekProgress?: (progress: PagedSeekProgress) => void }
type Result = Extract<LiveResponse, { kind: 'state' | 'records' }>;
type Input = LiveRequest extends infer R ? R extends { kind: 'ack' | 'cancel' } ? never : R extends { id: number } ? Omit<R, 'id'> : never : never;
interface Pending { resolve: (message: Result) => void; reject: (cause: unknown) => void; job: ClientJob; cleanup: () => void; acknowledged: boolean }
export class PagedRecordingClient {
  private worker: Worker;
  private sequence = 0;
  private latest = 0;
  private disposed = false;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(snapshot: PagedSnapshot) => void>();
  header!: PagedHeader;
  snapshot!: PagedSnapshot;
  private constructor(readonly isLive = false) {
    this.worker = isLive ? new Worker(new URL('../workers/live-recording.worker.ts', import.meta.url), { type: 'module' }) : new Worker(new URL('../workers/paged-history.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onerror = event => { event.preventDefault(); this.failAll(new Error('Não foi possível iniciar o histórico paginado neste navegador')); };
    this.worker.onmessage = (event: MessageEvent<LiveResponse>) => {
      if (this.disposed) return;
      const message = event.data, pending = this.pending.get(message.id); if (!pending) return;
      if (message.kind === 'index-progress') pending.job.onProgress?.(message.done, message.total);
      else if (message.kind === 'seek-progress') pending.job.onSeekProgress?.(message.progress);
      else if (message.kind === 'prepared') {
        if (message.id !== this.latest || pending.job.signal?.aborted) this.worker.postMessage({ kind: 'cancel', id: message.id } satisfies LiveRequest);
        else { pending.acknowledged = true; this.worker.postMessage({ kind: 'ack', id: message.id } satisfies LiveRequest); }
      }
      else {
        this.pending.delete(message.id); pending.cleanup();
        if (message.kind === 'error') pending.reject(message.aborted ? new DOMException(message.message, 'AbortError') : new Error(message.message));
        else if (message.kind === 'records') { if (pending.job.signal?.aborted) pending.reject(pending.job.signal.reason); else pending.resolve(message); }
        else if (!pending.acknowledged && (message.id !== this.latest || pending.job.signal?.aborted)) { this.worker.postMessage({ kind: 'cancel', id: message.id } satisfies PagedRequest); pending.reject(new DOMException('Pedido substituído ou cancelado', 'AbortError')); }
        else {
          if (!this.isLive) this.worker.postMessage({ kind: 'ack', id: message.id } satisfies PagedRequest);
          if (message.header) this.header = message.header;
          if ('events' in message && message.events?.length) this.header = { ...this.header, events: [...this.header.events, ...message.events] };
          if (message.id === this.latest) { this.snapshot = message.snapshot; for (const listener of this.listeners) listener(this.snapshot); }
          pending.resolve(message);
        }
      }
    };
  }
  static async open(id: string, options: PagedOptions, job: ClientJob = {}): Promise<PagedRecordingClient> {
    job.signal?.throwIfAborted(); const client = new PagedRecordingClient();
    try { await client.request({ kind: 'open', recordingId: id, options } as Omit<Extract<PagedRequest, { kind: 'open' }>, 'id'>, job); return client; }
    catch (cause) { client.dispose(); throw cause; }
  }
  static async startLive(source: string, runtime: RuntimeSelection, metadata: TraceMetadata, options: LiveOptions, job: ClientJob = {}): Promise<PagedRecordingClient> { const client = new PagedRecordingClient(true); try { await client.request({ kind: 'start', source, runtime, metadata, options }, job); return client; } catch (cause) { client.dispose(); throw cause; } }
  static async resumeLive(id: string, options: LiveOptions, job: ClientJob = {}): Promise<PagedRecordingClient> { const client = new PagedRecordingClient(true); try { await client.request({ kind: 'resume', recordingId: id, options }, job); return client; } catch (cause) { client.dispose(); throw cause; } }
  private request(input: Input | Omit<Extract<PagedRequest, { kind: 'open' }>, 'id'>, job: ClientJob = {}): Promise<Result> {
    if (this.disposed) return Promise.reject(new Error('Histórico fechado')); job.signal?.throwIfAborted();
    const id = ++this.sequence; this.latest = id;
    return new Promise((resolve, reject) => {
      const cancel = () => { if (!this.pending.get(id)?.acknowledged) this.worker.postMessage({ kind: 'cancel', id } satisfies PagedRequest); };
      this.pending.set(id, { resolve, reject, job, acknowledged: false, cleanup: () => job.signal?.removeEventListener('abort', cancel) }); job.signal?.addEventListener('abort', cancel, { once: true });
      this.worker.postMessage({ ...input, id });
    });
  }
  private async stateRequest(input: Input, job: ClientJob = {}): Promise<PagedSnapshot> { const response = await this.request(input, job); if (response.kind !== 'state') throw new Error('Resposta de sessão inconsistente'); return response.snapshot; }
  async seek(target: number, job: ClientJob = {}): Promise<PagedSnapshot> { return this.stateRequest({ kind: 'seek', target }, job); }
  async run(job: ClientJob = {}): Promise<PagedSnapshot> { return this.stateRequest({ kind: 'run' }, job); }
  async flush(job: ClientJob = {}): Promise<PagedSnapshot> { return this.stateRequest({ kind: 'flush' }, job); }
  async closeLive(): Promise<void> { if (!this.isLive) return; const response = await this.stateRequest({ kind: 'close' }); if (response.recording?.pauseReason || response.recording?.pendingSteps) throw new Error(response.recording.pauseReason ?? 'Passos pendentes não foram salvos'); }
  async capture(maxHistoryBytes: number, job: ClientJob = {}): Promise<ImportedHistory> {
    const { header, snapshot } = this; const builder = DebugSession.recordingBuilder(header.program.source, { ...header.program.runtime, maxSteps: header.limits?.maxSteps ?? 20_000, maxFrames: header.limits?.maxFrames ?? 256, maxHistoryBytes }, snapshot.count, snapshot.cursor);
    for (let first = 0; first < snapshot.count; first += 16) { job.signal?.throwIfAborted(); const response = await this.request({ kind: 'range', first, count: Math.min(16, snapshot.count - first) }, job); if (response.kind !== 'records') throw new Error('Captura incompleta'); builder.append(response.records); job.onProgress?.(builder.count, snapshot.count); await recordingYield(job); }
    const session = await builder.finish(job), bytes = (snapshot.recording?.diskBytes ?? header.entry.bytes) + (snapshot.recording?.pendingBytes ?? 0); return { name: header.entry.name, filename: header.entry.filename, bytes, checksum: await digest(JSON.stringify({ id: header.entry.id, cursor: snapshot.cursor, count: snapshot.count, revision: snapshot.recording?.revision })), session };
  }
  async setCacheBudget(bytes: number): Promise<PagedSnapshot> { return this.stateRequest({ kind: 'cache', bytes }); }
  cancel(): void { this.worker.postMessage({ kind: 'cancel', id: this.latest } satisfies PagedRequest); }
  subscribe(listener: (snapshot: PagedSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private failAll(cause: unknown): void { for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(cause); } this.pending.clear(); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.worker.terminate(); this.failAll(new DOMException('Histórico fechado', 'AbortError')); }
}
