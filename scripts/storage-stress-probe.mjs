import { stressFixtures, stressRuntime } from '/scripts/stress-fixtures.ts';
import { PagedRecordingClient } from '/src/ui/paged-client.ts';
import { DebugSession } from '/src/core/debugger.ts';
import { RecordingJournal } from '/src/core/recording-journal.ts';
import { encodedBytes } from '/src/core/storage-accounting.ts';
import { encode } from '/src/core/portable-history.ts';

export async function createStressProbe(id) {
  const fixture = stressFixtures.find(f => f.id === id), options = { cacheBytes: 1024, bufferBytes: 32768 };
  let client = await PagedRecordingClient.startLive(fixture.source, stressRuntime, { name: `Estresse · ${fixture.name}`, filename: `${id}.py` }, options);
  const recordingId = client.header.entry.id, journal = new RecordingJournal(), states = new Map();
  const report = { id, name: fixture.name, recordingId, record: { batches: 0, maxRpcMs: 0, maxPayloadBytes: 0, maxPendingBytes: 0, maxFrames: 0 }, seeks: [], resumes: [] };
  const state = () => JSON.stringify(encode(client.snapshot.state));
  const remember = () => states.set(client.snapshot.cursor, state());
  const healthy = () => {
    const s = client.snapshot;
    if (s.debug?.error || s.recording.pauseReason) throw new Error(s.debug?.error ?? s.recording.pauseReason);
    if (s.stats.bytes > 1024 || s.stats.estimatedBytes > s.stats.limitTotalBytes) throw new Error('Cache/payload budget exceeded');
  };
  let released = false;
  return {
    report,
    async recordChunk() {
      for (let i = 0; i < 16 && client.snapshot.recording.canRecord; i++) {
        const start = performance.now(); await client.control('continue'); const ms = performance.now() - start; healthy();
        report.record.batches++; report.record.maxRpcMs = Math.max(ms, report.record.maxRpcMs);
        report.record.maxPayloadBytes = Math.max(client.snapshot.stats.estimatedBytes, report.record.maxPayloadBytes);
        report.record.maxPendingBytes = Math.max(client.snapshot.recording.pendingBytes, report.record.maxPendingBytes);
        report.record.maxFrames = Math.max(client.snapshot.state.frames.length, report.record.maxFrames);
      }
      return !client.snapshot.recording.canRecord;
    },
    async inspect() {
      await client.flush(); healthy();
      if (client.snapshot.state.control.status !== 'halted') throw new Error('Program did not complete');
      const disk = await journal.open(recordingId), points = await journal.checkpoints.list(disk);
      report.steps = client.snapshot.count; report.diskBytes = disk.entry.bytes; report.blocks = disk.head.blocks.length;
      report.maxBlockBytes = Math.max(...disk.head.blocks.map(b => b.bytes));
      report.oversizedBlocks = disk.head.blocks.filter(b => b.bytes > 262144).map(b => ({ first: b.first, count: b.count, bytes: b.bytes }));
      if (report.oversizedBlocks.some(b => b.count !== 1)) throw new Error('Indivisible delta split or mixed');
      report.checkpoints = { count: points.length, bytes: points.reduce((n, p) => n + p.bytes, 0), maxBytes: Math.max(0, ...points.map(p => p.bytes)) };
      if (report.checkpoints.bytes > 8388608) throw new Error('Checkpoint quota exceeded');
      if (fixture.oversizedOp && report.oversizedBlocks.length === 0) throw new Error('Missing large transaction');
      if (!fixture.oversizedOp && points.length >= disk.head.blocks.length / 2) throw new Error('Checkpoint pressure did not cause thinning');
      remember(); return report;
    },
    async seekSamples() {
      const count = report.steps, critical = report.oversizedBlocks[0]?.first;
      const targets = [0, count, Math.floor(count / 2), 1, count - 1, ...(critical === undefined ? [] : [critical, critical + 1, critical, critical + 1]), 0, count];
      for (const target of targets) {
        const start = performance.now(); await client.seek(target); const ms = performance.now() - start; healthy(); remember();
        report.seeks.push({ target, ms, cacheBytes: client.snapshot.stats.bytes, isolatedReads: client.snapshot.stats.largeBlocks });
      }
      // Precisely cancel a private seek with a large prepared state before ACK,
      // then abort after ACK. The published destination must follow acceptance.
      const target = critical === undefined ? Math.floor(count / 2) : critical + 1;
      const previous = state(), previousCursor = client.snapshot.cursor, receiver = client.worker.onmessage;
      const pre = new AbortController(); let armed = true;
      client.worker.onmessage = e => { if (armed && e.data.kind === 'prepared') { armed = false; pre.abort(); } receiver(e); };
      try { await client.seek(target, { signal: pre.signal }); throw new Error('Pre-ACK abort accepted'); }
      catch (error) { if (error.name !== 'AbortError') throw error; } finally { client.worker.onmessage = receiver; }
      if (client.snapshot.cursor !== previousCursor || state() !== previous) throw new Error('Cancelled seek published');
      const post = new AbortController(); armed = true;
      client.worker.onmessage = e => { receiver(e); if (armed && e.data.kind === 'prepared') { armed = false; post.abort(); } };
      try { await client.seek(target, { signal: post.signal }); } finally { client.worker.onmessage = receiver; }
      if (client.snapshot.cursor !== target) throw new Error('Accepted seek lost');
      remember(); report.preAckPreserved = true; report.postAckCompleted = true;
      await client.seek(count); remember(); return report.seeks;
    },
    async resumeRound(round) {
      const expected = state(), samples = {};
      for (const [name, validateAll] of [['fullValidationNewWorker', true], ['prefixReuseNewWorker', false]]) {
        await client.closeLive(); client.dispose();
        const begin = performance.now(); client = await PagedRecordingClient.resumeLive(recordingId, { ...options, validateAll });
        const ms = performance.now() - begin; healthy();
        if (state() !== expected || client.snapshot.count !== report.steps) throw new Error('Resume state mismatch');
        const validation = client.snapshot.recording.validation;
        if (validateAll ? validation.checkedSteps !== report.steps : validation.reusedSteps !== report.steps || validation.checkedSteps !== 0) throw new Error('Wrong validation policy');
        samples[name] = { ms, ...validation };
      }
      report.resumes.push({ round, ...samples }); return report.resumes.at(-1);
    },
    async verify() {
      // No reference trace retained in measured recording/replay/resume phases.
      const oracle = new DebugSession(fixture.source, { ...stressRuntime, maxHistoryBytes: 64 * 1024 * 1024 });
      let checked = 0, maxStepBytes = 0;
      const check = () => { if (states.has(oracle.cursor)) { if (JSON.stringify(encode(oracle.state)) !== states.get(oracle.cursor)) throw new Error('Full state differs at ' + oracle.cursor); checked++; } };
      check(); while (oracle.canForward) { const step = oracle.forward(); maxStepBytes = Math.max(maxStepBytes, encodedBytes(step)); check(); if (oracle.cursor % 64 === 0) await new Promise(r => setTimeout(r, 0)); }
      if (checked !== states.size || oracle.cursor !== report.steps) throw new Error('Incomplete reference');
      report.validation = { states: checked, maxStepBytes, fullStateExact: true }; return report.validation;
    },
    async release() { if (released) return; released = true; try { await client.closeLive(); } finally { client.dispose(); await journal.close(); states.clear(); } },
  };
}
