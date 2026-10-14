import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Reuses the installed-Firefox harness/profile. All mutations are isolated test data. */
export async function runPagedBrowserFlows({ evaluate, command, context, click, activate, input, text, waitFor, shot, artifacts, browser }) {
  await click('Fechar histórico');
  await click('Abrir execução completa Listas em blocos'); await waitFor("document.querySelector('[data-testid=recording-banner]') && !document.querySelector('[data-testid=library-progress]')");
  assert.equal(await text('[data-testid=step-count]'), '123'); assert.equal(await evaluate("document.querySelector('[data-testid=paged-debugger]') === null"), true); await click('Fechar histórico');
  await command('browsingContext.reload', { context, wait: 'complete' }); await waitFor("document.querySelector('[data-saved-execution]')");
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  await click('Abrir execução Listas em blocos'); await waitFor("document.querySelector('[data-testid=paged-debugger]') && !document.querySelector('[data-testid=library-progress]')");
  assert.equal(await text('[data-testid=step-count]'), '123'); assert.ok(Number(await text('[data-testid=paged-cache-blocks]')) < 37);
  const scriptLibrary = await evaluate("localStorage.getItem('rewind.script-library.v1')");
  const runId = await evaluate("document.querySelector('[data-saved-execution]').getAttribute('data-saved-execution')");
  await evaluate("(() => { const select = document.querySelector('[aria-label=\"Limite do cache de blocos\"]'); select.value = '262144'; select.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await waitFor("document.querySelector('[data-testid=paged-cache-bytes]').textContent.includes('256 KiB')");
  for (const target of [4000, 8100, 2000, 6000, 123]) { await input('#timeline-target', String(target)); await click('Ir'); assert.equal(Number(await text('[data-testid=step-count]')), target); }
  assert.ok(Number(await text('[data-testid=paged-evictions]')) > 0); assert.ok(Number(await text('[data-testid=paged-cache-blocks]')) <= 2);
  await click('Avançar'); await waitFor("document.querySelector('[data-testid=step-count]').textContent === '124' && !document.querySelector('[data-testid=seek-progress]')");
  await click('Voltar'); await waitFor("document.querySelector('[data-testid=step-count]').textContent === '123' && !document.querySelector('[data-testid=seek-progress]')");
  await shot('firefox-paged-history.png');
  await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true); await shot('firefox-paged-history-mobile.png');
  await click('Fechar histórico');
  // Use the production RPC client in the same browser to compare complete machine
  // states against a sequential oracle, including fields hidden by paginated UI.
  const report = JSON.parse(await evaluate(`(async () => {
    const { PagedRecordingClient } = await import('/src/ui/paged-client.ts');
    const { DebugSession } = await import('/src/core/debugger.ts');
    const { examples } = await import('/src/examples.ts');
    const { encode } = await import('/src/core/portable-history.ts');
    const source = examples.find(e => e.id === 'python-cancellable-navigation').source;
    const wanted = new Set([0,1,123,124,300,2000,4000,6000,8100,9261]);
    const oracle = new DebugSession(source, { language:'python', maxHistoryBytes:4*1024*1024 }), states = new Map([[0,JSON.stringify(encode(oracle.state))]]);
    while(oracle.canForward) { try { oracle.forward(); } catch(error) { if(error.name !== 'HistoryBudgetError') throw error; } if(wanted.has(oracle.cursor)) states.set(oracle.cursor,JSON.stringify(encode(oracle.state))); }
    const same = (client,target) => { if(client.snapshot.cursor !== target || JSON.stringify(encode(client.snapshot.state)) !== states.get(target)) throw new Error('Estado completo difere no passo '+target); };
    const client = await PagedRecordingClient.open(${JSON.stringify(runId)}, { maxHistoryBytes:8*1024*1024, cacheBytes:262144 });
    try {
      const warm = { ...client.snapshot.stats }; same(client,123); if(warm.indexBuilt || warm.reads>2) throw new Error('Reabertura fez leitura integral');
      const begin = performance.now(); const samples=[];
      for(const target of [0,4000,8100,2000,6000,123,124,123,9261,0]) { const start=performance.now(); await client.seek(target); same(client,target); if(client.snapshot.stats.bytes>262144) throw new Error('Cache excedeu orçamento'); samples.push({target,ms:+(performance.now()-start).toFixed(2),...client.snapshot.stats}); }
      const allTargetsMs=performance.now()-begin;
      // Evict only derived checkpoints. The immutable original recording stays intact.
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('rewind.checkpoint-cache',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      await new Promise((resolve,reject)=>{const t=db.transaction('checkpoints','readwrite');t.objectStore('checkpoints').clear();t.oncomplete=resolve;t.onabort=()=>reject(t.error);});db.close();
      let heartbeats=0,paint=false,cancelled=false;const timer=setInterval(()=>heartbeats++,0);
      try { await client.seek(8100,{onSeekProgress:p=>{if(p.completed>=16&&!cancelled){cancelled=true;requestAnimationFrame(()=>{paint=true;client.cancel();});}}});throw new Error('Cancelamento deveria recusar o salto'); } catch(error){if(error.name!=='AbortError')throw error;}finally{clearInterval(timer);}
      same(client,0); if(!paint||!heartbeats)throw new Error('Cancelamento sem paint/heartbeat');
      let replacement=null,replaced=false;
      const old=client.seek(8100,{onSeekProgress:p=>{if(p.completed>=16&&!replaced){replaced=true;replacement=client.seek(123);}}});
      try{await old;throw new Error('Pedido antigo publicou estado');}catch(error){if(error.name!=='AbortError')throw error;}await replacement;same(client,123);
      await client.seek(6000);same(client,6000);await client.seek(0);same(client,0);
      // Simulate disk corruption after opening, then restore the isolated test block.
      const originalDb=await new Promise((resolve,reject)=>{const r=indexedDB.open('rewind.execution-library',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const key=[${JSON.stringify(runId)},1];
      const block=await new Promise((resolve,reject)=>{const r=originalDb.transaction('blocks').objectStore('blocks').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const put=data=>new Promise((resolve,reject)=>{const t=originalDb.transaction('blocks','readwrite');t.objectStore('blocks').put(data);t.oncomplete=resolve;t.onabort=()=>reject(t.error);});
      await client.setCacheBudget(1);await put({...block,content:'[]'});
      try{try{await client.seek(300);throw new Error('Bloco corrompido aceito');}catch(error){if(!/tamanho|checksum/.test(error.message))throw error;}same(client,0);}finally{await put(block);originalDb.close();}
      await client.seek(300);same(client,300);
      await client.seek(0);same(client,0);
      // Cancel precisely when a prepared response arrives, before the client ACK.
      // This test-owned client can intercept its handler; the app exposes no VM.
      const receiver=client.worker.onmessage,finalAbort=new AbortController();let armed=true;
      client.worker.onmessage=event=>{if(armed&&event.data.kind==='state'){armed=false;finalAbort.abort();}receiver(event);};
      try{try{await client.seek(123,{signal:finalAbort.signal});throw new Error('Confirmação cancelada publicou destino');}catch(error){if(error.name!=='AbortError')throw error;}same(client,0);}finally{client.worker.onmessage=receiver;}
      await client.seek(1);same(client,1);if(!client.snapshot.evidence)throw new Error('Worker ficou num cursor invisível após cancelar confirmação');
      return JSON.stringify({browser:${JSON.stringify(browser)},steps:client.snapshot.count,warm,samples,allTargetsMs:+allTargetsMs.toFixed(2),heartbeats,paint,cancellationPreservedCursor:0,lastDestination:123,missingCheckpointRecovered:true,corruptionPreservedCursor:0,finalConfirmationCancelled:true,note:'Firefox instalado, IndexedDB e RPC de produção. Estados completos comparados com execução sequencial independente. Tempos incluem Worker/I-O/codec/timers/BiDi; bytes são payloads, não RAM.'});
    }finally{client.dispose();}
  })()`));
  await writeFile(join(artifacts, 'paged-history-browser.json'), JSON.stringify(report, null, 2));
  assert.equal(await evaluate("localStorage.getItem('rewind.script-library.v1')"), scriptLibrary);
  await click('Abrir execução Listas em blocos'); await waitFor("document.querySelector('[data-testid=paged-debugger]') && !document.querySelector('[data-testid=library-progress]')");
  await click('Início'); await activate('Último'); await waitFor("document.querySelector('[data-testid=seek-progress]')"); await click('Cancelar navegação');
  await waitFor("document.querySelector('[data-testid=seek-message]')?.textContent.includes('preservada')"); assert.equal(await text('[data-testid=step-count]'), '000');
  await activate('Último'); await waitFor("document.querySelector('[data-testid=seek-progress]')"); await input('#timeline-target','123'); await click('Ir'); assert.equal(await text('[data-testid=step-count]'),'123');
  await click('Início'); await activate('Último'); await waitFor("document.querySelector('[data-testid=seek-progress]')");
  await evaluate("(() => {const s=document.querySelector('#example');s.value='python-sum-fixed';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await evaluate('new Promise(r=>setTimeout(r,150))'); assert.equal(await text('[data-testid=step-count]'),'000'); assert.equal(await evaluate("document.querySelector('[data-testid=paged-debugger]') === null"),true);
  await click('Abrir execução Listas em blocos'); await waitFor("document.querySelector('[data-testid=paged-debugger]') && !document.querySelector('[data-testid=library-progress]')");
  await click('Excluir execução Listas em blocos'); assert.match(await text('dialog[open]'),/será fechada/); await click('Excluir execução');
  await waitFor("document.querySelectorAll('[data-saved-execution]').length === 0 && !document.querySelector('[data-testid=paged-debugger]')");
  assert.equal(await text('[data-testid=step-count]'),'000');
  console.log('PASS: paginação real, reabertura sem ler tudo, cache/LRU limitado, estado completo em saltos, heartbeat/paint, cancelamento/substituição, checkpoint despejado, corrupção sem publicação parcial, fechamento/troca/exclusão e layout móvel.');
}
