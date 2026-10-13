import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DebugSession } from '../src/core/debugger';
import { explainStep, operandProducer, summarizeNavigation } from '../src/core/explanations';
import { firstEventAfter, historyEvent, HistoryEventIndex } from '../src/core/history-events';
import type { DeepReadonly, Step } from '../src/core/machine';
import * as machine from '../src/core/machine';
import * as math from '../src/core/python-values';

function recorded(source: string, language = 'python') {
  const session = new DebugSession(source, { language });
  while (session.canForward) session.runBatch();
  return session;
}
const example = (name: string) => readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');
function explain(session: DebugSession, index: number, direction: 'forward' | 'backward' = 'forward') { return explainStep(session.program, session.history, index, direction); }

describe('explicações dos valores registrados', () => {
  it('preserva ordem dos operandos e o resultado, inclusive ao desfazer', () => {
    const session = recorded('result = 9 - 4');
    const index = session.history.findIndex(step => step.op === 'BINARY');
    expect(explain(session, index)).toEqual({ kind: 'operation', operation: { inputs: [9n, 4n], operator: '-', result: 5n } });
    expect(explain(session, index, 'backward')).toEqual(explain(session, index));
  });
  it('mostra unary, bigint exato, -0 e NaN sem JSON nem coerção numérica', () => {
    const session = recorded('x = -0.0\ny = 90071992547409931234567890 + 1\nz = 1e308 * 1e308\nw = z - z');
    const unary = session.history.findIndex(step => step.op === 'UNARY');
    const negative = explain(session, unary);
    expect(negative.kind).toBe('operation');
    if (negative.kind === 'operation') expect(Object.is(negative.operation.result, -0)).toBe(true);
    const binary = session.history.map((step, index) => step.op === 'BINARY' ? explain(session, index) : null).filter(item => item?.kind === 'operation');
    expect(binary[0]!.operation.result).toBe(90071992547409931234567891n);
    expect(binary.at(-1)!.operation.result).toBeNaN();
  });
  it('uma decisão encontra seu produtor pelos splices, não por um valor semelhante', () => {
    const session = recorded(example('python-sum-bug.py'));
    const index = session.history.map((step, index) => step.op === 'JUMP_IF_FALSE' ? index : -1).filter(index => index >= 0).at(-1)!;
    const result = explain(session, index);
    expect(result.kind).toBe('decision');
    if (result.kind === 'decision') {
      expect(result.satisfied).toBe(false); expect(result.value).toBe(false);
      expect(result.operation).toEqual({ inputs: [5n, 5n], operator: '<', result: false });
    }
    expect(explain(session, index, 'backward')).toMatchObject({ kind: 'decision', satisfied: false, value: false });
  });
  it('decisões de truthiness e curto-circuito não atribuem uma fórmula de outro valor', () => {
    const session = recorded('x = 0\nif x and (1 < 2):\n    result = 1\nelse:\n    result = 2');
    for (let i = 0; i < session.history.length; i++) if (session.history[i]!.op === 'JUMP_IF_FALSE') {
      expect(explain(session, i)).toMatchObject({ kind: 'decision', value: 0n, satisfied: false, operation: null });
    }
  });
  it('seguir um operando atravessa remoções em índices menores sem confundir valores iguais', () => {
    const fake = (changes: Step['changes']): DeepReadonly<Step> => ({ index: 0, op: 'PUSH', span: { start: 0, end: 0, line: 1, column: 1 }, description: '', changes });
    const history = [fake([{ kind: 'operands', index: 0, removed: [], added: [7n, 7n] }]), fake([{ kind: 'operands', index: 0, removed: [7n], added: [] }]), fake([{ kind: 'operands', index: 1, removed: [], added: [7n] }])];
    expect(operandProducer(history, 3, 0)).toBe(0);
    expect(operandProducer(history, 3, 1)).toBe(2);
  });
  it('leituras distinguem locais, globais, builtins e aliases que já são bindings', () => {
    const session = recorded('x = 10\np = print\ndef f(x):\n    return x + p(x)\nresult = f(3)');
    const reads = session.history.flatMap((step, index) => step.op === 'LOAD' ? [explain(session, index)] : []);
    expect(reads).toContainEqual({ kind: 'read', name: 'print', value: { kind: 'builtin', name: 'print' }, frameId: null, scope: 'builtins do Python' });
    expect(reads).toContainEqual({ kind: 'read', name: 'p', value: { kind: 'builtin', name: 'print' }, frameId: 0, scope: 'programa' });
    expect(reads).toContainEqual({ kind: 'read', name: 'x', value: 3n, frameId: 1, scope: 'f' });
  });
  it('o escopo é reconstruído no registro escolhido mesmo depois de todos os frames retornarem', () => {
    const session = recorded(example('factorial.rw'), 'rewind');
    const reads = session.history.flatMap((step, index) => step.op === 'LOAD' ? [explain(session, index)] : []).filter(item => item.kind === 'read');
    expect(new Set(reads.filter(item => item.name === 'n').map(item => item.frameId)).size).toBe(5);
    expect(session.state.frames).toHaveLength(1);
  });
  it('desfazer declaração remove o binding e desfazer atribuição restaura o anterior', () => {
    const session = recorded('x = 1\nx = 2');
    const writes = session.history.flatMap((step, index) => step.op === 'SET' ? [index] : []);
    expect(explain(session, writes[0]!, 'backward')).toMatchObject({ kind: 'binding', before: { exists: true, value: 1n }, after: { exists: false } });
    expect(explain(session, writes[1]!, 'backward')).toMatchObject({ kind: 'binding', before: { exists: true, value: 2n }, after: { exists: true, value: 1n } });
  });
  it('chamada e retorno exibem frames e locais dos deltas, com ações inversas corretas', () => {
    const session = recorded('def f(n):\n    x = n + 1\n    return x\nresult = f(2)');
    const call = session.history.findIndex(step => step.changes.some(change => change.kind === 'frames' && change.added.length));
    const returning = session.history.findIndex(step => step.op === 'RETURN');
    expect(explain(session, call)).toMatchObject({ kind: 'frame', action: 'enter', frame: { id: 1, name: 'f', locals: { n: 2n } } });
    expect(explain(session, call, 'backward')).toMatchObject({ kind: 'frame', action: 'remove' });
    expect(explain(session, returning)).toMatchObject({ kind: 'frame', action: 'leave', frame: { locals: { n: 2n, x: 3n } }, result: { exists: true, value: 3n } });
    expect(explain(session, returning, 'backward')).toMatchObject({ kind: 'frame', action: 'restore', frame: { locals: { n: 2n, x: 3n } } });
  });
  it('saída é removida ao voltar e falhas não inventam mudanças que foram revertidas', () => {
    const session = recorded('print(42)\nresult = 1 / 0');
    const output = session.history.findIndex(step => step.changes.some(change => change.kind === 'output'));
    expect(explain(session, output, 'backward')).toEqual({ kind: 'output', text: '42\n', action: 'remove' });
    expect(explain(session, session.history.length - 1)).toEqual({ kind: 'error', message: 'Divisão por zero', action: 'raise' });
    expect(explain(session, session.history.length - 1, 'backward')).toMatchObject({ kind: 'error', action: 'clear' });
  });
  it('agrega na ordem real da navegação, mantendo frame e presença em cada direção', () => {
    const session = recorded('x = 1\nx = 2\nx = 3');
    expect(summarizeNavigation(session.program, session.history, 0, session.history.length).bindings).toEqual([{ frameId: 0, scope: 'programa', name: 'x', before: { exists: false }, after: { exists: true, value: 3n }, writes: 3 }]);
    expect(summarizeNavigation(session.program, session.history, session.history.length, 0).bindings).toEqual([{ frameId: 0, scope: 'programa', name: 'x', before: { exists: true, value: 3n }, after: { exists: false }, writes: 3 }]);
  });
  it('não executa instruções, matemática nem altera estado/histórico para explicar qualquer registro', () => {
    const session = recorded(example('python-sum-bug.py'));
    const state = structuredClone(session.state), history = structuredClone(session.history);
    const execute = vi.spyOn(machine, 'executeInstruction'), binary = vi.spyOn(math, 'pythonBinary');
    try {
      for (let i = 0; i < session.history.length; i++) { explain(session, i); explain(session, i, 'backward'); }
      summarizeNavigation(session.program, session.history, 0, session.history.length);
      expect(execute).not.toHaveBeenCalled(); expect(binary).not.toHaveBeenCalled();
      expect(session.state).toEqual(state); expect(session.history).toEqual(history);
    } finally { execute.mockRestore(); binary.mockRestore(); }
  });
  it('valida posições e intervalos antes de inspecionar registros', () => {
    const session = recorded('result = 1');
    for (const index of [-1, NaN, session.history.length]) expect(() => explain(session, index)).toThrow(RangeError);
    for (const [from, to] of [[0, 0], [0, 100], [-1, 1]]) expect(() => summarizeNavigation(session.program, session.history, from!, to!)).toThrow(RangeError);
  });
});

