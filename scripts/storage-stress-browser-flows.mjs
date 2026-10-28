import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { measureProcessPhase } from './process-resources.mjs';

export async function runStorageStressBrowserFlows({ evaluate, command, context, click, input, text, waitFor, shot, artifacts, browser, pid }) {
  const maxSteps = Number(process.env.REWIND_STRESS_STEPS ?? 20000);
  const scripts = await evaluate("localStorage.getItem('rewind.script-library.v1')");
  const report = { version: 1, maxSteps, date: new Date().toISOString(), browser, node: process.version,
    environment: { platform: process.platform, cpuModel: os.cpus()[0]?.model, cpus: os.availableParallelism(), totalMemoryBytes: os.totalmem() },
    note: 'Firefox installed, isolated profile, Vite dev. Five full-validation/new-Worker vs prefix-reuse/new-Worker rounds in one browser; not five cold browser boots. Timings include RPC, validation, storage and cloning. Reference history created after measured phases. /proc RSS/PSS samples cover the entire isolated browser tree; sampled peaks are lower bounds, not JS heap or allocation peaks.', workloads: [] };
  const parse = async expression => JSON.parse(await evaluate(`(async()=>JSON.stringify(await (${expression})))()`));
  for (const id of ['large-list', 'large-return', 'checkpoint-pressure']) {
    console.log(`Estresse: ${id} · blocos grandes, replay e cinco pares de retomadas.`);
    const measured = {};
    let result;
    try {
      await evaluate(`(async()=>{const {createStressProbe}=await import('/scripts/storage-stress-probe.mjs');window.stressProbe=await createStressProbe(${JSON.stringify(id)},${maxSteps});})()`);
      const record = await measureProcessPhase(pid, async () => {
        while (!await parse('window.stressProbe.recordChunk()')) { /* bounded RPC chunks */ }
        return parse('window.stressProbe.inspect()');
      });
      measured.record = record.memory;
      const replay = await measureProcessPhase(pid, () => parse('window.stressProbe.seekSamples()'));
      measured.replay = replay.memory;
      for (let round = 0; round < 5; round++) {
        const resume = await measureProcessPhase(pid, () => parse(`window.stressProbe.resumeRound(${round + 1})`));
        measured[`resume${round + 1}`] = resume.memory;
      }
      await parse('window.stressProbe.verify()');
      result = await parse('window.stressProbe.report');
      await evaluate('window.stressProbe.release()');
      // Real UI with the largest output accumulated, including reverse/replay.
      if (id === 'checkpoint-pressure') {
        await evaluate("window.dispatchEvent(new Event('focus'))");
        await waitFor("Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')==='Retomar sessão Estresse · Saída e redução de checkpoints')");
        await click('Retomar sessão Estresse · Saída e redução de checkpoints');
        await waitFor("document.querySelector('[data-testid=paged-debugger]') && !document.querySelector('[data-testid=live-open-progress]')");
        const count = Number(await text('[data-testid=step-count]'));
        result.ui = { outputCharacters: await evaluate("document.querySelector('[data-testid=program-output]').textContent.length") };
        assert.ok(result.ui.outputCharacters >= 800000);
        await click('Início'); assert.equal(Number(await text('[data-testid=step-count]')), 0);
        assert.equal(await text('[data-testid=program-output]'), 'Nenhuma saída ainda.');
        await input('#timeline-target', String(count)); await click('Ir');
        assert.equal(Number(await text('[data-testid=step-count]')), count);
        assert.equal(await evaluate("document.querySelector('[data-testid=program-output]').textContent.length"), result.ui.outputCharacters);
        await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
        result.ui.mobileWidth = 390; await shot('firefox-storage-stress-mobile.png');
        await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
        await click('Fechar histórico'); await waitFor("!document.querySelector('[data-testid=paged-debugger]')");
      }
      report.workloads.push({ ...result, measured });
      console.log(`PASS: ${id}, ${result.steps} passos, maior bloco ${result.maxBlockBytes} bytes, ${result.validation.states} estados exatos.`);
    } finally {
      await evaluate('(async()=>{try{await window.stressProbe?.release();}finally{delete window.stressProbe;}})()');
      if (result) await evaluate(`(async()=>{const {RecordingJournal}=await import('/src/core/recording-journal.ts');const j=new RecordingJournal();await j.delete(${JSON.stringify(result.recordingId)});await j.close();window.dispatchEvent(new Event('focus'));})()`);
    }
  }
  report.faults = await parse(`new Promise((resolve,reject)=>{const worker=new Worker('/scripts/storage-stress-fault.worker.mjs',{type:'module'});const timer=setTimeout(()=>{worker.terminate();reject(new Error('Stress fault timeout'));},18000);const cleanup=()=>{clearTimeout(timer);worker.terminate();};worker.onmessage=e=>{cleanup();e.data.error?reject(new Error(e.data.error)):resolve(e.data);};worker.onerror=e=>{cleanup();reject(new Error(e.message));};worker.postMessage({run:true,maxSteps:${maxSteps}});})`);
  assert.equal(report.faults.orphanBlocks, 0); assert.equal(report.faults.retryWithoutDuplicate, true);
  assert.equal(await evaluate("localStorage.getItem('rewind.script-library.v1')"), scripts);
  await writeFile(join(artifacts, 'storage-stress-browser.json'), JSON.stringify(report, null, 2) + '\n');
  const html = renderStressReport(report);
  await writeFile(join(artifacts, 'storage-stress.html'), html);
  await command('browsingContext.navigate', { context, url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`, wait: 'complete' });
  assert.equal(await evaluate("document.querySelectorAll('[data-case]').length"), 3);
  await evaluate("(()=>{const s=document.querySelector('#case');s.value='large-list';s.dispatchEvent(new Event('change'));})()");
  assert.equal(await evaluate("Array.from(document.querySelectorAll('[data-case]')).filter(r=>!r.hidden).length"), 1);
  await shot('firefox-storage-stress-report.png');
  console.log('PASS: estresse nativo, quota atômica sem blocos órfãos, corrupção, resposta perdida, auxiliares opcionais, replay exato e relatório visual.');
}

function renderStressReport(report) {
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ms = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(1);
  const rows = report.workloads.map(w => {
    const a = w.resumes.map(r => r.fullValidationNewWorker.ms), b = w.resumes.map(r => r.prefixReuseNewWorker.ms), max = Math.max(...a, ...b);
    const bars = a.map((v, i) => `<rect x="${i * 44 + 5}" y="${90 - v / max * 80}" width="16" height="${v / max * 80}" fill="#6ee7cf"/><rect x="${i * 44 + 23}" y="${90 - b[i] / max * 80}" width="16" height="${b[i] / max * 80}" fill="#90a9ff"/>`).join('');
    return `<tr data-case="${w.id}"><th scope="row">${escape(w.name)}<small>${w.steps} passos · ${w.validation.states} estados exatos</small></th><td>${(w.validation.maxStepBytes / 1024).toFixed(1)} KiB<small>${w.oversizedBlocks.length} blocos grandes isolados</small></td><td>${w.checkpoints.count}<small>${(w.checkpoints.bytes / 1048576).toFixed(2)} MiB</small></td><td>${ms(a)} ms<small>integral · Worker novo</small>${ms(b)} ms<small>prefixo · Worker novo</small></td><td><svg viewBox="0 0 225 100" width="225" height="100" role="img" aria-label="Cinco pares de retomadas, verde validação integral, azul prefixo reutilizado">${bars}</svg><small>5 rodadas · escala por programa</small></td></tr>`;
  }).join('');
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rewind · Estresse de armazenamento</title><style>body{margin:0;background:#101622;color:#e4ebf5;font:16px/1.6 system-ui}main{max-width:1160px;margin:auto;padding:32px}p{color:#b9c7d9;max-width:90ch}table{border-collapse:collapse;width:100%}th,td{padding:18px 12px;text-align:left;border-bottom:1px solid #324054}small{display:block;color:#9fb0c7;font-weight:400}select{padding:10px;background:#202b40;color:inherit;border:1px solid #51647c;border-radius:6px}.scroll{overflow:auto}code{color:#6ee7cf}li{margin-bottom:8px}</style><main><p>REWIND · ESTRESSE E RECUPERAÇÃO</p><h1>Uma transação grande continua reversível</h1><p>Firefox ${escape(report.browser)} · ${escape(report.date)} · ${escape(report.environment.cpuModel)}. Transações maiores que o bloco padrão ficam isoladas. O cache de deltas usa apenas 1 KiB e preserva a leitura temporária dos blocos grandes.</p><label for="case">Programa </label><select id="case"><option value="all">Todos</option>${report.workloads.map(w => `<option value="${w.id}">${escape(w.name)}</option>`).join('')}</select><div class="scroll"><table><thead><tr><th>Programa</th><th>Maior delta</th><th>Checkpoints retidos</th><th>Medianas de retomada</th><th>Integral / prefixo</th></tr></thead><tbody>${rows}</tbody></table></div><h2>Falhas verificadas no IndexedDB real</h2><ul><li>Quota no head aborta bloco, cabeça e catálogo juntos: <strong>zero blocos órfãos</strong>.</li><li>O delta grande pendente continua navegável e retry preserva um único registro e uma única saída.</li><li>Corrupção recusa o salto e preserva o estado publicado; restauração do bloco permite replay exato.</li><li>Resposta perdida após commit é reconciliada; falha dos checkpoints e do cache de prefixos preserva a gravação original.</li><li>Cancelar antes do ACK preserva o cursor; cancelar depois conclui o destino aceito.</li></ul><p>São cinco pares de Workers novos na mesma instância do Firefox, com validação integral ou prefixo reaproveitado. Não são cinco inicializações frias do navegador. Tempos incluem banco, validação, cópias e RPC. Referência sequencial criada depois das medições. Memória amostrada e dados completos no JSON; o teto de payload não representa RAM.</p><p>Reproduzir: <code>npm run bench:stress</code>. Limite declarado de ${report.maxSteps.toLocaleString('pt-BR')} passos e 256 frames. Nenhum histórico descartado.</p></main><script>document.querySelector('#case').addEventListener('change',e=>{for(const r of document.querySelectorAll('[data-case]'))r.hidden=e.target.value!=='all'&&r.dataset.case!==e.target.value;});</script></html>`;
}
