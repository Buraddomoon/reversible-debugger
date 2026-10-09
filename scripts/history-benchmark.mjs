import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';

// Reuse the project's TypeScript loader without installing a runner or a browser.
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' });
try {
  const { DebugSession } = await server.ssrLoadModule('/src/core/debugger.ts');
  const { encodedBytes } = await server.ssrLoadModule('/src/core/history.ts');
  const cases = [
    { name: 'loop Python, 2 locais', source: 'i = 0\nresult = 0\nwhile i < 200:\n    result += i\n    i += 1', language: 'python' },
    { name: 'loop Python, 252 locais', source: Array.from({ length: 250 }, (_, i) => `v${i} = ${i}`).join('\n') + '\ni = 0\nresult = 0\nwhile i < 200:\n    result += i\n    i += 1', language: 'python' },
    { name: 'loop longo Python, 2 locais', source: 'i = 0\nresult = 0\nwhile i < 1500:\n    result += i\n    i += 1', language: 'python' },
    { name: 'recursão Python + saída', source: (await readFile(new URL('../examples/python-factorial.py', import.meta.url), 'utf8')).replace('factorial(5)', 'factorial(25)') + '\nprint(result)', language: 'python' },
  ];
  const reports = [];
  const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];
  for (const scenario of cases) {
    const oracle = new DebugSession(scenario.source, { language: scenario.language, checkpointInterval: Number.MAX_SAFE_INTEGER });
    const snapshots = [structuredClone(oracle.state)];
    const snapshotStart = performance.now();
    while (oracle.canForward) { oracle.forward(); snapshots.push(structuredClone(oracle.state)); }
    const snapshotRecordMs = performance.now() - snapshotStart;
    const snapshotBytes = encodedBytes(snapshots);
    let seed = 20261009;
    const targets = Array.from({ length: 200 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % snapshots.length;
    });
    const snapshotLatency = targets.map(target => {
      const begin = performance.now(); const restored = structuredClone(snapshots[target]);
      const elapsed = performance.now() - begin;
      assert.deepStrictEqual(restored, snapshots[target]);
      return elapsed;
    });
    const configurations = [
      { mode: 'deltas', interval: Number.MAX_SAFE_INTEGER },
      ...[64, 128, 256].map(interval => ({ mode: `checkpoints ${interval}`, interval })),
    ];
    const variants = [];
    for (const config of configurations) {
      const session = new DebugSession(scenario.source, { language: scenario.language, checkpointInterval: config.interval });
      const start = performance.now();
      while (session.canForward) session.runBatch();
      const recordMs = performance.now() - start;
      // Warm up the seek/replay path, then time seek alone (no oracle/assert work).
      for (const target of targets.slice(0, 20)) session.seek(target);
      const latency = [], transitions = [];
      for (const target of targets) {
        const begin = performance.now();
        const result = session.seek(target);
        latency.push(performance.now() - begin); transitions.push(result.appliedSteps);
        assert.deepStrictEqual(structuredClone(session.state), snapshots[target]);
      }
      const payload = session.measureHistory();
      variants.push({ mode: config.mode, ...payload, checkpointCount: session.historyStats.checkpointCursors.length, recordMs: +recordMs.toFixed(2), seekMedianMs: +percentile(latency, .5).toFixed(3), seekP95Ms: +percentile(latency, .95).toFixed(3), maxReplayedSteps: Math.max(...transitions) });
    }
    reports.push({ name: scenario.name, steps: oracle.history.length, snapshotBytes, snapshotRecordMs: +snapshotRecordMs.toFixed(2), snapshotSeekMedianMs: +percentile(snapshotLatency, .5).toFixed(3), snapshotSeekP95Ms: +percentile(snapshotLatency, .95).toFixed(3), variants });
  }
  const report = JSON.stringify({ node: process.version, platform: process.platform, seed: 20261009, seeks: 200, note: 'Bytes de payload JSON com tags bigint/-0/nonfinite; não medem heap JS. Referência mantém deltas e copia o estado em cada passo; tempos são diagnósticos locais.', reports }, null, 2) + '\n';
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex !== -1) {
    const path = process.argv[outputIndex + 1];
    if (!path) throw new Error('--output requer um caminho de arquivo');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, report);
  }
  console.log(report);
} finally { await server.close(); }
