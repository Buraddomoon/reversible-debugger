import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function runStringsBrowserFlows({ evaluate, command, context, click, input, text, waitFor, shot, exportDownload, uploadHistory, artifacts, browser }) {
  const scripts = await evaluate("localStorage.getItem('rewind.script-library.v1')") ?? null;
  const choose = value => evaluate(`(()=>{const s=document.querySelector('#example');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await choose('python-hello'); await click('Executar'); await waitFor("document.querySelector('[role=status]').textContent==='Concluído'");
  assert.equal(await text('[data-testid=result-value]'), "'Hello, world!'"); assert.equal(await text('[data-testid=program-output]'), 'Hello, world!');
  await click('Início'); assert.equal(await text('[data-testid=program-output]'), 'Nenhuma saída ainda.'); await click('Último');
  await choose('python-string-reverse-bug'); await click('Executar'); await waitFor("document.querySelector('[role=status]').textContent==='Concluído'");
  assert.equal(await text('[data-testid=result-value]'), "'🚀ãça'"); assert.equal(await text('[data-testid=program-output]'), 'Invertido: 🚀ãça');
  assert.match(await text('.variables-panel'), /str/); assert.ok(await evaluate("Array.from(document.querySelectorAll('.syntax-string')).some(s=>s.textContent==='\"maçã🚀\"')"));
  const cursor = Number(await text('[data-testid=step-count]'));
  await shot('firefox-python-strings.png');
  await click('Comparar execuções'); assert.equal(await evaluate("document.querySelector('[aria-label=\"Programa da execução B\"]').value"), 'python-string-reverse-fixed');
  await click('Preparar comparação'); await waitFor("document.querySelector('[data-testid=comparison-final-a]')");
  assert.equal(await text('[data-testid=comparison-final-a]'), "'🚀ãça'"); assert.equal(await text('[data-testid=comparison-final-b]'), "'🚀ãçam'");
  await click('Primeira diferença'); await shot('firefox-python-strings-comparison.png');
  await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true); await shot('firefox-python-strings-mobile.png');
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  await click('Final da comparação'); await click('Início da comparação'); await click('Voltar ao debugger');
  assert.equal(Number(await text('[data-testid=step-count]')), cursor);
  const content = await exportDownload(); assert.equal(JSON.parse(content).payload.vm, 'rewind-vm/3');
  await uploadHistory(content); await waitFor("document.querySelector('[data-testid=recording-banner]') && !document.querySelector('[data-testid=trace-progress]')");
  assert.equal(await text('[data-testid=result-value]'), "'🚀ãça'"); await click('Início'); await click('Último'); assert.equal(await text('[data-testid=result-value]'), "'🚀ãça'"); await click('Fechar histórico');
  await choose('python-string-reverse-bug'); await click('Executar'); await waitFor("document.querySelector('[role=status]').textContent==='Concluído'");
  await click('Salvar execução'); await input('#execution-name', 'Texto invertido'); await click('Salvar'); await waitFor("document.querySelector('[data-testid=library-message]')?.textContent.includes('Execução salva')");
  await choose('python-hello'); await click('Abrir execução Texto invertido'); await waitFor("document.querySelector('[data-testid=paged-debugger]') && !document.querySelector('[data-testid=library-progress]')");
  assert.equal(await text('[data-testid=result-value]'), "'🚀ãça'"); await click('Início'); await click('Último');
  await click('Abrir debugger completo'); await waitFor("!document.querySelector('[data-testid=paged-debugger]')"); assert.equal(await text('[data-testid=result-value]'), "'🚀ãça'"); await click('Fechar histórico');
  await click('Excluir execução Texto invertido'); await click('Excluir execução'); await waitFor("!Array.from(document.querySelectorAll('[data-saved-execution]')).some(e=>e.textContent.includes('Texto invertido'))");
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/pre-strings-vm2.json', import.meta.url), 'utf8'));
  await uploadHistory(JSON.stringify(fixture.cases[1].file), 'legado.rewind.json'); await waitFor("document.querySelector('[data-testid=recording-banner]')"); await click('Último'); assert.equal(await text('[data-testid=result-value]'), '2'); await click('Fechar histórico');
  console.log('Strings: UI, Unicode, bug/correção, arquivo VM3 e legado VM2, biblioteca, materialização e 390 px.');
  await evaluate("(()=>{window.stringsJob={done:false};void import('/scripts/strings-probe.mjs').then(m=>m.probeStrings()).then(value=>{window.stringsJob.value=value;},error=>{window.stringsJob.error=error.stack??error.message;}).finally(()=>{window.stringsJob.done=true;});})()");
  const deadline = Date.now() + 120000; let logAt = Date.now();
  while (!await evaluate('window.stringsJob.done')) {
    if (Date.now() > deadline) throw new Error('Strings: prazo do ensaio excedido');
    if (Date.now() - logAt > 8000) { console.log('Strings: Workers, estados completos e gravações em andamento.'); logAt = Date.now(); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const result = JSON.parse(await evaluate('JSON.stringify(window.stringsJob)')); if (result.error) throw new Error(result.error);
  const current = await evaluate("localStorage.getItem('rewind.script-library.v1')") ?? null;
  assert.deepEqual(JSON.parse(current ?? 'null')?.scripts ?? [], JSON.parse(scripts ?? 'null')?.scripts ?? []);
  await writeFile(join(artifacts, 'python-strings-browser.json'), JSON.stringify({ browser, ...result.value, ui: { hello: true, reverseBug: true, comparison: true, exportImport: true, savedPaged: true, legacyImport: true, mobileWidth: 390 } }, null, 2) + '\n');
  console.log('PASS: strings em Workers de produção, journal/captura/arquivo/comparação paginada, todos os estados em ambos os sentidos, futuro volátil, prefixo VM3 e três arquivos legados VM2.');
}
