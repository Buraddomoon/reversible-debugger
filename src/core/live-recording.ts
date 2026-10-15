import { executeInstruction, applyStep, initialState, type DeepReadonly, type MachineState, type Step } from './machine';
import { RecordingJournal, LIVE_BLOCK_BYTES, LIVE_BLOCK_STEPS, type JournalSnapshot } from './recording-journal';
import { type RuntimeSelection } from './runtime';
import type { JournalPoint } from './journal-checkpoints';
import { JOURNAL_VALIDATOR } from './journal-validation-cache';
import { encode, type TraceMetadata } from './portable-history';
import { utf8Bytes } from './history-blocks';
import { freezePayload, HistoryBudgetError, validateHistoryBudget } from './history';
import { accountStep, encodedBytes, measureMachine } from './storage-accounting';
import { historyEvent, type HistoryEvent } from './history-events';
import { restoreValidatedStep, restoreValidatedReverse, requireTrace, integer, same } from './trace-validation';
import { recordingYield, SeekSupersededError } from './debugger';
import type { PagedCacheStats, PagedPreparedState, PagedSeekJob } from './paged-history';

export interface LiveOptions { maxHistoryBytes?: number; cacheBytes?: number; bufferBytes?: number; maxSteps?: number; maxFrames?: number; validateAll?: boolean; useCheckpoints?: boolean; readOnly?: boolean }
export interface RecordingLedger { id: string; frontier: number; durable: number; blocks: number; pendingSteps: number; pendingBytes: number; bufferLimit: number; pauseReason: string | null; canRecord: boolean; diskBytes: number; revision: number; oversized: boolean; validation: { reusedSteps: number; checkedSteps: number; blockReads: number; cacheWarning: string | null }; navigation: { restoredFrom: number; appliedSteps: number; warning: string | null } }
interface PendingStep { step: DeepReadonly<Step>; json: string; bytes: number }
/** Executes each new instruction once, buffers frozen deltas, and writes a
 * durable prefix. Navigation never executes; writer and viewed VM are detached. */
