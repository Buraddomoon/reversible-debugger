import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { DebugSession } from '../src/core/debugger';
import { ExecutionControl, type RunMode } from '../src/core/execution-control';
import * as machine from '../src/core/machine';

const example = (name: string) => readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');
const snapshot = (session: DebugSession) => structuredClone(session.state);
function reference(source: string, language = 'python') {
  const session = new DebugSession(source, { language });
  const states = [snapshot(session)];
  while (session.canForward) { session.forward(); states.push(snapshot(session)); }
  return { session, states };
}
function run(control: ExecutionControl, mode: RunMode, batch = 7) {
  control.start(mode);
  let ticks = 0;
  while (control.running) { control.runBatch(batch); if (++ticks > 10000) throw new Error('Plano não terminou'); }
  return control.stop!;
}

describe('posições de comandos no compilador', () => {
  it('não muda as instruções nem os estados da VM e mantém metadados congelados', () => {
    const { session } = reference(example('python-sum-bug.py'));
    expect(session.program.locations).toHaveLength(session.program.instructions.length);
    expect(Object.isFrozen(session.program.locations)).toBe(true);
    for (const site of session.program.locations) if (site) {
      expect(Object.isFrozen(site)).toBe(true); expect(Object.isFrozen(site.span)).toBe(true);
    }
    expect(session.state.frames[0]!.locals.result).toBe(10n);
    expect(session.history).toHaveLength(68);
  });
  it('identifica o cabeçalho de uma atribuição multilinha, não seus operandos', () => {
    const session = new DebugSession('# nota\nresult = (\n    2 +\n    3\n)\nprint(result)', { language: 'python' });
    expect(session.program.breakableLines).toEqual([2, 6]);
    expect(session.program.instructions[0]!.span.line).toBe(3);
    expect(session.program.locations[0]!.span.line).toBe(2);
    expect(session.program.locations.filter(site => site?.entry && site.kind === 'statement')).toHaveLength(2);
  });
  it('distingue comandos na mesma linha e não marca saltos internos nem retorno implícito', () => {
    const session = new DebugSession('let x = 0; while (x < 2) { x = x + 1; } let result = x;');
    const entries = session.program.locations.filter(site => site?.entry && site.kind === 'statement');
    expect(new Set(entries.map(site => site!.statementId)).size).toBe(4);
    expect(session.program.breakableLines).toEqual([1]);
    session.program.instructions.forEach((instruction, index) => {
      if (instruction.op === 'JUMP' || instruction.op === 'HALT') expect(session.program.locations[index]).toBeNull();
    });
    const empty = new DebugSession('def empty():\n    pass\nresult = empty()', { language: 'python' });
    expect(empty.program.breakableLines).toEqual([1, 3]);
    expect(empty.program.locations[empty.program.functions.empty!.entry]!.kind).toBe('implicit-return');
  });
});

