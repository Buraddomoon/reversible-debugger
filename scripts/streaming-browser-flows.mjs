import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function runStreamingBrowserFlows({ evaluate, command, context, click, input, text, waitFor, shot, artifacts, browser }) {
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  const scripts = await evaluate("localStorage.getItem('rewind.script-library.v1')");
  const fixture = JSON.parse(await evaluate(`(async()=>{
    const {PagedRecordingClient}=await import('/src/ui/paged-client.ts');const {DebugSession}=await import('/src/core/debugger.ts');
    const {ExecutionLibrary}=await import('/src/core/execution-library.ts');const {examples}=await import('/src/examples.ts');const {encode}=await import('/src/core/portable-history.ts');
    const runtime={language:'python',version:'3'},bug=examples.find(e=>e.id==='python-sum-bug').source,fixed=examples.find(e=>e.id==='python-sum-fixed').source;
    const a=await PagedRecordingClient.startLive(bug,runtime,{name:'Soma A em blocos',filename:'a.py'},{});while(a.snapshot.recording.canRecord)await a.run();await a.closeLive();a.dispose();
    const session=new DebugSession(fixed,runtime);while(session.canForward)session.forward();const library=new ExecutionLibrary(),b=await library.save(session,{name:'Soma B corrigida',filename:'b.py'});await library.close();
    const source='a = [0]\\nb = a\\ni = 0\\nwhile i < 110:\\n    b[0] = i\\n    print(i)\\n    i += 1',long=await PagedRecordingClient.startLive(source,runtime,{name:'Saltos com checkpoints',filename:'saltos.py'},{});
    while(long.snapshot.recording.canRecord)await long.run();const count=long.snapshot.count,oracle=new DebugSession(source,runtime);while(oracle.canForward)oracle.forward();const samples=[];
    for(const target of [700,400,900,1,count,0,650]){await long.seek(target);oracle.seek(target);if(JSON.stringify(encode(long.snapshot.state))!==JSON.stringify(encode(oracle.state)))throw new Error('Checkpoint restaurou outro estado');samples.push({target,...long.snapshot.recording.navigation,checkpoints:long.snapshot.stats.checkpoints});}
    if(samples[0].appliedSteps>=128||samples[0].restoredFrom===0)throw new Error('Salto não usou checkpoint');
    await long.seek(700);await long.closeLive();long.dispose();const resumed=await PagedRecordingClient.resumeLive(long.header.entry.id,{});if(resumed.snapshot.cursor!==700||resumed.snapshot.recording.navigation.appliedSteps>=128)throw new Error('Checkpoint não persistiu');await resumed.closeLive();resumed.dispose();
    window.dispatchEvent(new Event('focus'));return JSON.stringify({left:{kind:'journal',id:a.header.entry.id,name:'Soma A em blocos'},right:{kind:'saved',id:b.id,name:b.name},long:long.header.entry.id,count,samples});
  })()`));
  await waitFor("Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')==='Retomar sessão Soma A em blocos')");
  await click('Retomar sessão Soma A em blocos'); await waitFor("document.querySelector('[data-testid=recording-ledger]') && !document.querySelector('[data-testid=live-open-progress]')");
  await input('#timeline-target', '10'); await click('Ir'); await waitFor("Number(document.querySelector('[data-testid=step-count]').textContent)===10 && !document.querySelector('[data-testid=seek-progress]')");
  await click('Comparar gravações'); await waitFor("document.querySelector('[data-testid=paged-comparison-panel]') && document.querySelector('[aria-label=\"Gravação da execução B\"]')?.options.length > 0");
  await evaluate(`(()=>{const s=document.querySelector('[aria-label="Gravação da execução B"]');s.value=${JSON.stringify(`saved:${fixture.right.id}`)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click('Preparar comparação'); await waitFor("document.querySelector('[data-testid=paged-comparison-progress]')"); await click('Cancelar preparação');
  await waitFor("!document.querySelector('[data-testid=paged-comparison-progress]') && document.querySelector('[data-testid=seek-message]')?.textContent.includes('cancelada')");
  await click('Preparar comparação'); await waitFor("document.querySelector('[data-testid=comparison-final-a]') && !document.querySelector('[data-testid=paged-comparison-progress]')");
  assert.equal(await text('[data-testid=comparison-final-a]'), '10'); assert.equal(await text('[data-testid=comparison-final-b]'), '15');
  await click('Primeira diferença'); await waitFor("!document.querySelector('[data-testid=paged-comparison-progress]')");
  assert.match(await text('[data-testid=comparison-description-a]'), /falsa/); assert.match(await text('[data-testid=comparison-description-b]'), /verdadeira/); await shot('firefox-paged-comparison.png');
  await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 }); assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true); await shot('firefox-paged-comparison-mobile.png');
  await click('Final da comparação'); await waitFor("!document.querySelector('[data-testid=paged-comparison-progress]')"); assert.equal(await text('[data-testid=comparison-result-a]'), '10'); assert.equal(await text('[data-testid=comparison-result-b]'), '15');
  await click('Início da comparação'); await waitFor("!document.querySelector('[data-testid=paged-comparison-progress]')"); await click('Voltar ao debugger'); await waitFor("Number(document.querySelector('[data-testid=step-count]')?.textContent)===10");

  const rpc = JSON.parse(await evaluate(`(async()=>{
    const {PagedComparisonClient}=await import('/src/ui/paged-comparison-client.ts');const {RecordingJournal}=await import('/src/core/recording-journal.ts');const {encode}=await import('/src/core/portable-history.ts');
    const journal=new RecordingJournal(),before=await journal.open(${JSON.stringify(fixture.left.id)}),client=await PagedComparisonClient.open(${JSON.stringify(fixture.left)},${JSON.stringify(fixture.right)},4*1024*1024);
    try{if(Array.isArray(client.header.left.history)||Array.isArray(client.header.right.history))throw new Error('Histórico integral transferido');
      const pair=()=>JSON.stringify(encode([client.snapshot.left,client.snapshot.right])),initial=pair(),receiver=client.worker.onmessage,pre=new AbortController();let armed=true;
      client.worker.onmessage=e=>{if(armed&&e.data.kind==='prepared'){armed=false;pre.abort();}receiver(e);};
      try{await client.seek(client.header.firstDifference,{signal:pre.signal});throw new Error('Cancelamento antes do ACK aceito');}catch(error){if(error.name!=='AbortError')throw error;}finally{client.worker.onmessage=receiver;}
      if(client.snapshot.cursor!==0||pair()!==initial)throw new Error('Par parcial publicado');await client.seek(1);if(client.snapshot.cursor!==1)throw new Error('Worker não retomou após cancelar');
      const post=new AbortController();armed=true;client.worker.onmessage=e=>{receiver(e);if(armed&&e.data.kind==='prepared'){armed=false;post.abort();}};
      await client.seek(client.header.rows.length-1,{signal:post.signal});client.worker.onmessage=receiver;if(client.snapshot.left.state.frames[0].locals.result!==10n||client.snapshot.right.state.frames[0].locals.result!==15n)throw new Error('Par confirmado não foi publicado');
      const samples=[];for(const target of [0,client.header.firstDifference,client.header.rows.length-1,1,0]){await client.seek(target);const s=client.snapshot.stats;if(s.left.bytes>s.left.limitBytes||s.right.bytes>s.right.limitBytes||s.indexBytes>s.indexLimit)throw new Error('Orçamento excedido');samples.push({target,...s});}
      const after=await journal.open(${JSON.stringify(fixture.left.id)});if(before.entry.headHash!==after.entry.headHash||before.entry.owner!==after.entry.owner||before.entry.cursor!==after.entry.cursor)throw new Error('Comparação alterou a sessão original');
      return JSON.stringify({rows:client.header.rows.length,firstDifference:client.header.firstDifference,preAckPreservedPair:true,postAckPublishedPair:true,sourcePreserved:true,noFullHistoryArray:true,samples});
    }finally{client.dispose();await journal.close();}
  })()`));
  assert.equal(await evaluate("localStorage.getItem('rewind.script-library.v1')"), scripts);
  await click('Fechar histórico'); await waitFor("!document.querySelector('[data-testid=paged-debugger]')");
  await evaluate(`(async()=>{const {RecordingJournal}=await import('/src/core/recording-journal.ts');const {ExecutionLibrary}=await import('/src/core/execution-library.ts');const j=new RecordingJournal(),l=new ExecutionLibrary();await j.delete(${JSON.stringify(fixture.left.id)});await j.delete(${JSON.stringify(fixture.long)});await l.delete(${JSON.stringify(fixture.right.id)});await j.close();await l.close();window.dispatchEvent(new Event('focus'));})()`);
  await writeFile(join(artifacts, 'streaming-browser.json'), JSON.stringify({ browser, checkpoints: fixture.samples, steps: fixture.count, comparison: rpc, mobileWidth: 390, note: 'Firefox instalado, IndexedDB e Workers de produção. Quotas de payload, não RAM real. Nenhuma instalação global.' }, null, 2));
  console.log('PASS: checkpoints persistidos, saltos exatos com menos deltas, comparação paginada journal/captura 10/15, cancelamento antes/depois do ACK, par atômico, fontes preservadas e 390 px.');
}
