import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RecordingJournal } from '../src/core/recording-journal';
import { LiveRecording } from '../src/core/live-recording';
import { PagedExecutionComparison, type ComparisonReader } from '../src/core/paged-comparison';
import { ExecutionComparison } from '../src/core/comparison';
import { examples } from '../src/examples';
import * as machine from '../src/core/machine';
const runtime = { language: 'python', version: '3' } as const, fast = { yieldControl: async () => {} };
const resources: RecordingJournal[] = [];
async function fixture(a: string, b: string, limit = 20_000) {
  const journal = new RecordingJournal(new IDBFactory(), 'comparison'); resources.push(journal);
  async function create(source: string, name: string) {
    const live = await LiveRecording.start(journal, source, runtime, { name, filename: name + '.py' }, { maxSteps: limit }, fast);
    while (live.ledger.canRecord) await live.seek(live.count + 1, fast); await live.close();
    const replay = await LiveRecording.resume(journal, live.entry.id, { readOnly: true, cacheBytes: 4096 }, fast);
    const reader: ComparisonReader = { name, program: replay.program, count: replay.count, maxSteps: replay.source.maxSteps, maxFrames: replay.source.maxFrames, get state() { return replay.state; }, get cursor() { return replay.cursor; }, get stats() { return replay.stats; }, readRange: (first, count, job) => replay.readRange(first, count, job), seek: (target, job) => replay.seek(target, job), cancel: () => replay.cancel() };
    return { reader, live };
  }
  const left = await create(a, 'A'), right = await create(b, 'B'); return { journal, left, right };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(resources.splice(0).map(r => r.close())); });
describe('comparação paginada de gravações', () => {
  for (const ids of [['python-sum-bug', 'python-sum-fixed'], ['python-list-alias-bug', 'python-list-alias-fixed']] as const) it(`equivale ao alinhamento integral em todos os pontos: ${ids[0]}`, async () => {
    const a = examples.find(e => e.id === ids[0])!.source, b = examples.find(e => e.id === ids[1])!.source, { left, right } = await fixture(a, b);
    const oracle = new ExecutionComparison({ name: 'A', source: a, ...runtime }, { name: 'B', source: b, ...runtime }); while (!oracle.ready) oracle.prepareBatch();
    const execute = vi.spyOn(machine, 'executeInstruction'), comparison = await PagedExecutionComparison.prepare(left.reader, right.reader, 4 * 1024 * 1024, fast);
    expect(comparison.rows).toEqual(oracle.rows); expect(comparison.firstDifference).toBe(oracle.firstDifference);
    for (const row of [...comparison.rows.keys(), ...comparison.rows.keys()].reverse()) { await comparison.seekRow(row, fast); oracle.seekRow(row); expect(comparison.left.state).toEqual(oracle.left.state); expect(comparison.right.state).toEqual(oracle.right.state); expect(comparison.snapshot.differences).toEqual(oracle.differences()); }
    expect(execute).not.toHaveBeenCalled(); expect(comparison.left.history).toEqual({ length: left.live.count }); expect(Array.isArray(comparison.left.history)).toBe(false);
  });
  it('mantém o par anterior quando o segundo leitor falha ou a confirmação é cancelada', async () => {
    const { left, right } = await fixture('result = 40 + 2', 'result = 40 + 3'), comparison = await PagedExecutionComparison.prepare(left.reader, right.reader, 1024 * 1024, fast), initial = structuredClone(comparison.snapshot), seek = vi.spyOn(right.reader, 'seek').mockRejectedValue(new Error('Leitura falhou'));
    await expect(comparison.seekRow(comparison.rows.length - 1, fast)).rejects.toThrow('Leitura falhou'); expect(comparison.cursor).toBe(0); expect(comparison.snapshot.left).toEqual(initial.left); expect(comparison.snapshot.right).toEqual(initial.right); seek.mockRestore();
    const abort = new AbortController(); await expect(comparison.seekRow(comparison.rows.length - 1, { ...fast, signal: abort.signal, beforePublish: async () => abort.abort() })).rejects.toThrow(); expect(comparison.cursor).toBe(0); expect(comparison.snapshot.left).toEqual(initial.left); expect(comparison.snapshot.right).toEqual(initial.right); await comparison.seekRow(1, fast); expect(comparison.cursor).toBe(1);
  });
  for (const limit of [50, 20_000]) it(`recursão, ciclos e erro/parcial conservam a semântica: limite ${limit}`, async () => {
    const source = 'def f(n):\n    if n <= 1:\n        return 1\n    return n * f(n - 1)\na = [f(5)]\na.append(a)\nprint(a)\nresult = a[99]', { left, right } = await fixture(source, source, limit), comparison = await PagedExecutionComparison.prepare(left.reader, right.reader, 1024 * 1024, fast);
    expect(comparison.firstDifference).toBeNull(); expect(comparison.left.points.at(-1)?.phase).toBe(limit === 50 ? 'limit' : 'error'); await comparison.seekRow(comparison.rows.length - 1, fast); expect(comparison.left.state).toEqual(comparison.right.state); expect(comparison.snapshot.differences).toEqual([]);
  });
  it('leitores independentes não assumem nem alteram o escritor original', async () => {
    const journal = new RecordingJournal(new IDBFactory(), 'writer'); resources.push(journal); const live = await LiveRecording.start(journal, 'result = 40 + 2', runtime, { name: 'A', filename: 'a.py' }, {}, fast); await live.seek(1, fast); await live.flush();
    const before = await journal.open(live.entry.id), reader = await LiveRecording.resume(journal, live.entry.id, { readOnly: true }, fast); await reader.seek(0, fast); await reader.close();
    expect((await journal.open(live.entry.id)).entry).toEqual(before.entry); expect(live.cursor).toBe(1); await expect(reader.seek(reader.count + 1, fast)).rejects.toThrow(); await live.seek(2, fast); expect(live.count).toBe(2);
  });
  it('cancela preparação e recusa excesso de metadados sem modificar fontes', async () => {
    const source = 'i = 0\nwhile i < 60:\n    i += 1', { left, right, journal } = await fixture(source, source), abort = new AbortController();
    await expect(PagedExecutionComparison.prepare(left.reader, right.reader, 64 * 1024, { ...fast, signal: abort.signal, onStage: () => abort.abort() })).rejects.toThrow();
    await expect(PagedExecutionComparison.prepare(left.reader, right.reader, 64 * 1024, fast)).rejects.toThrow('orçamento'); expect((await journal.open(left.live.entry.id)).head.frontier).toBe(left.live.count);
  });
});
