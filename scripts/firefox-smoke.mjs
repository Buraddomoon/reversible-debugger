/** Smoke test against an existing Firefox, using standard WebDriver BiDi and no browser downloads. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, '.artifacts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(join(artifacts, 'firefox-profile-'));
await writeFile(join(profile, 'user.js'), [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.startup.homepage", "about:blank");',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("browser.aboutwelcome.enabled", false);',
  'user_pref("app.update.auto", false);',
  'user_pref("extensions.update.enabled", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
].join('\n'));
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5178, strictPort: true } });
await server.listen();
const port = process.env.REWIND_BIDI_PORT ?? '9238';
const firefox = spawn(process.env.FIREFOX_BIN ?? 'firefox', [
  '--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', port, 'about:blank',
], { cwd: root, env: { ...process.env, MOZ_HEADLESS_WIDTH: '1440', MOZ_HEADLESS_HEIGHT: '1100' }, stdio: ['ignore', 'pipe', 'pipe'] });
let browserLogs = '';
firefox.stdout.on('data', data => { browserLogs += data; });
firefox.stderr.on('data', data => { browserLogs += data; });
const browserExit = new Promise((_, reject) => {
  firefox.once('error', reject);
  firefox.once('exit', code => reject(new Error(`Firefox encerrou com código ${code}. ${browserLogs.slice(-1500)}`)));
});
// The rejection also races startup; keep cleanup exits from creating unhandled rejections.
browserExit.catch(() => {});
let socket;
try {
  await Promise.race([
    browserExit,
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const check = () => {
        if (browserLogs.includes('WebDriver BiDi listening')) return resolve();
        if (Date.now() > deadline) return reject(new Error(`Firefox não iniciou o protocolo BiDi. ${browserLogs.slice(-1500)}`));
        setTimeout(check, 100);
      };
      check();
    }),
  ]);
  socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'log.entryAdded' && message.params.level === 'error') pageErrors.push(message.params.text);
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.type === 'error') request.reject(new Error(`${message.error}: ${message.message}`));
    else request.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const currentId = ++id;
    const timer = setTimeout(() => { pending.delete(currentId); reject(new Error(`Timeout: ${method}`)); }, 20_000);
    pending.set(currentId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: currentId, method, params }));
  });
  const session = await command('session.new', { capabilities: {} });
  console.log(`Firefox ${session.capabilities.browserVersion} existente; perfil isolado no projeto.`);
  await command('session.subscribe', { events: ['log.entryAdded'] });
  const tree = await command('browsingContext.getTree', {});
  const context = tree.contexts[0].context;
  const evaluate = async expression => {
    const response = await command('script.evaluate', { expression, target: { context }, awaitPromise: true });
    if (response.type === 'exception') throw new Error(response.exceptionDetails.text);
    return response.result.value;
  };
  const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim()`);
  const click = name => evaluate(`(() => { const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(name)} || b.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!button || button.disabled) throw new Error('Botão indisponível: ' + ${JSON.stringify(name)}); button.click(); return true; })()`);
  const waitFor = (expression, timeout = 15_000) => evaluate(`new Promise((resolve, reject) => { const deadline = Date.now() + ${timeout}; const check = () => { if (${expression}) return resolve(true); if (Date.now() > deadline) return reject(new Error('Condição não satisfeita')); setTimeout(check, 30); }; check(); })`);
  const choose = value => evaluate(`(() => { const select = document.querySelector('#example'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const shot = async name => {
    const screenshot = await command('browsingContext.captureScreenshot', { context, origin: 'document', format: { type: 'image/png' } });
    await writeFile(join(artifacts, name), Buffer.from(screenshot.data, 'base64'));
  };
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  await command('browsingContext.navigate', { context, url: 'http://127.0.0.1:5178/', wait: 'complete' });
  await waitFor("document.querySelector('[data-testid=step-count]')");
  assert.match(await text('.source-runtime'), /Python 3/);
  await choose('sum-bug');
  assert.equal(await text('[data-testid=step-count]'), '000');
  await shot('firefox-initial.png');
  await click('Avançar');
  await waitFor("document.querySelector('[data-testid=step-count]').textContent === '001'");
  await click('Avançar');
  await waitFor("document.querySelector('[data-testid=call-stack]').textContent.includes('sumTo()')");
  await click('Voltar');
  await waitFor("!document.querySelector('[data-testid=call-stack]').textContent.includes('sumTo()')");
  await click('Avançar');
  await click('Executar');
  await waitFor("document.querySelector('[role=status]').textContent === 'Concluído'");
  assert.equal(await text('[data-testid=result-value]'), '10');
  const count = await text('[data-testid=step-count]');
  await shot('firefox-bug.png');
  await click('Voltar'); await click('Voltar');
  await waitFor("document.querySelector('[data-testid=result-value]').textContent === '—'");
  await click('Voltar');
  await waitFor("document.querySelector('[data-testid=call-stack]').textContent.includes('sumTo()')");
  const restoredLocals = JSON.parse(await evaluate("JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('.variable-row')).map(row => [row.querySelector('code').textContent, row.querySelector('strong').textContent])))"));
  assert.deepEqual(restoredLocals, { n: '5', total: '10', i: '5' });
  await shot('firefox-restored.png');
  await click('Retroceder tudo');
  await waitFor("document.querySelector('[data-testid=step-count]').textContent === '000'");
  await click('Executar');
  await waitFor("document.querySelector('[role=status]').textContent === 'Concluído'");
  assert.equal(await text('[data-testid=step-count]'), count);
  assert.equal(await text('[data-testid=result-value]'), '10');
  console.log('PASS: bug, chamada, retorno, reinício e reaplicação exata.');

  const input = (selector, value) => evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const historyLength = await text('[data-testid=history-length]');
  await click('Início');
  await waitFor("document.querySelector('[data-testid=step-count]').textContent === '000'");
  assert.equal(await text('[data-testid=result-value]'), '—');
  await evaluate("document.querySelector('[data-event-cursor=\"2\"]').click()");
  await waitFor("document.querySelector('[data-testid=call-stack]').textContent.includes('sumTo()')");
  assert.match(await text('[data-testid=timeline-selected]'), /Entrar em sumTo/);
  assert.match(await text('.changes-panel'), /Estado restaurado/);
  await input('#timeline-target', '99999');
  assert.equal(await evaluate("document.querySelector('.timeline-jump button').disabled"), true);
  await input('#timeline-target', '1'); await click('Ir');
  await waitFor("document.querySelector('[data-testid=step-count]').textContent === '001'");
  assert.equal(await evaluate("document.querySelector('[data-testid=call-stack]').textContent.includes('sumTo()')"), false);
  await evaluate("document.querySelector('#timeline-position').focus()");
  await command('input.performActions', { context, actions: [{ type: 'key', id: 'timeline-keyboard', actions: [{ type: 'keyDown', value: '\uE014' }, { type: 'keyUp', value: '\uE014' }] }] });
  await waitFor("document.querySelector('[data-testid=step-count]').textContent === '002'");
  await input('#timeline-position', '20');
  await waitFor("document.querySelector('[data-testid=step-count]').textContent === '020'");
  await shot('firefox-timeline.png');
  await click('Último');
  assert.equal(await text('[data-testid=step-count]'), count);
  assert.equal(await text('[data-testid=result-value]'), '10');
  assert.equal(await text('[data-testid=history-length]'), historyLength);
  assert.ok(await evaluate("document.querySelectorAll('[data-event-cursor]').length") <= 8);
  await click('Evento anterior');
  await waitFor("document.querySelector('[data-testid=timeline-selected]').textContent.includes('sumTo retorna')");
  await click('Evento anterior');
  assert.equal(await evaluate("document.querySelector('[data-testid=call-stack]').textContent.includes('sumTo()')"), true);
  await click('Próximo evento');
  assert.match(await text('[data-testid=timeline-selected]'), /sumTo retorna/);
  await click('Início'); await click('Executar');
  await input('#timeline-position', '2');
  await waitFor("document.querySelector('[role=status]').textContent === 'Pausado'");
  await evaluate('new Promise(resolve => setTimeout(resolve, 250))');
  assert.equal(await text('[data-testid=step-count]'), '002');
  await click('Último');
  console.log('PASS: linha do tempo, teclado, saltos exatos, eventos, pausa ao navegar e histórico preservado.');

  await choose('python-sum-bug'); await click('Executar');
  await waitFor("document.querySelector('[role=status]').textContent === 'Concluído'");
  await evaluate("Array.from(document.querySelectorAll('[data-event-kind=decision]')).at(-1).click()");
  assert.match(await text('[data-testid=timeline-selected]'), /Condição falsa/);
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.variable-row')).find(row => row.querySelector('code').textContent === 'i').querySelector('strong').textContent"), '5');
  await shot('firefox-python-timeline.png');

  await choose('sum-fixed');
  await click('Executar');
  await waitFor("document.querySelector('[role=status]').textContent === 'Concluído'");
  assert.equal(await text('[data-testid=result-value]'), '15');
  await choose('runtime-error');
  await click('Executar');
  await waitFor("document.querySelector('[role=alert]')");
  assert.equal(await text('[role=alert]'), 'Divisão por zero');
  await click('Voltar');
  await waitFor("!document.querySelector('[role=alert]')");
  assert.equal(await text('[data-testid=next-instruction]'), 'Calcular /');
  await click('Avançar');
  await waitFor("document.querySelector('[role=alert]')");
  await click('Início');
  await waitFor("!document.querySelector('[role=alert]')");
  await evaluate("document.querySelector('[data-event-kind=error]').click()");
  await waitFor("document.querySelector('[role=alert]')");
  assert.equal(await text('[role=alert]'), 'Divisão por zero');
  console.log('PASS: soma corrigida e erro reversível.');

  await choose('factorial');
  await click('Avançar'); await click('Avançar');
  await shot('firefox-call.png');
  await click('Executar');
  await waitFor("document.querySelector('[role=status]').textContent === 'Concluído'");
  assert.equal(await text('[data-testid=result-value]'), '120');
  console.log('PASS: execução recursiva até o resultado 120.');
  await click('Retroceder tudo');
  await waitFor("document.querySelector('[data-testid=step-count]').textContent === '000'");
  await click('Avançar'); await click('Avançar');
  await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  await shot('firefox-mobile.png');
  await click('Editar código');
  const edit = value => evaluate(`(() => { const editor = document.querySelector('#source-editor'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, ${JSON.stringify(value)}); editor.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await edit('let result = ;'); await click('Aplicar código');
  await waitFor("document.querySelector('[role=alert]')");
  assert.match(await text('[role=alert]'), /expressão/);
  await edit('fn twice(n) { return n * 2; }\nlet result = twice(21);'); await click('Aplicar código');
  await click('Executar');
  await waitFor("document.querySelector('[role=status]').textContent === 'Concluído'");
  assert.equal(await text('[data-testid=result-value]'), '42');
  console.log('PASS: edição, diagnóstico e layout móvel sem overflow.');

  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  const createScript = async (name, language = 'python') => {
    await click('Adicionar script');
    await waitFor("document.querySelector('dialog[open] #new-script-name')");
    await input('#new-script-name', name);
    await evaluate(`(() => { const select = document.querySelector('#script-language'); select.value = ${JSON.stringify(language)}; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await click('Criar');
    await waitFor("!document.querySelector('dialog[open]') && document.querySelector('#source-editor')");
  };
  const currentStep = await text('[data-testid=step-count]');
  await click('Adicionar script');
  await waitFor("document.querySelector('dialog[open]')");
  assert.equal(await evaluate("document.activeElement.id"), 'new-script-name');
  assert.equal(await evaluate("Array.from(document.querySelectorAll('dialog button')).find(button => button.textContent === 'Criar').disabled"), true);
  assert.equal(await evaluate("document.querySelector('#script-language').value"), 'python');
  assert.equal(await evaluate("document.querySelector('#script-version').value"), '3');
  await input('#new-script-name', 'Meu script');
  await shot('firefox-new-script-modal.png');
  await command('input.performActions', { context, actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE00C' }, { type: 'keyUp', value: '\uE00C' }] }] });
  await waitFor("!document.querySelector('dialog[open]')");
  assert.equal(await text('[data-testid=step-count]'), currentStep);
  await createScript('Meu script', 'rewind');
  assert.equal(await evaluate("document.querySelector('#source-editor').value"), '');
  assert.equal(await text('[data-testid=step-count]'), '000');
  assert.equal(await text('[data-testid=result-value]'), '—');
  assert.equal(await evaluate("document.querySelector('#example').selectedOptions[0].textContent"), 'Meu script');
  console.log('PASS: modal acessível, nome/linguagem/versão, cancelamento com Escape e script vazio sem estado anterior.');
  const upload = (name, source) => evaluate(`(() => { const input = document.querySelector('input[type=file]'); const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(source)}], ${JSON.stringify(name)}, { type: 'text/plain' })); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const personal = 'def double(n):\n    return n * 2\nresult = double(21)\nprint(result)';
  await upload('meu-script.py', personal);
  await waitFor(`document.querySelector('#source-editor').value === ${JSON.stringify(personal)}`);
  assert.match(await text('.editor-runtime'), /Python 3/);
  await shot('firefox-script-editor.png');
  await click('Aplicar código'); await click('Executar');
  await waitFor("document.querySelector('[role=status]').textContent === 'Concluído'");
  assert.equal(await text('[data-testid=result-value]'), '42');
  assert.equal(await text('[data-testid=program-output]'), '42');
  await click('Início');
  assert.equal(await text('[data-testid=program-output]'), 'Nenhuma saída ainda.');
  await evaluate("document.querySelector('[data-event-kind=output]').click()");
  assert.equal(await text('[data-testid=program-output]'), '42');
  await click('Último');
  await shot('firefox-python.png');
  const pythonCount = await text('[data-testid=step-count]');
  await click('Retroceder tudo');
  await waitFor("document.querySelector('[data-testid=step-count]').textContent === '000'");
  assert.equal(await text('[data-testid=result-value]'), '—');
  assert.equal(await text('[data-testid=program-output]'), 'Nenhuma saída ainda.');
  await click('Executar');
  await waitFor("document.querySelector('[role=status]').textContent === 'Concluído'");
  assert.equal(await text('[data-testid=step-count]'), pythonCount);
  assert.equal(await text('[data-testid=program-output]'), '42');
  console.log('PASS: importar .py, selecionar linguagem/versão, executar Python, desfazer saída e reaplicar tudo.');
  await click('Reiniciar programa');
  assert.equal(await text('[data-testid=history-length]'), '0 passos registrados');
  assert.equal(await evaluate("document.querySelector('#timeline-position').disabled"), true);
  assert.equal(await text('[data-testid=step-count]'), '000');
  assert.equal(await text('[data-testid=result-value]'), '—');
  assert.equal(await text('[data-testid=program-output]'), 'Nenhuma saída ainda.');
  assert.equal(await evaluate("document.querySelector('#example').selectedOptions[0].textContent"), 'Meu script');
  await click('Editar código');
  await edit(personal + '\n# código em edição');
  await command('browsingContext.reload', { context, wait: 'complete' });
  await waitFor("document.querySelector('[data-testid=step-count]')");
  assert.equal(await evaluate("document.querySelector('#example').selectedOptions[0].textContent"), 'Meu script');
  assert.match(await text('.source-scroll'), /código em edição/);
  await click('Editar código');
  await edit('result =');
  await command('browsingContext.reload', { context, wait: 'complete' });
  await waitFor("document.querySelector('#source-editor')");
  assert.equal(await evaluate("document.querySelector('#source-editor').value"), 'result =');
  assert.match(await text('[role=alert]'), /Expressão Python/);
  await edit(personal); await click('Aplicar código');
  console.log('PASS: reiniciar programa, recarregar imediatamente e preservar até código incompleto em edição.');

  await createScript('Arquivo grande');
  const largeSource = '# comentário\n'.repeat(10000) + 'result = 42\n';
  await upload('grande.py', largeSource);
  await waitFor("document.querySelector('#source-editor').value.endsWith('result = 42\\n')");
  await upload('excesso.py', ' '.repeat(1_000_001));
  await waitFor("document.querySelector('[role=alert]')");
  assert.match(await text('[role=alert]'), /1\.000\.000/);
  assert.equal(await evaluate('document.querySelector("#source-editor").value.length'), largeSource.length);
  await click('Aplicar código');
  await waitFor("document.querySelector('[data-testid=current-line]')?.textContent.includes('10001')");
  assert.ok(await evaluate("document.querySelectorAll('.code-line').length") < 100);
  await click('Executar');
  await waitFor("document.querySelector('[role=status]').textContent === 'Concluído'");
  assert.equal(await text('[data-testid=result-value]'), '42');
  await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  await waitFor("Array.from(document.querySelectorAll('.source-scroll code')).some(code => code.textContent.includes('result = 42'))");
  await shot('firefox-large-mobile.png');
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.source-scroll code')).some(code => code.textContent.includes('result = 42'))"), true);
  console.log('PASS: arquivo de 10.001 linhas, código virtualizado, limite ampliado e preservação do rascunho.');
  const scriptCount = await evaluate("document.querySelectorAll('#example optgroup[label=\"Seus scripts\"] option').length");
  await click('Excluir script');
  await waitFor("document.querySelector('dialog[open]')");
  assert.match(await text('dialog[open]'), /Arquivo grande/);
  await shot('firefox-delete-script.png');
  await click('Cancelar');
  assert.equal(await evaluate("document.querySelectorAll('#example optgroup[label=\"Seus scripts\"] option').length"), scriptCount);
  await click('Excluir script'); await click('Excluir');
  await command('browsingContext.reload', { context, wait: 'complete' });
  await waitFor("document.querySelector('[data-testid=step-count]')");
  assert.equal(await evaluate("document.querySelectorAll('#example optgroup[label=\"Seus scripts\"] option').length"), scriptCount - 1);
  assert.equal(await evaluate("document.querySelector('#example').selectedOptions[0].textContent"), 'Meu script');
  assert.match(await text('.source-scroll'), /def double/);
  assert.equal(await evaluate("Array.from(document.querySelectorAll('#example option')).some(option => option.textContent === 'Arquivo grande')"), false);
  console.log('PASS: confirmação de exclusão, cancelamento e manutenção dos outros scripts após recarregar.');
  assert.deepEqual(pageErrors, []);
  console.log('PASS: ausência de erros no console.');
  await command('session.end');
} finally {
  if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  firefox.kill('SIGTERM');
  await server.close();
  await writeFile(join(artifacts, 'firefox.log'), browserLogs);
}
