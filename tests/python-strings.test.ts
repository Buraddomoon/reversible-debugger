import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { IDBFactory } from 'fake-indexeddb';
import { DebugSession } from '../src/core/debugger';
import type { Step } from '../src/core/machine';
import * as machine from '../src/core/machine';
import { encode, decode, digest, exportHistory, importHistory } from '../src/core/portable-history';
import { captureRecording, encodeBlocks, validateManifest } from '../src/core/history-blocks';
import { ExecutionLibrary } from '../src/core/execution-library';
import { CheckpointCache } from '../src/core/checkpoint-cache';
import { PagedHistoryStore } from '../src/core/paged-history';
import { RecordingJournal } from '../src/core/recording-journal';
import { LiveRecording } from '../src/core/live-recording';
import { formatValue, formatPythonOutput } from '../src/core/runtime';
import { MAX_STRING_UNITS, reprString } from '../src/core/python-strings';
import { LEGACY_VM, STRING_VM, programVM } from '../src/core/vm-version';
import { ExecutionComparison } from '../src/core/comparison';
import { journalValidator } from '../src/core/journal-validation-cache';

const runtime = { language: 'python', version: '3' } as const, fast = { yieldControl: async () => {} }, details = { name: 'Textos reversíveis', filename: 'texto.py' };
const python = (source: string) => new DebugSession(source, runtime);
function finish(session: DebugSession) { while (session.canForward) session.runBatch(); return session; }
const resources: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(resources.splice(0).map(resource => resource.close())); });
const bug = readFileSync(new URL('../examples/python-string-reverse-bug.py', import.meta.url), 'utf8');
const fixed = readFileSync(new URL('../examples/python-string-reverse-fixed.py', import.meta.url), 'utf8');

