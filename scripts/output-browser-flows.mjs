import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function runOutputBrowserFlows({ evaluate, command, context, click, input, text, waitFor, shot, artifacts, browser }) {
  const previous = await evaluate("localStorage.getItem('rewind.script-library.v1')") ?? null;
  const source = 'def emit():\n    n = 10 ** 2000\n    i = 0\n    while i < 400:\n        print(n)\n        i += 1\n    return i\nresult = emit()';
  const expected = ('1' + '0'.repeat(2000) + '\n').repeat(400), report = { browser, total: expected.length, modes: {} };
  const id = 'script:output-pagination', name = 'Saída extensa'; let recordingId;
  const select = (selector, value) => evaluate(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const checkPages = async (mode, selector = '[data-testid=program-output]') => {
    const panel = selector.includes('comparison') ? '.lane-a .comparison-output' : '.output-panel';
    assert.equal(Number(await evaluate(`document.querySelector(${JSON.stringify(panel)}).dataset.outputTotal`)), expected.length);
    const pageCount = Number(await evaluate(`document.querySelector(${JSON.stringify(panel + ' input')}).max`)); let rebuilt = '';
    for (let page = 1; page <= pageCount; page++) {
      await input(`${panel} input`, String(page)); const part = await evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`); assert.ok(part.length <= 32769); rebuilt += part;
    }
    assert.ok(rebuilt === expected, `${mode}: todas as páginas devem reconstruir a saída exata`); report.modes[mode] = { pages: pageCount, exactText: true, maxDOMCharacters: 32769 };
  };
  try {
    await evaluate(`(()=>{const key='rewind.script-library.v1',d=JSON.parse(localStorage.getItem(key)||'null')||{schemaVersion:1,scripts:[]};d.scripts.push({id:${JSON.stringify(id)},name:${JSON.stringify(name)},filename:'saida.py',language:'python',version:'3',source:${JSON.stringify(source)}});d.selection=${JSON.stringify(id)};localStorage.setItem(key,JSON.stringify(d));})()`);
    await command('browsingContext.reload', { context, wait: 'complete' }); await waitFor("document.querySelector('[data-testid=step-count]')");
    await click('Entrar'); await click('Passar sobre'); await waitFor("document.querySelector('[role=status]').textContent==='Concluído'");
    await checkPages('classic');
    await click('Acompanhar fim da saída'); const last = await text('[data-testid=program-output]');
    // Observe the actual Blob produced by the download action, not a second export helper.
    await evaluate("(()=>{window.outputBlobOriginal=URL.createObjectURL;URL.createObjectURL=blob=>{window.outputDownload=blob;return window.outputBlobOriginal(blob);};})()");
    await click('Baixar saída completa');
    assert.ok(await evaluate('window.outputDownload.text()') === expected, 'Download deve preservar toda a saída');
    await evaluate('URL.createObjectURL=window.outputBlobOriginal;delete window.outputBlobOriginal;delete window.outputDownload'); report.downloadExact = true;
    await click('Início'); assert.ok(await text('[data-testid=program-output]') === 'Nenhuma saída ainda.', 'Recuar até zero deve remover toda a saída');
    await click('Último'); assert.equal(await text('[data-testid=program-output]'), last);
    await click('Primeira página da saída'); await shot('firefox-output-pagination.png');
    await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true); await shot('firefox-output-pagination-mobile.png');
    await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
    await click('Comparar execuções'); await select('[aria-label="Programa da execução B"]', id); await click('Preparar comparação');
    await waitFor("document.querySelector('[data-testid=comparison-final-a]')", 60000); await click('Final da comparação');
    await waitFor("document.querySelector('.lane-a [data-output-total]')?.dataset.outputTotal==='800800'", 60000);
    await checkPages('comparison', '[data-testid=comparison-output-a]');
    assert.ok((await text('[data-testid=comparison-output-b]')).length <= 32769);
    await click('Voltar ao debugger');
    await click('Gravar sessão'); await input('#live-name', name); await click('Iniciar gravação');
    await waitFor("document.querySelector('[data-testid=paged-debugger]') && !document.querySelector('[data-testid=live-open-progress]')");
    recordingId = await evaluate("document.querySelector('#example').value.slice(6)");
    await click('Executar'); await waitFor("document.querySelector('[role=status]').textContent==='Concluído'", 60000);
    await checkPages('live'); await click('Acompanhar fim da saída');
    await click('Início'); assert.ok(await text('[data-testid=program-output]') === 'Nenhuma saída ainda.', 'Recuar até zero deve remover toda a saída');
    await click('Último'); assert.equal(await text('[data-testid=program-output]'), last);
    await click('Abrir debugger completo'); await waitFor("!document.querySelector('[data-testid=paged-debugger]')", 60000);
    await checkPages('materialized'); await click('Fechar histórico');
    report.reverseAndReplay = true; report.mobileWidth = 390;
  } finally {
    if (recordingId) {
      await evaluate('new Promise(r=>setTimeout(r,5200))');
      await evaluate(`(async()=>{const {RecordingJournal}=await import('/src/core/recording-journal.ts');const j=new RecordingJournal();try{await j.delete(${JSON.stringify(recordingId)});}finally{await j.close();}})()`);
    }
    await evaluate(`(()=>{const old=${JSON.stringify(previous)},key='rewind.script-library.v1';if(old===null)localStorage.removeItem(key);else localStorage.setItem(key,old);})()`);
  }
  await writeFile(join(artifacts, 'output-pagination-browser.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('PASS: 800.800 caracteres completos, páginas limitadas, download exato, saída clássica/contínua/comparação/materialização, reversão e 390 px.');
}
