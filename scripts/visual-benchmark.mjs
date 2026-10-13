import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' });
try {
  const { DebugSession } = await server.ssrLoadModule('/src/core/debugger.ts');
  const { explainStep, summarizeNavigation } = await server.ssrLoadModule('/src/core/explanations.ts');
  const { HistoryEventIndex, historyEvent } = await server.ssrLoadModule('/src/core/history-events.ts');
  const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];
  const timings = values => ({ medianMs: +percentile(values, .5).toFixed(3), p95Ms: +percentile(values, .95).toFixed(3), maxMs: +Math.max(...values).toFixed(3) });
  const measure = (count, fn) => {
    for (let i = 0; i < 10; i++) fn(i);
    return timings(Array.from({ length: count }, (_, i) => { const start = performance.now(); fn(i); return performance.now() - start; }));
  };
  const reports = [];
  for (const locals of [0, 2500]) {
    const source = Array.from({ length: locals }, (_, i) => `v${i} = ${i}`).join('\n') + `\ni = 0\nresult = 0\nwhile i < ${locals ? 1000 : 1500}:\n    result += i\n    i += 1`;
    const session = new DebugSession(source, { language: 'python' });
    const initial = structuredClone(session.state), batches = [];
    while (session.canForward) {
      const start = performance.now(); session.runBatch(256); batches.push(performance.now() - start);
    }
    const final = structuredClone(session.state);
    const history = session.history;
    const lastLoad = history.findLastIndex(step => step.op === 'LOAD');
    const lastDecision = history.findLastIndex(step => step.op === 'JUMP_IF_FALSE');
    const read = measure(100, () => explainStep(session.program, history, lastLoad, 'backward'));
    const decision = measure(100, () => explainStep(session.program, history, lastDecision, 'backward'));
    const group = measure(50, () => summarizeNavigation(session.program, history, history.length, 0));
    let seed = 20261013;
    const seeks = measure(100, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; session.seek(seed % (history.length + 1)); });
    const prefix = [], index = new HistoryEventIndex(), incremental = [], rescans = [];
    for (let offset = 0; offset < history.length; offset += 256) {
      prefix.push(...history.slice(offset, offset + 256));
      let start = performance.now(); index.update(prefix); incremental.push(performance.now() - start);
      start = performance.now(); prefix.map((step, i) => historyEvent(step, i + 1)).filter(Boolean); rescans.push(performance.now() - start);
    }
    assert.deepStrictEqual(index.update(prefix), history.map((step, i) => historyEvent(step, i + 1)).filter(Boolean));
    assert.equal(session.history, history);
    session.seek(0); assert.deepStrictEqual(structuredClone(session.state), initial);
    session.seek(history.length); assert.deepStrictEqual(structuredClone(session.state), final);
    const payload = session.measureHistory();
    reports.push({ locals: locals + 2, steps: history.length, recordBatch256: timings(batches), seek: seeks, explainLateRead: read, explainLateDecision: decision, summarizeFullUndo: group, incrementalEventBatch256: timings(incremental), fullEventRescanPerBatch: timings(rescans), ...payload });
  }
  const report = JSON.stringify({ date: new Date().toISOString(), node: process.version, platform: process.platform, seed: 20261013, note: 'Diagnóstico local, sem React/DOM. Warmup de 10 amostras, 100 buscas/explicações, 50 resumos. Gravação e índice usam lotes 256. Bytes de payload com tags especiais; não medem heap. P95 inclui checkpoints adaptativos. Sem executar expressões para explicar/reaplicar.', reports }, null, 2) + '\n';
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex !== -1) {
    const path = process.argv[outputIndex + 1];
    if (!path) throw new Error('--output requer um caminho');
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, report);
  }
  console.log(report);
} finally { await server.close(); }
