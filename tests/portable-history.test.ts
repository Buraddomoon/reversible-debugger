import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { DebugSession, type RecordingJob } from '../src/core/debugger';
import { checkImportBudget, exportHistory, importHistory, MAX_IMPORTED_BYTES, MAX_TRACE_BYTES } from '../src/core/portable-history';
import * as machine from '../src/core/machine';
import * as math from '../src/core/python-values';
import { ExecutionComparison } from '../src/core/comparison';
import { ExecutionControl } from '../src/core/execution-control';

const fast: RecordingJob = { yieldControl: async () => {} };
const details = { name: 'Execução de teste', filename: 'teste.py' };
function record(source: string, language = 'python', maxSteps = 20_000) {
  const session = new DebugSession(source, { language, maxSteps });
  const snapshots = [structuredClone(session.state)];
  while (session.canForward && session.history.length < maxSteps) { session.forward(); snapshots.push(structuredClone(session.state)); }
  return { session, snapshots };
}
async function rewrite(content: string, change: (envelope: any) => void) {
  const envelope = JSON.parse(content); change(envelope);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(envelope.payload)));
  envelope.checksum = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  return JSON.stringify(envelope);
}

describe('históricos portáveis', () => {
  for (const filename of readdirSync(new URL('../examples/', import.meta.url)).filter(name => /\.(rw|py)$/.test(name))) {
    it(`restaura todos os estados de ${filename} nos dois sentidos sem executor`, async () => {
      const { session, snapshots } = record(readFileSync(new URL(`../examples/${filename}`, import.meta.url), 'utf8'), filename.endsWith('.py') ? 'python' : 'rewind');
      session.seek(Math.floor(session.history.length / 2));
      const state = structuredClone(session.state), cursor = session.cursor;
      const exported = await exportHistory(session, { ...details, filename }, fast);
      const execute = vi.spyOn(machine, 'executeInstruction'), binary = vi.spyOn(math, 'pythonBinary'), unary = vi.spyOn(math, 'pythonUnary');
      try {
        const restored = (await importHistory(exported, fast)).session;
        expect(restored.cursor).toBe(cursor); expect(restored.state).toEqual(state); expect(restored.history).toEqual(session.history);
        for (let i = 0; i < snapshots.length; i++) { restored.seek(i); expect(restored.state).toEqual(snapshots[i]); }
        for (let i = snapshots.length - 1; i >= 0; i--) { restored.seek(i); expect(restored.state).toEqual(snapshots[i]); }
        expect(execute).not.toHaveBeenCalled(); expect(binary).not.toHaveBeenCalled(); expect(unary).not.toHaveBeenCalled();
        expect(session.state).toEqual(state); expect(session.cursor).toBe(cursor);
      } finally { execute.mockRestore(); binary.mockRestore(); unary.mockRestore(); }
    });
  }
  it('preserva bigint, -0, NaN, infinitos, None, aliases e nomes __proto__/constructor', async () => {
    const source = 'a = 90071992547409931234567890\nb = -0.0\nc = 1e308 * 1e308\nd = -c\ne = c - c\nf = None\np = print\n__proto__ = a\nconstructor = p\nprint(a, b, e)';
    const { session } = record(source);
    const restored = (await importHistory(await exportHistory(session, details, fast), fast)).session;
    const globals = restored.state.frames[0]!.locals;
    expect(globals.a).toBe(90071992547409931234567890n); expect(Object.is(globals.b, -0)).toBe(true);
    expect(globals.c).toBe(Infinity); expect(globals.d).toBe(-Infinity); expect(globals.e).toBeNaN(); expect(globals.f).toBe(null);
    expect(Object.hasOwn(globals, '__proto__')).toBe(true); expect(globals.__proto__).toBe(globals.a);
    expect(globals.constructor).toEqual({ kind: 'builtin', name: 'print' }); expect(({} as any).a).toBeUndefined();
    expect(restored.state).toEqual(session.state);
  });
  it('mantém o futuro gravado ao exportar de um cursor anterior e reexporta o novo cursor', async () => {
    const { session } = record('x = 1\nresult = x + 2\nprint(result)'); session.seek(2);
    const first = await importHistory(await exportHistory(session, details, fast), fast);
    expect(first.session.cursor).toBe(2); expect(first.session.history.length).toBe(session.history.length);
    first.session.seek(4);
    const second = await importHistory(await exportHistory(first.session, details, fast), fast);
    expect(second.session.cursor).toBe(4); expect(second.session.history).toEqual(session.history);
  });
  it('histórico parcial não executa além do último registro; reiniciar libera uma execução nova', async () => {
    const session = new DebugSession('result = 1 + 2', { language: 'python' }); session.forward();
    const restored = (await importHistory(await exportHistory(session, details, fast), fast)).session;
    expect(restored.replayOnly).toBe(true); expect(restored.state.control.status).toBe('running'); expect(restored.canForward).toBe(false);
    const spy = vi.spyOn(machine, 'executeInstruction');
    expect(restored.forward()).toBe(null); restored.seek(0); restored.forward(); expect(restored.forward()).toBe(null);
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
    restored.restart(); expect(restored.replayOnly).toBe(false); while (restored.canForward) restored.runBatch();
    expect(restored.state.frames[0]!.locals.result).toBe(3n);
  });
  it('importa um histórico vazio e uma gravação parada no limite sem perder a navegação', async () => {
    for (const source of ['', 'while True:\n    pass']) {
      const { session } = record(source, 'python', 30); if (!source) session.restart();
      const restored = (await importHistory(await exportHistory(session, details, fast), fast)).session;
      expect(restored.cursor).toBe(session.cursor); expect(restored.canForward).toBe(false);
      restored.seek(0); restored.seek(restored.history.length); expect(restored.state).toEqual(session.state);
    }
  });
  it('fork mantém VM/checkpoints separados e os registros imutáveis', () => {
    const { session } = record('result = 42'); const fork = session.forkRecording(0);
    expect(fork.cursor).toBe(0); expect(session.cursor).toBe(session.history.length);
    expect(Object.isFrozen(fork.history[0])).toBe(true);
    fork.seek(fork.history.length); expect(fork.state).toEqual(session.state); expect(fork.state).not.toBe(session.state);
    expect(fork.state.frames[0]).not.toBe(session.state.frames[0]); expect(fork.program).toBe(session.program);
    fork.restart(); expect(session.history.length).toBeGreaterThan(0); expect(fork.history.length).toBe(0);
  });
  it('fork de uma gravação parcial não acompanha append/clear da sessão original', () => {
    const session = new DebugSession('i = 0\nwhile i < 100:\n    i += 1', { language: 'python', checkpointInterval: 4 });
    session.runBatch(40); const fork = session.forkRecording(20), saved = structuredClone(fork.state);
    session.runBatch(40); expect(fork.history).toHaveLength(40);
    session.restart(); fork.seek(40); fork.seek(20); expect(fork.state).toEqual(saved);
    expect(fork.historyStats.checkpointCursors).toContain(4); expect(session.history).toHaveLength(0);
  });
  it('compara dois históricos importados sem executar, preservando seus cursores e todos os estados', async () => {
    const load = async (file: string) => importHistory(await exportHistory(record(readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8')).session, { ...details, filename: file }, fast), fast);
    const left = await load('python-sum-bug.py'), right = await load('python-sum-fixed.py');
    left.session.seek(12); right.session.seek(13);
    const spy = vi.spyOn(machine, 'executeInstruction');
    try {
      const input = (run: typeof left) => ({ name: run.name, source: run.session.program.source, ...run.session.runtime, recording: run.session });
      const comparison = new ExecutionComparison(input(left), input(right));
      while (!comparison.ready) comparison.prepareBatch();
      expect(comparison.left.finalResult).toEqual({ present: true, value: 10n }); expect(comparison.right.finalResult).toEqual({ present: true, value: 15n });
      expect(comparison.firstDifference).not.toBeNull();
      for (let i = comparison.rows.length - 1; i >= 0; i--) {
        comparison.seekRow(i); const row = comparison.rows[i]!;
        const a = left.session.forkRecording(row.leftCursor), b = right.session.forkRecording(row.rightCursor);
        expect(comparison.left.state).toEqual(a.state); expect(comparison.right.state).toEqual(b.state);
      }
      expect(left.session.cursor).toBe(12); expect(right.session.cursor).toBe(13); expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('comparação e controles distinguem fim do registro parcial de conclusão', () => {
    const session = new DebugSession('result = 1 + 2', { language: 'python' }); session.forward();
    const replay = session.forkRecording(0), input = { name: 'Parcial', source: replay.program.source, ...replay.runtime, recording: replay };
    const comparison = new ExecutionComparison(input, input); while (!comparison.ready) comparison.prepareBatch();
    expect(comparison.left.points.at(-1)?.phase).toBe('pause'); expect(comparison.left.history).toHaveLength(1);
    const control = new ExecutionControl(replay); control.start('continue'); control.runBatch();
    expect(control.stop?.reason).toBe('recorded-end'); expect(replay.state.control.status).toBe('running');
    const empty = new DebugSession('', { language: 'python' }).forkRecording();
    const emptyInput = { ...input, source: '', recording: empty };
    const emptyComparison = new ExecutionComparison(emptyInput, emptyInput); while (!emptyComparison.ready) emptyComparison.prepareBatch();
    expect(emptyComparison.left.points.at(-1)?.phase).toBe('pause');
  });
  it('navegação gerada mantém todos os campos e nunca cria novos registros', async () => {
    const { session, snapshots } = record('def f(n):\n    if n <= 1:\n        return n\n    return f(n - 1) + f(n - 2)\nresult = f(5)');
    const restored = (await importHistory(await exportHistory(session, details, fast), fast)).session;
    fc.assert(fc.property(fc.array(fc.nat(snapshots.length - 1), { minLength: 10, maxLength: 80 }), targets => {
      for (const target of targets) { restored.seek(target); expect(restored.state).toEqual(snapshots[target]); }
      expect(restored.history.length).toBe(session.history.length);
    }), { seed: 20261013, numRuns: 30 });
  });
  it('cancela validação em lote e exportação sem alterar a sessão original', async () => {
    const { session } = record('i = 0\nwhile i < 100:\n    i += 1');
    const content = await exportHistory(session, details, fast), state = structuredClone(session.state);
    for (const action of ['import', 'export']) {
      const abort = new AbortController();
      const job = { ...fast, signal: abort.signal, onProgress: () => abort.abort() };
      await expect(action === 'import' ? importHistory(content, job) : exportHistory(session, details, job)).rejects.toThrow();
      expect(session.state).toEqual(state);
    }
  });
  it('exportação captura o cursor e os registros antes de uma navegação concorrente', async () => {
    const { session } = record('i = 0\nwhile i < 100:\n    i += 1');
    const cursor = session.cursor, state = structuredClone(session.state), count = session.history.length;
    const content = await exportHistory(session, details, { ...fast, onProgress: () => session.seek(0) });
    expect(session.cursor).toBe(0);
    const imported = await importHistory(content, fast);
    expect(imported.session.cursor).toBe(cursor); expect(imported.session.history).toHaveLength(count); expect(imported.session.state).toEqual(state);
  });
  it('reconstrói checkpoints esparsos e restaura frames em uma importação grande', async () => {
    const { session } = record('i = 0\nwhile i < 500:\n    i += 1');
    const restored = (await importHistory(await exportHistory(session, details, fast), fast)).session;
    expect(restored.historyStats.checkpointCursors.length).toBeGreaterThan(1);
    expect(restored.historyStats.checkpointCursors.length).toBeLessThanOrEqual(128);
    restored.seek(0); restored.seek(restored.history.length); expect(restored.state).toEqual(session.state);
  });
});

describe('arquivos rejeitados antes de publicar a sessão', () => {
  const source = 'def f(n):\n    x = n + 1\n    return x\nresult = f(2)\nprint(result)';
  const content = async () => exportHistory(record(source).session, details, fast);
  it('rejeita JSON quebrado, tamanho excessivo, versões/formato e checksum', async () => {
    await expect(importHistory('{', fast)).rejects.toThrow(/corrompido/);
    await expect(importHistory(' '.repeat(MAX_TRACE_BYTES + 1), fast)).rejects.toThrow(/32 MiB/);
    for (const [key, item] of [['version', 3], ['format', 'outro'], ['checksum', '0'.repeat(64)]]) {
      const envelope = JSON.parse(await content()); envelope[key as string] = item;
      await expect(importHistory(JSON.stringify(envelope), fast)).rejects.toThrow();
    }
  });
  const corruptions: [string, (envelope: any) => void][] = [
    ['compiler', e => { e.payload.vm = 'rewind-vm/3'; }],
    ['runtime', e => { e.payload.runtime.version = '4'; }],
    ['source', e => { e.payload.source += '\nresult = 99'; }],
    ['initial', e => { e.payload.initial.control.nextFrameId = 9; }],
    ['cursor', e => { e.payload.cursor = 99_999; }],
    ['quota', e => { e.payload.limits.maxSteps = 20_001; }],
    ['extra field', e => { e.payload.extra = 1; }],
    ['opcode', e => { e.payload.steps[0].op = 'HALT'; }],
    ['span', e => { e.payload.steps[0].span.line = 99; }],
    ['control before', e => { e.payload.steps[0].changes.at(-1).before.pc = 9; }],
    ['control after', e => { e.payload.steps[0].changes.at(-1).after.pc = 9; }],
    ['splice', e => { e.payload.steps.find((s: any) => s.changes.some((c: any) => c.kind === 'operands' && c.removed.length)).changes.find((c: any) => c.kind === 'operands').removed[0] = { $bigint: '999' }; }],
    ['binding before', e => { e.payload.steps[0].changes[0].before = { exists: true, value: 10 }; }],
    ['binding after', e => { e.payload.steps[0].changes[0].after.value.name = 'abs'; }],
    ['frame', e => { e.payload.steps.find((s: any) => s.changes.some((c: any) => c.kind === 'frames' && c.added.length)).changes.find((c: any) => c.kind === 'frames').added[0].id = 9; }],
    ['noncanonical bigint', e => { e.payload.steps[1].changes[0].added[0] = { $bigint: '02' }; }],
    ['number tag', e => { e.payload.steps[1].changes[0].added[0] = { $number: 'unknown' }; }],
  ];
  for (const [label, change] of corruptions) it(`rejeita ${label}, mesmo com checksum recalculado`, async () => {
    await expect(importHistory(await rewrite(await content(), change), fast)).rejects.toThrow();
  });
  it('rejeita payload muito profundo sem ultrapassar a pilha JS', async () => {
    const bad = await rewrite(await content(), e => { let nested: any = {}; for (let i = 0; i < 40; i++) nested = { nested }; e.payload.metadata = nested; });
    await expect(importHistory(bad, fast)).rejects.toThrow(/profunda/);
  });
  it('define quotas explícitas sem remover históricos existentes', () => {
    expect(() => checkImportBudget(Array.from({ length: 8 }, () => ({ bytes: 1 })), 1)).toThrow(/8 históricos/);
    const existing = [{ bytes: MAX_IMPORTED_BYTES }];
    expect(() => checkImportBudget(existing, 1)).toThrow(/64 MiB/);
    expect(existing).toEqual([{ bytes: MAX_IMPORTED_BYTES }]);
    expect(() => checkImportBudget([{ bytes: MAX_TRACE_BYTES }], MAX_TRACE_BYTES)).not.toThrow();
  });
});