describe('strings Python: semântica e reversibilidade', () => {
  it.each([
    ['result = "Hello, world!"', 'Hello, world!'],
    ['result = "ação #1 [ok] (sim)" # comentário', 'ação #1 [ok] (sim)'],
    [String.raw`result = 'aspas \' e " e \\ e \n\r\t\a\b\f\v\x41\u00e7\U0001f680\101'`, 'aspas \' e " e \\ e \n\r\t\x07\b\f\vAç🚀A'],
    ['result = ("a" # comentário com \" [\n    "b" \'c\')', 'abc'],
    ['result = "a" + "ção"', 'ação'], ['result = "ab" * 3', 'ababab'],
    ['result = 2 * "🚀"', '🚀🚀'], ['result = "abc" * -1000000000000000000000', ''],
    ['result = "" * (10 ** 1000)', ''], ['result = "a" * True', 'a'],
    ['result = "a" * False', ''], ['result = "a" * 0', ''],
    ['result = len("a🚀é")', 3n], ['result = len("e\\u0301")', 2n],
    ['result = "a🚀é"[1]', '🚀'], ['result = "a🚀é"[-1]', 'é'],
    ['result = "a🚀é"[True]', '🚀'], ['result = "a🚀é"[False]', 'a'],
    ['result = "🚀" > "\\ue000"', true], ['result = "abc" <= "abd"', true],
    ['result = "a" == 1', false], ['result = "" != None', true],
    ['result = "" or "alternativa"', 'alternativa'], ['result = "texto" and "fim"', 'fim'],
    ['result = bool("")', false], ['result = not "x"', false], ['result = not ""', true],
    ['result = ["a", ["🚀"]] == ["a", ["🚀"]]', true],
    ['convert = str\nresult = convert(42)', '42'], ['result = str()', ''],
    ['result = str(True)', 'True'], ['result = str(None)', 'None'], ['result = str("x")', 'x'],
    ['result = str(["a", "b\\nc"])', "['a', 'b\\nc']"],
    ['def str(x):\n    return x + 1\nresult = str(41)', 42n],
  ])('executa %s', (source, expected) => {
    const session = finish(python(source)); expect(session.state.control.error).toBeNull(); expect(session.state.frames[0]!.locals.result).toBe(expected);
  });
  it('imprime strings sem aspas e strings em listas com repr, inclusive ciclos', () => {
    const session = finish(python('a = ["linha\\n2", "ação", "can\'t"]\na.append(a)\nprint("Hello, world!", "# [ ]")\nprint(a)'));
    expect(session.state.output.join('')).toBe('Hello, world! # [ ]\n[\'linha\\n2\', \'ação\', "can\'t", [...]]\n');
    expect(formatValue('a\nb', 'python')).toBe("'a\\nb'");
    expect(reprString('\x01\u00a0')).toBe("'\\x01\\xa0'");
    expect(formatValue('x'.repeat(100000), 'python').length).toBeLessThanOrEqual(161);
  });
  it.each([
    'result = "abc"[3]', 'result = "abc"[-4]', 'result = "abc"[1.0]', 'result = ""[0]',
    'result = "a" + 1', 'result = "a" * 2.0', 'result = "a" * "b"', 'result = "a" < 1',
    'result = -"a"', 'result = "a" % 2', 'result = str(1, 2)', 'result = int("42")',
    'text = "abc"\ntext[0] = "x"', 'text = "abc"\ntext.append(1 / 0)',
    'result = "x" * 100001', 'result = "🚀" * 50001',
    'result = ("x" * 100000) + "y"', 'print("x" * 100000)', 'print(["\\0" * 30000])',
  ])('desfaz erro atomicamente e reaplica sem executar: %s', source => {
    const session = python(source); let before = structuredClone(session.state);
    while (session.canForward) { before = structuredClone(session.state); session.forward(); }
    const error = structuredClone(session.state); expect(error.control.status).toBe('error');
    expect(error.frames).toEqual(before.frames); expect(error.operands).toEqual(before.operands); expect(error.heap).toEqual(before.heap); expect(error.output).toEqual(before.output);
    expect(session.lastStep!.changes.map(c => c.kind)).toEqual(['control']);
    const execute = vi.spyOn(machine, 'executeInstruction'); session.backward(); expect(session.state).toEqual(before); session.forward(); expect(session.state).toEqual(error); expect(execute).not.toHaveBeenCalled();
    if (source.includes('append')) expect(error.control.error).not.toContain('zero');
  });
  it.each([String.raw`result = '\q'`, String.raw`result = '\x1'`, String.raw`result = '\uD800'`, String.raw`result = '\U00110000'`, String.raw`result = '\400'`, 'result = "não fechada', 'result = "a\nb"', 'result = """tripla"""', 'result = f"{1}"', 'result = r"abc"', 'result = b"abc"', 'result = "\0"', `result = "${'x'.repeat(100001)}"`, 'result = "\ud800"'])('diagnostica literal não suportado (%#)', source => {
    expect(() => python(source)).toThrow(/linha \d+, coluna \d+/);
  });
  it('preserva limites, posições CRLF e lexing de comentários e delimitadores em texto', () => {
    const source = 'result = (\r\n    "#[("\r\n    "🚀" # ) ] \'\r\n)\r\nprint(result)';
    const session = finish(python(source)), literal = session.program.instructions.find(i => i.op === 'PUSH')!;
    expect(session.state.control.error).toBeNull(); expect(session.state.frames[0]!.locals.result).toBe('#[(🚀'); expect(literal.span.line).toBe(2);
    expect(source.slice(literal.span.start, literal.span.end)).toBe('"#[("\r\n    "🚀"');
    expect(finish(python('result = "x" * 100000')).state.frames[0]!.locals.result).toHaveLength(MAX_STRING_UNITS);
    expect(finish(python('result = "🚀" * 50000')).state.frames[0]!.locals.result).toHaveLength(MAX_STRING_UNITS);
  });
  for (const source of [bug, fixed, 'def f(text):\n    if not text:\n        return ""\n    return text[-1] + f("" )\na = ["ação", "\\0", "🚀"]\nb = a\nb[0] = b[0] + "!"\nresult = f(a[0])\nprint(a, result)']) it('restaura todos os campos em cada passo nos dois sentidos', () => {
    const session = python(source), states = [structuredClone(session.state)];
    while (session.canForward) { session.forward(); states.push(structuredClone(session.state)); }
    expect(session.state.control.error).toBeNull();
    const execute = vi.spyOn(machine, 'executeInstruction'), records = [...session.history];
    for (let i = states.length - 2; i >= 0; i--) { session.backward(); expect(session.state).toEqual(states[i]); }
    for (let i = 1; i < states.length; i++) { session.forward(); expect(session.state).toEqual(states[i]); }
    expect(execute).not.toHaveBeenCalled(); expect(session.history).toEqual(records);
    if (source === bug) expect(session.state.frames[0]!.locals.result).toBe('🚀ãça');
    if (source === fixed) expect(session.state.frames[0]!.locals.result).toBe('🚀ãçam');
  });
  it('gera sequências de navegação e strings Unicode sem normalizar nem perder valores', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom('a', 'é', 'e\u0301', '🚀', '#', '"', "'", '\n', '\t', '\0'), { maxLength: 12 }), fc.array(fc.nat(), { maxLength: 25 }), (parts, targets) => {
      const text = parts.join(''), session = python(`def identity(text):\n    return text + "!"\nwords = [${JSON.stringify(text)}]\nwords.append(identity(words[0]))\nresult = words[-1]\nprint(words, result)`), states = [structuredClone(session.state)];
      while (session.canForward) { session.forward(); states.push(structuredClone(session.state)); }
      expect(session.state.control.error).toBeNull(); expect(session.state.frames[0]!.locals.result).toBe(text + '!');
      const execute = vi.spyOn(machine, 'executeInstruction'); for (const target of [...targets, states.length - 1, 0]) { const cursor = target % states.length; session.seek(cursor); expect(session.state).toEqual(states[cursor]); } expect(execute).not.toHaveBeenCalled(); execute.mockRestore();
    }), { numRuns: 50, seed: 20261028 });
  });
  const native = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  it.skipIf(native.status !== 0)('compara semântica e saída com o Python instalado', () => {
    const programs = [bug, fixed, 'print("a🚀é", len("a🚀é"), "a🚀é"[-2], "🚀" > "\\ue000")\nprint(["\\x01", "\\u200b", "can\'t", "a\\nb"])\nprint(str(), str(None), str(True), str(["x"]))', 'print("" or "fallback", "x" and "fim", "a" == 1, "a" * -99, True * "🚀")'];
    for (const source of programs) { const result = spawnSync('python3', ['-c', source], { encoding: 'utf8', timeout: 5000 }); expect(result.status, result.stderr).toBe(0); const session = finish(python(source)); expect(session.state.control.error).toBeNull(); expect(session.state.output.join('')).toBe(result.stdout); }
  });
});