describe('índice incremental do histórico', () => {
  it('classifica só instruções novas, mantém eventos no replay e limpa após restart', () => {
    const session = new DebugSession(example('python-sum-bug.py'), { language: 'python' });
    const index = new HistoryEventIndex();
    while (session.canForward) { session.forward(); index.update(session.history); }
    const expected = session.history.flatMap((step, i) => historyEvent(step, i + 1) ?? []);
    const events = index.update(session.history); expect(events).toEqual(expected);
    session.seek(0); expect(index.update(session.history)).toBe(events);
    session.restart(); expect(index.update(session.history)).toEqual([]);
  });
  it('não relê payloads antigos ao anexar novos registros', () => {
    const session = recorded('x = 1\nprint(x)');
    const seen = new Set<number>();
    const trace: DeepReadonly<Step>[] = [];
    const index = new HistoryEventIndex();
    session.history.forEach((step, i) => {
      trace.push(new Proxy(step, { get(target, property) { if (seen.has(i)) throw new Error('Payload antigo relido'); return Reflect.get(target, property); } }));
      index.update(trace); seen.add(i);
    });
    expect(index.update(trace).length).toBeGreaterThan(0);
  });
  it('busca próximo evento por cursor e trata limites inclusive no início/fim', () => {
    const session = recorded('x = 1\nprint(x)');
    const events = new HistoryEventIndex().update(session.history);
    for (let cursor = 0; cursor <= session.history.length; cursor++) {
      const expected = events.findIndex(event => event.cursor > cursor);
      expect(firstEventAfter(events, cursor)).toBe(expected === -1 ? events.length : expected);
    }
  });
});
