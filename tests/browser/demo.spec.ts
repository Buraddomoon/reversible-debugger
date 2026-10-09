import { expect, test } from '@playwright/test';

test('executa o bug, volta ao início e reaplica o mesmo resultado', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Programa', { exact: true }).selectOption('sum-bug');
  await expect(page.getByTestId('result-value')).toHaveText('—');
  await expect(page.getByRole('button', { name: 'Voltar', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Avançar', exact: true }).click();
  await expect(page.getByTestId('step-count')).toHaveText('001');
  await page.getByRole('button', { name: 'Avançar', exact: true }).click();
  await expect(page.getByTestId('call-stack')).toContainText('sumTo()');
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await expect(page.getByTestId('call-stack')).not.toContainText('sumTo()');
  await page.getByRole('button', { name: 'Avançar', exact: true }).click();
  await page.getByRole('button', { name: 'Executar', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Concluído', { timeout: 15000 });
  await expect(page.getByTestId('result-value')).toHaveText('10');
  const count = await page.getByTestId('step-count').textContent();
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Pausado');
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await expect(page.getByTestId('result-value')).toHaveText('—');
  await page.getByRole('button', { name: 'Retroceder tudo', exact: true }).click();
  await expect(page.getByTestId('step-count')).toHaveText('000');
  await page.getByRole('button', { name: 'Executar', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Concluído', { timeout: 15000 });
  await expect(page.getByTestId('step-count')).toHaveText(count!);
  await expect(page.getByTestId('result-value')).toHaveText('10');
});

test('troca exemplos e desfaz um erro de execução', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Programa', { exact: true }).selectOption('sum-fixed');
  await page.getByRole('button', { name: 'Executar', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Concluído', { timeout: 15000 });
  await expect(page.getByTestId('result-value')).toHaveText('15');
  await page.getByLabel('Programa', { exact: true }).selectOption('runtime-error');
  await page.getByRole('button', { name: 'Executar', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Divisão por zero');
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('next-instruction')).toHaveText('Calcular /');
  await page.getByRole('button', { name: 'Avançar', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Divisão por zero');
});

test('permite editar código, preserva a sessão diante de sintaxe inválida e funciona sem overflow', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Programa', { exact: true }).selectOption('sum-bug');
  await page.getByRole('button', { name: 'Editar código' }).click();
  await page.getByLabel('Código do programa').fill('let result = ;');
  await page.getByRole('button', { name: 'Aplicar código' }).click();
  await expect(page.getByRole('alert')).toContainText('Esperada uma expressão');
  await page.getByLabel('Código do programa').fill('fn twice(n) { return n * 2; }\nlet result = twice(21);');
  await page.getByRole('button', { name: 'Aplicar código' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Executar', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Concluído');
  await expect(page.getByTestId('result-value')).toHaveText('42');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('adiciona e importa Python com linguagem e versão reais, retrocede tudo e reaplica a saída', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Adicionar script' }).click();
  await expect(page.getByLabel('Linguagem', { exact: true })).toHaveValue('python');
  await expect(page.getByLabel('Versão', { exact: true })).toHaveValue('3');
  await page.getByLabel('Linguagem', { exact: true }).selectOption('rewind');
  await page.getByLabel('Arquivo do script').setInputFiles({ name: 'meu-script.py', mimeType: 'text/plain', buffer: Buffer.from('def double(n):\n    return n * 2\nresult = double(21)\nprint(result)') });
  await expect(page.getByLabel('Linguagem', { exact: true })).toHaveValue('python');
  await expect(page.getByLabel('Versão', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('Código do programa')).toHaveValue(/def double/);
  await page.getByRole('button', { name: 'Aplicar código' }).click();
  await page.getByRole('button', { name: 'Executar', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Concluído');
  await expect(page.getByTestId('result-value')).toHaveText('42');
  await expect(page.getByTestId('program-output')).toHaveText('42\n');
  const count = await page.getByTestId('step-count').textContent();
  await page.getByRole('button', { name: 'Retroceder tudo' }).click();
  await expect(page.getByTestId('step-count')).toHaveText('000');
  await expect(page.getByTestId('result-value')).toHaveText('—');
  await expect(page.getByTestId('program-output')).toHaveText('Nenhuma saída ainda.');
  await page.getByRole('button', { name: 'Executar', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Concluído');
  await expect(page.getByTestId('step-count')).toHaveText(count!);
  await expect(page.getByTestId('program-output')).toHaveText('42\n');
});

test('aceita arquivo acima do limite antigo com renderização limitada e preserva o rascunho ao rejeitar arquivo grande demais', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Adicionar script' }).click();
  const source = '# comentário\n'.repeat(10000) + 'result = 42\n';
  await page.getByLabel('Arquivo do script').setInputFiles({ name: 'grande.py', mimeType: 'text/plain', buffer: Buffer.from(source) });
  await expect(page.getByLabel('Código do programa')).toHaveValue(source);
  await page.getByLabel('Arquivo do script').setInputFiles({ name: 'excesso.py', mimeType: 'text/plain', buffer: Buffer.from(' '.repeat(1_000_001)) });
  await expect(page.getByRole('alert')).toContainText('1.000.000');
  await expect(page.getByLabel('Código do programa')).toHaveValue(source);
  await page.getByRole('button', { name: 'Aplicar código' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('current-line')).toContainText('10001');
  expect(await page.locator('.code-line').count()).toBeLessThan(100);
  await page.getByRole('button', { name: 'Executar', exact: true }).click();
  await expect(page.getByTestId('result-value')).toHaveText('42');
  await expect(page.locator('.source-scroll')).toContainText('result = 42');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
