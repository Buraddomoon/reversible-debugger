import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { createServer } from 'vite';
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' });
try {
  const { RecordingJournal } = await server.ssrLoadModule('/src/core/recording-journal.ts'), { LiveRecording } = await server.ssrLoadModule('/src/core/live-recording.ts'), { PagedExecutionComparison } = await server.ssrLoadModule('/src/core/paged-comparison.ts');
  const { ExecutionComparison } = await server.ssrLoadModule('/src/core/comparison.ts'), { encode } = await server.ssrLoadModule('/src/core/portable-history.ts'), { examples } = await server.ssrLoadModule('/src/examples.ts');
  const source = id => examples.find(e => e.id === id).source, runtime = { language: 'python', version: '3' }, fast = { yieldControl: async () => new Promise(resolve => setImmediate(resolve)) };
  const scenarios = [
    { name: 'soma 10/15', a: source('python-sum-bug'), b: source('python-sum-fixed') },
    { name: 'aliases 99/2', a: source('python-list-alias-bug'), b: source('python-list-alias-fixed') },
    { name: 'iteração extra', a: 'i = 0\nresult = 0\nwhile i < 90:\n    result += i\n    i += 1', b: 'i = 0\nresult = 0\nwhile i < 91:\n    result += i\n    i += 1' },
  ], results = [];
  for (const scenario of scenarios) {
    const journal = new RecordingJournal(new IDBFactory(), 'streaming');
    try {
      async function make(code, name) {
        const live = await LiveRecording.start(journal, code, runtime, { name, filename: name + '.py' }, { bufferBytes: 16384, cacheBytes: 65536 }); while (live.ledger.canRecord) await live.seek(live.count + 1, fast); await live.close(); return live;
      }
      async function read(live, useCheckpoints = true) {
        const r = await LiveRecording.resume(journal, live.entry.id, { readOnly: true, cacheBytes: 65536, useCheckpoints }, fast);
        return { live: r, reader: { name: live.entry.name, program: r.program, count: r.count, maxFrames: r.source.maxFrames, maxSteps: r.source.maxSteps, get state() { return r.state; }, get cursor() { return r.cursor; }, get stats() { return r.stats; }, readRange: (first, count, job) => r.readRange(first, count, job), seek: (target, job) => r.seek(target, job), cancel: () => r.cancel() } };
      }
      const a = await make(scenario.a, 'A'), b = await make(scenario.b, 'B'), left = await read(a), right = await read(b), begin = performance.now();
      const comparison = await PagedExecutionComparison.prepare(left.reader, right.reader, 4 * 1024 * 1024, fast), prepareMs = performance.now() - begin, measuredMemory = process.memoryUsage();
      const oracle = new ExecutionComparison({ name: 'A', source: scenario.a, ...runtime }, { name: 'B', source: scenario.b, ...runtime }); while (!oracle.ready) oracle.prepareBatch(); assert.deepStrictEqual(comparison.rows, oracle.rows);
      const samples = [];
      for (const target of [0, comparison.firstDifference ?? 0, comparison.rows.length - 1, Math.floor(comparison.rows.length / 2), 0]) {
        const start = performance.now(); await comparison.seekRow(target, fast); const ms = performance.now() - start; oracle.seekRow(target);
        assert.deepStrictEqual(encode(comparison.left.state), encode(oracle.left.state)); assert.deepStrictEqual(encode(comparison.right.state), encode(oracle.right.state)); assert.deepStrictEqual(encode(comparison.snapshot.differences), encode(oracle.differences()));
        samples.push({ target, ms: +ms.toFixed(3), ...comparison.snapshot.stats });
      }
      const without = await read(a, false), checkpointSeeks = [];
      for (const target of [Math.floor(a.count / 4), Math.floor(a.count / 2), Math.floor(a.count * .75)]) {
        await left.live.seek(0, fast); await without.live.seek(0, fast); await left.live.seek(target, fast); await without.live.seek(target, fast); assert.deepStrictEqual(encode(left.live.state), encode(without.live.state));
        checkpointSeeks.push({ target, withCheckpoints: left.live.ledger.navigation, withoutCheckpoints: without.live.ledger.navigation });
      }
      results.push({ name: scenario.name, steps: [a.count, b.count], rows: comparison.rows.length, firstDifference: comparison.firstDifference, prepareMs: +prepareMs.toFixed(3), indexBytes: comparison.snapshot.stats.indexBytes, indexLimit: comparison.snapshot.stats.indexLimit, heapUsedAfterPrepare: measuredMemory.heapUsed, rssAfterPrepare: measuredMemory.rss, checkpointSeeks, samples });
    } finally { await journal.close(); }
  }
  const report = JSON.stringify({ node: process.version, cacheBytesPerSide: 65536, note: 'Diagnóstico local com fake-indexeddb. Comparador paginado mantém metadados e leitores limitados; o comparador integral é usado somente como oráculo do benchmark, após medir preparação. Índice/reservas são payload estimado, não RAM. Heap/RSS são uma amostra do processo inteiro com Vite/banco emulado e não um pico isolado. Sem aumento dos limites de execução.', results }, null, 2) + '\n';
  const i = process.argv.indexOf('--output'); if (i !== -1) { const output = process.argv[i + 1]; await mkdir(dirname(output), { recursive: true }); await writeFile(output, report); } console.log(report);
} finally { await server.close(); }
