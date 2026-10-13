import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' });
try {
  const { DebugSession, HistoryBudgetError } = await server.ssrLoadModule('/src/core/debugger.ts');
  const source = `a = [${Array.from({ length: 2000 }, () => '0').join(',')}]\nb = a\ni = 0\nwhile i < 500:\n    b[i % 2000] = i\n    i += 1\nresult = a[0]`;
  const session = new DebugSession(source, { language: 'python', maxHistoryBytes: 2 * 1024 * 1024 });
  while (session.canForward) { try { session.runBatch(256); } catch (error) { if (!(error instanceof HistoryBudgetError)) throw error; } }
  assert.ok(session.recordingStop); assert.deepEqual(session.historyStats.checkpointCursors, [0]);
  const frontier = session.cursor, retained = session.storageStats;
  let seed = 20261014;
  const targets = [0, frontier, ...Array.from({ length: 18 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % (frontier + 1); })];
  const oracle = new DebugSession(source, { language: 'python', checkpointInterval: Number.MAX_SAFE_INTEGER });
  const wanted = new Set(targets), snapshots = new Map([[0, structuredClone(oracle.state)]]);
  while (oracle.canForward) { oracle.forward(); if (wanted.has(oracle.cursor)) snapshots.set(oracle.cursor, structuredClone(oracle.state)); }
  const syncTimes = [], batchTimes = [], wallTimes = [], checkpointTimes = [];
  session.seek(frontier);
  for (const target of targets) {
    const begin = performance.now(); session.seek(target); syncTimes.push(performance.now() - begin);
    assert.deepStrictEqual(structuredClone(session.state), snapshots.get(target));
  }
  session.seek(frontier);
  let heartbeats = 0, yields = 0;
  const heartbeat = setInterval(() => heartbeats++, 0);
  try {
    for (const target of targets) {
      const start = performance.now(), begin = performance.now(); let progress = session.beginSeek(target);
      checkpointTimes.push(performance.now() - begin);
      while (!progress.done) {
        const batchStart = performance.now(), previous = progress.appliedSteps;
        progress = session.seekBatch(progress.id, 128, 6);
        batchTimes.push(performance.now() - batchStart);
        assert.ok(progress.appliedSteps - previous <= 128);
        if (!progress.done) { yields++; await new Promise(resolve => setTimeout(resolve, 0)); }
      }
      wallTimes.push(performance.now() - start);
      assert.deepStrictEqual(structuredClone(session.state), snapshots.get(target));
      assert.deepStrictEqual(session.storageStats, retained);
    }
  } finally { clearInterval(heartbeat); }
  assert.ok(heartbeats > 0); assert.ok(yields > 0);
  const stats = values => { const sorted = [...values].sort((a, b) => a - b); return { p95Ms: +sorted[Math.floor(sorted.length * .95)].toFixed(3), maxMs: +sorted.at(-1).toFixed(3), samples: sorted.length }; };
  const report = JSON.stringify({ date: new Date().toISOString(), node: process.version, seed: 20261014, frontier, targets: targets.length, budgetBytes: retained.limitBytes, checkpoints: session.historyStats.checkpointCursors, sync: stats(syncTimes), batches: stats(batchTimes), initialCheckpoint: stats(checkpointTimes), cooperativeWall: stats(wallTimes), yields, heartbeats, note: '20 destinos completos comparados com execução independente; snapshots somente nos destinos. Sem DOM/RAM. Lotes visam 6 ms e 128 transações, mas cópia de checkpoint/transação individual são indivisíveis; timers acrescentam latência total. Asserções finais fora dos tempos de restauração.' }, null, 2) + '\n';
  const output = process.argv.indexOf('--output'); if (output !== -1) await writeFile(process.argv[output + 1], report);
  console.log(report);
} finally { await server.close(); }
