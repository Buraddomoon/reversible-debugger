import { useCallback, useEffect, useRef, useState } from 'react';
import { writeScriptLibrary, type LibraryRead, type ScriptLibrary } from './script-library';

export function useScriptLibrary(initial: LibraryRead) {
  const [library, setLibrary] = useState(initial.library);
  const [error, setError] = useState(initial.error);
  const latest = useRef(initial.library);
  const persisted = useRef(initial.library);
  const unreadable = useRef(Boolean(initial.error));
  const flush = useCallback(() => {
    if (latest.current === persisted.current) return;
    if (unreadable.current) { setError('Os dados salvos não puderam ser carregados e foram preservados. Os novos códigos ficarão somente nesta página até o problema ser corrigido.'); return; }
    const failure = writeScriptLibrary(latest.current);
    if (!failure) persisted.current = latest.current;
    setError(failure);
  }, []);
  const update = useCallback((transform: (library: ScriptLibrary) => ScriptLibrary) => {
    const next = transform(latest.current);
    latest.current = next; // Also current before React renders or beforeunload fires.
    setLibrary(next);
  }, []);
  useEffect(() => {
    if (library === persisted.current) return;
    const timer = window.setTimeout(flush, 250);
    return () => window.clearTimeout(timer);
  }, [library, flush]);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [flush]);
  return { library, error, update, flush };
}
