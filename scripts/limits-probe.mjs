import { PagedRecordingClient } from '/src/ui/paged-client.ts';
import { DebugSession, recordingYield } from '/src/core/debugger.ts';
import { RecordingJournal } from '/src/core/recording-journal.ts';
import { ExecutionLibrary } from '/src/core/execution-library.ts';
import { encode, exportHistory, importHistory, digest } from '/src/core/portable-history.ts';
export async function createLimitsProbe({ compareCapture = false } = {}) {
  const runtime = { language: 'python', version: '3' }, source = 'i = 0\nwhile True:\n    i += 1', options = { maxSteps: 50000, maxFrames: 64, cacheBytes: 16384 };
  const journal = new RecordingJournal(), library = new ExecutionLibrary(), metadata = { name: 'Limite ampliado', filename: 'limits.py' };
  let client = await PagedRecordingClient.startLive(source, runtime, metadata, options), savedId, captured, released = false;
  const id = client.header.entry.id, begin = performance.now(), expected = new Map();
  const report = { count: 0, maxPayloadBytes: 0, maxCacheBytes: 0, batches: 0, resumes: [], seeks: [] };
  const state = s => JSON.stringify(encode(s));
  const remember = () => { const s = client.snapshot; expected.set(s.cursor, state(s.state)); if (s.stats.estimatedBytes > s.stats.limitTotalBytes || s.stats.bytes > 16384 || s.debug?.error || s.recording?.pauseReason) throw new Error('Invalid state/budget'); report.maxPayloadBytes = Math.max(report.maxPayloadBytes, s.stats.estimatedBytes); report.maxCacheBytes = Math.max(report.maxCacheBytes, s.stats.bytes); };
  const targets = [0, 19999, 20000, 20001, 32769, 49999, 50000];
  return {
    async recordChunk() {
      for (let i = 0; i < 32 && client.snapshot.recording.canRecord; i++) { await client.control('continue'); remember(); report.batches++; }
      return !client.snapshot.recording.canRecord;
    },
    async navigateAndResume() {
      report.recordMs = performance.now() - begin; report.count = client.snapshot.count;
      if (report.count !== 50000 || client.snapshot.recording.durable !== 50000 || client.snapshot.state.control.status !== 'running') throw new Error('Extended frontier lost');
      report.journalVersion = (await journal.open(id)).source.version; if (report.journalVersion !== 2) throw new Error('Wrong journal version');
      for (const target of targets) { const start = performance.now(); await client.seek(target); remember(); report.seeks.push({ target, ms: performance.now() - start }); }
      for (const validateAll of [false, true]) {
        const before = state(client.snapshot.state); await client.closeLive(); client.dispose(); const start = performance.now();
        client = await PagedRecordingClient.resumeLive(id, { cacheBytes: 16384, validateAll });
        if (state(client.snapshot.state) !== before || client.header.limits.maxSteps !== 50000 || client.header.limits.maxFrames !== 64) throw new Error('Resume lost limits/state');
        const validation = client.snapshot.recording.validation; if (validateAll ? validation.checkedSteps !== 50000 : validation.reusedSteps !== 50000 || validation.checkedSteps !== 0) throw new Error('Wrong resume validation');
        report.resumes.push({ validateAll, ms: performance.now() - start, ...client.snapshot.recording.validation });
      }
      return report;
    },
    async capture() {
      const measure = async operation => {
        await client.pause(); const reads = client.snapshot.stats.reads, receiver = client.worker.onmessage;
        const metrics = { packets: 0, maxPacketSteps: 0, maxPacketBytes: 0 };
        client.worker.onmessage = event => {
          if (event.data.kind === 'records' || event.data.kind === 'capture-records') {
            const records = event.data.records; metrics.packets++; metrics.maxPacketSteps = Math.max(metrics.maxPacketSteps, records.length);
            metrics.maxPacketBytes = Math.max(metrics.maxPacketBytes, new TextEncoder().encode(JSON.stringify(encode(records))).length);
          }
          receiver(event);
        };
        const start = performance.now(); let copy;
        try { copy = await operation(); metrics.ms = performance.now() - start; }
        finally { client.worker.onmessage = receiver; }
        await client.pause(); metrics.blockReads = client.snapshot.stats.reads - reads;
        if (metrics.maxPacketSteps > 16) throw new Error('Unbounded transport');
        const checksum = await digest(JSON.stringify(encode(copy.history))); return { copy, metrics, checksum };
      };
      let baselineHash;
      if (compareCapture) {
        const legacy = await measure(async () => {
          const { header, snapshot } = client, builder = DebugSession.recordingBuilder(source, { ...runtime, ...header.limits, maxHistoryBytes: 64 * 1024 * 1024 }, snapshot.count, snapshot.cursor);
          for (let first = 0; first < snapshot.count; first += 16) {
            const response = await client.request({ kind: 'range', first, count: Math.min(16, snapshot.count - first) });
            builder.append(response.records); await recordingYield({});
          }
          return builder.finish();
        });
        baselineHash = legacy.checksum; report.captureBaseline = legacy.metrics; legacy.copy = null;
        const before = state(client.snapshot.state), cursor = client.snapshot.cursor;
        const unchanged = () => { if (client.snapshot.cursor !== cursor || state(client.snapshot.state) !== before || client.snapshot.count !== 50000) throw new Error('Cancelled capture changed the session'); };
        let releasePull, packets = 0;
        const pullAbort = new AbortController();
        const held = client.capture(64 * 1024 * 1024, { signal: pullAbort.signal, onProgress: () => packets++, yieldControl: () => new Promise(resolve => { releasePull = resolve; }) });
        // Attach rejection handling before aborting, then hold the UI consumer.
        const heldResult = held.then(() => false, error => { if (error.name !== 'AbortError') throw error; return true; });
        while (!releasePull) await new Promise(resolve => setTimeout(resolve, 0));
        await new Promise(resolve => setTimeout(resolve, 30));
        if (packets !== 1) throw new Error('Worker sent records without consumer pull');
        pullAbort.abort(); if (!await heldResult) throw new Error('Held transfer ignored cancellation');
        releasePull(); await client.pause(); unchanged();
        const abort = new AbortController(); let cancelled = false;
        try { await client.capture(64 * 1024 * 1024, { signal: abort.signal, onProgress: done => { if (done >= 32) abort.abort(); } }); }
        catch (error) { if (error.name !== 'AbortError') throw error; cancelled = true; }
        if (!cancelled) throw new Error('Capture cancellation ignored'); await client.pause(); unchanged();
        let rejected = false;
        try { await client.capture(1024); } catch { rejected = true; }
        if (!rejected) throw new Error('Budget failure ignored'); await client.pause(); unchanged();
        let replacement;
        try { await client.capture(64 * 1024 * 1024, { onProgress: () => { replacement ??= client.seek(0); } }); throw new Error('Capture replacement ignored'); }
        catch (error) { if (error.name !== 'AbortError') throw error; }
        await replacement; if (client.snapshot.cursor !== 0) throw new Error('Replacement seek lost');
        await client.seek(cursor); unchanged(); report.captureCancellation = { abort: true, backpressure: true, budgetFailure: true, replacement: true, sourcePreserved: true };
      }
      const result = await measure(async () => (await client.capture(64 * 1024 * 1024)).session); captured = result.copy;
      if (captured.maxSteps !== 50000 || captured.maxFrames !== 64 || captured.history.length !== 50000) throw new Error('Capture truncated');
      report.captureMs = result.metrics.ms; report.captureStream = result.metrics;
      if (compareCapture) {
        report.captureExactRecords = baselineHash === result.checksum;
        const blocks = (await journal.open(id)).head.blocks.length;
        if (!report.captureExactRecords || result.metrics.blockReads !== blocks || report.captureBaseline.blockReads <= blocks) throw new Error('Stream records/read count differs');
      }
      await client.closeLive(); client.dispose(); return { count: captured.history.length };
    },

    async portableAndSave() {
      const start = performance.now(), text = await exportHistory(captured, metadata), imported = await importHistory(text);
      report.fileVersion = JSON.parse(text).version; report.fileBytes = new TextEncoder().encode(text).byteLength;
      if (report.fileVersion !== 3 || imported.session.maxSteps !== 50000 || imported.session.maxFrames !== 64) throw new Error('File limits lost');
      for (const target of targets) { imported.session.seek(target); if (state(imported.session.state) !== expected.get(target)) throw new Error('File state differs'); }
      const saved = await library.save(captured, metadata); savedId = saved.id;
      report.blockVersion = (await library.openRecording(saved.id)).manifest.header.version;
      if (report.blockVersion !== 2) throw new Error('Capture version lost');
      report.portableAndSaveMs = performance.now() - start; return report;
    },
    async savedReplay() {
      client = await PagedRecordingClient.open(savedId, { cacheBytes: 16384 });
      if (client.header.limits.maxSteps !== 50000 || client.header.limits.maxFrames !== 64) throw new Error('Saved header limits lost');
      for (const target of [...targets].reverse()) { await client.seek(target); if (state(client.snapshot.state) !== expected.get(target)) throw new Error('Saved state differs'); }
      client.dispose(); return true;
    },
    async verify() {
      const oracle = new DebugSession(source, { ...runtime, maxSteps: 50000, maxFrames: 64 }); let checked = 0;
      const check = () => { if (expected.has(oracle.cursor)) { if (state(oracle.state) !== expected.get(oracle.cursor)) throw new Error('Reference differs'); checked++; } };
      check(); for (let i = 0; i < 50000; i++) { oracle.forward(); check(); if (i % 256 === 0) await new Promise(r => setTimeout(r, 0)); }
      if (checked !== expected.size) throw new Error('Missing reference states');
      return { ...report, exactStates: checked, note: 'Firefox installed / native IndexedDB / application Workers, Vite dev. Timings include RPC, codec and I/O; logical payload, not browser RAM. Independent oracle created after transport checks.' };
    },
    async release() { if (released) return; released = true; try { if (client.isLive) await client.closeLive().catch(() => {}); } finally { client.dispose(); if (savedId) await library.delete(savedId); await journal.delete(id); await journal.close(); await library.close(); captured = null; expected.clear(); } },
  };
}
