import type { Value } from './language';

export type LanguageId = 'python' | 'rewind';
export interface RuntimeSelection { readonly language: LanguageId; readonly version: string }
export const runtimes = [
  { id: 'python', label: 'Python', extension: '.py', versions: ['3'], versionLabel: 'Python 3', description: 'Suporte inicial: números, booleanos, atribuições, if/elif/else, while, funções e print. Sem bibliotecas, strings ou coleções nesta versão.' },
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
  if (typeof value === 'object') return value.kind === 'function' ? `<function ${value.name}>` : ['int', 'float', 'bool'].includes(value.name) ? `<class '${value.name}'>` : `<built-in function ${value.name}>`;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'bigint') return value.toString();
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value < 0 ? '-inf' : 'inf';
  if (Object.is(value, -0)) return '-0.0';
  if (value !== 0 && (Math.abs(value) >= 1e16 || Math.abs(value) < 1e-4)) return value.toExponential().replace(/e([+-])(\d+)$/, (_match, sign: string, digits: string) => `e${sign}${digits.padStart(2, '0')}`);
  return Number.isInteger(value) ? `${value}.0` : String(value);
}
