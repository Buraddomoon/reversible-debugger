import type { Value } from './language';
import { getList, isList, type ReadonlyHeap } from './heap';

export type LanguageId = 'python' | 'rewind';
export interface RuntimeSelection { readonly language: LanguageId; readonly version: string }
export const runtimes = [
  { id: 'python', label: 'Python', extension: '.py', versions: ['3'], versionLabel: 'Python 3', description: 'Números, booleanos, listas, índices, append, len, condicionais, while, funções e print. Sem bibliotecas, strings, slicing ou outros métodos nesta versão.' },
  { id: 'rewind', label: 'Experimental da demo', extension: '.rw', versions: ['0.1'], versionLabel: '0.1', description: 'Linguagem criada para os exemplos originais da demo, com sintaxe própria. Não é Python ou JavaScript.' },
] as const;

export function getRuntime(language: string, version?: string): RuntimeSelection {
  const runtime = runtimes.find(item => item.id === language);
  if (!runtime) throw new Error(`Linguagem ainda não suportada: ${language}`);
  const selectedVersion = version ?? runtime.versions[0];
  if (!(runtime.versions as readonly string[]).includes(selectedVersion)) throw new Error(`Versão ainda não suportada para ${runtime.label}: ${selectedVersion}`);
  return Object.freeze({ language: runtime.id, version: selectedVersion });
}

export function formatValue(value: Value, language: LanguageId = 'rewind'): string {
  if (language !== 'python') return String(value);
  if (value === null) return 'None';
  if (isList(value)) return `#L${value.id}`;
  if (typeof value === 'object') return value.kind === 'function' ? `<function ${value.name}>` : ['int', 'float', 'bool'].includes(value.name) ? `<class '${value.name}'>` : `<built-in function ${value.name}>`;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'bigint') return value.toString();
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value < 0 ? '-inf' : 'inf';
  if (Object.is(value, -0)) return '-0.0';
  if (value !== 0 && (Math.abs(value) >= 1e16 || Math.abs(value) < 1e-4)) return value.toExponential().replace(/e([+-])(\d+)$/, (_match, sign: string, digits: string) => `e${sign}${digits.padStart(2, '0')}`);
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/** Bounded preview, without expanding reference graphs or hiding object identity. */
export function previewValue(value: Value, language: LanguageId, heap: ReadonlyHeap): string {
  if (!isList(value)) return formatValue(value, language);
  const items = getList(value, heap).items;
  return `#L${value.id} [${items.slice(0, 6).map(item => { const text = formatValue(item, language); return text.length > 80 ? `${text.slice(0, 77)}…` : text; }).join(', ')}${items.length > 6 ? ', …' : ''}]`;
}
export const MAX_PRINT_CHARS = 100_000;
/** Python repr for lists with cycle markers. Iterative traversal also bounds DAG
 * expansion: fail atomically rather than silently truncating program output. */
export function formatPythonOutput(value: Value, heap: ReadonlyHeap): string {
  type Work = { value: Value } | { text: string } | { leave: number };
  const work: Work[] = [{ value }], active = new Set<number>(), parts: string[] = [];
  let length = 0;
  const add = (text: string) => { length += text.length; if (length > MAX_PRINT_CHARS) throw new Error('Saída de print excede 100.000 caracteres'); parts.push(text); };
  while (work.length) {
    const next = work.pop()!;
    if ('leave' in next) { active.delete(next.leave); continue; }
    if ('text' in next) { add(next.text); continue; }
    if (!isList(next.value)) { add(formatValue(next.value, 'python')); continue; }
    if (active.has(next.value.id)) { add('[...]'); continue; }
    const items = getList(next.value, heap).items;
    active.add(next.value.id); add('['); work.push({ leave: next.value.id }, { text: ']' });
    for (let i = items.length - 1; i >= 0; i--) { work.push({ value: items[i]! }); if (i > 0) work.push({ text: ', ' }); }
  }
  return parts.join('');
}
