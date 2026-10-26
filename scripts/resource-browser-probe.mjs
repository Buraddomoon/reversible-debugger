// Imported only by the opt-in benchmark, never by the application bundle.
export const workloads = [
  { id: 'numeric', name: 'Loop numérico', source: 'i = 0\nresult = 0\nwhile i < 1450:\n    result += i\n    i += 1' },
  { id: 'heap-output', name: 'Lista compartilhada e saída', source: 'a = [0]\nb = a\ni = 0\nwhile i < 600:\n    b.append(i)\n    print(i)\n    i += 1\nresult = len(a)' },
  { id: 'recursion', name: 'Pilha recursiva', source: 'def total(n):\n    if n <= 0:\n        return 0\n    return n + total(n - 1)\nresult = total(120)' },
  { id: 'locals', name: '1.200 variáveis', source: Array.from({ length: 1200 }, (_, i) => `v${i} = ${i}`).join('\n') + '\nresult = v1199' },
];

const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, medianMs: sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(3) : null,
    p95Ms: sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))].toFixed(3) : null,
    maxMs: sorted.length ? +sorted.at(-1).toFixed(3) : null };
};

export async function createProbe(id) {
  const { PagedRecordingClient } = await import('/src/ui/paged-client.ts');
  const { encode } = await import('/src/core/portable-history.ts');
  const { measureMachine } = await import('/src/core/storage-accounting.ts');
  const workload = workloads.find(w => w.id === id), runtime = { language: 'python', version: '3' };
  const options = { cacheBytes: 65536, bufferBytes: 32768, maxHistoryBytes: 64 * 1024 * 1024 };
  let phase, heartbeat, lastBeat, released = false;
  const NativeWorker = globalThis.Worker;
  const ObservedWorker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => {
        const message = event.data;
        if (phase) {
          phase.messages[message.kind] = (phase.messages[message.kind] ?? 0) + 1;
          if (message.snapshot?.state) {
            phase.fullStateMessages++;
            if (message.kind === 'prepared') phase.preparedFullStateMessages++;
          }
        }
      });
    }
  };
  globalThis.Worker = ObservedWorker;
  let client;
  try { client = await PagedRecordingClient.startLive(workload.source, runtime, { name: `Perfil · ${workload.name}`, filename: `${id}.py` }, options); }
  catch (error) { globalThis.Worker = NativeWorker; throw error; }
  const recordingId = client.header.entry.id, expected = new Map(), phases = [];
  const summary = () => ({ cursor: client.snapshot.cursor, count: client.snapshot.count, stats: client.snapshot.stats,
    ledger: client.snapshot.recording, machinePayload: measureMachine(client.snapshot.state),
    frames: client.snapshot.state.frames.length, locals: client.snapshot.state.frames.reduce((n, f) => n + Object.keys(f.locals).length, 0),
    outputLines: client.snapshot.state.output.length, heapObjects: Object.keys(client.snapshot.state.heap).length });
  const remember = () => { expected.set(client.snapshot.cursor, JSON.stringify(encode(client.snapshot.state))); };
  function begin(name) {
    if (phase) throw new Error('Phase already active');
    phase = { name, begin: performance.now(), latency: [], gaps: [], messages: {}, fullStateMessages: 0, preparedFullStateMessages: 0,
      maxEstimatedBytes: 0, maxCacheBytes: 0, maxFrames: 0, maxPendingBytes: 0, maxIndexBytes: 0 };
    lastBeat = performance.now();
    heartbeat = setInterval(() => { const now = performance.now(); phase?.gaps.push(now - lastBeat); lastBeat = now; }, 20);
  }
  async function timed(action) {
    const start = performance.now(); await action(); phase.latency.push(performance.now() - start);
    const s = client.snapshot;
    if (s.stats.estimatedBytes > options.maxHistoryBytes || s.stats.bytes > options.cacheBytes) throw new Error('Payload budget exceeded');
    phase.maxEstimatedBytes = Math.max(phase.maxEstimatedBytes, s.stats.estimatedBytes);
    phase.maxCacheBytes = Math.max(phase.maxCacheBytes, s.stats.bytes);
    phase.maxIndexBytes = Math.max(phase.maxIndexBytes, s.stats.indexBytes);
    phase.maxPendingBytes = Math.max(phase.maxPendingBytes, s.recording?.pendingBytes ?? 0);
    phase.maxFrames = Math.max(phase.maxFrames, s.state.frames.length);
    if (s.debug?.error || s.recording?.pauseReason) throw new Error(s.debug?.error ?? s.recording.pauseReason);
  }
  function end() {
    clearInterval(heartbeat);
    const { begin: start, latency, gaps, ...rest } = phase;
    const value = { ...rest, elapsedMs: +(performance.now() - start).toFixed(3), rpc: distribution(latency),
      heartbeat20ms: distribution(gaps), final: summary() };
    phases.push(value); phase = null;
    if (value.preparedFullStateMessages) throw new Error('ACK preparation must not transfer full state');
    if (value.fullStateMessages !== value.rpc.samples) throw new Error('Expected one published state per accepted RPC');
    return value;
  }
  return {
    workload, options, recordingId, phases, begin, end,
    async recordChunk() {
      for (let i = 0; i < 24 && client.snapshot.recording.canRecord; i++) await timed(() => client.control('continue'));
      return { done: !client.snapshot.recording.canRecord, count: client.snapshot.count };
    },
    async flush() { await timed(() => client.flush()); remember(); if (client.snapshot.state.control.status !== 'halted') throw new Error('Workload did not complete: ' + client.snapshot.count + ' / ' + client.snapshot.state.control.status); },
    async seeks() {
      const count = client.snapshot.count;
      const targets = [0, count, Math.floor(count * .25), Math.floor(count * .75), 1, Math.floor(count / 2), count - 1, 0, count];
      const samples = [];
      for (const target of targets) { await timed(() => client.seek(target)); remember(); samples.push({ target, navigation: client.snapshot.recording.navigation, reads: client.snapshot.stats.reads, hits: client.snapshot.stats.hits }); }
      return samples;
    },
    async reopen() {
      await timed(() => client.closeLive()); client.dispose();
      await timed(async () => { client = await PagedRecordingClient.resumeLive(recordingId, options); });
      remember();
      return summary();
    },
    async verify() {
      // Oracle is created only after all resource measurements have finished.
      const { DebugSession } = await import('/src/core/debugger.ts');
      const oracle = new DebugSession(workload.source, { ...runtime, maxHistoryBytes: 128 * 1024 * 1024 });
      const wanted = new Set(expected.keys()); let checked = 0;
      const check = () => { if (wanted.has(oracle.cursor)) { if (JSON.stringify(encode(oracle.state)) !== expected.get(oracle.cursor)) throw new Error('Full state differs at ' + oracle.cursor); checked++; } };
      check();
      while (oracle.canForward) { oracle.runBatch(1); check(); if (oracle.cursor % 64 === 0) await new Promise(r => setTimeout(r, 0)); }
      if (checked !== expected.size || oracle.cursor !== client.snapshot.count) throw new Error('Incomplete reference');
      return { states: checked, count: oracle.cursor, fullStateExact: true };
    },
    async release() { if (released) return; released = true; clearInterval(heartbeat); try { await client.closeLive(); } finally { client.dispose(); expected.clear(); if (globalThis.Worker === ObservedWorker) globalThis.Worker = NativeWorker; } },
  };
}