export class LiveRecording {
  readonly owner = crypto.randomUUID();
  private recording!: JournalSnapshot;
  private frontierMachine = initialState();
  private viewed = initialState();
  private position = 0;
  private frontier = 0;
  private buffer: PendingStep[] = [];
  private bufferSize = 2;
  private payload = measureMachine(this.frontierMachine);
  private maxMachine = this.payload.totalBytes;
  private maxStep = 0;
  private cache = new Map<number, { records: readonly DeepReadonly<Step>[]; bytes: number }>();
  private cacheSize = 0;
  private hits = 0;
  private reads = 0;
  private evictions = 0;
  private largeBlocks = 0;
  private epoch = 0;
  private pauseReason: string | null = null;
  private reusedSteps = 0;
  private checkedSteps = 0;
  private validationReads = 0;
  private cacheWarning: string | null = null;
  private points: JournalPoint[] = [];
  private pointBytes = 2;
  private checkpointWarning: string | null = null;
  private restoredFrom = 0;
  private appliedSteps = 0;
  private readonly useCheckpoints: boolean;
  private readonly readOnly: boolean;
  private currentStep: DeepReadonly<Step> | null = null;
  readonly events: HistoryEvent[] = [];
  private eventBytes = 2;
  private descriptorBytes = 2;
  readonly limitBytes: number;
  readonly bufferLimit: number;
  private cacheLimit: number;
  private constructor(readonly journal: RecordingJournal, options: LiveOptions) { this.readOnly = options.readOnly === true; this.useCheckpoints = options.useCheckpoints !== false; this.limitBytes = options.maxHistoryBytes ?? 64 * 1024 * 1024; validateHistoryBudget(this.limitBytes); this.bufferLimit = options.bufferBytes ?? LIVE_BLOCK_BYTES; integer(this.bufferLimit, 1, LIVE_BLOCK_BYTES); this.cacheLimit = options.cacheBytes ?? 2 * 1024 * 1024; integer(this.cacheLimit, 1, 8 * 1024 * 1024); }
  static async start(journal: RecordingJournal, source: string, runtime: RuntimeSelection, details: TraceMetadata, options: LiveOptions = {}, job: PagedSeekJob = {}): Promise<LiveRecording> {
    if (options.readOnly) throw new Error('Uma sessão nova precisa de um escritor');
    const store = new LiveRecording(journal, options); store.admit(); job.signal?.throwIfAborted(); store.recording = await journal.create(source, runtime, details, store.owner, { maxSteps: options.maxSteps ?? 20_000, maxFrames: options.maxFrames ?? 256 }, job.signal); return store;
  }
  static async resume(journal: RecordingJournal, id: string, options: LiveOptions = {}, job: PagedSeekJob = {}): Promise<LiveRecording> {
    const store = new LiveRecording(journal, options); store.recording = await journal.open(id, job.signal); store.descriptorBytes = encodedBytes(store.recording.head.blocks);
    try {
      const cached = options.validateAll ? null : await journal.validation.read(store.recording); job.signal?.throwIfAborted();
      if (cached) {
        const { prefix, state } = cached;
        store.frontierMachine = state; store.payload = measureMachine(state); store.maxMachine = prefix.maxMachineBytes; store.maxStep = prefix.maxStepBytes;
        store.frontier = prefix.frontier; store.reusedSteps = prefix.frontier;
        store.events.push(...prefix.events); store.eventBytes = 2 + prefix.events.reduce((bytes, event) => bytes + encodedBytes(event) + 1, 0);
      }
    } catch (cause) { job.signal?.throwIfAborted(); store.cacheWarning = cause instanceof Error ? cause.message : String(cause); await journal.validation.delete(id).catch(() => {}); }
    store.admit();
    try { for (const block of store.recording.head.blocks) {
      if (block.first < store.frontier) continue;
      const records = await journal.readBlock(store.recording, block, job.signal); store.validationReads++;
      for (const raw of records) { const step = restoreValidatedStep(store.frontierMachine, store.program, raw, store.maxFrames); store.payload = accountStep(store.payload, step, 'forward'); store.maxMachine = Math.max(store.maxMachine, store.payload.totalBytes); store.maxStep = Math.max(store.maxStep, encodedBytes(step)); store.frontier++; store.checkedSteps++; store.addEvent(step, store.frontier); store.admit(0, block.bytes); if (store.frontier % 16 === 0) { job.onProgress?.(store.frontier, store.recording.head.frontier); await recordingYield(job); } }
    }
    requireTrace(same(encode(store.frontierMachine), JSON.parse(store.recording.head.state)), 'checkpoint não corresponde ao prefixo durável');
    } catch (cause) {
      job.signal?.throwIfAborted();
      if (!store.reusedSteps || cause instanceof HistoryBudgetError) throw cause;
      // A stale/corrupt derived checkpoint must not make healthy source blocks
      // inaccessible. Retry once from the origin; primary corruption still fails.
      await journal.validation.delete(id).catch(() => {});
      return LiveRecording.resume(journal, id, { ...options, validateAll: true }, job);
    }
    job.signal?.throwIfAborted();
    await store.refreshPoints();
    if (!store.readOnly) await journal.claim(store.recording, store.owner);
    try { await store.seek(store.recording.head.cursor, job); if (!store.readOnly) await store.cachePrefix(); job.signal?.throwIfAborted(); return store; } catch (cause) { await journal.release(id, store.owner).catch(() => {}); throw cause; }
  }
  get program() { return this.recording.program; }
  get source() { return this.recording.source; }
  get entry() { return this.recording.entry; }
  get state(): DeepReadonly<MachineState> { return this.viewed; }
  get cursor(): number { return this.position; }
  get count(): number { return this.frontier; }
  get lastStep(): DeepReadonly<Step> | null { return this.currentStep; }
  private get maxFrames() { return this.source.maxFrames; }
  get ledger(): RecordingLedger { return { id: this.entry.id, frontier: this.frontier, durable: this.recording.head.frontier, blocks: this.recording.head.blocks.length, pendingSteps: this.buffer.length, pendingBytes: this.buffer.length ? this.bufferSize : 0, bufferLimit: this.bufferLimit, pauseReason: this.pauseReason, canRecord: !this.readOnly && this.pauseReason === null && this.frontierMachine.control.status === 'running' && this.frontier < this.source.maxSteps, diskBytes: this.entry.bytes, revision: this.recording.head.revision, oversized: this.bufferSize > this.bufferLimit && this.buffer.length === 1, validation: { reusedSteps: this.reusedSteps, checkedSteps: this.checkedSteps, blockReads: this.validationReads, cacheWarning: this.cacheWarning }, navigation: { restoredFrom: this.restoredFrom, appliedSteps: this.appliedSteps, warning: this.checkpointWarning } }; }
  get stats(): PagedCacheStats { const indexBytes = this.eventBytes + this.descriptorBytes + this.pointBytes, reservedMachineBytes = this.maxMachine * 5 + this.maxStep * 2 + this.bufferSize * 2; return { bytes: this.cacheSize, limitBytes: this.cacheLimit, blocks: this.cache.size, hits: this.hits, reads: this.reads, evictions: this.evictions, largeBlocks: this.largeBlocks, indexBytes, reservedMachineBytes, estimatedBytes: this.cacheSize + indexBytes + reservedMachineBytes, limitTotalBytes: this.limitBytes, checkpoints: this.points.length + 1, indexBuilt: false }; }
  cancel(): void { this.epoch++; }
  stop(reason: string): void { this.pauseReason = reason; }
  private check(epoch: number, job: PagedSeekJob): void { job.signal?.throwIfAborted(); if (epoch !== this.epoch) throw new SeekSupersededError(); }
  private addEvent(step: DeepReadonly<Step>, cursor: number): void { const event = historyEvent(step, cursor); if (event) { const compact = { ...event, description: event.description.slice(0, 240) }, bytes = encodedBytes(compact) + 1; if (this.eventBytes + bytes > 4 * 1024 * 1024) throw new Error('Índice de eventos excede 4 MiB'); this.events.push(compact); this.eventBytes += bytes; } }
  private evict(extra = 0): void { while (this.cache.size && this.cacheSize + extra > this.cacheLimit) { const id = this.cache.keys().next().value!; this.cacheSize -= this.cache.get(id)!.bytes; this.cache.delete(id); this.evictions++; } }
  private admit(bufferBytes = this.bufferSize, transient = 0, machineBytes = this.maxMachine, stepBytes = this.maxStep, futureEventBytes = 0): void { const minimum = machineBytes * 5 + stepBytes * 2 + bufferBytes * 2 + this.eventBytes + futureEventBytes + this.descriptorBytes + this.pointBytes + transient; if (minimum > this.limitBytes) throw new HistoryBudgetError(this.limitBytes, minimum); while (this.cacheSize + minimum > this.limitBytes && this.cache.size) { const id = this.cache.keys().next().value!; this.cacheSize -= this.cache.get(id)!.bytes; this.cache.delete(id); this.evictions++; } }
  setCacheBudget(bytes: number): void { integer(bytes, 1, 8 * 1024 * 1024); if (bytes + this.stats.reservedMachineBytes + this.stats.indexBytes > this.limitBytes) throw new HistoryBudgetError(this.limitBytes, bytes + this.stats.reservedMachineBytes + this.stats.indexBytes); this.cancel(); this.cacheLimit = bytes; this.evict(); }
  async renew(): Promise<void> { try { await this.journal.renew(this.entry.id, this.owner); } catch (cause) { this.pauseReason = cause instanceof Error ? cause.message : String(cause); } }
  async flush(signal?: AbortSignal): Promise<boolean> {
    if (this.readOnly) throw new Error('Este leitor não grava na sessão original');
    try {
      signal?.throwIfAborted(); await this.journal.renew(this.entry.id, this.owner);
      const candidate = await this.journal.prepare(this.recording, this.buffer.map(item => item.json), this.frontierMachine, this.position);
      this.admit(2, Math.max(0, encodedBytes(candidate.head.blocks) - this.descriptorBytes));
      let next;
      try { next = await this.journal.commit(this.recording, this.owner, candidate, signal); }
      catch (cause) { // Reconcile an uncertain response without duplicating a durable block.
        const disk = await this.journal.open(this.entry.id).catch(() => null);
        if (disk?.entry.headHash !== candidate.checksum) throw cause; next = disk.entry;
      }
      this.recording = { ...this.recording, entry: next, head: candidate.head }; this.descriptorBytes = encodedBytes(candidate.head.blocks); this.buffer = []; this.bufferSize = 2; this.pauseReason = null; await this.savePoint(); await this.cachePrefix(); return true;
    } catch (cause) { this.pauseReason = cause instanceof Error ? cause.message : String(cause); return false; }
  }
  private async refreshPoints(): Promise<void> {
    if (!this.useCheckpoints) return;
    const previous = this.points, previousBytes = this.pointBytes;
    try { const points = await this.journal.checkpoints.list(this.recording); this.points = points; this.pointBytes = encodedBytes(points); this.admit(); this.checkpointWarning = null; }
    catch (cause) { this.points = previous; this.pointBytes = previousBytes; this.checkpointWarning = cause instanceof Error ? cause.message : String(cause); }
  }
  private async savePoint(): Promise<void> {
    if (!this.useCheckpoints) return;
    try { await this.journal.checkpoints.put(this.recording, this.recording.head.frontier, this.recording.head.state); await this.refreshPoints(); }
    catch (cause) { this.checkpointWarning = cause instanceof Error ? cause.message : String(cause); }
  }
  private async cachePrefix(): Promise<void> {
    try {
      await this.journal.validation.publish({ validator: JOURNAL_VALIDATOR, runId: this.entry.id, sourceHash: this.entry.sourceHash,
        frontier: this.recording.head.frontier, seal: this.recording.head.lastSeal, state: this.recording.head.state,
        maxMachineBytes: this.maxMachine, maxStepBytes: this.maxStep, events: this.events });
      this.cacheWarning = null;
    } catch (cause) { this.cacheWarning = cause instanceof Error ? cause.message : String(cause); }
  }
  async close(): Promise<void> { if (this.readOnly) return; if (!await this.flush()) throw new Error(this.pauseReason ?? 'Pendências não foram salvas'); await this.journal.release(this.entry.id, this.owner); }
  private async advance(job: PagedSeekJob): Promise<void> {
    if (this.position !== this.frontier || !this.ledger.canRecord) throw new Error(this.pauseReason ?? (this.frontier >= this.source.maxSteps ? `Limite de ${this.source.maxSteps.toLocaleString('pt-BR')} passos atingido` : 'Navegue até o fim registrado para continuar a gravação'));
    const epoch = ++this.epoch, beforePayload = this.payload, raw = executeInstruction(this.frontierMachine, this.program, this.maxFrames), step = freezePayload(raw), json = JSON.stringify(encode(step)), bytes = utf8Bytes(json);
    let applied = true, committed = false;
    try {
      const nextPayload = accountStep(beforePayload, step, 'forward');
      if (this.buffer.length && (this.bufferSize + bytes + 1 > this.bufferLimit || this.buffer.length === LIVE_BLOCK_STEPS)) {
        applyStep(this.frontierMachine, step, 'backward'); applied = false;
        if (!await this.flush(job.signal)) throw new Error(this.pauseReason!); this.check(epoch, job);
        applyStep(this.frontierMachine, step, 'forward'); applied = true;
      }
      const event = historyEvent(step, this.frontier + 1), futureEventBytes = event ? encodedBytes({ ...event, description: event.description.slice(0, 240) }) + 1 : 0;
      if (this.eventBytes + futureEventBytes > 4 * 1024 * 1024) throw new Error('Índice de eventos excede 4 MiB');
      this.admit(this.bufferSize + bytes + 1, 0, Math.max(this.maxMachine, nextPayload.totalBytes), Math.max(this.maxStep, bytes), futureEventBytes);
      await job.beforePublish?.({ state: this.frontierMachine, cursor: this.frontier + 1, lastStep: step }); this.check(epoch, job);
      this.buffer.push({ step, json, bytes }); this.bufferSize += bytes + (this.buffer.length > 1 ? 1 : 0); this.frontier++; this.position = this.frontier; this.payload = nextPayload; this.maxMachine = Math.max(this.maxMachine, nextPayload.totalBytes); this.maxStep = Math.max(this.maxStep, bytes); this.currentStep = step; applyStep(this.viewed, step, 'forward'); this.addEvent(step, this.frontier); committed = true;
      if (this.buffer.length === LIVE_BLOCK_STEPS || this.bufferSize >= this.bufferLimit || this.frontierMachine.control.status !== 'running' || this.frontier === this.source.maxSteps) await this.flush();
    } finally { if (applied && !committed) applyStep(this.frontierMachine, step, 'backward'); }
  }
  private async recordsAt(index: number, job: PagedSeekJob): Promise<{ records: readonly DeepReadonly<Step>[]; first: number }> {
    if (index >= this.recording.head.frontier) return { records: this.buffer.map(item => item.step), first: this.recording.head.frontier };
    const descriptor = this.recording.head.blocks.find(b => index >= b.first && index < b.first + b.count)!; const hit = this.cache.get(descriptor.index);
    if (hit) { this.hits++; this.cache.delete(descriptor.index); this.cache.set(descriptor.index, hit); return { records: hit.records, first: descriptor.first }; }
    this.admit(this.bufferSize, descriptor.bytes); this.evict(descriptor.bytes); const records = freezePayload(await this.journal.readBlock(this.recording, descriptor, job.signal) as Step[]); this.reads++;
    if (descriptor.bytes <= this.cacheLimit) { this.cache.set(descriptor.index, { records, bytes: descriptor.bytes }); this.cacheSize += descriptor.bytes; } else this.largeBlocks++;
    return { records, first: descriptor.first };
  }
  async readRange(first: number, count: number, job: PagedSeekJob = {}): Promise<readonly DeepReadonly<Step>[]> { integer(first, 0, this.frontier); integer(count, 0, 16); integer(first + count, 0, this.frontier); const records: DeepReadonly<Step>[] = []; while (records.length < count) { job.signal?.throwIfAborted(); const batch = await this.recordsAt(first + records.length, job); records.push(...batch.records.slice(first + records.length - batch.first, first + count - batch.first)); } return records; }
  async seek(target: number, job: PagedSeekJob = {}): Promise<void> {
    integer(target, 0, this.frontier + 1); job.signal?.throwIfAborted(); if (target === this.frontier + 1) { await this.advance(job); return; }
    const epoch = ++this.epoch, from = this.position;
    let cursor = from, state: MachineState;
    if (target < Math.abs(from - target) && target < Math.abs(this.frontier - target)) { state = initialState(); cursor = 0; }
    else if (Math.abs(this.frontier - target) < Math.abs(from - target)) { state = structuredClone(this.frontierMachine); cursor = this.frontier; }
    else state = structuredClone(this.viewed);
    if (this.useCheckpoints) {
      const candidates = this.points.filter(p => Math.abs(p.cursor - target) < Math.abs(cursor - target)).sort((a, b) => Math.abs(a.cursor - target) - Math.abs(b.cursor - target));
      for (const point of candidates) {
        try {
          this.admit(this.bufferSize, point.bytes); const decoded = await this.journal.checkpoints.read(this.recording, point); this.check(epoch, job);
          if (!decoded) { this.points = this.points.filter(p => p !== point); this.pointBytes = encodedBytes(this.points); continue; }
          requireTrace(measureMachine(decoded).totalBytes <= this.maxMachine, 'checkpoint excede reserva da execução'); state = decoded; cursor = point.cursor; break;
        } catch (cause) { this.check(epoch, job); this.checkpointWarning = cause instanceof Error ? cause.message : String(cause); }
      }
    }
    const restoredFrom = cursor, total = Math.abs(cursor - target); let completed = 0;
    while (cursor !== target) {
      this.check(epoch, job); const forward = cursor < target, batch = await this.recordsAt(forward ? cursor : cursor - 1, job); this.check(epoch, job); let started = performance.now(), size = 0;
      while (cursor !== target && (forward ? cursor : cursor - 1) >= batch.first && (forward ? cursor : cursor - 1) < batch.first + batch.records.length) { const step = batch.records[(forward ? cursor : cursor - 1) - batch.first]!; if (forward) restoreValidatedStep(state, this.program, step, this.maxFrames); else restoreValidatedReverse(state, this.program, step, this.maxFrames); cursor += forward ? 1 : -1; completed++; size++; if (size === 16 || performance.now() - started >= 6) { job.onSeekProgress?.({ from, to: target, cursor, total, completed }); await recordingYield(job); this.check(epoch, job); size = 0; started = performance.now(); } }
    }
    const step = target ? (await this.readRange(target - 1, 1, job))[0]! : null; this.check(epoch, job);
    const prepared: PagedPreparedState = { state, cursor: target, lastStep: step }; await job.beforePublish?.(prepared); this.check(epoch, job); this.viewed = state; this.position = target; this.currentStep = step; this.restoredFrom = restoredFrom; this.appliedSteps = completed;
  }
}
