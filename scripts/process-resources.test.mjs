import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleProcessTree, measureProcessPhase } from './process-resources.mjs';

const fakeProc = missing => async path => {
  const pid = Number(path.split('/')[2]);
  if (missing && path === missing) throw new Error('Process exited or permission denied');
  if (path.endsWith('/children')) return pid === 1 ? '2 3' : '';
  if (path.endsWith('/status')) return `Name:\tfirefox\nVmRSS:\t${pid * 10} kB\n`;
  return `Pss: ${pid * 5} kB\nPrivate_Clean: ${pid} kB\nPrivate_Dirty: ${pid * 2} kB\n`;
};
test('aggregates the dedicated process tree and distinguishes RSS/PSS/private', async () => {
  assert.deepEqual(await sampleProcessTree(1, fakeProc()), { processes: 3, rssBytes: 60 * 1024, pssBytes: 30 * 1024,
    privateBytes: 18 * 1024, missingRss: 0, missingPss: 0, incompleteTree: false });
});
test('a missing PSS measurement stays null while available RSS remains measurable', async () => {
  const value = await sampleProcessTree(1, fakeProc('/proc/2/smaps_rollup'));
  assert.equal(value.pssBytes, null); assert.equal(value.privateBytes, null);
  assert.equal(value.rssBytes, 60 * 1024); assert.equal(value.missingPss, 1);
});
test('an incomplete tree cannot report a complete aggregate', async () => {
  const value = await sampleProcessTree(1, fakeProc('/proc/1/task/1/children'));
  assert.equal(value.rssBytes, null); assert.equal(value.pssBytes, null); assert.equal(value.incompleteTree, true);
});
test('unsupported platforms still execute the action without invented memory samples', async () => {
  const result = await measureProcessPhase(1, async () => 42, { supported: false });
  assert.equal(result.value, 42); assert.equal(result.memory.supported, false); assert.deepEqual(result.memory.samples, []);
});
test('scans do not overlap and the final sample belongs to the measured interval', async () => {
  let active = 0, maxActive = 0;
  const result = await measureProcessPhase(1, async () => { await new Promise(r => setTimeout(r, 12)); return 7; }, {
    supported: true, intervalMs: 1, sample: async () => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise(r => setTimeout(r, 2)); active--;
      return { rssBytes: 1024, pssBytes: 512, privateBytes: 256 };
    },
  });
  assert.equal(result.value, 7); assert.equal(maxActive, 1); assert.equal(active, 0);
  assert.ok(result.memory.samples.length >= 2);
  assert.ok(result.memory.samples.every(s => s.elapsedMs <= result.memory.elapsedMs));
});