describe('strings em arquivos, blocos e journals, com leitura legada', () => {
  it('abre arquivos VM2 realmente produzidos antes da mudança, incluindo str sombreado/inexistente', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/pre-strings-vm2.json', import.meta.url), 'utf8'));
    expect(fixture.commit).toBe('d62d861');
    for (const legacy of fixture.cases) {
      const imported = await importHistory(JSON.stringify(legacy.file), fast), { session } = imported;
      expect(programVM(session.program)).toBe(LEGACY_VM);
      const execute = vi.spyOn(machine, 'executeInstruction');
      for (let i = legacy.states.length - 1; i >= 0; i--) { session.seek(i); expect(encode(session.state)).toEqual(legacy.states[i]); }
      for (let i = 0; i < legacy.states.length; i++) { session.seek(i); expect(encode(session.state)).toEqual(legacy.states[i]); }
      expect(execute).not.toHaveBeenCalled(); execute.mockRestore();
      session.seek(legacy.file.payload.cursor); expect(JSON.parse(await exportHistory(session, details, fast)).payload.programHash).toBe(legacy.file.payload.programHash);
      session.restart(); finish(session); expect(encode(session.state)).toEqual(legacy.states.at(-1));
    }
  });
  it.each([20000, 50000])('transfere arquivo, captura, biblioteca e journal VM3 com limite %s', async maxSteps => {
    const factory = new IDBFactory(), library = new ExecutionLibrary({ factory, name: 'strings-library' }), cache = new CheckpointCache(factory, 'strings-cache'), journal = new RecordingJournal(factory, 'strings-journal'); resources.push(library, cache, journal);
    const source = fixed + '\na = [result, "\\0", "\\\\", "__proto__", "$bigint"]\na.append(a)\nprint(a)';
    const session = new DebugSession(source, { ...runtime, maxSteps }), states = [structuredClone(session.state)]; while (session.canForward) { session.forward(); states.push(structuredClone(session.state)); }
    expect(session.state.control.error).toBeNull(); session.seek(7);
    const text = await exportHistory(session, details, fast), file = JSON.parse(text); expect(file.version).toBe(maxSteps > 20000 ? 3 : 2); expect(file.payload.vm).toBe(STRING_VM);
    const restored = (await importHistory(text, fast)).session, entry = await library.save(session, details, fast), loaded = (await library.load(entry.id, fast)).session;
    expect((await library.openRecording(entry.id)).manifest.header.vm).toBe(STRING_VM);
    const paged = await PagedHistoryStore.open(library, cache, entry.id, { cacheBytes: 1024 }, fast), live = await LiveRecording.start(journal, source, runtime, details, { maxSteps, bufferBytes: 4096, cacheBytes: 1024 }, fast);
    while (live.ledger.canRecord) await live.seek(live.count + 1, fast); await live.seek(7, fast); await live.close();
    expect((await journal.open(live.entry.id)).source.vm).toBe(STRING_VM); expect(journalValidator(live.program)).toContain('/2');
    const resumed = await LiveRecording.resume(journal, live.entry.id, { cacheBytes: 1024 }, fast); expect(resumed.ledger.validation.reusedSteps).toBe(live.count);
    const full = await LiveRecording.resume(journal, live.entry.id, { readOnly: true, validateAll: true }, fast); expect(full.ledger.validation.checkedSteps).toBe(live.count);
    const builder = DebugSession.recordingBuilder(source, { ...runtime, vm: programVM(resumed.program), maxSteps, maxFrames: 256 }, resumed.count, resumed.cursor);
    for await (const batch of resumed.streamRecords(resumed.count, fast)) builder.append(batch); const captured = await builder.finish(fast);
    const execute = vi.spyOn(machine, 'executeInstruction');
    for (let i = states.length - 1; i >= 0; i--) { for (const copy of [restored, loaded, captured]) { copy.seek(i); expect(copy.state).toEqual(states[i]); } await paged.seek(i, fast); expect(paged.state).toEqual(states[i]); await resumed.seek(i, fast); expect(resumed.state).toEqual(states[i]); }
    for (let i = 0; i < states.length; i++) { restored.seek(i); await paged.seek(i, fast); expect(restored.state).toEqual(states[i]); expect(paged.state).toEqual(states[i]); }
    expect(execute).not.toHaveBeenCalled(); paged.dispose(); await resumed.close();
  });
  it('recusa VM desconhecida, downgrade e strings fora da quota sem publicar uma sessão', async () => {
    const file = JSON.parse(await exportHistory(finish(python('result = "hello"')), details, fast));
    for (const vm of ['rewind-vm/99', LEGACY_VM]) { const changed = structuredClone(file); changed.payload.vm = vm; changed.checksum = await digest(JSON.stringify(changed.payload)); await expect(importHistory(JSON.stringify(changed), fast)).rejects.toThrow(/VM|vm|incompatível/); }
    const header = await captureRecording(finish(python('result = "hello"')), details, 'strings', Date.now()), blocks = []; for await (const b of encodeBlocks(header, fast)) blocks.push(b);
    const manifest = JSON.stringify({ header: { ...header.header, vm: LEGACY_VM }, blocks: blocks.map(({ runId: _run, content: _content, ...descriptor }) => descriptor) });
    await expect(validateManifest(manifest, await digest(manifest), 'strings')).rejects.toThrow();
    const legacy = finish(python('result = 1 + 2')); const records = structuredClone(legacy.history) as Step[]; const binary = records.find(s => s.op === 'BINARY')!; const push = [...binary.changes].reverse().find(c => c.kind === 'operands' && c.added.length)!; if (push.kind === 'operands') push.added[0] = 'injetado';
    await expect(DebugSession.restoreRecording(legacy.program.source, { ...runtime, vm: LEGACY_VM, maxSteps: 20000, maxFrames: 256 }, records, 0, fast)).rejects.toThrow('strings exigem');
    const withStrings = finish(python('result = "a" + "b"'));
    for (const invalid of ['x'.repeat(MAX_STRING_UNITS + 1), '\ud800']) {
      const bad = structuredClone(withStrings.history) as Step[], binary = bad.find(s => s.op === 'BINARY')!;
      const result = [...binary.changes].reverse().find(c => c.kind === 'operands' && c.added.length)!; if (result.kind === 'operands') result.added[0] = invalid;
      await expect(DebugSession.restoreRecording(withStrings.program.source, { ...runtime, vm: STRING_VM, maxSteps: 20000, maxFrames: 256 }, bad, 0, fast)).rejects.toThrow(/String excede|Surrogates/);
    }
    expect(decode(encode({ value: '$bigint', nested: ['__proto__', '\0', '🚀'] }))).toEqual({ value: '$bigint', nested: ['__proto__', '\0', '🚀'] });
  });
  it('compara o bug e a correção sem perder valores nos saltos', async () => {
    const comparison = new ExecutionComparison({ source: bug, name: 'Bug', ...runtime }, { source: fixed, name: 'Corrigido', ...runtime });
    while (!comparison.ready) comparison.prepareBatch(); expect(comparison.left.finalResult).toEqual({ present: true, value: '🚀ãça' }); expect(comparison.right.finalResult).toEqual({ present: true, value: '🚀ãçam' }); expect(comparison.firstDifference).not.toBeNull();
    const execute = vi.spyOn(machine, 'executeInstruction');
    for (const cursor of [comparison.rows.length - 1, comparison.firstDifference!, 0, comparison.rows.length - 1]) { comparison.seekRow(cursor); expect(comparison.cursor).toBe(cursor); }
    expect(execute).not.toHaveBeenCalled();
  });
  it('limita repr na interface, preserva texto real e cobra o payload do histórico', () => {
    const session = new DebugSession('result = "x" * 10000', { ...runtime, maxHistoryBytes: 64 * 1024 });
    while (session.canForward && !session.recordingStop) session.forward();
    expect(session.storageStats.estimatedBytes).toBeLessThanOrEqual(64 * 1024);
    expect(formatPythonOutput('x'.repeat(10000), {})).toHaveLength(10000);
  });
});
