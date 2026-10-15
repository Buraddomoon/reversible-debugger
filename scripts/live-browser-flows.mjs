import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Native IndexedDB and the production actor, in the existing isolated Firefox profile. */
export async function runLiveBrowserFlows({ evaluate, command, context, click, input, text, waitFor, shot, artifacts, browser }) {
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  await evaluate("(() => {const s=document.querySelector('#example');s.value='python-sum-bug';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await evaluate('new Promise(r=>setTimeout(r,300))');
  const scripts = await evaluate("localStorage.getItem('rewind.script-library.v1')");
  await click('Gravar sessão'); await input('#live-name', 'Soma contínua'); await click('Iniciar gravação');
  await waitFor("document.querySelector('[data-testid=recording-ledger]') && !document.querySelector('[data-testid=live-open-progress]')");
  const cursor = n => `Number(document.querySelector('[data-testid=step-count]').textContent) === ${n} && !document.querySelector('[data-testid=seek-progress]')`;
  for (let n = 1; n <= 5; n++) { await click('Avançar'); await waitFor(cursor(n)); }
  await click('Salvar pendências'); await waitFor("document.querySelector('[data-testid=durable-frontier]').textContent === '5' && document.querySelector('[data-testid=pending-steps]').textContent === '0'");
  const visibleState = "JSON.stringify(['[data-testid=current-line]','.variable-table','[data-testid=call-stack]','.operand-values','[data-testid=program-output]'].map(s=>document.querySelector(s)?.textContent.trim()))";
  const savedState = await evaluate(visibleState);
  for (let n = 6; n <= 8; n++) { await click('Avançar'); await waitFor(cursor(n)); }
  assert.equal(await text('[data-testid=pending-steps]'), '3'); assert.equal(await text('[data-testid=durable-frontier]'), '5');
  await shot('firefox-live-recording-pending.png');
  // Forced reload intentionally drops the three volatile steps; only the durable prefix is promised.
  await command('browsingContext.reload', { context, wait: 'complete' }); await waitFor("document.querySelector('[data-live-session]')");
  await evaluate('new Promise(r=>setTimeout(r,5200))'); await click('Retomar sessão Soma contínua');
  await waitFor("document.querySelector('[data-testid=recording-ledger]') && !document.querySelector('[data-testid=live-open-progress]')");
  assert.equal(Number(await text('[data-testid=step-count]')), 5); assert.equal(await evaluate(visibleState), savedState);
  assert.equal(await text('[data-testid=pending-steps]'), '0');
  await click('Executar'); await waitFor("document.querySelector('[role=status]').textContent === 'Concluído'");
  assert.equal(await text('[data-testid=result-value]'), '10'); const total = Number(await text('[data-testid=durable-frontier]'));
  assert.equal(Number(await text('[data-testid=step-count]')), total); assert.equal(await text('[data-testid=pending-steps]'), '0');
  const finalState = await evaluate(visibleState); await click('Início'); await waitFor(cursor(0)); await click('Último'); await waitFor(cursor(total)); assert.equal(await evaluate(visibleState), finalState);
  await input('#timeline-target', '10'); await click('Ir'); await waitFor(cursor(10)); await click('Fechar histórico');
  await waitFor("!document.querySelector('[data-testid=paged-debugger]')"); await click('Retomar sessão Soma contínua'); await waitFor(cursor(10));
  assert.equal(Number(await text('[data-testid=durable-frontier]')), total);
  assert.match(await text('[data-testid=validation-summary]'), new RegExp(`${total} passos reutilizados.*0 passos conferidos`));
  await shot('firefox-live-recording.png'); await shot('firefox-segment-validation.png');
  await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true); await shot('firefox-live-recording-mobile.png');
  await click('Fechar histórico');
  await waitFor("!document.querySelector('[data-testid=paged-debugger]')");
  await evaluate("document.querySelector('.validation-option input').click()");
  await click('Retomar sessão Soma contínua'); await waitFor(cursor(10));
  assert.match(await text('[data-testid=validation-summary]'), new RegExp(`0 passos reutilizados.*${total} passos conferidos`));
  await click('Abrir debugger completo'); await waitFor("!document.querySelector('[data-testid=paged-debugger]') && Number(document.querySelector('[data-testid=step-count]').textContent) === 10");
  await click('Último'); assert.equal(await text('[data-testid=result-value]'), '10');
  await click('Comparar execuções');
  await evaluate("(() => {const s=document.querySelector('[aria-label=\"Programa da execução B\"]');s.value='python-sum-fixed';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await click('Preparar comparação'); await waitFor("document.querySelector('[data-testid=comparison-final-a]') && !document.querySelector('.comparison-progress')");
  assert.equal(await text('[data-testid=comparison-final-a]'), '10'); assert.equal(await text('[data-testid=comparison-final-b]'), '15');
  await click('Voltar ao debugger'); await click('Fechar histórico');
  await waitFor("Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label') === 'Excluir sessão Soma contínua' && !b.disabled)");
  await click('Excluir sessão Soma contínua'); await click('Excluir sessão'); await waitFor("document.querySelectorAll('[data-live-session]').length === 0");
  assert.equal(await evaluate("localStorage.getItem('rewind.script-library.v1')"), scripts);

  const report = JSON.parse(await evaluate(`(async () => {
    const { PagedRecordingClient } = await import('/src/ui/paged-client.ts');
    const { DebugSession } = await import('/src/core/debugger.ts');
    const { encode } = await import('/src/core/portable-history.ts');
    const { RecordingJournal } = await import('/src/core/recording-journal.ts');
    const source='a = [0]\\nb = a\\ni = 0\\nwhile i < 45:\\n    b[0] = i\\n    print(i)\\n    i += 1', runtime={language:'python',version:'3'};
    const oracle=new DebugSession(source,runtime),states=[JSON.stringify(encode(oracle.state))];
    while(oracle.canForward){oracle.forward();states.push(JSON.stringify(encode(oracle.state)));}
    const client=await PagedRecordingClient.startLive(source,runtime,{name:'Teste RPC contínuo',filename:'rpc.py'},{bufferBytes:4096,cacheBytes:2048,maxSteps:2000,maxFrames:32});
    const same=()=>{if(JSON.stringify(encode(client.snapshot.state))!==states[client.snapshot.cursor])throw new Error('Estado completo difere no passo '+client.snapshot.cursor);};
    let beforeAck=false,afterAck=false,blocksDuringExecution=0,warmValidation=null,fullValidation=null,suffixValidation=null;
    try {
      const receiver=client.worker.onmessage,pre=new AbortController();let armed=true;
      client.worker.onmessage=e=>{if(armed&&e.data.kind==='prepared'){armed=false;pre.abort();}receiver(e);};
      try{await client.seek(1,{signal:pre.signal});throw new Error('Cancelamento antes do ACK aceito');}catch(error){if(error.name!=='AbortError')throw error;beforeAck=true;}finally{client.worker.onmessage=receiver;}
      if(client.snapshot.cursor!==0||client.snapshot.count!==0)throw new Error('Instrução cancelada foi publicada');same();
      await client.seek(1);same();if(!client.snapshot.evidence)throw new Error('Cursor invisível após cancelamento');
      const post=new AbortController();armed=true;
      client.worker.onmessage=e=>{receiver(e);if(armed&&e.data.kind==='prepared'){armed=false;post.abort();}};
      await client.run({signal:post.signal});client.worker.onmessage=receiver;same();
      if(client.snapshot.cursor!==17)throw new Error('Lote confirmado não foi concluído após pausa');afterAck=true;
      const samples=[];
      while(client.snapshot.count<240){await client.run();same();const l=client.snapshot.recording;if(l.pendingBytes>4096&&!l.oversized)throw new Error('Buffer excedido');if(l.durable>0&&client.snapshot.state.control.status==='running')blocksDuringExecution=l.blocks; samples.push({cursor:client.snapshot.cursor,durable:l.durable,pendingBytes:l.pendingBytes,cacheBytes:client.snapshot.stats.bytes});}
      const probe=new RecordingJournal(),oldPrefix=(await probe.validation.read(await probe.open(client.header.entry.id))).prefix;await probe.close();
      const frontier=client.snapshot.count;await client.seek(7);same();
      const captured=await client.capture(8*1024*1024);if(captured.session.cursor!==7||captured.session.history.length!==frontier||captured.session.maxSteps!==2000||captured.session.maxFrames!==32)throw new Error('Captura/limites não preservados');
      captured.session.seek(frontier);if(JSON.stringify(encode(captured.session.state))!==states[frontier])throw new Error('Futuro volátil não capturado');
      for(const target of [0,frontier,21,180,7,0]){await client.seek(target);same();if(client.snapshot.stats.bytes>2048)throw new Error('Cache excedido');}
      await client.seek(frontier);while(client.snapshot.recording.canRecord){await client.run();same();}
      const count=client.snapshot.count;if(client.snapshot.recording.durable!==count||client.snapshot.recording.pendingSteps!==0||!blocksDuringExecution)throw new Error('Gravação incremental não persistida');
      await client.seek(7);await client.closeLive();client.dispose();
      const warmBegin=performance.now(),restored=await PagedRecordingClient.resumeLive(client.header.entry.id,{cacheBytes:2048});const warmResumeMs=+(performance.now()-warmBegin).toFixed(2);
      try{warmValidation=restored.snapshot.recording.validation;if(warmValidation.reusedSteps!==count||warmValidation.checkedSteps!==0||warmValidation.blockReads!==0)throw new Error('Prefixo validado não reutilizado');if(restored.snapshot.cursor!==7||restored.snapshot.count!==count||JSON.stringify(encode(restored.snapshot.state))!==states[7])throw new Error('Retomada divergiu');await restored.seek(count);if(JSON.stringify(encode(restored.snapshot.state))!==states[count])throw new Error('Replay retomado divergiu');await restored.seek(7);await restored.closeLive();}finally{restored.dispose();}
      const fullBegin=performance.now(),audited=await PagedRecordingClient.resumeLive(client.header.entry.id,{cacheBytes:2048,validateAll:true});const fullResumeMs=+(performance.now()-fullBegin).toFixed(2);
      try{fullValidation=audited.snapshot.recording.validation;if(fullValidation.reusedSteps!==0||fullValidation.checkedSteps!==count||JSON.stringify(encode(audited.snapshot.state))!==states[7])throw new Error('Conferência integral divergiu');await audited.closeLive();}finally{audited.dispose();}
      const journal=new RecordingJournal();await journal.validation.delete(client.header.entry.id);await journal.validation.publish(oldPrefix);
      const incremental=await PagedRecordingClient.resumeLive(client.header.entry.id,{cacheBytes:2048});
      try{suffixValidation=incremental.snapshot.recording.validation;if(suffixValidation.reusedSteps!==oldPrefix.frontier||suffixValidation.checkedSteps!==count-oldPrefix.frontier||JSON.stringify(encode(incremental.snapshot.state))!==states[7])throw new Error('Sufixo novo não validado corretamente');await incremental.closeLive();}finally{incremental.dispose();}
      const finalManifest=await journal.open(client.header.entry.id);await journal.delete(client.header.entry.id);if(await journal.validation.read(finalManifest))throw new Error('Cache da sessão excluída permaneceu');await journal.close();
      return JSON.stringify({browser:${JSON.stringify(browser)},steps:count,beforeAck,afterAck,blocksDuringExecution,captureIncludedVolatileFuture:true,limitsPreserved:true,fullStateOracle:true,resumeCursor:7,warmValidation,fullValidation,suffixValidation,warmResumeMs,fullResumeMs,samples,note:'IndexedDB e Worker de produção no Firefox instalado; estado completo comparado com executor sequencial. Payload não mede RAM.'});
    }finally{client.dispose();}
  })()`));
  // Fault injection stays in a test-owned module Worker and temporary database.
  // This exercises native transaction rollback without exhausting the user's disk.
  const fault = JSON.parse(await evaluate(`(async () => {
    const code = \`import {LiveRecording} from '\${location.origin}/src/core/live-recording.ts';
      import {RecordingJournal} from '\${location.origin}/src/core/recording-journal.ts';
      import {encode} from '\${location.origin}/src/core/portable-history.ts';
      const journal=new RecordingJournal(indexedDB,'rewind.live-browser-tests');
      try{const live=await LiveRecording.start(journal,'i = 0\\\\nwhile i < 40:\\\\n    print(i)\\\\n    i += 1',{language:'python',version:'3'},{name:'Falha controlada',filename:'fault.py'});
        for(let i=0;i<20;i++)await live.seek(live.count+1);
        const before=JSON.stringify(encode(live.state)),put=IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put=function(...args){if(this.name==='heads')throw new DOMException('Teste de quota','QuotaExceededError');return put.apply(this,args);};
        let failed;try{failed=!await live.flush();}finally{IDBObjectStore.prototype.put=put;}
        const disk=await journal.open(live.entry.id);if(!failed||disk.head.frontier!==0||live.ledger.pendingSteps!==20||JSON.stringify(encode(live.state))!==before)throw new Error('Falha não foi atômica');
        await live.seek(0);await live.seek(20);if(JSON.stringify(encode(live.state))!==before)throw new Error('Futuro perdido');
        if(!await live.flush()||live.ledger.pendingSteps!==0||(await journal.open(live.entry.id)).head.blocks.length!==1)throw new Error('Retry não reconciliou');
        await live.close();await journal.delete(live.entry.id);await journal.close();postMessage({atomicNativeQuotaRollback:true,pendingPreserved:20,retryWithoutDuplicate:true});
      }catch(error){postMessage({error:error.message});}\`;
    const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'})),worker=new Worker(url,{type:'module'});
    try{return JSON.stringify(await new Promise((resolve,reject)=>{worker.onmessage=e=>e.data.error?reject(new Error(e.data.error)):resolve(e.data);worker.onerror=e=>reject(new Error(e.message));}));}finally{worker.terminate();URL.revokeObjectURL(url);}
  })()`));
  await writeFile(join(artifacts, 'live-recording-browser.json'), JSON.stringify({ ...report, recovery: { durable: 5, volatileLostOnForcedReload: 3, exactVisibleState: true }, fault, mobileWidth: 390 }, null, 2));
  console.log('PASS: gravação incremental, fronteira durável, reload/retomada, fechamento, replay, materialização/comparação, exclusão, oracle completo, ACK/cancelamento, buffer/cache limitado e quota atômica no IndexedDB nativo.');
}
