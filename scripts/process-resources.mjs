import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const kilobytes = (text, name) => {
  const match = text.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm'));
  return match ? Number(match[1]) * 1024 : null;
};

/** Sample only the isolated Firefox and descendants. Missing measurements stay
 * null; exited/denied processes must never masquerade as zero memory. */
export async function sampleProcessTree(rootPid, read = path => readFile(path, 'utf8')) {
  const visited = new Set();
  const rows = [];
  async function visit(pid) {
    if (visited.has(pid)) return;
    visited.add(pid);
    const [status, rollup, children] = await Promise.allSettled([
      read(`/proc/${pid}/status`), read(`/proc/${pid}/smaps_rollup`), read(`/proc/${pid}/task/${pid}/children`),
    ]);
    rows.push({ pid, rss: status.status === 'fulfilled' ? kilobytes(status.value, 'VmRSS') : null,
      pss: rollup.status === 'fulfilled' ? kilobytes(rollup.value, 'Pss') : null,
      private: rollup.status === 'fulfilled' && kilobytes(rollup.value, 'Private_Clean') !== null && kilobytes(rollup.value, 'Private_Dirty') !== null
        ? kilobytes(rollup.value, 'Private_Clean') + kilobytes(rollup.value, 'Private_Dirty') : null,
      childrenKnown: children.status === 'fulfilled' });
    if (children.status === 'fulfilled') await Promise.all(children.value.trim().split(/\s+/).filter(Boolean).map(Number).map(visit));
  }
  await visit(rootPid);
  const sum = key => rows.every(row => row[key] !== null && row.childrenKnown) ? rows.reduce((n, row) => n + row[key], 0) : null;
  return { processes: rows.length, rssBytes: sum('rss'), pssBytes: sum('pss'), privateBytes: sum('private'),
    missingRss: rows.filter(row => row.rss === null).length, missingPss: rows.filter(row => row.pss === null).length,
    incompleteTree: rows.some(row => !row.childrenKnown) };
}

/** No overlapping scans. Peaks are sampled lower bounds, not allocation peaks. */
export async function measureProcessPhase(pid, action, { intervalMs = 150, supported = process.platform === 'linux', sample = () => sampleProcessTree(pid) } = {}) {
  const start = performance.now(), samples = [];
  let done = false, timer;
  async function scan() {
    const before = performance.now();
    const value = await sample();
    samples.push({ elapsedMs: +(performance.now() - start).toFixed(2), scanMs: +(performance.now() - before).toFixed(2), ...value });
  }
  const loop = async () => {
    while (!done) {
      await new Promise(resolve => { timer = { id: setTimeout(resolve, intervalMs), resolve }; });
      if (!done) await scan();
    }
  };
  if (supported) await scan();
  const running = supported ? loop() : Promise.resolve();
  let value;
  try {
    value = await action();
  } finally {
    done = true;
    if (timer) { clearTimeout(timer.id); timer.resolve(); }
    await running;
    if (supported) await scan();
  }
  return { value, memory: { supported, intervalMs, elapsedMs: +(performance.now() - start).toFixed(2), samples } };
}
