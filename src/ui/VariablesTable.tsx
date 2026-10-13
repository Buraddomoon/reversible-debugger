import { useState } from 'react';
import type { DeepReadonly, Frame } from '../core/machine';
import { formatValue, type LanguageId } from '../core/runtime';

export function VariablesTable({ frame, changedNames, language, cursor }: { frame: DeepReadonly<Frame>; changedNames: ReadonlySet<string>; language: LanguageId; cursor: number }) {
  const [requestedPage, setPage] = useState(0);
  const entries = Object.entries(frame.locals);
  const pages = Math.max(1, Math.ceil(entries.length / 24));
  const page = Math.min(requestedPage, pages - 1);
  return <div className="variable-table"><div className="variable-table-header"><span>Nome</span><span>Valor</span><span>Tipo</span></div>
    {!entries.length ? <p className="variables-empty">Este escopo ainda não tem variáveis.</p> : entries.slice(page * 24, (page + 1) * 24).map(([name, value]) => <div className={`variable-row ${changedNames.has(name) ? 'changed motion-highlight' : ''}`} key={`${name}:${cursor}`}><code>{name}</code><strong>{formatValue(value, language)}</strong><span>{value === null ? 'None' : typeof value === 'bigint' ? 'int' : typeof value === 'number' ? language === 'python' ? 'float' : 'número' : typeof value === 'boolean' ? 'booleano' : 'função'}</span></div>)}
    {pages > 1 && <div className="variable-pagination"><span>{entries.length} variáveis · {page + 1} / {pages}</span><button disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Página anterior de variáveis">←</button><button disabled={page === pages - 1} onClick={() => setPage(page + 1)} aria-label="Próxima página de variáveis">→</button></div>}
  </div>;
}
