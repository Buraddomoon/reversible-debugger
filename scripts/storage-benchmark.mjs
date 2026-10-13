import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' });
try {
  const { DebugSession, HistoryBudgetError } = await server.ssrLoadModule('/src/core/debugger.ts');
  const cases = [
    { name: 'Listas e aliases', budget: 2 * 1024 * 1024, source: `a = [${Array.from({ length: 2000 }, () => '0').join(',')}]\nb = a\ni = 0\nwhile i < 500:\n    b[i % 2000] = i\n    i += 1\nresult = a[0]` },
    { name: 'Saída acumulada', budget: 512 * 1024, source: 'n = 10 ** 1000\ni = 0\nwhile i < 700:\n    print(n)\n    i += 1\nresult = i' },
    { name: 'Mil variáveis', budget: 1024 * 1024, source: Array.from({ length: 1000 }, (_, i) => `v${i} = ${i}\n`).join('') + 'i = 0\nwhile i < 1000:\n    i += 1\nresult = i' },
  ];
  const reports = [];
  for (const scenario of cases) {
    const session = new DebugSession(scenario.source, { language: 'python', maxHistoryBytes: scenario.budget });
    const recording = performance.now(), batches = [];
    while (session.canForward) {
      const begin = performance.now();
      try { session.runBatch(256); } catch (error) { if (!(error instanceof HistoryBudgetError)) throw error; }
      batches.push(performance.now() - begin);
    }
    const recordMs = performance.now() - recording;
    assert.ok(session.recordingStop); assert.equal(session.state.control.status, 'running');
    const frontier = session.cursor, payload = session.storageStats, records = [...session.history];
    assert.ok(payload.estimatedBytes <= scenario.budget);
    let seed = 20261013;
    const targets = [0, frontier, ...Array.from({ length: 100 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % (frontier + 1); })];
    const oracle = new DebugSession(scenario.source, { language: 'python', checkpointInterval: Number.MAX_SAFE_INTEGER });
    const wanted = new Set(targets), snapshots = new Map([[0, structuredClone(oracle.state)]]);
    while (oracle.canForward) { oracle.forward(); if (wanted.has(oracle.cursor)) snapshots.set(oracle.cursor, structuredClone(oracle.state)); }
    const times = [];
    for (const cursor of targets) {
      const begin = performance.now(); session.seek(cursor); times.push(performance.now() - begin);
      assert.deepStrictEqual(structuredClone(session.state), snapshots.get(cursor));
      assert.deepStrictEqual(session.storageStats, payload);
    }
    session.seek(frontier); session.setHistoryBudget(64 * 1024 * 1024);
    const resumeStart = performance.now(); while (session.canForward) session.runBatch(256); const resumeMs = performance.now() - resumeStart;
    assert.deepStrictEqual(structuredClone(session.state), structuredClone(oracle.state));
    assert.equal(session.history.length, oracle.history.length);
    assert.ok(records.every((step, i) => session.history[i] === step));
    times.sort((a, b) => a - b); batches.sort((a, b) => a - b);
    reports.push({ name: scenario.name, stoppedAt: frontier, fullSteps: oracle.history.length, budgetBytes: scenario.budget, retained: payload, recordMs: +recordMs.toFixed(2), batchP95Ms: +batches[Math.floor(batches.length * .95)].toFixed(3), seekP95Ms: +times[Math.floor(times.length * .95)].toFixed(3), resumeMs: +resumeMs.toFixed(2), recordedPeak: session.storageStats.reservedMachineBytes });
  }
  const report = JSON.stringify({ date: new Date().toISOString(), node: process.version, seed: 20261013, note: 'Payload UTF-8 estimado por sessão, não heap JavaScript. 102 saltos restaurados contra execução independente; snapshots somente nos destinos selecionados. Pausa preservou estado/controle e aumento do limite completou os mesmos registros. Medição local sem DOM; custo de asserções fora dos tempos de seek.', reports }, null, 2) + '\n';
  const output = process.argv.indexOf('--output'); if (output !== -1) await writeFile(process.argv[output + 1], report);
  console.log(report);
} finally { await server.close(); }
