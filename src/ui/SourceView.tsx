import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Span } from '../core/language';
import type { LanguageId } from '../core/runtime';

function syntax(text: string, language: LanguageId): ReactNode[] {
  const pattern = language === 'python' ? /(#.*|\b(?:def|while|if|elif|else|return|pass|not|and|or|True|False|None)\b|\b\d+(?:\.\d+)?\b|[+*/%<>=!\-]+|\b[A-Za-z_]\w*(?=\())/g : /(\/\/.*|\b(?:fn|let|while|if|else|return|true|false)\b|\b\d+(?:\.\d+)?\b|[+*/%<>=!\-]+|\b[A-Za-z_]\w*(?=\())/g;
  return text.split(pattern).filter(Boolean).map((piece, index) => {
    const kind = piece.startsWith(language === 'python' ? '#' : '//') ? 'comment' : /^(fn|def|let|while|if|elif|else|return|pass|not|and|or|true|false|True|False|None)$/.test(piece) ? 'keyword' : /^\d/.test(piece) ? 'number' : /^[+*/%<>=!\-]+$/.test(piece) ? 'operator' : /^[A-Za-z_]/.test(piece) ? 'function' : '';
    return <span className={`syntax-${kind}`} key={index}>{piece}</span>;
  });
}

export function SourceView({ source, span, language, breakableLines, breakpoints, enabled, onToggle }: {
  source: string;
  span?: Span;
  language: LanguageId;
  breakableLines: readonly number[];
  breakpoints: readonly number[];
  enabled: boolean;
  onToggle: (line: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const lastSource = useRef(source);
  const lines = useMemo(() => source.trimEnd().split('\n'), [source]);
  const eligible = useMemo(() => new Set(breakableLines), [breakableLines]);
  const points = new Set(breakpoints);
  const [viewport, setViewport] = useState({ top: 0, height: 440, lineHeight: 28 });
  useEffect(() => {
    const element = container.current!;
    const measure = () => setViewport({ top: element.scrollTop, height: element.clientHeight, lineHeight: Number.parseFloat(getComputedStyle(element).getPropertyValue('--code-line-height')) || 28 });
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = container.current!;
    const sourceChanged = lastSource.current !== source;
    lastSource.current = source;
    if (!span && !sourceChanged) return;
    const top = ((span?.line ?? 1) - 1) * viewport.lineHeight + 22;
    if (top < element.scrollTop) element.scrollTop = top;
    if (top + viewport.lineHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + viewport.lineHeight - element.clientHeight;
    setViewport(current => ({ ...current, top: element.scrollTop }));
  }, [span?.line, source, viewport.lineHeight]);
  const start = Math.max(0, Math.floor((viewport.top - 22) / viewport.lineHeight) - 8);
  const end = Math.min(lines.length, Math.ceil((viewport.top + viewport.height) / viewport.lineHeight) + 8);
  return <div className="source-scroll" ref={container} tabIndex={0} aria-label="Código-fonte em execução" onScroll={event => { const top = event.currentTarget.scrollTop; setViewport(current => ({ ...current, top })); }}>
    <div className="source-lines" style={{ height: lines.length * viewport.lineHeight }}>
    {lines.slice(start, end).map((line, offset) => {
      const index = start + offset, number = index + 1;
      const active = number === span?.line;
      const point = points.has(number);
      return <div className={`code-line ${active ? 'current' : ''} ${point ? 'has-breakpoint' : ''}`} key={index} style={{ top: index * viewport.lineHeight }} data-testid={active ? 'current-line' : undefined} aria-current={active ? 'step' : undefined}>
        <button className={`line-number breakpoint-toggle ${point ? 'set' : ''} ${enabled ? '' : 'inactive'}`} disabled={!eligible.has(number)} onClick={() => onToggle(number)} aria-label={`${point ? 'Remover' : 'Adicionar'} breakpoint na linha ${number}`} aria-pressed={point} title={eligible.has(number) ? `${point ? 'Remover' : 'Adicionar'} breakpoint antes do comando na linha ${number}` : 'Essa linha não inicia um comando executável'}>{number}</button>
        <span className="line-marker" aria-hidden="true">{active ? '▸' : ''}</span>
        <code>{syntax(line || ' ', language)}</code>
      </div>;
    })}</div>
  </div>;
}
