import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' });
try {
  const { DebugSession } = await server.ssrLoadModule('/src/core/debugger.ts');
  const { exportHistory, importHistory } = await server.ssrLoadModule('/src/core/portable-history.ts');
  const reports = [];
  const monitor = () => {
    let previous = performance.now(), maximum = 0;
    const tick = () => { const now = performance.now(); maximum = Math.max(maximum, now - previous - 5); previous = now; };
    const timer = setInterval(tick, 5);
    return () => { tick(); clearInterval(timer); return +Math.max(0, maximum).toFixed(2); };
  };
  for (const locals of [0, 2500]) {
    const source = Array.from({ length: locals }, (_, i) => `v${i} = ${i}`).join('\n') + `\ni = 0\nresult = 0\nwhile i < ${locals ? 1000 : 1500}:\n    result += i\n    i += 1\nprint(result)`;
    const session = new DebugSession(source, { language: 'python' });
    while (session.canForward) session.runBatch(256);
    session.seek(Math.floor(session.history.length / 2));
    const original = structuredClone(session.state);
    let lastYield = performance.now(), maxGap = 0;
    const job = { yieldControl: async () => { const now = performance.now(); maxGap = Math.max(maxGap, now - lastYield); await new Promise(resolve => setTimeout(resolve, 0)); lastYield = performance.now(); } };
    const exportMonitor = monitor(), begin = performance.now();
    const content = await exportHistory(session, { name: 'Benchmark', filename: 'benchmark.py' }, job);
    maxGap = Math.max(maxGap, performance.now() - lastYield);
    const exportMs = performance.now() - begin, exportMaxYieldGapMs = maxGap, exportMaxTimerDelayMs = exportMonitor();
    maxGap = 0; lastYield = performance.now();
    const importMonitor = monitor(), importStart = performance.now(), imported = await importHistory(content, job);
    maxGap = Math.max(maxGap, performance.now() - lastYield);
    const importMs = performance.now() - importStart, importMaxTimerDelayMs = importMonitor();
    assert.deepStrictEqual(structuredClone(imported.session.state), original);
    assert.equal(imported.session.cursor, session.cursor); assert.equal(imported.session.history.length, session.history.length);
    imported.session.seek(0); imported.session.seek(session.history.length);
    session.seek(session.history.length);
    assert.deepStrictEqual(structuredClone(imported.session.state), structuredClone(session.state));
    const forkStart = performance.now(); imported.session.forkRecording(0); const forkMs = performance.now() - forkStart;
    reports.push({ locals: locals + 2, steps: session.history.length, fileBytes: new TextEncoder().encode(content).byteLength, exportMs: +exportMs.toFixed(2), exportMaxYieldGapMs: +exportMaxYieldGapMs.toFixed(2), exportMaxTimerDelayMs, importMs: +importMs.toFixed(2), importMaxYieldGapMs: +maxGap.toFixed(2), importMaxTimerDelayMs, forkMs: +forkMs.toFixed(2), checkpointCount: imported.session.historyStats.checkpointCursors.length });
  }
  const report = JSON.stringify({ date: new Date().toISOString(), node: process.version, note: 'Diagnóstico local, duas fontes, sem DOM. Gaps incluem digest/compilação/parse e espera assíncrona; não são medidas isoladas de CPU. Payload UTF-8 não mede heap. Restauração e replay comparados com a sessão original.', reports }, null, 2) + '\n';
  const outputIndex = process.argv.indexOf('--output'); if (outputIndex !== -1) await writeFile(process.argv[outputIndex + 1], report);
  console.log(report);
} finally { await server.close(); }
