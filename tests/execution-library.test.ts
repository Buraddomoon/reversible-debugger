import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import fc from 'fast-check';
import { DebugSession, type RecordingJob } from '../src/core/debugger';
import { ExecutionLibrary, STAGING_LEASE_MS } from '../src/core/execution-library';
import { captureRecording, encodeBlocks, BLOCK_BYTES, BLOCK_STEPS, utf8Bytes } from '../src/core/history-blocks';
import { digest, exportHistory, importHistory } from '../src/core/portable-history';
import { activeHistoryBudget, heldHistoryBytes, PAGE_HISTORY_BYTES, stagingHistoryBudget } from '../src/core/page-budget';
import * as machine from '../src/core/machine';

const fast: RecordingJob = { yieldControl: async () => {} }, details = { name: 'Minha execução', filename: 'minha.py' };
const open: ExecutionLibrary[] = [];
function setup(options: { maxDiskBytes?: number; maxExecutions?: number } = {}) {
  const factory = new IDBFactory(), name = 'test';
  const library = new ExecutionLibrary({ factory, name, ...options }); open.push(library);
  return { factory, name, library };
}
function record(source: string, language = 'python', count = 20_000) {
  const session = new DebugSession(source, { language, maxSteps: count }); const states = [structuredClone(session.state)];
  while (session.canForward && session.history.length < count) { session.forward(); states.push(structuredClone(session.state)); }
  return { session, states };
}
async function rawDB(factory: IDBFactory, name: string, operation: (tx: IDBTransaction) => void, stores = ['catalog', 'manifests', 'blocks']) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = factory.open(name); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction(stores, 'readwrite'); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); operation(tx); }); }
  finally { db.close(); }
}
async function changeManifest(factory: IDBFactory, name: string, id: string, change: (manifest: any) => void) {
  let saved: any;
  await rawDB(factory, name, tx => { const req = tx.objectStore('manifests').get(id); req.onsuccess = () => { saved = req.result; }; });
  const beforeBytes = utf8Bytes(saved.content), parsed = JSON.parse(saved.content); change(parsed); saved.content = JSON.stringify(parsed); saved.checksum = await digest(saved.content);
  await rawDB(factory, name, tx => { tx.objectStore('manifests').put(saved); });
  return utf8Bytes(saved.content) - beforeBytes;
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(open.splice(0).map(library => library.close())); });

