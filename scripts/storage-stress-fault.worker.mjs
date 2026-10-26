// Only loaded by the opt-in browser stress command. Temporary database only.
import { stressFixtures, stressRuntime } from '/scripts/stress-fixtures.ts';
import { LiveRecording } from '/src/core/live-recording.ts';
import { RecordingJournal } from '/src/core/recording-journal.ts';
import { encode } from '/src/core/portable-history.ts';
const details = { name: 'Fault stress', filename: 'fault.py' };
const state = live => JSON.stringify(encode(live.state));
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
async function rows(journalId) {
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open('rewind.storage-stress-tests'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try { return await new Promise((resolve, reject) => { const r = db.transaction('blocks').objectStore('blocks').index('runId').getAll(journalId); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
  finally { db.close(); }
}
onmessage = async () => {
  const journal = new RecordingJournal(indexedDB, 'rewind.storage-stress-tests'), put = IDBObjectStore.prototype.put;
  try {
    const fixture = stressFixtures[0], live = await LiveRecording.start(journal, fixture.source, stressRuntime, details, { cacheBytes: 1024, bufferBytes: 32768 });
    while (live.program.instructions[live.state.control.pc]?.op !== 'BUILD_LIST') await live.seek(live.count + 1);
    await live.flush(); const before = await journal.open(live.entry.id), count = live.count, blockCount = (await rows(live.entry.id)).length;
    IDBObjectStore.prototype.put = function(...args) { if (this.name === 'heads') throw new DOMException('Controlled quota', 'QuotaExceededError'); return put.apply(this, args); };
    try { await live.seek(count + 1); } finally { IDBObjectStore.prototype.put = put; }
    const accepted = state(live), disk = await journal.open(live.entry.id);
    ensure(live.ledger.pauseReason && live.ledger.pendingSteps === 1 && live.ledger.oversized, 'Large pending delta not retained');
    ensure(JSON.stringify(disk.head) === JSON.stringify(before.head) && (await rows(live.entry.id)).length === blockCount, 'Native quota left partial head/orphan block');
    await live.seek(0); await live.seek(count + 1); ensure(state(live) === accepted, 'Volatile future changed');
    ensure(await live.flush(), 'Large retry failed'); await live.flush();
    ensure((await rows(live.entry.id)).length === blockCount + 1, 'Large retry duplicated rows');
    const oversized = (await rows(live.entry.id)).find(b => b.bytes > 262144);
    ensure(oversized?.count === 1, 'Large delta not isolated');

    // Persisted corruption must not change an already published large state.
    const db = await new Promise(resolve => { const r = indexedDB.open('rewind.storage-stress-tests'); r.onsuccess = () => resolve(r.result); });
    const store = value => new Promise((resolve, reject) => { const tx = db.transaction('blocks', 'readwrite'); tx.objectStore('blocks').put(value); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    try {
      await store({ ...oversized, content: '[]' }); let refused = false;
      try { await live.seek(count); } catch { refused = true; }
      ensure(refused && state(live) === accepted && live.cursor === count + 1, 'Corrupt large block published partial state');
      await store(oversized); await live.seek(count); await live.seek(count + 1); ensure(state(live) === accepted, 'Repair did not recover');
    } finally { db.close(); }
    while (live.ledger.canRecord) await live.seek(live.count + 1);
    ensure(live.state.output.join('') === '81\n', 'Retry duplicated output'); await live.close(); await journal.delete(live.entry.id);

    // Unknown outcome after committing a large delta is reconciled by hash.
    const uncertain = await LiveRecording.start(journal, fixture.source, stressRuntime, details, { bufferBytes: 32768 });
    while (uncertain.program.instructions[uncertain.state.control.pc]?.op !== 'BUILD_LIST') await uncertain.seek(uncertain.count + 1);
    await uncertain.flush(); const first = uncertain.count, commit = journal.commit.bind(journal);
    journal.commit = async (...args) => { const result = await commit(...args); if (args[2].block?.bytes > 262144) throw new Error('Lost large commit response'); return result; };
    try { await uncertain.seek(first + 1); } finally { journal.commit = commit; }
    ensure(uncertain.ledger.durable === first + 1 && uncertain.ledger.pendingSteps === 0, 'Unknown outcome not reconciled');
    await uncertain.close(); await journal.delete(uncertain.entry.id);

    // A pre-flush can fail before the speculative large delta is accepted.
    const preflush = await LiveRecording.start(journal, fixture.source, stressRuntime, details, { bufferBytes: 32768, cacheBytes: 1024 });
    while (preflush.program.instructions[preflush.state.control.pc]?.op !== 'BUILD_LIST') await preflush.seek(preflush.count + 1);
    const preState = state(preflush), preCount = preflush.count, prePending = preflush.ledger.pendingSteps, preDisk = await journal.open(preflush.entry.id);
    ensure(prePending > 0, 'Missing pre-flush buffer');
    IDBObjectStore.prototype.put = function(...args) { if (this.name === 'heads') throw new DOMException('Pre-flush quota', 'QuotaExceededError'); return put.apply(this, args); };
    let acceptedEarly = false, preRefused = false;
    try { await preflush.seek(preCount + 1, { beforePublish: async () => { acceptedEarly = true; } }); } catch { preRefused = true; }
    finally { IDBObjectStore.prototype.put = put; }
    ensure(preRefused && !acceptedEarly && state(preflush) === preState && preflush.count === preCount && preflush.ledger.pendingSteps === prePending, 'Speculative large delta survived failed pre-flush');
    ensure(JSON.stringify((await journal.open(preflush.entry.id)).head) === JSON.stringify(preDisk.head), 'Failed pre-flush changed durable head');
    ensure(await preflush.flush(), 'Pre-flush retry failed'); await preflush.seek(preCount + 1);
    ensure(preflush.count === preCount + 1 && Object.keys(preflush.state.heap).length === 1, 'Pre-flush retry duplicated allocation');
    await preflush.close(); await journal.delete(preflush.entry.id);

    const aux = await LiveRecording.start(journal, stressFixtures[1].source, stressRuntime, details, { bufferBytes: 32768 });
    IDBObjectStore.prototype.put = function(...args) { if (['states', 'prefixes'].includes(this.name)) throw new DOMException('Derived quota', 'QuotaExceededError'); return put.apply(this, args); };
    try { while (aux.ledger.canRecord) await aux.seek(aux.count + 1); await aux.close(); } finally { IDBObjectStore.prototype.put = put; }
    ensure(aux.ledger.durable === aux.count && !aux.ledger.pauseReason && aux.ledger.navigation.warning && aux.ledger.validation.cacheWarning, 'Derived quota invalidated primary commit');
    const final = state(aux), resumed = await LiveRecording.resume(journal, aux.entry.id, { cacheBytes: 1024 });
    ensure(state(resumed) === final && resumed.ledger.validation.reusedSteps === 0, 'Derived quota prevented full recovery');
    await resumed.close(); await journal.delete(aux.entry.id);
    postMessage({ atomicNativeQuotaRollback: true, orphanBlocks: 0, largeBlockBytes: oversized.bytes, retryWithoutDuplicate: true,
      largeCorruptionPreservedState: true, repairedReplayExact: true, lostResponseReconciled: true, preflushPreservedUnacceptedState: true, derivedQuotaPreservedPrimary: true });
  } catch (error) { postMessage({ error: error.stack ?? error.message }); }
  finally { IDBObjectStore.prototype.put = put; await journal.close(); }
};
