import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { DebugSession } from '../src/core/debugger';
import { initialState, type MachineState } from '../src/core/machine';
import { exportHistory, importHistory } from '../src/core/portable-history';
import { getList } from '../src/core/heap';
import { formatPythonOutput } from '../src/core/runtime';
import { compareHeapRoots } from '../src/core/heap-comparison';
import { ExecutionComparison } from '../src/core/comparison';
import * as machine from '../src/core/machine';
import { explainStep } from '../src/core/explanations';

function record(source: string) {
  const session = new DebugSession(source, { language: 'python', checkpointInterval: 4, maxCheckpoints: 8 });
  const snapshots = [structuredClone(session.state)];
  while (session.canForward) { session.forward(); snapshots.push(structuredClone(session.state)); }
  return { session, snapshots };
}
const globals = (session: DebugSession) => session.state.frames[0]!.locals;
const list = (session: DebugSession, name: string) => getList(globals(session)[name]!, session.state.heap).items;
const fast = { yieldControl: async () => {} };

describe('listas Python no heap reversível', () => {
  it('preserva identidade entre aliases, parâmetros e retornos', () => {
    const { session, snapshots } = record('def f(a):\n    a[0] = 9\n    a.append(3)\n    return a\nx = [1, 2]\ny = x\nz = f(y)\nresult = x[0]');
    expect(globals(session).x).toEqual(globals(session).y); expect(globals(session).z).toEqual(globals(session).x);
    expect(list(session, 'x')).toEqual([9n, 2n, 3n]); expect(globals(session).result).toBe(9n);
    expect(Object.keys(session.state.heap)).toHaveLength(1);
    for (let i = snapshots.length - 1; i >= 0; i--) { session.seek(i); expect(session.state).toEqual(snapshots[i]); }
    expect(session.state).toEqual(initialState());
    for (let i = 0; i < snapshots.length; i++) { session.seek(i); expect(session.state).toEqual(snapshots[i]); }
  });
  it('listas independentes, aninhadas e autorreferentes mantêm o grafo', () => {
    const { session } = record('x = [1]\ny = [1]\nz = [x, x]\nx.append(x)\nz[0][0] = 9\nprint(x, z)\nresult = y[0]');
    expect(globals(session).x).not.toEqual(globals(session).y); expect(list(session, 'z')[0]).toEqual(list(session, 'z')[1]);
    expect(list(session, 'x')).toEqual([9n, globals(session).x]); expect(globals(session).result).toBe(1n);
    expect(session.state.output).toEqual(['[9, [...]] [[9, [...]], [9, [...]]]\n']);
    session.rewind(); expect(session.state.heap).toEqual({}); expect(session.state.control.nextObjectId).toBe(1);
    session.runBatch(1000); expect(list(session, 'x')[1]).toEqual(globals(session).x);
  });
  it('índices negativos e booleanos funcionam sem arredondar inteiros grandes', () => {
    const { session } = record('a = [3, 4, 5]\na[-1] = 8\nx = a[True]\ny = a[False]\nresult = a[-3]');
    expect(list(session, 'a')).toEqual([3n, 4n, 8n]); expect(globals(session)).toMatchObject({ x: 4n, y: 3n, result: 3n });
  });
  it.each(['a[2]', 'a[-3]', 'a[1.0]', 'a[None]', 'a[90071992547409931234567890]', 'a[2] = 8', 'a[0.0] = 8', 'len(3)'])('erros de %s são atômicos e reversíveis', source => {
    const { session, snapshots } = record(`a = [1, 2]\n${source}`);
    expect(session.state.control.status).toBe('error');
    const before = snapshots.at(-2)!;
    expect(session.state.heap).toEqual(before.heap); expect(session.state.operands).toEqual(before.operands); expect(session.state.frames).toEqual(before.frames);
    session.backward(); expect(session.state).toEqual(before); session.forward(); expect(session.state).toEqual(snapshots.at(-1));
  });
  it('append retorna None, e valida o receptor antes de avaliar argumentos', () => {
    const { session } = record('def f():\n    print(99)\n    return 1\nx = 3\nx.append(f())');
    expect(session.state.control.status).toBe('error'); expect(session.state.output).toEqual([]);
    const valid = record('a = []\nresult = a.append(2)').session;
    expect(globals(valid).result).toBe(null); expect(list(valid, 'a')).toEqual([2n]);
  });
  it('avalia RHS antes do receptor/índice na atribuição', () => {
    const { session } = record('def rhs():\n    a[0] = 3\n    return 7\ndef index():\n    print(a[0])\n    return 0\na = [1]\na[index()] = rhs()');
    expect(session.state.output).toEqual(['3\n']); expect(list(session, 'a')).toEqual([7n]);
  });
  it('len, bool, not e curto-circuito usam o conteúdo atual das listas', () => {
    const { session } = record('a = []\nx = bool(a)\ny = not a\nz = a and print(99)\na.append(1)\nw = bool(a)\nresult = len(a)\nprint(a or [2])');
    expect(globals(session)).toMatchObject({ x: false, y: true, w: true, result: 1n }); expect(globals(session).z).toEqual(globals(session).a);
    expect(session.state.output).toEqual(['[1]\n']); expect(Object.keys(session.state.heap)).toHaveLength(1);
  });
  it('igualdade por conteúdo distingue comparação de identidade e trata ciclos', () => {
    const { session } = record('a = [[1], 2]\nb = [[True], 2.0]\nresult = a == b\na[0].append(a)\nx = a == a');
    expect(globals(session).result).toBe(true); expect(globals(session).x).toBe(true);
    const cyclic = record('a = []\nb = []\na.append(a)\nb.append(b)\nresult = a == b').session;
    expect(cyclic.state.control.status).toBe('error'); expect(cyclic.state.control.error).toMatch(/cíclicas/);
  });
  it('splices guardam somente o item alterado, não a lista inteira', () => {
    const small = record('a = [1]\na[0] = 7').session;
    const large = record(`a = [${Array.from({ length: 1000 }, () => '1').join(',')}]\na[0] = 7`).session;
    const delta = (session: DebugSession) => session.history.find(step => step.op === 'LIST_SET')!.changes.find(change => change.kind === 'heap-splice');
    expect(delta(small)).toEqual(delta(large)); expect(delta(large)).toMatchObject({ removed: [1n], added: [7n] });
  });
  it('gravações v2 preservam ciclos, IDs, contadores e todos os cursores sem executor', async () => {
    const { session, snapshots } = record('a = []\na.append(a)\nb = [a, a]\na.append(7)\nprint(b)');
    const content = await exportHistory(session, { name: 'Ciclo', filename: 'ciclo.py' }, fast);
    expect(JSON.parse(content).version).toBe(2);
    const spy = vi.spyOn(machine, 'executeInstruction');
    try {
      const restored = (await importHistory(content, fast)).session;
      for (let i = 0; i < snapshots.length; i++) { restored.seek(i); expect(restored.state).toEqual(snapshots[i]); }
      for (let i = snapshots.length - 1; i >= 0; i--) { restored.seek(i); expect(restored.state).toEqual(snapshots[i]); }
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('navegação gerada restaura heap, referências e todos os campos', () => {
    const { session, snapshots } = record('a = [1, 2]\nb = a\ni = 0\nwhile i < 20:\n    b[0] = i\n    a.append(b)\n    i += 1\nresult = len(a)');
    fc.assert(fc.property(fc.array(fc.nat(snapshots.length - 1), { minLength: 10, maxLength: 100 }), targets => {
      for (const target of targets) { session.seek(target); expect(session.state).toEqual(snapshots[target]); }
    }), { seed: 20261013, numRuns: 40 });
  });
  it('forks e checkpoints não compartilham listas mutáveis', () => {
    const { session } = record('a = [1]\na.append(a)');
    const copy = session.forkRecording(); const original = structuredClone(session.state);
    copy.seek(0); copy.seek(copy.history.length); expect(copy.state).toEqual(original);
    expect(copy.state.heap[1]).not.toBe(session.state.heap[1]);
    copy.restart(); copy.runBatch(); expect(session.state).toEqual(original);
  });
  it('formatador de print limita expansão sem recursão JS nem truncamento silencioso', () => {
    const heap: MachineState['heap'] = {};
    for (let id = 1; id <= 100; id++) heap[id] = { kind: 'list', items: id === 1 ? [] : [{ kind: 'list', id: id - 1 }, { kind: 'list', id: id - 1 }] };
    expect(() => formatPythonOutput({ kind: 'list', id: 100 }, heap)).toThrow(/100.000/);
  });
  it('limite de objetos é atômico, e o heap não é coletado ao perder uma referência', () => {
    const session = new DebugSession('a = []\n'.repeat(4097), { language: 'python' });
    while (session.canForward) session.runBatch(1000);
    expect(session.state.control.error).toMatch(/4.096/); expect(Object.keys(session.state.heap)).toHaveLength(4096);
    expect(session.state.control.nextObjectId).toBe(4097); expect(session.state.control.heapItems).toBe(0);
    const state = structuredClone(session.state); session.backward();
    expect(session.state.control.status).toBe('running'); expect(session.state.heap).toEqual(state.heap);
    session.forward(); expect(session.state).toEqual(state);
  });
  it('limite de itens preserva o objeto e os operandos quando append falha', () => {
    const session = new DebugSession(`a = [${Array.from({ length: 20_000 }, () => '1').join(',')}]\na.append(2)`, { language: 'python', maxSteps: 30_000 });
    while (session.canForward) session.runBatch(1000);
    expect(session.state.control.error).toMatch(/20.000 itens/); expect(session.state.control.heapItems).toBe(20_000);
    expect(list(session, 'a')).toHaveLength(20_000); expect(session.history.at(-1)!.changes).toHaveLength(1);
    const heap = structuredClone(session.state.heap), operands = structuredClone(session.state.operands);
    session.backward(); expect(session.state.heap).toEqual(heap); expect(session.state.operands).toEqual(operands);
  });
  it('explica mutações pelo delta e decisões pelo caminho registrado, mesmo após listas mudarem', () => {
    const { session } = record('a = []\nif a:\n    pass\na.append(7)\na[0] = 9');
    const decision = session.history.findIndex(step => step.op === 'JUMP_IF_FALSE');
    expect(explainStep(session.program, session.history, decision, 'forward')).toMatchObject({ kind: 'decision', satisfied: false });
    const append = session.history.findIndex(step => step.op === 'LIST_APPEND');
    expect(explainStep(session.program, session.history, append, 'backward')).toMatchObject({ kind: 'heap', id: 1, before: [7n], after: [], action: 'remove' });
    const set = session.history.findIndex(step => step.op === 'LIST_SET');
    expect(explainStep(session.program, session.history, set, 'backward')).toMatchObject({ kind: 'heap', before: [9n], after: [7n], action: 'replace' });
  });
  it('preserva posições de listas multilinha e rejeita slicing/atribuição aumentada', () => {
    const { session } = record('a = [\n    1, # comentário\n    [2, 3],\n]\nresult = a[1][-1]');
    expect(globals(session).result).toBe(3n);
    const push = session.history.find(step => step.op === 'PUSH' && step.span.line === 3)!;
    expect(session.program.source.slice(push.span.start, push.span.end)).toBe('2');
    for (const source of ['a = [1]\na[0:1]', 'a = [1]\na[0] += 1', 'a = [1]\na.pop()', 'a = [1]\na.append()', 'a = [1]\na.append(2, 3)']) expect(() => new DebugSession(source, { language: 'python' })).toThrow();
  });
  it('rejeita um arquivo v1 real com mensagem explícita, sem alterar seu conteúdo', async () => {
    const legacy = readFileSync(new URL('./fixtures/history-v1.json', import.meta.url), 'utf8');
    expect(JSON.parse(legacy).version).toBe(1);
    await expect(importHistory(legacy, fast)).rejects.toThrow(/v1.*VM anterior/);
    expect(readFileSync(new URL('./fixtures/history-v1.json', import.meta.url), 'utf8')).toBe(legacy);
  });
  it('rejeita referências, splices, IDs e contadores adulterados mesmo com novo checksum', async () => {
    const content = await exportHistory(record('a = [1]\nb = a\na.append(a)\na[0] = 9').session, { name: 'Teste', filename: 'teste.py' }, fast);
    const corruptions = [
      (e: any) => { e.payload.steps.find((s: any) => s.op === 'BUILD_LIST').changes.find((c: any) => c.kind === 'heap-allocation').id = 2; },
      (e: any) => { e.payload.steps.find((s: any) => s.op === 'BUILD_LIST').changes.at(-1).after.nextObjectId = 3; },
      (e: any) => { e.payload.steps.find((s: any) => s.op === 'LIST_APPEND').changes.at(-1).after.heapItems = 8; },
      (e: any) => { e.payload.steps.find((s: any) => s.op === 'LIST_APPEND').changes.find((c: any) => c.kind === 'heap-splice').added[0].id = 999; },
      (e: any) => { e.payload.steps.find((s: any) => s.op === 'LIST_SET').changes.find((c: any) => c.kind === 'heap-splice').removed[0] = { $bigint: '5' }; },
    ];
    for (const change of corruptions) {
      const envelope = JSON.parse(content); change(envelope);
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(envelope.payload)));
      envelope.checksum = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
      await expect(importHistory(JSON.stringify(envelope), fast)).rejects.toThrow();
    }
  });
});

describe('comparação do heap', () => {
  it('ignora IDs de alocação diferentes mas compara conteúdo e referências compartilhadas', () => {
    const a = { 1: { kind: 'list' as const, items: [1n] } };
    const b = { 9: { kind: 'list' as const, items: [1n] }, 10: { kind: 'list' as const, items: [1n] } };
    const ref = (id: number) => ({ kind: 'list' as const, id });
    expect(compareHeapRoots([{ left: ref(1), right: ref(9) }], a, b).equal).toEqual([true]);
    expect(compareHeapRoots([{ left: ref(1), right: ref(9) }, { left: ref(1), right: ref(10) }], a, b).equal).toEqual([false, false]);
    a[1].items[0] = 3n;
    expect(compareHeapRoots([{ left: ref(1), right: ref(9) }], a, b).differences).toContainEqual({ name: '#L1 ↔ #L9 · item [0]', left: 3n, right: 1n });
  });
  it('propaga diferenças em grafos cíclicos sem laço infinito', () => {
    const ref = (id: number) => ({ kind: 'list' as const, id });
    const a = { 1: { kind: 'list' as const, items: [ref(1), 1n] } }, b = { 9: { kind: 'list' as const, items: [ref(9), 2n] } };
    expect(compareHeapRoots([{ left: ref(1), right: ref(9) }], a, b).equal).toEqual([false]);
  });
  it('integra mutações nos pontos da comparação sem confundir IDs', () => {
    const source = (body: string) => ({ name: body, source: body, language: 'python', version: '3' });
    const comparison = new ExecutionComparison(source('a = [1]\nb = a\nb[0] = 9\nresult = a[0]'), source('unused = []\na = [1]\nb = [a[0]]\nb[0] = 9\nresult = a[0]'));
    while (!comparison.ready) comparison.prepareBatch();
    expect(comparison.left.points.some(point => point.phase === 'mutation')).toBe(true);
    comparison.seekRow(comparison.rows.length - 1);
    expect(comparison.left.finalResult).toEqual({ present: true, value: 9n }); expect(comparison.right.finalResult).toEqual({ present: true, value: 1n });
    expect(comparison.differences().some(diff => diff.category === 'heap')).toBe(true);
  });
});
