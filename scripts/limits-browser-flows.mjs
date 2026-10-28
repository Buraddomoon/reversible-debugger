import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function runLimitsBrowserFlows({ evaluate, command, context, click, input, text, waitFor, shot, artifacts, browser }) {
  const scripts = await evaluate("localStorage.getItem('rewind.script-library.v1')");
  const settings = await evaluate("localStorage.getItem('rewind.execution-limits.v1')") ?? null;
  await evaluate("(()=>{const s=document.querySelector('#example');s.value='python-factorial';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await evaluate("document.querySelector('[data-testid=execution-limits] details').open=true");
  await input('#execution-max-steps', '17'); await input('#execution-max-frames', '32'); await click('Aplicar limites');
  await click('Executar'); await waitFor("document.querySelector('[role=status]').textContent==='Limite de passos'");
  assert.equal(Number(await text('[data-testid=step-count]')), 17);
  const before = await text('[data-testid=history-length]');
  await input('#execution-max-steps', '50000'); await click('Aplicar limites');
  assert.equal(Number(await text('[data-testid=step-count]')), 17); assert.equal(await text('[data-testid=history-length]'), before);
  await click('Executar'); await waitFor("document.querySelector('[role=status]').textContent==='Concluído'");
  assert.equal(await text('[data-testid=result-value]'), '120');
  await click('Reiniciar programa');
  assert.equal(await evaluate("document.querySelector('#execution-max-steps').value"), '50000');
  await command('browsingContext.reload', { context, wait: 'complete' }); await waitFor("document.querySelector('#execution-max-steps')");
  await evaluate("document.querySelector('[data-testid=execution-limits] details').open=true");
  assert.equal(await evaluate("document.querySelector('#execution-max-steps').value"), '50000');
  assert.equal(await evaluate("document.querySelector('#execution-max-frames').value"), '32');
  await shot('firefox-execution-limits.png');
  await click('Gravar sessão'); await input('#live-name', 'Limites herdados');
  assert.match(await text('.dialog-runtime-note'), /50.000 passos e 32 níveis/);
  await click('Iniciar gravação'); await waitFor("document.querySelector('[data-testid=paged-debugger]') && !document.querySelector('[data-testid=live-open-progress]')");
  assert.match(await text('[data-testid=paged-execution-limits]'), /50000 passos.*32 níveis/);
  const inheritedId = await evaluate("document.querySelector('#example').value.slice(6)");
  await click('Executar'); await waitFor("document.querySelector('[role=status]').textContent==='Concluído'");
  await click('Abrir debugger completo'); await waitFor("!document.querySelector('[data-testid=paged-debugger]') && document.querySelector('[data-testid=execution-limits]')");
  assert.equal(await evaluate("Boolean(document.querySelector('#execution-max-steps'))"), false);
  await click('Executar código de novo');
  assert.equal(await evaluate("document.querySelector('#execution-max-steps').value"), '50000');
  await click('Fechar histórico');
  // The materialized view disposes its source Worker. Its existing writer lease
  // expires independently, just as after a reload; do not delete an owned run.
  await evaluate('new Promise(r=>setTimeout(r,5200))');
  await evaluate(`(async()=>{const {RecordingJournal}=await import('/src/core/recording-journal.ts');const j=new RecordingJournal();await j.delete(${JSON.stringify(inheritedId)});await j.close();window.dispatchEvent(new Event('focus'));})()`);
  await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
  await evaluate("document.querySelector('[data-testid=execution-limits] details').open=true");
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true); await shot('firefox-execution-limits-mobile.png');
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  const parse = async expression => JSON.parse(await evaluate(`(async()=>JSON.stringify(await (${expression})))()`));
  const phase = async (name, expression) => {
    console.log(`Limites: ${name}.`);
    await evaluate(`(()=>{window.limitsJob={done:false};void(async()=>{try{window.limitsJob.value=await(${expression});}catch(e){window.limitsJob.error=e.stack??e.message;}finally{window.limitsJob.done=true;}})();})()`);
    const deadline = Date.now() + 120000; let lastLog = Date.now();
    while (!await evaluate('window.limitsJob.done')) {
      if (Date.now() > deadline) throw new Error(`Prazo do ensaio excedido: ${name}`);
      if (Date.now() - lastLog > 8000) { console.log(`Limites: ${name} em andamento, página respondendo.`); lastLog = Date.now(); }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const result = await parse('window.limitsJob');
    if (result.error) throw new Error(`${name}: ${result.error}`); return result.value;
  };
  await evaluate("(async()=>{const {createLimitsProbe}=await import('/scripts/limits-probe.mjs');window.limitsProbe=await createLimitsProbe();})()");
  let report;
  try {
    console.log('Limites: gravando 50.000 passos em lotes de até 16.');
    while (!await parse('window.limitsProbe.recordChunk()')) { /* bounded requests */ }
    await phase('navegação e retomadas', 'window.limitsProbe.navigateAndResume()');
    await phase('captura integral', 'window.limitsProbe.capture()');
    await phase('arquivo e biblioteca', 'window.limitsProbe.portableAndSave()');
    await phase('replay paginado', 'window.limitsProbe.savedReplay()');
    report = await phase('referência independente', 'window.limitsProbe.verify()');
  } finally { await evaluate('(async()=>{try{await window.limitsProbe?.release();}finally{delete window.limitsProbe;}})()'); }
  const currentScripts = await evaluate("localStorage.getItem('rewind.script-library.v1')");
  // Choosing a different example legitimately updates selection; script data is preserved.
  assert.deepEqual(JSON.parse(currentScripts ?? 'null')?.scripts ?? [], JSON.parse(scripts ?? 'null')?.scripts ?? []);
  await evaluate(`(()=>{const key='rewind.execution-limits.v1',old=${JSON.stringify(settings)};if(old===null)localStorage.removeItem(key);else localStorage.setItem(key,old);})()`);
  await writeFile(join(artifacts, 'execution-limits-browser.json'), JSON.stringify({ browser, ...report, ui: { increasePreservedHistory: true, reloadPreservedSettings: true, journalInheritedLimits: true, materializedLimitsPreserved: true, mobileWidth: 390 } }, null, 2) + '\n');
  console.log('PASS: limites configuráveis, 50 mil passos, versões explícitas, estados completos, formatos mistos, retomada/captura/arquivo, reinício/recarga e 390 px.');
}
