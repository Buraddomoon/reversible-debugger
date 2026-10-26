import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function runPagedControlsBrowserFlows({ evaluate, command, context, click, input, text, waitFor, shot, artifacts, browser }) {
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  const scripts = await evaluate("localStorage.getItem('rewind.script-library.v1')");
  const report = JSON.parse(await evaluate(`(async()=>{
    const {PagedRecordingClient}=await import('/src/ui/paged-client.ts'),{DebugSession}=await import('/src/core/debugger.ts');
    const {ExecutionControl}=await import('/src/core/execution-control.ts'),{ExecutionLibrary}=await import('/src/core/execution-library.ts');
    const {encode}=await import('/src/core/portable-history.ts');
    const source='a = [0]\\nb = a\\ndef fact(n):\\n    if n <= 1:\\n        return 1\\n    b[0] = n\\n    return n * fact(n - 1)\\nresult = fact(6)\\nprint(a, result)',runtime={language:'python',version:'3'};
    const oracle=new DebugSession(source,runtime),states=[JSON.stringify(encode(oracle.state))];while(oracle.canForward){oracle.forward();states.push(JSON.stringify(encode(oracle.state)));}oracle.seek(0);
    const library=new ExecutionLibrary(),saved=await library.save(oracle,{name:'Controles em captura',filename:'controles.py'});
    const results=[];let liveId=null;
    for(const kind of ['live','saved']){
      const client=kind==='live'?await PagedRecordingClient.startLive(source,runtime,{name:'Controles por comando',filename:'controles.py'},{cacheBytes:1024}):await PagedRecordingClient.open(saved.id,{cacheBytes:1024});
      try{
        if(kind==='live')liveId=client.header.entry.id;
        oracle.seek(0);const classic=new ExecutionControl(oracle),times=[];let batches=0,maxCache=0;
        const same=()=>{if(client.snapshot.cursor!==oracle.cursor||JSON.stringify(encode(client.snapshot.state))!==states[oracle.cursor])throw new Error('Estado completo difere em '+kind+'/'+oracle.cursor);if(JSON.stringify(client.snapshot.debug.stop)!==JSON.stringify(classic.stop))throw new Error('Parada diferente');if(client.snapshot.stats.bytes>1024)throw new Error('Cache excedido');maxCache=Math.max(maxCache,client.snapshot.stats.bytes);};
        const drive=async mode=>{if(mode==='out'&&!classic.canStepOut)return;classic.start(mode);let first=true;do{const expected=classic.runBatch(16),start=performance.now();await client.control(first?mode:undefined);times.push(performance.now()-start);first=false;batches++;same();if(Boolean(client.snapshot.debug.mode)!==classic.running)throw new Error('Plano se perdeu entre lotes');if(batches>1000)throw new Error('Plano infinito');}while(classic.running);};
        for(const points of [[4],[],[1,4,6,8,9],[]]){
          await client.configureBreakpoints(points,true);classic.configure(points,true);
          for(const mode of ['into','into','over','out','continue','reverse-continue','back-statement','continue','into','out','continue'])await drive(mode);
        }
        // Cancellation before ACK must preserve both cursor and breakpoint-resume policy.
        await client.seek(0);oracle.seek(0);classic.cancel();await client.configureBreakpoints([1],true);classic.configure([1],true);await drive('continue');
        const receiver=client.worker.onmessage,pre=new AbortController();let armed=true;
        client.worker.onmessage=e=>{if(armed&&e.data.kind==='prepared'){if(Object.keys(e.data).sort().join(',')!=='id,kind')throw new Error('Preparação transferiu payload desnecessário');armed=false;pre.abort();}receiver(e);};
        try{await client.control('continue',{signal:pre.signal});throw new Error('Cancelamento antes do ACK aceito');}catch(error){if(error.name!=='AbortError')throw error;}finally{client.worker.onmessage=receiver;}same();
        await drive('continue');
        // Once accepted, even an abort immediately after ACK completes <=16 instructions.
        await client.seek(0);oracle.seek(0);classic.cancel();await client.configureBreakpoints([],true);classic.configure([],true);
        const post=new AbortController();armed=true;client.worker.onmessage=e=>{receiver(e);if(armed&&e.data.kind==='prepared'){armed=false;post.abort();}};
        classic.start('continue');classic.runBatch(16);await client.control('continue',{signal:post.signal});client.worker.onmessage=receiver;same();
        if(client.snapshot.cursor!==16)throw new Error('Lote aceito incompleto');await client.pause();classic.pause();if(client.snapshot.debug.mode!==null)throw new Error('Pausa manteve plano');same();
        // An accepted batch followed by two seeks: only the newest waiting destination wins.
        await client.seek(0);oracle.seek(0);classic.cancel();let accepted=false,one,two;
        client.worker.onmessage=e=>{receiver(e);if(!accepted&&e.data.kind==='prepared'){accepted=true;one=client.seek(5).then(()=>({ok:true}),error=>({error:error.name}));two=client.seek(3);}};
        await client.control('continue');await two;client.worker.onmessage=receiver;if((await one).error!=='AbortError')throw new Error('Pedido intermediário não foi substituído');oracle.seek(3);same();
        try{await client.configureBreakpoints([999],true);throw new Error('Breakpoint inválido aceito');}catch(error){if(!/inválida/.test(error.message))throw error;}same();
        times.sort((a,b)=>a-b);results.push({kind,batches,maxCache,latencyMs:{median:+times[Math.floor(times.length/2)].toFixed(2),p95:+times[Math.floor(times.length*.95)].toFixed(2)},preAckPreserved:true,postAckCompleted16:true,newestWaitingWins:true});
        if(kind==='live')await client.closeLive();
      }finally{client.dispose();}
    }
    const partial=new DebugSession('while True:\\n    pass',{...runtime,maxSteps:17});for(let i=0;i<17;i++)partial.forward();partial.seek(0);const capture=await library.save(partial,{name:'Captura parcial por comando',filename:'parcial.py'}),reader=await PagedRecordingClient.open(capture.id,{});
    try{await reader.control('continue');while(reader.snapshot.debug.mode)await reader.control();if(reader.snapshot.cursor!==17||reader.snapshot.debug.stop.reason!=='recorded-end')throw new Error('Captura ultrapassou a fronteira');}finally{reader.dispose();}
    await library.delete(capture.id);await library.close();window.dispatchEvent(new Event('focus'));return JSON.stringify({liveId,savedId:saved.id,steps:states.length-1,results,partialFrontier:17});
  })()`));
  report.budgetReserve = JSON.parse(await evaluate(`(async()=>{
    const {PagedRecordingClient}=await import('/src/ui/paged-client.ts'),{DebugSession}=await import('/src/core/debugger.ts'),{encode}=await import('/src/core/portable-history.ts'),{RecordingJournal}=await import('/src/core/recording-journal.ts');
    const source='a = []\\ni = 0\\nwhile i < 100:\\n    a.append(i)\\n    i += 1',runtime={language:'python',version:'3'},oracle=new DebugSession(source,runtime),states=[JSON.stringify(encode(oracle.state))];while(oracle.canForward){oracle.forward();states.push(JSON.stringify(encode(oracle.state)));}
    const client=await PagedRecordingClient.startLive(source,runtime,{name:'Reserva de leitura 64 KiB',filename:'reserva.py'},{maxHistoryBytes:65536,cacheBytes:65536,bufferBytes:4096}),journal=new RecordingJournal();
    try{
      const drive=async mode=>{await client.control(mode);while(client.snapshot.debug.mode){if(JSON.stringify(encode(client.snapshot.state))!==states[client.snapshot.cursor]||client.snapshot.stats.estimatedBytes>65536)throw new Error('Estado/reserva incorretos');await client.control();}if(JSON.stringify(encode(client.snapshot.state))!==states[client.snapshot.cursor]||client.snapshot.stats.estimatedBytes>65536)throw new Error('Destino/reserva incorretos');};
      await drive('continue');if(client.snapshot.debug.stop.reason!=='budget'||client.snapshot.state.control.status!=='running')throw new Error('Limite virou erro da VM');const frontier=client.snapshot.count;
      await drive('reverse-continue');if(client.snapshot.cursor!==0)throw new Error('Sem reserva para desfazer depois do limite');await drive('continue');if(client.snapshot.cursor!==frontier||client.snapshot.count!==frontier)throw new Error('Futuro mudou');await client.closeLive();return JSON.stringify({limit:65536,frontier,reverseToStart:true,replayPreserved:true});
    }finally{client.dispose();await journal.delete(client.header.entry.id);await journal.close();window.dispatchEvent(new Event('focus'));}
  })()`));
  await waitFor("Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')==='Retomar sessão Controles por comando')");
  await click('Retomar sessão Controles por comando');
  await waitFor("document.querySelector('[data-testid=paged-debugger]') && !document.querySelector('[data-testid=live-open-progress]')");
  await click('Início');
  await click('Entrar'); await waitFor("document.querySelector('[data-testid=paged-debug-stop]')?.textContent.includes('comando alcançado') && Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Entrar'&&!b.disabled)");
  await click('Adicionar breakpoint na linha 4'); await waitFor("document.querySelector('[aria-label=\"Remover breakpoint L4\"]') && !document.querySelector('[aria-label=\"Remover breakpoint L4\"]').disabled");
  await click('Executar'); await waitFor("document.querySelector('[data-testid=paged-debug-stop]')?.textContent.includes('Breakpoint na linha 4')");
  const first = Number(await text('[data-testid=step-count]'));
  assert.match(await text('[data-testid=call-stack]'), /fact\(\)/);
  await shot('firefox-paged-controls.png');
  await click('Executar'); await waitFor(`Number(document.querySelector('[data-testid=step-count]').textContent)>${first} && document.querySelector('[data-testid=paged-debug-stop]')?.textContent.includes('Breakpoint na linha 4')`);
  await click('Continuar para trás'); await waitFor(`Number(document.querySelector('[data-testid=step-count]').textContent)===${first} && Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Continuar para trás'&&!b.disabled)`);
  await click('Remover breakpoint L4'); await waitFor("!document.querySelector('[aria-label=\"Remover breakpoint L4\"]')");
  await click('Sair da função'); await waitFor("document.querySelector('[data-testid=call-stack]').textContent.includes('programa') && document.querySelectorAll('.frame').length===1 && Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Entrar'&&!b.disabled)");
  assert.equal(await text('[data-testid=result-value]'), '—');
  assert.match(await text('.operand-values'), /720/);
  await click('Passar sobre'); await waitFor("document.querySelector('[data-testid=result-value]').textContent==='720'");
  await click('Executar'); await waitFor("document.querySelector('[role=status]').textContent==='Concluído'");
  await click('Voltar comando'); await waitFor("document.querySelector('[data-testid=program-output]').textContent==='Nenhuma saída ainda.'");
  await click('Salvar pendências'); await waitFor("document.querySelector('[data-testid=pending-steps]').textContent==='0'");
  await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true); await shot('firefox-paged-controls-mobile.png');
  await click('Fechar histórico'); await waitFor("!document.querySelector('[data-testid=paged-debugger]')");
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  await click('Abrir execução Controles em captura'); await waitFor("document.querySelector('[data-testid=paged-debugger]') && !document.querySelector('[data-testid=library-progress]')");
  await click('Adicionar breakpoint na linha 4'); await waitFor("document.querySelector('[aria-label=\"Remover breakpoint L4\"]') && !document.querySelector('[aria-label=\"Remover breakpoint L4\"]').disabled");
  await click('Executar'); await waitFor("document.querySelector('[data-testid=paged-debug-stop]')?.textContent.includes('Breakpoint na linha 4')");
  await click('Continuar para trás'); await waitFor("Number(document.querySelector('[data-testid=step-count]').textContent)===0");
  await click('Limpar breakpoints'); await waitFor("!document.querySelector('[aria-label=\"Remover breakpoint L4\"]')");
  await click('Passar sobre'); await waitFor("Number(document.querySelector('[data-testid=step-count]').textContent)>0 && Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Entrar'&&!b.disabled)");
  await click('Adicionar breakpoint na linha 4'); await waitFor("document.querySelector('[aria-label=\"Remover breakpoint L4\"]') && !document.querySelector('[aria-label=\"Remover breakpoint L4\"]').disabled");
  await click('Executar código de novo'); await waitFor("!document.querySelector('[data-testid=paged-debugger]') && Number(document.querySelector('[data-testid=step-count]').textContent)===0");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Remover breakpoint na linha 4\"]').getAttribute('aria-pressed')"), 'true');
  await click('Executar'); await waitFor("document.querySelector('.breakpoint-pause')?.textContent.includes('4')");
  await click('Fechar histórico');
  await evaluate(`(async()=>{const {RecordingJournal}=await import('/src/core/recording-journal.ts'),{ExecutionLibrary}=await import('/src/core/execution-library.ts');const j=new RecordingJournal(),l=new ExecutionLibrary();await j.delete(${JSON.stringify(report.liveId)});await l.delete(${JSON.stringify(report.savedId)});await j.close();await l.close();window.dispatchEvent(new Event('focus'));})()`);
  assert.equal(await evaluate("localStorage.getItem('rewind.script-library.v1')"), scripts);
  await writeFile(join(artifacts, 'paged-controls-browser.json'), JSON.stringify({ browser, ...report, mobileWidth:390, note:'Firefox instalado, IndexedDB e Workers de produção. Estados completos, paradas e lotes comparados com o controlador clássico. Latências incluem I/O, validação, codec e RPC; payload do cache, não RAM real.' }, null, 2));
  console.log('PASS: controles unificados em live/capturas, recursão e operandos, breakpoints nos dois sentidos, cancelamento antes/depois de ACK, lote aceito limitado, último destino vence, fronteira parcial e 390 px.');
}