describe('breakpoints antes dos comandos', () => {
  it('para antes da primeira instrução, retoma uma vez e para novamente em cada iteração', () => {
    const code = 'i = 0\nwhile i < 3:\n    i += 1\nresult = i';
    const { states } = reference(code);
    const session = new DebugSession(code, { language: 'python', checkpointInterval: 2 });
    const control = new ExecutionControl(session); control.toggleBreakpoint(2);
    const positions: number[] = [];
    for (let i = 0; i <= 3; i++) {
      const stop = run(control, 'continue'); positions.push(session.cursor);
      expect(stop.reason).toBe('breakpoint'); expect(stop.line).toBe(2);
      expect(session.state.frames[0]!.locals.i).toBe(BigInt(i));
      expect(control.location!.entry).toBe(true);
      expect(snapshot(session)).toEqual(states[session.cursor]);
    }
    expect(new Set(positions).size).toBe(4);
    expect(run(control, 'continue').reason).toBe('halted');
    expect(session.state.frames[0]!.locals.result).toBe(3n);
    const final = snapshot(session);
    for (let i = 3; i >= 0; i--) {
      expect(run(control, 'reverse-continue').reason).toBe('breakpoint');
      expect(session.cursor).toBe(positions[i]);
      expect(snapshot(session)).toEqual(states[session.cursor]);
    }
    run(control, 'continue');
    expect(session.cursor).toBe(positions[1]);
    control.breakpointsEnabled = false; run(control, 'continue');
    expect(snapshot(session)).toEqual(final);
    expect(session.history).toHaveLength(states.length - 1);
  });
  it('um breakpoint no início não executa nada até retomar', () => {
    const session = new DebugSession('result = 42', { language: 'python' });
    const control = new ExecutionControl(session); control.toggleBreakpoint(1);
    expect(run(control, 'continue').reason).toBe('breakpoint');
    expect(session.cursor).toBe(0); expect(session.history).toHaveLength(0);
    expect(run(control, 'continue').reason).toBe('halted');
    expect(session.state.frames[0]!.locals.result).toBe(42n);
  });
  it('parar, retomar e retroceder em loop vazio não duplica a parada no salto interno', () => {
    const session = new DebugSession('while True:\n    pass', { language: 'python', maxSteps: 30 });
    const control = new ExecutionControl(session); control.toggleBreakpoint(1);
    const cursors: number[] = [];
    for (let i = 0; i < 4; i++) { run(control, 'continue'); cursors.push(session.cursor); }
    expect(cursors).toEqual([0, 3, 6, 9]);
    for (let i = 2; i >= 0; i--) { run(control, 'reverse-continue'); expect(session.cursor).toBe(cursors[i]); }
  });
  it('cada comando da mesma linha é uma ocorrência, inclusive no replay', () => {
    const code = 'let a = 1; let b = 2; let result = a + b;';
    const { states } = reference(code, 'rewind');
    const session = new DebugSession(code); const control = new ExecutionControl(session); control.toggleBreakpoint(1);
    for (const cursor of [0, 2, 4]) { run(control, 'continue'); expect(session.cursor).toBe(cursor); expect(snapshot(session)).toEqual(states[cursor]); }
    run(control, 'continue'); expect(session.state.frames[0]!.locals.result).toBe(3);
    control.cancel(); session.seek(0);
    for (const cursor of [0, 2, 4]) { run(control, 'continue'); expect(session.cursor).toBe(cursor); }
    expect(session.history).toHaveLength(states.length - 1);
  });
  it('ignora linha sem código, permite remover/desativar e preserva pontos ao reiniciar', () => {
    const session = new DebugSession('# nota\nresult = 1', { language: 'python' });
    const control = new ExecutionControl(session);
    for (const line of [0, 1, 3, 2.5, NaN]) expect(() => control.toggleBreakpoint(line)).toThrow('comando');
    control.toggleBreakpoint(2); control.toggleBreakpoint(2); expect(control.breakpoints).toEqual([]);
    control.toggleBreakpoint(2); control.breakpointsEnabled = false;
    expect(run(control, 'continue').reason).toBe('halted');
    control.cancel(); session.restart(); control.breakpointsEnabled = true;
    expect(control.breakpoints).toEqual([2]); expect(run(control, 'continue').reason).toBe('breakpoint');
    control.clearBreakpoints(); expect(run(control, 'continue').reason).toBe('halted');
  });
  it('buscar ou avançar manualmente invalida a autorização de ignorar o breakpoint anterior', () => {
    const session = new DebugSession('result = 1', { language: 'python' });
    const control = new ExecutionControl(session); control.toggleBreakpoint(1);
    run(control, 'continue'); control.cancel(); session.seek(0);
    expect(run(control, 'continue').reason).toBe('breakpoint'); expect(session.cursor).toBe(0);
    control.cancel(); session.forward(); run(control, 'continue');
    expect(session.state.frames[0]!.locals.result).toBe(1n);
  });
});

