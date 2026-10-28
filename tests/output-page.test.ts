import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { OUTPUT_PAGE_SIZE as size, outputPage } from '../src/ui/output-page';

describe('páginas de saída sem perda de texto', () => {
  it('mantém o texto pequeno, a página final e limites válidos', () => {
    expect(outputPage([], null)).toMatchObject({ text: '', total: 0, page: 0, pages: 1 });
    expect(outputPage(['42', '\n'], null).text).toBe('42\n');
    const chunks = ['a'.repeat(size), 'fim'];
    expect(outputPage(chunks, null)).toMatchObject({ text: 'fim', page: 1, pages: 2 });
    expect(outputPage(chunks, 999).text).toBe('fim');
    expect(outputPage(chunks, -1).text).toBe(chunks[0]);
    chunks.pop(); expect(outputPage(chunks, 999).page).toBe(0);
  });
  it('não divide emojis nem quando o par atravessa entradas de saída', () => {
    const chunks = ['a'.repeat(size - 1), '\ud83d', '\ude80', 'z'.repeat(size)];
    const first = outputPage(chunks, 0), second = outputPage(chunks, 1), third = outputPage(chunks, 2);
    expect(first.text.endsWith('🚀')).toBe(true); expect(second.text.startsWith('z')).toBe(true);
    expect(first.text + second.text + third.text).toBe(chunks.join(''));
    expect(first.text.length).toBe(size + 1);
  });
  it('não cria uma última página vazia quando o texto termina no emoji da fronteira', () => {
    for (const count of [1, 2, 3]) {
      const chunks = ['a'.repeat(count * size - 1), '🚀'], view = outputPage(chunks, null);
      expect(view.pages).toBe(count); expect(view.page).toBe(count - 1); expect(view.text.endsWith('🚀')).toBe(true);
      expect(view.text.length).toBeLessThanOrEqual(size + 1);
    }
  });
  it('reconstrói exatamente todas as páginas geradas, inclusive quebras e Unicode', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom('abc\n', '🚀', 'á', '\t', ''), { minLength: 1, maxLength: 80 }), fc.integer({ min: 0, max: 6000 }), (parts, repeat) => {
      const chunks = parts.map(part => part.repeat(repeat)), all = chunks.join(''), pages = outputPage(chunks, null).pages, result: string[] = [];
      for (let page = 0; page < pages; page++) { const view = outputPage(chunks, page); expect(view.text.length).toBeLessThanOrEqual(size + 1); if (view.total) expect(view.text.length).toBeGreaterThan(0); result.push(view.text); }
      expect(result.join('')).toBe(all);
    }), { numRuns: 80, seed: 20261028 });
  });
});
