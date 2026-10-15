import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createServer } from 'vite';
import { IDBFactory } from 'fake-indexeddb';

// Project-local TypeScript loader and in-memory IndexedDB; no installs or browser downloads.
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' });
try {
  const { RecordingJournal } = await server.ssrLoadModule('/src/core/recording-journal.ts');
  const { LiveRecording } = await server.ssrLoadModule('/src/core/live-recording.ts');
  const { encode } = await server.ssrLoadModule('/src/core/portable-history.ts');
  const { DebugSession } = await server.ssrLoadModule('/src/core/debugger.ts');
  const runtime = { language: 'python', version: '3' }, details = { name: 'Benchmark', filename: 'benchmark.py' };
  const scenarios = [
    { name: 'loop escalar', source: 'i = 0\nresult = 0\nwhile i < 160:\n    result += i\n    i += 1' },
    { name: '202 locais', source: Array.from({ length: 200 }, (_, i) => `v${i} = ${i}`).join('\n') + '\ni = 0\nwhile i < 90:\n    i += 1' },
    { name: 'heap compartilhado e saída', source: 'a = [0]\nb = a\ni = 0\nwhile i < 120:\n    b[0] = i\n    a.append(i)\n    print(i)\n    i += 1' },
    { name: 'recursão e erro reversível', source: 'def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)\na = [fact(9)]\na.append(a)\nprint(a)\nresult = a[99]' },
  ];
  const results = [];
  for (const scenario of scenarios) {
    const journal = new RecordingJournal(new IDBFactory(), 'benchmark');
    try {
      const live = await LiveRecording.start(journal, scenario.source, runtime, details, { bufferBytes: 16384, cacheBytes: 8192 });
      let logicalPeak = 0, bufferPeak = 0, heapUsedPeak = process.memoryUsage().heapUsed, rssPeak = process.memoryUsage().rss, yields = 0, oldPrefix = null;
      const sample = () => { const m = process.memoryUsage(); heapUsedPeak = Math.max(heapUsedPeak, m.heapUsed); rssPeak = Math.max(rssPeak, m.rss); logicalPeak = Math.max(logicalPeak, live.stats.estimatedBytes); bufferPeak = Math.max(bufferPeak, live.ledger.pendingBytes); };
      const job = { yieldControl: async () => { yields++; sample(); await new Promise(resolve => setImmediate(resolve)); } };
      const begin = performance.now();
      while (live.ledger.canRecord) {
        await live.seek(live.count + 1, job);
        if (live.count % 16 === 0) sample();
        if (live.count === 512) { await live.flush(); oldPrefix = (await journal.validation.read(await journal.open(live.entry.id))).prefix; }
      }
      sample(); await live.close(); const recordMs = performance.now() - begin, final = structuredClone(live.state), count = live.count;
      const timedResume = async options => { const start = performance.now(), resumed = await LiveRecording.resume(journal, live.entry.id, { cacheBytes: 8192, ...options }, job), ms = performance.now() - start; assert.deepStrictEqual(encode(resumed.state), encode(final)); const validation = resumed.ledger.validation; await resumed.close(); return { ms: +ms.toFixed(3), ...validation }; };
      await journal.validation.delete(live.entry.id);
      const cold = await timedResume({}), warm = await timedResume({});
      assert.equal(cold.checkedSteps, count); assert.equal(warm.reusedSteps, count); assert.equal(warm.checkedSteps, 0); assert.equal(warm.blockReads, 0);
      let suffix = null;
      if (oldPrefix && oldPrefix.frontier < count) { await journal.validation.delete(live.entry.id); await journal.validation.publish(oldPrefix); suffix = await timedResume({}); assert.equal(suffix.reusedSteps, 512); assert.equal(suffix.checkedSteps, count - 512); }
      const oracle = new DebugSession(scenario.source, runtime); while (oracle.canForward) oracle.forward(); assert.deepStrictEqual(encode(final), encode(oracle.state)); assert.equal(count, oracle.history.length);
      const viewed = await LiveRecording.resume(journal, live.entry.id, { cacheBytes: 8192 }, job), seeks = [];
      for (const target of [0, Math.floor(count / 2), count, 1, count - 1, 0]) { const start = performance.now(); await viewed.seek(target, job); const ms = performance.now() - start; oracle.seek(target); assert.deepStrictEqual(encode(viewed.state), encode(oracle.state)); seeks.push({ target, ms: +ms.toFixed(3), cacheBytes: viewed.stats.bytes }); assert.ok(viewed.stats.bytes <= 8192); }
      await viewed.close();
      results.push({ name: scenario.name, steps: count, blocks: live.ledger.blocks, diskBytes: live.ledger.diskBytes, recordMs: +recordMs.toFixed(3), logicalPeak, bufferPeak, heapUsedPeakSampled: heapUsedPeak, rssPeakSampled: rssPeak, yields, cold, warm, suffix, seeks });
    } finally { await journal.close(); }
  }
  const report = JSON.stringify({ node: process.version, platform: process.platform, bufferBytes: 16384, cacheBytes: 8192, note: 'Diagnóstico local com fake-indexeddb; não mede disco real. Tempos incluem codec/checksums/validação. Picos de heap/RSS são amostras do processo inteiro, incluindo Vite, emulação do banco e efeitos de GC; não são picos isolados da VM. logicalPeak mede payload reservado, não RAM. Oráculos criados após medir gravação/retomadas. Limites de 20.000 passos/256 frames mantidos.', results }, null, 2) + '\n';
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex !== -1) { const output = process.argv[outputIndex + 1]; await mkdir(dirname(output), { recursive: true }); await writeFile(output, report); }
  console.log(report);
} finally { await server.close(); }