describe('entrar, passar sobre, sair e voltar comando', () => {
  const code = 'def double(n):\n    return n * 2\nresult = 10 + double(double(3))\nprint(result)';
  it('entrar observa a primeira chamada dentro de argumentos e o retorno ao chamador', () => {
    const session = new DebugSession(code, { language: 'python' }); const control = new ExecutionControl(session);
    run(control, 'into'); expect(control.location!.span.line).toBe(3);
    run(control, 'into'); expect(session.state.frames.at(-1)!.locals.n).toBe(3n);
    expect(control.location!.span.line).toBe(2);
    run(control, 'into'); expect(session.state.frames).toHaveLength(1);
    expect(session.state.operands).toContain(6n);
    run(control, 'into'); expect(session.state.frames.at(-1)!.locals.n).toBe(6n);
    run(control, 'into'); expect(session.state.operands).toContain(12n);
    run(control, 'into'); expect(session.state.frames[0]!.locals.result).toBe(22n);
    expect(control.location!.span.line).toBe(4);
  });
  it('passar sobre conclui a atribuição inteira, preservando temporários de chamadas aninhadas', () => {
    const session = new DebugSession(code, { language: 'python' }); const control = new ExecutionControl(session);
    run(control, 'over'); run(control, 'over');
    expect(session.state.frames).toHaveLength(1); expect(session.state.operands).toEqual([]);
    expect(session.state.frames[0]!.locals.result).toBe(22n);
    expect(control.location!.span.line).toBe(4); expect(session.state.output).toEqual([]);
    run(control, 'over'); expect(session.state.output).toEqual(['22\n']);
    expect(control.stop!.reason).toBe('halted');
  });
  it('sair identifica o frame original em recursão e para antes de terminar a expressão do chamador', () => {
    const session = new DebugSession(example('python-factorial.py'), { language: 'python' });
    const control = new ExecutionControl(session);
    run(control, 'into'); run(control, 'into');
    const originalFrame = session.state.frames.at(-1)!.id;
    run(control, 'into'); // if -> return n * factorial(...)
    run(control, 'into'); // recursive callee
    const recursiveFrame = session.state.frames.at(-1)!.id;
    expect(recursiveFrame).not.toBe(originalFrame);
    run(control, 'out', 1);
    expect(session.state.frames.at(-1)!.id).toBe(originalFrame);
    expect(session.state.operands).toEqual([5n, 24n]);
    expect(session.program.instructions[session.state.control.pc]!.op).toBe('BINARY');
    run(control, 'out'); expect(session.state.frames).toHaveLength(1);
    expect(session.state.operands).toEqual([120n]); expect(session.state.frames[0]!.locals).not.toHaveProperty('result');
    expect(control.canStepOut).toBe(false); expect(() => control.start('out')).toThrow('função ativa');
  });
  it('passar sobre e sair respeitam breakpoints internos antes de terminar a ação', () => {
    for (const mode of ['over', 'out'] as const) {
      const session = new DebugSession(mode === 'out' ? example('python-factorial.py') : code, { language: 'python' }); const control = new ExecutionControl(session);
      run(control, 'into');
      if (mode === 'out') run(control, 'into');
      control.toggleBreakpoint(2);
      const stop = run(control, mode);
      expect(stop.reason).toBe('breakpoint'); expect(stop.line).toBe(2);
      expect(session.state.frames.length).toBeGreaterThan(1);
    }
  });
  it('entrar em função vazia exibe retorno implícito sem inventar um breakpoint no pass', () => {
    const session = new DebugSession('def empty():\n    pass\nresult = empty()', { language: 'python' });
    const control = new ExecutionControl(session);
    run(control, 'into'); run(control, 'into');
    expect(session.state.frames.at(-1)!.name).toBe('empty');
    expect(control.location!.kind).toBe('implicit-return');
    run(control, 'out'); expect(session.state.operands).toEqual([null]);
    run(control, 'over'); expect(session.state.frames[0]!.locals.result).toBeNull();
  });
  it('voltar comando atravessa todas as instruções do último comando e desfaz print', () => {
    const session = new DebugSession('x = 2 + 3\nprint(x)\nresult = x * 2', { language: 'python' });
    const control = new ExecutionControl(session);
    run(control, 'continue');
    run(control, 'back-statement'); expect(control.location!.span.line).toBe(3);
    expect(session.state.frames[0]!.locals).not.toHaveProperty('result');
    run(control, 'back-statement'); expect(control.location!.span.line).toBe(2);
    expect(session.state.output).toEqual([]);
    run(control, 'back-statement'); expect(session.cursor).toBe(0);
    expect(session.state.frames[0]!.locals).toEqual({});
    run(control, 'continue'); expect(session.state.output).toEqual(['5\n']);
    expect(session.state.frames[0]!.locals.result).toBe(10n);
  });
  it('agrupar pelo comando não confunde a mesma linha executada no próximo ciclo', () => {
    const session = new DebugSession('i = 0\nwhile i < 2:\n    i += 1\nresult = i', { language: 'python' });
    const control = new ExecutionControl(session); const lines = [];
    while (session.canForward) { run(control, 'over'); lines.push(control.location?.span.line ?? null); }
    expect(lines).toEqual([2, 3, 2, 3, 2, 4, null]);
    expect(session.state.frames[0]!.locals.result).toBe(2n);
  });
});

