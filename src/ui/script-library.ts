import { getRuntime, type LanguageId } from '../core/runtime';

export const SCRIPT_LIBRARY_KEY = 'rewind.script-library.v1';
export const DEFAULT_SELECTION = 'python-sum-bug';
export interface SavedScript {
  id: string;
  name: string;
  filename: string;
  language: LanguageId;
  version: string;
  source: string;
}
export interface ScriptLibrary {
  schemaVersion: 1;
  scripts: SavedScript[];
  selection: string;
}
export interface LibraryRead { library: ScriptLibrary; error: string | null }

export function readScriptLibrary(): LibraryRead {
  const empty: ScriptLibrary = { schemaVersion: 1, scripts: [], selection: DEFAULT_SELECTION };
  try {
    const raw = localStorage.getItem(SCRIPT_LIBRARY_KEY);
    if (!raw) return { library: empty, error: null };
    const data = JSON.parse(raw) as Partial<ScriptLibrary>;
    if (data.schemaVersion !== 1 || !Array.isArray(data.scripts) || typeof data.selection !== 'string') throw new Error('Formato inválido');
    const ids = new Set<string>();
    for (const script of data.scripts) {
      if (!script || typeof script.id !== 'string' || !script.id.startsWith('script:') || ids.has(script.id) || typeof script.name !== 'string' || !script.name.trim() || typeof script.filename !== 'string' || typeof script.source !== 'string' || typeof script.language !== 'string' || typeof script.version !== 'string') throw new Error('Script inválido');
      getRuntime(script.language, script.version); ids.add(script.id);
    }
    return { library: data as ScriptLibrary, error: null };
  } catch {
    // Reading failures never overwrite the existing browser data.
    return { library: empty, error: 'Não foi possível carregar os scripts salvos neste navegador.' };
  }
}

export function writeScriptLibrary(library: ScriptLibrary): string | null {
  try { localStorage.setItem(SCRIPT_LIBRARY_KEY, JSON.stringify(library)); return null; }
  catch (error) {
    return error instanceof DOMException && error.name === 'QuotaExceededError'
      ? 'O navegador ficou sem espaço para salvar os scripts. Exclua um script que não utiliza para liberar espaço.'
      : 'Não foi possível salvar os scripts neste navegador. O código continua aberto nesta página.';
  }
}

export function newSavedScript(data: Omit<SavedScript, 'id'>): SavedScript {
  return { ...data, id: `script:${crypto.randomUUID()}` };
}

export function uniqueScriptName(base: string, scripts: readonly Pick<SavedScript, 'name'>[]): string {
  const names = new Set(scripts.map(script => script.name.toLocaleLowerCase()));
  let name = base, suffix = 2;
  while (names.has(name.toLocaleLowerCase())) name = `${base} (${suffix++})`;
  return name;
}
