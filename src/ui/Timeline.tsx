import { useEffect, useMemo, useState } from 'react';
import type { DeepReadonly, Step } from '../core/machine';
import { firstEventAfter, HistoryEventIndex, type EventKind, type HistoryEvent } from '../core/history-events';

const labels: Record<EventKind, string> = { call: 'Chamada', return: 'Retorno', mutation: 'Lista', decision: 'Decisão', output: 'Saída', error: 'Erro', end: 'Fim' };
const symbols: Record<EventKind, string> = { call: '↳', return: '↰', mutation: '▦', decision: '◇', output: '▤', error: '!', end: '■' };
const priority: Record<EventKind, number> = { decision: 0, mutation: 1, output: 1, call: 2, return: 3, end: 4, error: 5 };

export function Timeline({ history, cursor, disabled, pendingTarget, onSeek }: {
  history: readonly DeepReadonly<Step>[];
  cursor: number;
  disabled: boolean;
  pendingTarget?: number;
  onSeek: (cursor: number) => void;
}) {
  const length = history.length;
  const [target, setTarget] = useState('');
  useEffect(() => setTarget(''), [history]);
  const [index] = useState(() => new HistoryEventIndex());
  const events = index.update(history);
  const markers = useMemo(() => {
    const bins = new Map<number, HistoryEvent>();
    for (const event of events) {
      const bin = Math.min(95, Math.floor(event.cursor / Math.max(1, length) * 96));
      const existing = bins.get(bin);
      if (!existing || priority[event.kind] > priority[existing.kind]) bins.set(bin, event);
    }
    return [...bins].map(([bin, event]) => ({ bin, event }));
  }, [events, length]);
  // Show a small window around the cursor, even in traces with thousands of events.
  const boundary = firstEventAfter(events, cursor);
  const previous = events[boundary - 1]?.cursor === cursor ? events[boundary - 2] : events[boundary - 1];
  const next = events[boundary];
  const start = Math.max(0, Math.min(events.length - 8, boundary - 4));
  const visible = events.slice(start, start + 8);
  const number = target === '' ? cursor : Number(target);
  const valid = Number.isSafeInteger(number) && number >= 0 && number <= length;
  const step = history[cursor - 1];
  return <section className="timeline" aria-label="Linha do tempo">
    <div className="timeline-heading"><div><h2>Linha do tempo</h2><span data-testid="history-length">{length} passos registrados</span></div><span className="timeline-mode">{cursor < length ? 'Explorando o histórico' : 'Último estado registrado'}</span></div>
    <div className="timeline-controls">
      <button onClick={() => onSeek(0)} disabled={disabled || cursor === 0 && pendingTarget === undefined} title="Restaurar o estado inicial">Início</button>
      <div className="timeline-scrubber">
        <label className="sr-only" htmlFor="timeline-position">Posição na linha do tempo</label>
        <input id="timeline-position" type="range" min={0} max={length} step={1} value={pendingTarget ?? cursor} disabled={disabled || length === 0} aria-valuetext={pendingTarget === undefined ? `Passo ${cursor} de ${length}` : `Destino ${pendingTarget}; estado atual no passo ${cursor}`} onChange={event => onSeek(Number(event.target.value))} style={{ background: `linear-gradient(to right, var(--accent) ${length ? cursor / length * 100 : 0}%, #344459 0%)` }} />
        <div className="timeline-markers" aria-hidden="true">{markers.map(({ bin, event }) => <span key={bin} className={`event-${event.kind}`} style={{ left: `${bin / 95 * 100}%` }} />)}</div>
        <div className="timeline-scale"><span>0</span><strong>Passo {cursor}</strong><span>{length}</span></div>
      </div>
      <button onClick={() => onSeek(length)} disabled={disabled || cursor === length && pendingTarget === undefined} title="Restaurar o último estado registrado">Último</button>
      <form className="timeline-jump" onSubmit={event => { event.preventDefault(); if (valid && !disabled) { onSeek(number); setTarget(''); } }}>
        <label htmlFor="timeline-target">Ir ao passo</label>
        <input id="timeline-target" type="number" min={0} max={length} step={1} value={target} placeholder={String(cursor)} onChange={event => setTarget(event.target.value)} disabled={disabled} aria-invalid={!valid} />
        <button disabled={disabled || !valid || length === 0} type="submit">Ir</button>
      </form>
    </div>
    <div className="timeline-selected" data-testid="timeline-selected"><span>{cursor === 0 ? 'ESTADO INICIAL' : `ESTADO APÓS O PASSO ${cursor} · L${step?.span.line}`}</span><p>{step?.description ?? 'Nenhuma instrução aplicada. Avance para registrar a execução.'}</p></div>
    <div className="timeline-event-heading"><span>EVENTOS <small>{events.length}</small></span><div><button onClick={() => previous && onSeek(previous.cursor)} disabled={disabled || !previous}>Evento anterior</button><button onClick={() => next && onSeek(next.cursor)} disabled={disabled || !next}>Próximo evento</button></div></div>
    <div className="timeline-event-list" data-testid="timeline-event-list">
      {visible.map(event => <button key={event.cursor} className={`timeline-event event-${event.kind} ${event.cursor === cursor ? 'selected' : ''}`} aria-label={`${labels[event.kind]}, passo ${event.cursor}, linha ${event.line}: ${event.description}`} aria-pressed={event.cursor === cursor} data-event-cursor={event.cursor} data-event-kind={event.kind} onClick={() => onSeek(event.cursor)} disabled={disabled} title={event.description}><span className="event-symbol" aria-hidden="true">{symbols[event.kind]}</span><span><strong>{labels[event.kind]}</strong><small>#{event.cursor} · L{event.line}</small></span></button>)}
      {!events.length && <p>Chamadas, retornos, decisões, saída e erros aparecerão aqui.</p>}
    </div>
    <p className="timeline-note">Arraste ou escolha um evento para restaurar o estado após aquele passo. Para registrar novos passos, use Avançar ou Executar.</p>
  </section>;
}