describe('limites, erros, lotes e replay', () => {
  it('lotes devolvem o controle, e cancelar impede a continuidade do plano', () => {
    const session = new DebugSession('while True:\n    pass', { language: 'python', maxSteps: 2000 });
    const control = new ExecutionControl(session); control.start('over');
    expect(control.runBatch(1).moved).toBe(1); expect(control.running).toBe(true);
    control.cancel(); const state = snapshot(session);
    expect(control.runBatch(100).moved).toBe(0); expect(snapshot(session)).toEqual(state);
    for (const size of [0, 1001, 1.5]) expect(() => control.runBatch(size)).toThrow('lote');
  });
  it('erro atômico interrompe passar sobre e pode ser removido ao voltar comando', () => {
    const session = new DebugSession('def fail():\n    return 1 / 0\nresult = fail()', { language: 'python' });
    const control = new ExecutionControl(session); run(control, 'over');
    expect(run(control, 'over').reason).toBe('error');
    const error = snapshot(session);
    run(control, 'back-statement'); expect(session.state.control.status).toBe('running');
    expect(control.location!.span.line).toBe(2);
    run(control, 'continue'); expect(snapshot(session)).toEqual(error);
  });
  it('atingir o limite do histórico encerra o plano e mantém navegação reversível', () => {
    const session = new DebugSession('while True:\n    pass', { language: 'python', maxSteps: 17 });
    const control = new ExecutionControl(session); control.start('continue');
    expect(control.runBatch(100).stop?.reason).toBe('budget');
    expect(control.running).toBe(false); expect(session.cursor).toBe(17);
    expect(run(control, 'reverse-continue').reason).toBe('start'); expect(session.cursor).toBe(0);
    control.start('continue'); expect(control.runBatch(100).stop?.reason).toBe('budget');
    expect(session.history).toHaveLength(17);
  });
  it('finalização não vira breakpoint na função cujas instruções vêm depois de HALT', () => {
    const session = new DebugSession('def f():\n    return 1\nresult = 2', { language: 'python' });
    const control = new ExecutionControl(session); control.toggleBreakpoint(2);
    expect(run(control, 'continue').reason).toBe('halted');
    expect(run(control, 'continue').reason).toBe('halted');
  });
  it('replay com controles não executa código nem cria novos registros', () => {
    const { session, states } = reference(example('python-factorial.py'));
    const control = new ExecutionControl(session); control.toggleBreakpoint(2);
    session.seek(0);
    const execute = vi.spyOn(machine, 'executeInstruction');
    try {
      while (session.canForward) {
        run(control, 'into'); expect(snapshot(session)).toEqual(states[session.cursor]);
      }
      run(control, 'reverse-continue'); run(control, 'back-statement');
      expect(snapshot(session)).toEqual(states[session.cursor]);
      expect(execute).not.toHaveBeenCalled(); expect(session.history).toHaveLength(states.length - 1);
    } finally { execute.mockRestore(); }
  });
  it.each(['rewind', 'python'])('sequências geradas de controles em %s preservam todo o estado', language => {
    const code = example(language === 'python' ? 'python-factorial.py' : 'factorial.rw');
    const { states } = reference(code, language);
    fc.assert(fc.property(fc.array(fc.constantFrom<RunMode>('continue', 'reverse-continue', 'into', 'over', 'out', 'back-statement'), { minLength: 20, maxLength: 70 }), moves => {
      const session = new DebugSession(code, { language, checkpointInterval: 3, maxCheckpoints: 4 });
      const control = new ExecutionControl(session);
      for (const line of session.program.breakableLines) control.toggleBreakpoint(line);
      for (const mode of moves) {
        if (mode === 'out' && !control.canStepOut) continue;
        run(control, mode, 3); expect(snapshot(session)).toEqual(states[session.cursor]);
      }
      control.breakpointsEnabled = false; run(control, 'continue');
      expect(snapshot(session)).toEqual(states.at(-1));
    }), { numRuns: 80, seed: 20261010 });
  });
});
