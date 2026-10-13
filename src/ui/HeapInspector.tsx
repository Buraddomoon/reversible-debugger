import { useState } from 'react';
import type { DeepReadonly, MachineState, Step } from '../core/machine';
import { isList } from '../core/heap';
import { formatValue, type LanguageId } from '../core/runtime';

export function HeapInspector({ state, language, changes = [], selectedId, onSelect }: {
  state: DeepReadonly<MachineState>; language: LanguageId; changes?: readonly DeepReadonly<Step>[]; selectedId?: number | null; onSelect?: (id: number) => void;
}) {
  const [localId, setLocalId] = useState<number | null>(null);
  const [requestedItemPage, setItemPage] = useState(0);
  const [requestedAliasPage, setAliasPage] = useState(0);
  const [target, setTarget] = useState('');
  const ids = Object.keys(state.heap).map(Number);
  const requested = selectedId ?? localId;
  const id = requested !== null && state.heap[requested] ? requested : ids[0];
  const object = id === undefined ? null : state.heap[id]!;
  const choose = (next: number) => { setLocalId(next); onSelect?.(next); setItemPage(0); setAliasPage(0); setTarget(''); };
  const objectPage = id === undefined ? 0 : Math.floor(ids.indexOf(id) / 8);
  const objectPages = Math.max(1, Math.ceil(ids.length / 8));
  const itemPages = Math.max(1, Math.ceil((object?.items.length ?? 0) / 16)), itemPage = Math.min(requestedItemPage, itemPages - 1);
  const aliases: Array<{ label: string; parent?: number }> = [];
  if (id !== undefined) {
    for (const frame of state.frames) for (const [name, value] of Object.entries(frame.locals)) if (isList(value) && value.id === id) aliases.push({ label: `${frame.name}${frame.id ? '()' : ''} · ${name}` });
    state.operands.forEach((value, index) => { if (isList(value) && value.id === id) aliases.push({ label: `Pilha [${index}]` }); });
    for (const [parent, entry] of Object.entries(state.heap)) entry.items.forEach((value, index) => { if (isList(value) && value.id === id) aliases.push({ label: `#L${parent}[${index}]`, parent: Number(parent) }); });
  }
  const aliasPages = Math.max(1, Math.ceil(aliases.length / 12)), aliasPage = Math.min(requestedAliasPage, aliasPages - 1);
  const changed = new Set(changes.flatMap(step => step.changes.flatMap(change => change.kind === 'heap-splice' && change.id === id ? [change.index] : change.kind === 'heap-allocation' && change.id === id ? change.object.items.map((_, i) => i) : [])));
  const number = Number(target), validTarget = target !== '' && Number.isSafeInteger(number) && Object.hasOwn(state.heap, number);
  return <section className="heap-panel" aria-label="Listas e referências" data-testid="heap-panel">
    <div className="panel-header"><div><span aria-hidden="true">▦</span><h2>Listas e referências</h2></div><span className="count-badge">{ids.length}</span></div>
    {!object || id === undefined ? <p className="heap-empty">Nenhuma lista alocada neste estado.</p> : <div className="heap-content">
      <div className="heap-picker">{ids.slice(objectPage * 8, (objectPage + 1) * 8).map(item => <button key={item} onClick={() => choose(item)} aria-label={`Inspecionar lista L${item}`} aria-pressed={item === id} className={item === id ? 'selected' : ''}><code>#L{item}</code><span>{state.heap[item]!.items.length} itens</span></button>)}</div>
      {objectPages > 1 && <div className="heap-pagination"><button disabled={objectPage === 0} onClick={() => choose(ids[(objectPage - 1) * 8]!)} aria-label="Página anterior de listas">←</button><span>{objectPage + 1} / {objectPages}</span><button disabled={objectPage === objectPages - 1} onClick={() => choose(ids[(objectPage + 1) * 8]!)} aria-label="Próxima página de listas">→</button></div>}
      {ids.length > 8 && <form className="heap-jump" onSubmit={event => { event.preventDefault(); if (validTarget) choose(number); }}><label>Ir à lista <input aria-label="ID da lista" type="number" min="1" step="1" value={target} onChange={event => setTarget(event.target.value)} /></label><button disabled={!validTarget}>Abrir lista</button></form>}
      <div className="heap-selected"><strong data-testid="heap-object-id">#L{id}</strong><span>{object.items.length} itens · identidade estável</span></div>
      <div className="heap-alias-heading">Referências diretas <span>{aliases.length}</span></div>
      <div className="heap-aliases" data-testid="heap-aliases">{aliases.slice(aliasPage * 12, (aliasPage + 1) * 12).map((alias, index) => alias.parent !== undefined ? <button key={index} onClick={() => choose(alias.parent!)}>{alias.label} <span aria-hidden="true">↗</span></button> : <span key={index}>{alias.label} <span aria-hidden="true">→</span> #L{id}</span>)}{aliases.length === 0 && <p>Sem referências nos escopos, na pilha ou em outras listas.</p>}</div>
      {aliasPages > 1 && <div className="heap-pagination"><button disabled={aliasPage === 0} onClick={() => setAliasPage(aliasPage - 1)} aria-label="Página anterior de referências">←</button><span>{aliasPage + 1} / {aliasPages}</span><button disabled={aliasPage === aliasPages - 1} onClick={() => setAliasPage(aliasPage + 1)} aria-label="Próxima página de referências">→</button></div>}
      <div className="heap-items" data-testid="heap-items">{object.items.slice(itemPage * 16, (itemPage + 1) * 16).map((value, offset) => { const index = itemPage * 16 + offset; return <div key={index} className={`heap-cell ${changed.has(index) ? 'changed motion-highlight' : ''}`} data-heap-index={index}><span>[{index}]</span>{isList(value) ? <button onClick={() => choose(value.id)} aria-label={`Seguir referência do item ${index} para L${value.id}`}><code>#L{value.id}</code><span aria-hidden="true">↗</span></button> : <code>{formatValue(value, language)}</code>}</div>; })}</div>
      {object.items.length === 0 && <p className="heap-empty-list">[] · A lista existe e está vazia.</p>}
      {itemPages > 1 && <div className="heap-pagination"><button disabled={itemPage === 0} onClick={() => setItemPage(itemPage - 1)} aria-label="Página anterior de itens">←</button><span>{itemPage + 1} / {itemPages}</span><button disabled={itemPage === itemPages - 1} onClick={() => setItemPage(itemPage + 1)} aria-label="Próxima página de itens">→</button></div>}
      <p className="heap-note">As referências compartilham este objeto. Listas alocadas permanecem no heap até desfazer a criação ou reiniciar.</p>
    </div>}
  </section>;
}
