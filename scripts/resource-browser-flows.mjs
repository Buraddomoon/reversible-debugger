import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { measureProcessPhase } from './process-resources.mjs';
import { renderResourceReport } from './resource-report.mjs';

export async function runResourceBrowserFlows({ evaluate, command, context, click, text, waitFor, shot, artifacts, browser, pid }) {
  const scripts = await evaluate("localStorage.getItem('rewind.script-library.v1')");
  const report = { version: 1, date: new Date().toISOString(), browser, node: process.version,
    environment: { platform: process.platform, architecture: process.arch, cpus: os.availableParallelism(), cpuModel: os.cpus()[0]?.model, totalMemoryBytes: os.totalmem(), viewport: { width: 1440, height: 1100 }, mode: 'Vite dev / Firefox headless / isolated project profile' },
    memoryMethod: 'Linux /proc, isolated Firefox process tree. RSS sum includes shared pages more than once; PSS apportions shared pages. Private = Private_Clean + Private_Dirty. Samples are non-atomic lower bounds of peaks, include browser/JIT/GC/graphics/other tabs, and do not measure JS heap. No forced GC. Missing/denied measurements are null. Scans add overhead.',
    limits: { maxSteps: 20000, maxFrames: 256, cacheBytes: 65536, bufferBytes: 32768, maxHistoryBytes: 67108864 }, workloads: [] };
  const ids = ['numeric', 'heap-output', 'recursion', 'locals'];
  const parse = async expression => JSON.parse(await evaluate(`(async()=>JSON.stringify(await (${expression})))()`));
  for (const id of ids) {
    console.log(`Perfil de recursos: ${id} · gravação, persistência, navegação, retomada e UI.`);
    const entry = { id, phases: [] };
    report.workloads.push(entry);
    const stage = async (name, action) => {
      const measured = await measureProcessPhase(pid, async () => {
        await evaluate(`window.resourceProbe.begin(${JSON.stringify(name)})`);
        const extra = await action();
        const result = await parse('window.resourceProbe.end()');
        return { ...result, extra };
      });
      entry.phases.push({ ...measured.value, memory: measured.memory });
    };
    let completed = false;
    try {
      const setup = await measureProcessPhase(pid, () => parse(`(async()=>{const {createProbe}=await import('/scripts/resource-browser-probe.mjs');window.resourceProbe=await createProbe(${JSON.stringify(id)});return {name:window.resourceProbe.workload.name,recordingId:window.resourceProbe.recordingId};})()`));
      Object.assign(entry, setup.value); entry.setupMemory = setup.memory;
      await stage('record', async () => { let progress; do { progress = await parse('window.resourceProbe.recordChunk()'); } while (!progress.done); return progress; });
      await stage('flush', () => evaluate('window.resourceProbe.flush()'));
      await stage('seek', () => parse('window.resourceProbe.seeks()'));
      await stage('resume', () => parse('window.resourceProbe.reopen()'));
      // Reference VM and its retained history must be outside profiling phases.
      entry.validation = await parse('window.resourceProbe.verify()');
      await evaluate('window.resourceProbe.release();');
      await evaluate("window.dispatchEvent(new Event('focus'))");
      await waitFor(`Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')===${JSON.stringify(`Retomar sessão ${entry.name ? 'Perfil · ' + entry.name : ''}`)})`);
      await click(`Retomar sessão Perfil · ${entry.name}`);
      await waitFor("document.querySelector('[data-testid=paged-debugger]') && !document.querySelector('[data-testid=live-open-progress]')");
      const count = Number(await text('[data-testid=step-count]'));
      const ui = await measureProcessPhase(pid, async () => {
        const targets = [0, count, Math.floor(count / 2), count, 1, 0];
        const samples = [];
        for (const target of targets) {
          // Measure inside the page. Includes Worker RPC, React commit and two
          // animation-frame opportunities; does not claim GPU paint timing.
          samples.push(await parse(`new Promise((resolve,reject)=>{const begin=performance.now(),field=document.querySelector('#timeline-target'),deadline=begin+15000;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${target});field.dispatchEvent(new Event('input',{bubbles:true}));setTimeout(()=>{Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Ir').click();const check=()=>{if(Number(document.querySelector('[data-testid=step-count]').textContent)===${target}&&!document.querySelector('[data-testid=seek-progress]'))requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({target:${target},commitAndTwoFramesMs:performance.now()-begin,domElements:document.querySelectorAll('[data-testid=paged-debugger] *').length})));else if(performance.now()>deadline)reject(new Error('UI did not settle'));else setTimeout(check,5);};check();},0);})`));
        }
        return samples;
      });
      entry.ui = { samples: ui.value, memory: ui.memory };
      assert.ok(ui.value.every(sample => sample.domElements < 2000), 'Debugger DOM must stay bounded');
      await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      entry.mobileWidth = 390;
      if (id === 'locals') await shot('firefox-resource-profile-mobile.png');
      await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
      await click('Fechar histórico'); await waitFor("!document.querySelector('[data-testid=paged-debugger]')");
      completed = true;
      console.log(`PASS: ${id}, ${entry.validation.count} passos, ${entry.validation.states} estados completos e UI móvel.`);
    } finally {
      // In case of failure, best effort release the isolated benchmark worker.
      await evaluate('(async()=>{try{await window.resourceProbe?.release();}catch{}delete window.resourceProbe;})()');
      try {
        if (await evaluate("Boolean(document.querySelector('[data-testid=paged-debugger]'))")) { await click('Fechar histórico'); await waitFor("!document.querySelector('[data-testid=paged-debugger]')"); }
        if (entry.recordingId) await evaluate(`(async()=>{const {RecordingJournal}=await import('/src/core/recording-journal.ts');const j=new RecordingJournal();await j.delete(${JSON.stringify(entry.recordingId)});await j.close();window.dispatchEvent(new Event('focus'));})()`);
      } catch (error) { if (completed) throw error; console.error('Limpeza do perfil isolado:', error.message); }
    }
  }
  assert.equal(await evaluate("localStorage.getItem('rewind.script-library.v1')"), scripts);
  await writeFile(join(artifacts, 'resource-profile.json'), JSON.stringify(report, null, 2) + '\n');
  const html = renderResourceReport(report);
  await writeFile(join(artifacts, 'resource-profile.html'), html);
  await command('browsingContext.navigate', { context, url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`, wait: 'complete' });
  assert.equal(await evaluate("document.querySelectorAll('[data-case]').length"), 16);
  await evaluate("(()=>{const select=document.querySelector('#case');select.value='locals';select.dispatchEvent(new Event('change'));})()");
  assert.equal(await evaluate("Array.from(document.querySelectorAll('[data-case]')).filter(row=>!row.hidden).length"), 4);
  await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await shot('firefox-resource-report.png');
  console.log('PASS: perfil reproduzível de recursos, payload/RSS/PSS distintos, estados exatos e scripts preservados. Relatórios em .artifacts/resource-profile.{json,html}.');
}