describe('biblioteca IndexedDB em blocos', () => {
  for (const [label, language, source] of [
    ['chamadas e decisões', 'python', 'def sum_to(n):\n    total = 0\n    i = 1\n    while i < n:\n        total += i\n        i += 1\n    return total\nresult = sum_to(5)\nprint(result)'],
    ['aliases, ciclos e erro', 'python', 'a = [1, 2]\nb = a\na.append(a)\ndef change(items):\n    items[0] = 99\n    return items\nc = change(b)\nprint(c)\nresult = c[99]'],
    ['inteiros e números especiais', 'python', 'a = 90071992547409931234567890\nb = -0.0\nc = 1e308 * 1e308\nd = c - c\ne = None\n__proto__ = a\nconstructor = print\nprint(a, b, d)'],
    ['experimental', 'rewind', 'let x = 1; while (x < 4) { x = x + 1; } let result = x;'],
  ]) it(`reabre ${label}, restaura todos os estados e mantém o futuro sem executar`, async () => {
    const { factory, name, library } = setup(), { session, states } = record(source!, language!);
    session.seek(Math.floor(session.history.length / 2)); const cursor = session.cursor;
    const entry = await library.save(session, details, fast); await library.close();
    const reopened = new ExecutionLibrary({ factory, name }); open.push(reopened);
    const execute = vi.spyOn(machine, 'executeInstruction');
    const history = await reopened.load(entry.id, fast);
    expect(history.session.cursor).toBe(cursor); expect(history.session.state).toEqual(states[cursor]); expect(history.session.history).toEqual(session.history);
    for (let i = 0; i < states.length; i++) { history.session.seek(i); expect(history.session.state).toEqual(states[i]); }
    for (let i = states.length - 1; i >= 0; i--) { history.session.seek(i); expect(history.session.state).toEqual(states[i]); }
    expect(execute).not.toHaveBeenCalled(); expect(session.cursor).toBe(cursor); expect(session.state).toEqual(states[cursor]);
    execute.mockRestore();
    const portable = await importHistory(await exportHistory(history.session, details, fast), fast);
    expect(portable.session.history).toEqual(session.history);
  });
  it('navegação gerada após reabrir cruza blocos com estado completo idêntico', async () => {
    const { library } = setup(), { session, states } = record('a = [0]\nb = a\ni = 0\nwhile i < 40:\n    b[0] = i\n    i += 1\nresult = a[0]');
    const saved = await library.save(session, details, fast); expect(saved.blocks).toBeGreaterThan(1);
    const restored = (await library.load(saved.id, fast)).session;
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: session.history.length }), { minLength: 1, maxLength: 50 }), targets => { for (const cursor of targets) { restored.seek(cursor); expect(restored.state).toEqual(states[cursor]); } }), { numRuns: 30 });
  });
  it('separa blocos por bytes/passos e captura código/cursor/futuro antes dos awaits', async () => {
    const { session } = record('i = 0\nwhile i < 70:\n    print(12345678901234567890)\n    i += 1'); session.seek(7);
    const capture = captureRecording(session, details, 'test-id', Date.now()); session.restart();
    const snapshot = await capture, blocks = [];
    for await (const block of encodeBlocks(snapshot, fast)) blocks.push(block);
    expect(snapshot.header.cursor).toBe(7); expect(snapshot.header.count).toBeGreaterThan(BLOCK_STEPS);
    expect(blocks.reduce((sum, b) => sum + b.count, 0)).toBe(snapshot.header.count);
    expect(blocks.every(b => b.count <= BLOCK_STEPS && b.bytes <= BLOCK_BYTES && b.bytes === utf8Bytes(b.content))).toBe(true);
    const bigSession = new DebugSession(`a = [${Array.from({ length: 800 }, () => '1'.repeat(700)).join(',')}]`, { language: 'python' });
    while (bigSession.canForward) bigSession.runBatch(256);
    let oversized = 0;
    for await (const block of encodeBlocks(await captureRecording(bigSession, details, 'big', Date.now()), fast)) { if (block.bytes > BLOCK_BYTES) { oversized++; expect(block.count).toBe(1); } }
    expect(oversized).toBeGreaterThan(0);
  });
  it('lista somente metadados, sem carregar fonte, manifesto ou deltas', async () => {
    const { library } = setup(), { session } = record('result = 42'); const saved = await library.save(session, details, fast);
    const get = vi.spyOn(IDBObjectStore.prototype, 'get'), getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    expect(await library.list()).toEqual([saved]); expect(get).not.toHaveBeenCalled();
    expect(getAll.mock.instances.map(store => (store as IDBObjectStore).name)).toEqual(['catalog']); expect(Object.keys(saved)).not.toContain('source');
  });
  it('salva uma captura consistente mesmo quando fonte/cursor/metadados mudam durante a gravação', async () => {
    const { library } = setup(), { session } = record('result = 42'); session.seek(1);
    const mutable = { ...details }, count = session.history.length, before = structuredClone(session.state);
    const pending = library.save(session, mutable, fast); mutable.name = 'Outro nome'; mutable.filename = 'outro.py'; session.restart();
    const saved = await pending, restored = await library.load(saved.id, fast);
    expect(saved.name).toBe(details.name); expect(saved.filename).toBe(details.filename); expect(saved.cursor).toBe(1); expect(saved.count).toBe(count);
    expect(restored.session.state).toEqual(before); expect(restored.session.history).toHaveLength(count); expect(session.history).toHaveLength(0);
  });
  it('suporta gravação vazia e parcial sem inventar estados nem executar além da fronteira', async () => {
    const { library } = setup();
    for (const source of ['', 'while True:\n    pass']) {
      const { session } = record(source, 'python', 35); if (!source) session.restart();
      const saved = await library.save(session, details, fast), loaded = (await library.load(saved.id, fast)).session;
      expect(loaded.history.length).toBe(session.history.length); expect(loaded.state).toEqual(session.state); expect(loaded.replayOnly).toBe(true); expect(loaded.canForward).toBe(false);
      loaded.seek(0); loaded.seek(loaded.history.length); expect(loaded.state).toEqual(session.state);
    }
  });
  it('cancelar gravação remove somente a reserva incompleta e seus blocos', async () => {
    const { factory, name, library } = setup(); const first = await library.save(record('result = 1').session, details, fast);
    const controller = new AbortController(), { session } = record('i = 0\nwhile i < 60:\n    i += 1'); const state = structuredClone(session.state);
    await expect(library.save(session, details, { ...fast, signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow();
    expect(await library.list()).toEqual([first]); expect((await library.stats()).pending).toBe(0); expect(session.state).toEqual(state);
    let blocks: any[] = []; await rawDB(factory, name, tx => { const req = tx.objectStore('blocks').getAll(); req.onsuccess = () => { blocks = req.result; }; });
    expect(blocks.every(b => b.runId === first.id)).toBe(true);
  });
  it('recusa quota agregada e mantém execuções anteriores intactas', async () => {
    const { factory, name, library } = setup(); const first = await library.save(record('result = 1').session, details, fast);
    const limited = new ExecutionLibrary({ factory, name, maxDiskBytes: first.bytes + 3000 }); open.push(limited);
    await expect(limited.save(record('i = 0\nwhile i < 80:\n    i += 1').session, details, fast)).rejects.toThrow(/orçamento/);
    expect(await library.list()).toEqual([first]); expect((await library.stats()).pending).toBe(0); expect((await library.load(first.id, fast)).session.state.frames[0]!.locals.result).toBe(1n);
  });
  it('QuotaExceededError real da API aborta o bloco e libera a reserva', async () => {
    const { library } = setup(); const first = await library.save(record('result = 1').session, details, fast);
    const add = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value: any, key?: IDBValidKey) {
      if (this.name === 'blocks') throw new DOMException('Disco cheio', 'QuotaExceededError');
      return add.call(this, value, key);
    });
    await expect(library.save(record('result = 2').session, details, fast)).rejects.toThrow(/navegador não tem espaço/);
    expect(await library.list()).toEqual([first]); expect((await library.stats()).pending).toBe(0);
  });
  it('duas abas reservam a quota de entradas atomicamente', async () => {
    const { factory, name, library } = setup({ maxExecutions: 1 });
    const second = new ExecutionLibrary({ factory, name, maxExecutions: 1 }); open.push(second);
    const { session } = record('result = 1');
    const results = await Promise.allSettled([library.save(session, details, fast), second.save(session, details, fast)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(await library.list()).toHaveLength(1); expect((await library.stats()).pending).toBe(0);
  });
  it('duas abas não ultrapassam a quota de bytes durante publicação', async () => {
    const { factory, name, library } = setup(); const { session } = record('result = 123'); const first = await library.save(session, details, fast);
    await library.delete(first.id);
    const a = new ExecutionLibrary({ factory, name, maxDiskBytes: first.bytes + 100 }), b = new ExecutionLibrary({ factory, name, maxDiskBytes: first.bytes + 100 }); open.push(a, b);
    const results = await Promise.allSettled([a.save(session, details, fast), b.save(session, details, fast)]);
    // Both writers may fail while their live reservations overlap, but never exceed quota.
    expect(results.filter(r => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
    expect((await library.stats()).bytes).toBeLessThanOrEqual(first.bytes + 100); expect((await library.stats()).pending).toBe(0);
  });
  it('recupera gravação expirada após interrupção, preservando outra aba ativa e prontos', async () => {
    const { factory, name, library } = setup(); const ready = await library.save(record('result = 1').session, details, fast), now = Date.now();
    await rawDB(factory, name, tx => {
      const req = tx.objectStore('catalog').get(ready.id);
      req.onsuccess = () => { for (const [id, lease] of [['expired', now - 1], ['live', now + STAGING_LEASE_MS]] as const) { tx.objectStore('catalog').add({ ...req.result, id, status: 'writing', lease }); tx.objectStore('blocks').add({ runId: id, index: 0, content: 'interrompido' }); tx.objectStore('manifests').add({ id, content: 'interrompido' }); } };
    });
    expect(await library.recover(now)).toBe(1); expect(await library.list()).toEqual([ready]); expect((await library.stats()).pending).toBe(1);
    let expired: unknown, live: unknown; await rawDB(factory, name, tx => { const e = tx.objectStore('blocks').get(['expired', 0]), l = tx.objectStore('blocks').get(['live', 0]); e.onsuccess = () => { expired = e.result; }; l.onsuccess = () => { live = l.result; }; });
    expect(expired).toBeUndefined(); expect(live).toBeDefined();
  });
  it('leitura cancelável mantém sessão aberta intacta e pode ser repetida', async () => {
    const { library } = setup(), { session } = record('i = 0\nwhile i < 50:\n    i += 1'); session.seek(7);
    const saved = await library.save(session, details, fast), state = structuredClone(session.state), controller = new AbortController();
    let received = 0;
    await expect(library.load(saved.id, { ...fast, signal: controller.signal, onChunk: async records => { received += records.length; if (received >= 16) controller.abort(); } })).rejects.toThrow();
    expect(received).toBe(16); expect(session.state).toEqual(state); expect(session.cursor).toBe(7);
    const loaded = await library.load(saved.id, fast); expect(loaded.session.state).toEqual(state); expect(loaded.session.history).toEqual(session.history);
  });
  it('baixo orçamento de carregamento recusa o staging sem truncar o disco', async () => {
    const { library } = setup(), { session } = record('i = 0\nwhile i < 50:\n    i += 1'); const saved = await library.save(session, details, fast);
    await expect(library.load(saved.id, { ...fast, maxHistoryBytes: 2048 })).rejects.toThrow(/Orçamento/);
    expect(await library.list()).toEqual([saved]); expect((await library.load(saved.id, fast)).session.state).toEqual(session.state);
  });
  it('exclusão durante leitura recusa a sessão incompleta sem recriar dados', async () => {
    const { library } = setup(), { session } = record('i = 0\nwhile i < 70:\n    i += 1'); const saved = await library.save(session, details, fast); let deleted = false;
    await expect(library.load(saved.id, { ...fast, onChunk: async () => { if (!deleted) { deleted = true; await library.delete(saved.id); } } })).rejects.toThrow();
    expect(await library.list()).toEqual([]); expect(session.state.frames[0]!.locals.i).toBe(70n);
  });
  it('excluir remove manifesto/blocos somente daquela execução', async () => {
    const { factory, name, library } = setup(); const a = await library.save(record('result = 1').session, details, fast), b = await library.save(record('result = 2').session, details, fast);
    await library.delete(a.id); await library.delete(a.id); expect(await library.list()).toEqual([b]);
    let blocks: any[] = [], manifest: unknown; await rawDB(factory, name, tx => { const req = tx.objectStore('blocks').getAll(), m = tx.objectStore('manifests').get(a.id); req.onsuccess = () => { blocks = req.result; }; m.onsuccess = () => { manifest = m.result; }; });
    expect(manifest).toBeUndefined(); expect(blocks.every(b => b.runId !== a.id)).toBe(true); expect((await library.load(b.id, fast)).session.state.frames[0]!.locals.result).toBe(2n);
  });
  it('banco de versão futura é recusado sem resetar dados', async () => {
    const { factory, name, library } = setup(); const saved = await library.save(record('result = 42').session, details, fast); await library.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = factory.open(name, 2); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); db.close();
    await expect(library.list()).rejects.toThrow(/VersionError.*preservados/);
    let manifest: unknown; await rawDB(factory, name, tx => { const req = tx.objectStore('manifests').get(saved.id); req.onsuccess = () => { manifest = req.result; }; }); expect(manifest).toBeDefined();
  });
  for (const [label, change] of [
    ['versão', (m: any) => { m.header.version = 2; }],
    ['VM', (m: any) => { m.header.vm = 'outra'; }],
    ['programa', (m: any) => { m.header.source = 'result = 999'; }],
    ['cursor', (m: any) => { m.header.cursor = 20001; }],
    ['lacuna', (m: any) => { m.blocks[0].first = 1; }],
    ['índice repetido', (m: any) => { m.blocks.push(m.blocks[0]); }],
    ['campos extras', (m: any) => { m.header.unexpected = true; }],
    ['contagem', (m: any) => { m.blocks[0].count--; }],
    ['estado inicial', (m: any) => { m.header.initial.frames = []; }],
  ] as const) it(`manifesto com checksum recalculado ainda rejeita ${label}`, async () => {
    const { factory, name, library } = setup(); const saved = await library.save(record('result = 42').session, details, fast);
    await changeManifest(factory, name, saved.id, change); await expect(library.load(saved.id, fast)).rejects.toThrow();
    expect(await library.list()).toEqual([saved]);
  });
  for (const kind of ['checksum', 'identidade', 'ausente', 'delta-inválido'] as const) it(`bloco ${kind} nunca publica uma sessão`, async () => {
    const { factory, name, library } = setup(); const saved = await library.save(record('result = 42').session, details, fast);
    let block: any;
    await rawDB(factory, name, tx => { const req = tx.objectStore('blocks').get([saved.id, 0]); req.onsuccess = () => { block = req.result; }; });
    if (kind === 'checksum') block.content = block.content.replace('42', '43');
    if (kind === 'identidade') block.first = 1;
    if (kind === 'delta-inválido') {
      const beforeBytes = block.bytes, records = JSON.parse(block.content); records[0].changes.find((c: any) => c.kind === 'control').before.pc = 99999;
      block.content = JSON.stringify(records); block.bytes = utf8Bytes(block.content); block.checksum = await digest(block.content);
      const manifestExtra = await changeManifest(factory, name, saved.id, m => { m.blocks[0].bytes = block.bytes; m.blocks[0].checksum = block.checksum; });
      await rawDB(factory, name, tx => { const req = tx.objectStore('catalog').get(saved.id); req.onsuccess = () => { tx.objectStore('catalog').put({ ...req.result, bytes: saved.bytes + block.bytes - beforeBytes + manifestExtra }); }; });
    }
    await rawDB(factory, name, tx => { if (kind === 'ausente') tx.objectStore('blocks').delete([saved.id, 0]); else tx.objectStore('blocks').put(block); });
    await expect(library.load(saved.id, fast)).rejects.toThrow(kind === 'delta-inválido' ? /inteiro fora dos limites/ : undefined); expect(await library.list()).toHaveLength(1);
  });
});

describe('restauração incremental e orçamento agregado', () => {
  it('builder nunca publica um prefixo incompleto ou uma cadeia que falhou', async () => {
    const { session } = record('result = 42'), options = { language: 'python', version: '3', maxSteps: session.maxSteps, maxFrames: session.maxFrames };
    const incomplete = DebugSession.recordingBuilder(session.program.source, options, session.history.length, 0); incomplete.append([session.history[0]]); await expect(incomplete.finish(fast)).rejects.toThrow(/incompleta/);
    const broken = DebugSession.recordingBuilder(session.program.source, options, session.history.length, 0);
    expect(() => broken.append([{}])).toThrow(); expect(() => broken.append([session.history[0]])).toThrow(/encerrada/); await expect(broken.finish(fast)).rejects.toThrow();
    const correct = DebugSession.recordingBuilder(session.program.source, options, session.history.length, 1); correct.append(session.history); expect((await correct.finish(fast)).state).toEqual((session.seek(1), session.state)); expect(correct.count).toBe(session.history.length); await expect(correct.finish(fast)).rejects.toThrow();
  });
  it('reserva importação em duas VMs e comparação em quatro, incluindo sessão atual', () => {
    const active = new DebugSession(''), a = new DebugSession(''), b = new DebugSession(''); const histories = [{ session: a }, { session: b }];
    expect(heldHistoryBytes(histories)).toBe(128 * 1024 * 1024); expect(activeHistoryBudget(histories)).toBe(128 * 1024 * 1024);
    const incoming = stagingHistoryBudget(histories, active, 2), comparison = stagingHistoryBudget(histories, active, 4);
    expect(incoming).toBe(32 * 1024 * 1024); expect(comparison).toBe(16 * 1024 * 1024);
    expect(heldHistoryBytes(histories) + active.storageStats.limitBytes + comparison * 4).toBe(PAGE_HISTORY_BYTES);
    active.setHistoryBudget(128 * 1024 * 1024); expect(() => stagingHistoryBudget(histories, active, 2)).toThrow(/agregado/);
    expect(() => stagingHistoryBudget([], active, 0)).toThrow();
  });
});
