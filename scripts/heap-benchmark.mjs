import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' });
try {
  const { DebugSession } = await server.ssrLoadModule('/src/core/debugger.ts');
  const { encodedBytes } = await server.ssrLoadModule('/src/core/history.ts');
  const reports = [];
  for (const size of [8, 2000]) {
    const source = `a = [${Array.from({ length: size }, () => '0').join(',')}]\nb = a\ni = 0\nwhile i < 500:\n    b[i % ${size}] = i\n    i += 1\nresult = a[0]`;
    const session = new DebugSession(source, { language: 'python' });
    const recording = performance.now(); while (session.canForward) session.runBatch(256); const recordMs = performance.now() - recording;
    const count = session.history.length;
    let seed = 20261013;
    const targets = Array.from({ length: 100 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % (count + 1); });
    const wanted = new Set(targets), oracle = new DebugSession(source, { language: 'python', checkpointInterval: Number.MAX_SAFE_INTEGER }), snapshots = new Map();
    if (wanted.has(0)) snapshots.set(0, structuredClone(oracle.state));
    while (oracle.canForward) { oracle.forward(); if (wanted.has(oracle.cursor)) snapshots.set(oracle.cursor, structuredClone(oracle.state)); }
    const expected = Array.from({ length: size }, () => 0n); for (let i = 0; i < 500; i++) expected[i % size] = BigInt(i);
    assert.deepStrictEqual(session.state.heap[1].items, expected);
    assert.deepStrictEqual(structuredClone(session.state), structuredClone(oracle.state));
    for (const cursor of targets.slice(0, 10)) session.seek(cursor);
    const times = targets.map(cursor => { const start = performance.now(); session.seek(cursor); const ms = performance.now() - start; assert.deepStrictEqual(structuredClone(session.state), snapshots.get(cursor)); return ms; }).sort((a, b) => a - b);
    const mutation = session.history.find(step => step.op === 'LIST_SET').changes.find(change => change.kind === 'heap-splice');
    reports.push({ listItems: size, steps: count, recordMs: +recordMs.toFixed(2), seekMedianMs: +times[50].toFixed(3), seekP95Ms: +times[95].toFixed(3), mutationBytes: encodedBytes(mutation), checkpointCount: session.historyStats.checkpointCursors.length, ...session.measureHistory() });
  }
  assert.equal(reports[0].mutationBytes, reports[1].mutationBytes);
  const report = JSON.stringify({ date: new Date().toISOString(), node: process.version, seed: 20261013, note: 'Diagnóstico local sem DOM. 100 saltos comparados com snapshots de cursores selecionados de uma execução independente. Não cria snapshot a cada passo. Bytes de payload com tags, não heap JS.', reports }, null, 2) + '\n';
  const output = process.argv.indexOf('--output'); if (output !== -1) await writeFile(process.argv[output + 1], report);
  console.log(report);
} finally { await server.close(); }
