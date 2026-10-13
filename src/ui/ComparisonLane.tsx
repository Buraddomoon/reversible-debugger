import { useMemo, useState } from 'react';
import type { ComparisonPhase, ComparisonPoint, ComparisonRunView, DifferenceValue, StateDifference } from '../core/comparison-types';
import { formatValue, type LanguageId } from '../core/runtime';
import type { Value } from '../core/language';
import { highlightSyntax } from './SourceView';

export const phaseLabels: Record<ComparisonPhase, string> = { initial: 'Início', write: 'Atribuição', decision: 'Decisão', call: 'Chamada', return: 'Retorno', output: 'Saída', error: 'Erro', end: 'Fim', limit: 'Limite da gravação', pause: 'Fim do histórico parcial' };
const statusLabels: Record<string, string> = { running: 'Em andamento', halted: 'Concluída', error: 'Erro' };
export function differenceText(binding: DifferenceValue, language: LanguageId): string {
  if (!binding.present) return '—';
  const value = binding.value;
  if (typeof value === 'string') return value || '(vazio)';
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : formatValue(item, language)).join(' · ') || '(vazia)';
  return formatValue(value as Value, language);
}
function valueType(value: Value, language: LanguageId): string {
  return value === null ? 'None' : typeof value === 'bigint' ? 'int' : typeof value === 'number' ? language === 'python' ? 'float' : 'número' : typeof value === 'boolean' ? 'booleano' : 'função';
}
function CodeExcerpt({ source, language, line }: { source: string; language: LanguageId; line: number | null }) {
  const lines = useMemo(() => source.split('\n'), [source]);
  const start = Math.max(0, (line ?? 1) - 4);
  return <div className="comparison-code" tabIndex={0} aria-label="Trecho de código do evento">
    {lines.slice(start, start + 7).map((text, index) => <div key={start + index} className={start + index + 1 === line ? 'selected' : ''}><span>{start + index + 1}</span><code>{highlightSyntax(text || ' ', language)}</code></div>)}
  </div>;
}
function LaneVariables({ run, frameId, changed }: { run: ComparisonRunView; frameId: number; changed: ReadonlySet<string> }) {
  const [page, setPage] = useState(0);
  const frame = run.state.frames.find(item => item.id === frameId)!;
  const entries = Object.entries(frame.locals);
  const pages = Math.max(1, Math.ceil(entries.length / 20));
  const format = (value: Value) => formatValue(value, run.program.runtime.language);
  return <>
    <div className="comparison-variable-table"><div className="comparison-variable-heading"><span>Nome</span><span>Valor</span><span>Tipo</span></div>
      {entries.slice(page * 20, (page + 1) * 20).map(([name, value]) => <div key={name} className={`comparison-variable ${changed.has(`${run.frameLabel(frame.id)} · ${name}`) ? 'different' : ''}`}><code>{name}</code><strong>{format(value)}</strong><small>{valueType(value, run.program.runtime.language)}</small></div>)}
      {!entries.length && <p className="comparison-empty-scope">Nenhuma variável neste escopo.</p>}
    </div>
    {pages > 1 && <div className="comparison-pagination"><button disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Página anterior de variáveis">←</button><span>{page + 1} / {pages}</span><button disabled={page === pages - 1} onClick={() => setPage(page + 1)} aria-label="Próxima página de variáveis">→</button></div>}
  </>;
}

export function ComparisonLane({ side, run, point, held, differences }: { side: 'A' | 'B'; run: ComparisonRunView; point: ComparisonPoint; held: boolean; differences: readonly StateDifference[] }) {
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const frame = run.state.frames.find(item => item.id === selectedFrame) ?? run.state.frames.at(-1)!;
  const changed = new Set(differences.filter(diff => diff.category === 'variables').map(diff => diff.name));
  const globals = run.state.frames[0]!.locals;
  const result = Object.hasOwn(globals, 'result') ? formatValue(globals.result!, run.program.runtime.language) : '—';
  return <section className={`comparison-lane lane-${side.toLowerCase()}`} aria-label={`Execução ${side}`} data-testid={`comparison-${side.toLowerCase()}`} data-run-fingerprint={run.identity.fingerprint}>
    <header><div><span className="comparison-side">{side}</span><h3>{run.name}</h3></div><strong>Passo <span data-testid={`comparison-step-${side.toLowerCase()}`}>{run.cursor}</span></strong></header>
    <div className="comparison-point"><span className={`comparison-phase phase-${point.phase}`}>{phaseLabels[point.phase]} {point.phase !== 'initial' && point.phase !== 'end' && point.phase !== 'error' && point.phase !== 'limit' ? `· ocorrência ${point.occurrence}` : ''}</span>{held && <span className="comparison-held">Sem evento neste ponto</span>}<p data-testid={`comparison-description-${side.toLowerCase()}`}>{point.description}</p></div>
    {run.limitReached && <p className="comparison-limit">Gravação interrompida no limite de {run.history.length.toLocaleString('pt-BR')} passos. Os estados registrados continuam navegáveis.</p>}
    <CodeExcerpt source={run.identity.source} language={run.program.runtime.language} line={point.line} />
    <div className="comparison-scope"><h4>Variáveis</h4><label><span className="sr-only">Escopo da execução {side}</span><select value={frame.id} onChange={event => setSelectedFrame(Number(event.target.value))}>{[...run.state.frames].reverse().map(item => <option value={item.id} key={item.id}>{item.name} · #{item.id}</option>)}</select></label></div>
    <LaneVariables key={`${run.cursor}:${frame.id}`} run={run} frameId={frame.id} changed={changed} />
    <details className="comparison-stack" open><summary>Pilha de chamadas <span>{run.state.frames.length}</span></summary><ol>{[...run.state.frames].reverse().map(item => <li key={item.id}><code>{item.name}{item.id ? '()' : ''}</code><span>#{item.id}</span></li>)}</ol></details>
    <details className="comparison-stack"><summary>Pilha de valores <span>{run.state.operands.length}</span></summary><p className="comparison-operands">{run.state.operands.map(value => formatValue(value, run.program.runtime.language)).join(' · ') || 'Vazia'}</p></details>
    <div className="comparison-current-result"><span>Resultado atual <code>result</code></span><strong data-testid={`comparison-result-${side.toLowerCase()}`}>{result}</strong><small>{statusLabels[run.state.control.status]}</small></div>
    {run.state.control.error && <p className="comparison-error" data-testid={`comparison-error-${side.toLowerCase()}`}>{run.state.control.error}</p>}
    {run.program.runtime.language === 'python' && <div className="comparison-output"><span>SAÍDA</span><pre data-testid={`comparison-output-${side.toLowerCase()}`}>{run.state.output.join('') || 'Nenhuma saída ainda.'}</pre></div>}
  </section>;
}

export function DifferenceTable({ differences, language }: { differences: readonly StateDifference[]; language: LanguageId }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(differences.length / 20));
  const text = (diff: StateDifference, value: DifferenceValue) => {
    if (diff.category === 'output' && value.present && Array.isArray(value.value)) return value.value.join('') || '(vazia)';
    const raw = differenceText(value, language);
    if (diff.category === 'control') return statusLabels[raw] ?? phaseLabels[raw as ComparisonPhase] ?? raw;
    return raw;
  };
  return <section className="comparison-differences" aria-label="Diferenças neste ponto">
    <div><h3>Diferenças neste ponto</h3><span data-testid="comparison-difference-count">{differences.length}</span></div>
    {!differences.length ? <p className="comparison-equal">Estados observáveis iguais neste ponto.</p> : <table><thead><tr><th>O que difere</th><th>Execução A</th><th>Execução B</th></tr></thead><tbody>{differences.slice(page * 20, (page + 1) * 20).map((diff, index) => <tr key={page * 20 + index}><th scope="row">{diff.name}</th><td><pre>{text(diff, diff.left)}</pre></td><td><pre>{text(diff, diff.right)}</pre></td></tr>)}</tbody></table>}
    {pages > 1 && <div className="comparison-pagination"><button disabled={page === 0} onClick={() => setPage(page - 1)}>Página anterior de diferenças</button><span>{page + 1} / {pages}</span><button disabled={page === pages - 1} onClick={() => setPage(page + 1)}>Próxima página de diferenças</button></div>}
  </section>;
}
