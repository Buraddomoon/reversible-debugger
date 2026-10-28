import { DebugSession } from '/src/core/debugger.ts';
import { PagedRecordingClient } from '/src/ui/paged-client.ts';
import { PagedComparisonClient } from '/src/ui/paged-comparison-client.ts';
import { importHistoryInWorker } from '/src/ui/import-history.ts';
import { loadExecutionInWorker } from '/src/ui/load-execution.ts';
import { RecordingJournal } from '/src/core/recording-journal.ts';
import { ExecutionLibrary } from '/src/core/execution-library.ts';
import { encode, exportHistory } from '/src/core/portable-history.ts';
import { programVM } from '/src/core/vm-version.ts';

export async function probeStrings() {
  const runtime = { language: 'python', version: '3' }, details = { name: 'Strings nativas', filename: 'strings.py' };
  const source = 'def echo(text):\n    return "[" + text + "]"\na = ["ação", "🚀", "\\0", "#[]()"]\nb = a\ni = 0\ntext = ""\nwhile i < 20:\n    text += a[i % 4]\n    i += 1\nb[0] = echo(a[0])\nresult = echo(text)\nprint(a, result, len(result), str(True))';
  const oracle = new DebugSession(source, runtime), states = [JSON.stringify(encode(oracle.state))];
  while (oracle.canForward) { oracle.forward(); states.push(JSON.stringify(encode(oracle.state))); }
  if (oracle.state.control.error) throw new Error(oracle.state.control.error);
  const journal = new RecordingJournal(), library = new ExecutionLibrary(); let client, pair, saved;
  let id; const check = (state, cursor) => { if (JSON.stringify(encode(state)) !== states[cursor]) throw new Error(`State differs at ${cursor}`); };
  try {
    client = await PagedRecordingClient.startLive(source, runtime, details, { maxSteps: 50000, bufferBytes: 4096, cacheBytes: 1024 }); id = client.header.entry.id;
    while (client.snapshot.count < 80) await client.run();
    await client.seek(7); const pending = client.snapshot.recording.pendingSteps;
    if (!pending) throw new Error('Missing volatile future');
    const partial = (await client.capture(64 * 1024 * 1024)).session;
    if (programVM(partial.program) !== 'rewind-vm/3' || partial.cursor !== 7 || partial.history.length !== client.snapshot.count) throw new Error('Partial profile lost');
    partial.seek(partial.history.length); check(partial.state, partial.cursor);
    await client.seek(client.snapshot.count);
    while (client.snapshot.recording.canRecord) await client.control('continue');
    const count = client.snapshot.count; check(client.snapshot.state, count);
    await client.seek(7); const captured = (await client.capture(64 * 1024 * 1024)).session;
    const text = await exportHistory(captured, details), file = JSON.parse(text), imported = (await importHistoryInWorker(text)).session;
    if (file.version !== 3 || file.payload.vm !== 'rewind-vm/3') throw new Error('Wrong file version');
    saved = await library.save(captured, details); const loaded = (await loadExecutionInWorker(saved.id, { maxHistoryBytes: 64 * 1024 * 1024 })).session;
    await client.closeLive(); client.dispose();
    client = await PagedRecordingClient.resumeLive(id, { cacheBytes: 1024 });
    if (client.snapshot.recording.validation.reusedSteps !== count) throw new Error('VM3 prefix not reused');
    let checked = 0;
    for (let cursor = count; cursor >= 0; cursor--) {
      await client.seek(cursor); check(client.snapshot.state, cursor);
      imported.seek(cursor); check(imported.state, cursor); loaded.seek(cursor); check(loaded.state, cursor); captured.seek(cursor); check(captured.state, cursor); checked++;
    }
    for (let cursor = 0; cursor <= count; cursor++) { await client.seek(cursor); check(client.snapshot.state, cursor); checked++; }
    await client.closeLive(); client.dispose();
    pair = await PagedComparisonClient.open({ kind: 'journal', id, name: 'Journal' }, { kind: 'saved', id: saved.id, name: 'Captura' }, 64 * 1024 * 1024);
    if (pair.header.firstDifference !== null) throw new Error('Equal VM3 runs differ');
    for (const target of [pair.header.rows.length - 1, 0, Math.floor(pair.header.rows.length / 2)]) {
      await pair.seek(target); check(pair.snapshot.left.state, pair.snapshot.left.cursor); check(pair.snapshot.right.state, pair.snapshot.right.cursor);
    }
    pair.dispose(); pair = null;
    client = await PagedRecordingClient.open(saved.id, { cacheBytes: 1024 });
    for (let cursor = count; cursor >= 0; cursor--) { await client.seek(cursor); check(client.snapshot.state, cursor); checked++; }
    client.dispose(); client = null;
    const legacy = await (await fetch('/tests/fixtures/pre-strings-vm2.json')).json();
    for (const item of legacy.cases) {
      const copy = (await importHistoryInWorker(JSON.stringify(item.file))).session;
      if (programVM(copy.program) !== 'rewind-vm/2') throw new Error('Legacy profile changed during Worker transfer');
      for (let cursor = 0; cursor < item.states.length; cursor++) { copy.seek(cursor); if (JSON.stringify(encode(copy.state)) !== JSON.stringify(item.states[cursor])) throw new Error('Legacy state changed'); }
      copy.restart(); while (copy.canForward) copy.forward(); if (JSON.stringify(encode(copy.state)) !== JSON.stringify(item.states.at(-1))) throw new Error('Legacy restart changed');
    }
    return { count, exactStates: checked, vm: file.payload.vm, fileVersion: file.version, volatileFuture: pending, sourcePreserved: true, portableWorker: true, libraryWorker: true, pagedCapture: true, pagedComparison: true, legacyFiles: legacy.cases.length, note: 'Installed Firefox; native IndexedDB, application Workers and full-state oracle. No execution during navigation; independent legacy fixtures written at d62d861.' };
  } finally {
    pair?.dispose(); if (client) { if (client.isLive) await client.closeLive().catch(() => {}); client.dispose(); }
    if (saved) await library.delete(saved.id); if (id) await journal.delete(id); await library.close(); await journal.close();
  }
}
