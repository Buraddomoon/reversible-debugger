import { useEffect, useMemo, useReducer, useState } from 'react';
import { ExecutionComparison } from '../core/comparison';
import type { ComparisonSource } from '../core/comparison-types';
import { ComparisonLane, DifferenceTable, differenceText, phaseLabels } from './ComparisonLane';
import { SeekStatus } from './SeekStatus';

export interface ComparisonCandidate extends ComparisonSource { id: string; group: 'script' | 'example' | 'history' }
const pairs: Record<string, string> = { 'python-list-alias-bug': 'python-list-alias-fixed', 'python-list-alias-fixed': 'python-list-alias-bug', 'python-sum-bug': 'python-sum-fixed', 'python-sum-fixed': 'python-sum-bug', 'sum-bug': 'sum-fixed', 'sum-fixed': 'sum-bug' };

export function ComparisonPanel({ primary, candidates, maxHistoryBytes, onClose }: { primary: ComparisonCandidate; candidates: readonly ComparisonCandidate[]; maxHistoryBytes: number; onClose: () => void }) {
  const [targetId, setTargetId] = useState(() => candidates.find(item => item.id === pairs[primary.id])?.id ?? candidates.find(item => item.id !== primary.id)?.id ?? primary.id);
  const [comparison, setComparison] = useState<ExecutionComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, refresh] = useReducer(value => value + 1, 0);
  const [seekMessage, setSeekMessage] = useState<string | null>(null);
  const target = candidates.find(item => item.id === targetId)!;
  const preparing = comparison && !comparison.ready && comparison.stage !== 'cancelled';
  const differences = comparison?.ready ? comparison.differences() : [];
  const differenceIndexes = useMemo(() => comparison?.ready ? comparison.rows.flatMap((row, index) => row.differenceCount ? [index] : []) : [], [comparison, comparison?.ready]);
  const row = comparison?.ready ? comparison.rows[comparison.cursor]! : null;
  const navigation = comparison?.ready ? comparison.navigationProgress : null;
  const requestedPosition = navigation?.target ?? comparison?.cursor ?? 0;
  const nextDifference = differenceIndexes.find(index => index > requestedPosition);
  const previousDifference = [...differenceIndexes].reverse().find(index => index < requestedPosition);
  const prepare = () => {
    comparison?.cancel(); setError(null); setSeekMessage(null);
    try { setComparison(new ExecutionComparison(primary, target, { maxHistoryBytes })); }
    catch (cause) { setComparison(null); setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => {
    if (!comparison || comparison.ready || comparison.stage === 'cancelled') return;
    const timer = window.setTimeout(() => {
      try { comparison.prepareBatch(comparison.stage === 'analyzing' ? 32 : 256); }
      catch (cause) { comparison.cancel(); setError(cause instanceof Error ? cause.message : String(cause)); }
      refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [comparison, revision]);
  useEffect(() => () => { comparison?.cancel(); }, [comparison]);
  useEffect(() => {
    if (!comparison?.ready || !navigation) return;
    const timer = window.setTimeout(() => {
      try { comparison.seekRowBatch(navigation.id); }
      catch (cause) { comparison.cancelNavigation(navigation.id); setError(cause instanceof Error ? cause.message : String(cause)); }
      refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [comparison, navigation?.id, revision]);
  const seek = (index: number) => {
    setSeekMessage(null);
    try { const request = comparison!.beginSeekRow(index); if (!request.done) comparison!.seekRowBatch(request.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    refresh();
  };
  const first = comparison?.ready && comparison.firstDifference !== null ? comparison.rows[comparison.firstDifference]! : null;
  const firstPoint = first && comparison ? first.leftPoint !== null ? comparison.left.points[first.leftPoint]! : comparison.right.points[first.rightPoint!]! : null;
  return <section className="execution-comparison" aria-label="Comparação entre execuções" data-testid="comparison-panel">
    <div className="comparison-header"><div><p className="eyebrow">DOIS CAMINHOS / UM BUG</p><h2>Encontre onde a execução muda.</h2><p>Alinhamento por escopo, comando e ocorrência. Passos diferentes podem representar a mesma etapa.</p></div><button onClick={onClose}>Voltar ao debugger</button></div>
    <form className="comparison-setup" onSubmit={event => { event.preventDefault(); prepare(); }}>
      <div><span>EXECUÇÃO A · {primary.recording ? 'HISTÓRICO GRAVADO' : 'CÓDIGO ABERTO'}</span><strong>{primary.name}</strong></div>
      <label><span>EXECUÇÃO B</span><select aria-label="Programa da execução B" value={targetId} onChange={event => { comparison?.cancel(); setComparison(null); setError(null); setTargetId(event.target.value); }}>{(['history', 'script', 'example'] as const).map(group => candidates.some(item => item.group === group) && <optgroup key={group} label={group === 'history' ? 'Históricos importados' : group === 'script' ? 'Seus scripts' : 'Exemplos'}>{candidates.filter(item => item.group === group).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>)}</select></label>
      <button className="primary" type="submit" disabled={Boolean(preparing)}>Preparar comparação</button>
    </form>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!comparison && !error && <div className="comparison-intro"><span aria-hidden="true">A ↔ B</span><p>Escolha a segunda versão e prepare as execuções para comparar decisões, variáveis, pilhas e saída.</p></div>}
    {preparing && <div className="comparison-progress"><p role="status">{comparison.stage === 'recording' ? `Registrando execuções · A: ${comparison.left.history.length} passos · B: ${comparison.right.history.length} passos` : `Comparando estados · ${comparison.analyzedRows} de ${comparison.rows.length} pontos`}</p><button onClick={() => { comparison.cancel(); refresh(); }}>Cancelar preparação</button></div>}
    {comparison?.stage === 'cancelled' && !error && <p className="comparison-cancelled" role="status">Preparação cancelada. Você pode preparar outra comparação.</p>}
    {comparison?.ready && row && <>
      <div className="comparison-overview">
        <div><span>{comparison.left.points.at(-1)?.phase === 'end' ? 'RESULTADO FINAL' : 'RESULTADO NA PARADA'} · A</span><strong data-testid="comparison-final-a">{differenceText(comparison.left.finalResult, comparison.left.program.runtime.language)}</strong><small>{comparison.left.history.length} instruções registradas</small></div>
        <div><span>{comparison.right.points.at(-1)?.phase === 'end' ? 'RESULTADO FINAL' : 'RESULTADO NA PARADA'} · B</span><strong data-testid="comparison-final-b">{differenceText(comparison.right.finalResult, comparison.right.program.runtime.language)}</strong><small>{comparison.right.history.length} instruções registradas</small></div>
        <div className="comparison-first"><span>PRIMEIRA DIFERENÇA OBSERVADA</span><strong>{firstPoint ? `${phaseLabels[firstPoint.phase]}${firstPoint.line ? ` · L${firstPoint.line}` : ''}${firstPoint.phase === 'decision' ? ` · ocorrência ${firstPoint.occurrence}` : ''}` : 'Nenhuma nestes eventos'}</strong><small>{differenceIndexes.length} pontos com diferenças</small></div>
      </div>
      <nav className="comparison-navigation" aria-label="Navegação da comparação"><div><button onClick={() => seek(0)} disabled={comparison.cursor === 0 && !navigation}>Início da comparação</button><button onClick={() => seek(requestedPosition - 1)} disabled={requestedPosition === 0}>Ponto anterior</button><button onClick={() => seek(requestedPosition + 1)} disabled={requestedPosition === comparison.rows.length - 1}>Próximo ponto</button><button onClick={() => seek(comparison.rows.length - 1)} disabled={comparison.cursor === comparison.rows.length - 1 && !navigation}>Final da comparação</button></div><div><button onClick={() => seek(comparison.firstDifference!)} disabled={comparison.firstDifference === null}>Primeira diferença</button><button onClick={() => seek(previousDifference!)} disabled={previousDifference === undefined}>Diferença anterior</button><button onClick={() => seek(nextDifference!)} disabled={nextDifference === undefined}>Próxima diferença</button></div></nav>
      {navigation && <SeekStatus unit="Ponto" current={comparison.cursor + 1} target={navigation.target + 1} completed={navigation.completedSteps} total={navigation.totalSteps} onCancel={() => { comparison.cancelNavigation(); setSeekMessage(`Navegação cancelada. O ponto ${comparison.cursor + 1} e os dois estados anteriores foram preservados.`); refresh(); }} />}
      {seekMessage && <p className="seek-message" data-testid="seek-message" aria-live="polite">{seekMessage}</p>}
      <div className="comparison-position"><label htmlFor="comparison-position">Ponto <strong data-testid="comparison-position">{comparison.cursor + 1}</strong> de {comparison.rows.length}</label><input id="comparison-position" type="range" min={0} max={comparison.rows.length - 1} step={1} value={requestedPosition} aria-label="Posição da comparação" aria-valuetext={navigation ? `Destino ${requestedPosition + 1}; ponto exibido ${comparison.cursor + 1}` : `Ponto ${comparison.cursor + 1} de ${comparison.rows.length}`} onChange={event => seek(Number(event.target.value))} /></div>
      <div className={`comparison-alignment ${row.leftPoint === null || row.rightPoint === null ? 'one-sided' : ''}`} data-testid="comparison-alignment"><strong>{row.leftPoint === null ? 'Somente B executou este evento' : row.rightPoint === null ? 'Somente A executou este evento' : 'Eventos correspondentes'}</strong><span>{row.leftPoint === null || row.rightPoint === null ? 'A outra execução permanece no último ponto representado até reencontrar uma etapa comum.' : 'O código destacado produziu o estado mostrado, após a instrução registrada.'}</span></div>
      <div className="comparison-lanes"><ComparisonLane key={`a:${comparison.cursor}`} side="A" run={comparison.left} point={comparison.left.points[row.leftStatePoint]!} held={row.leftPoint === null} differences={differences} /><ComparisonLane key={`b:${comparison.cursor}`} side="B" run={comparison.right} point={comparison.right.points[row.rightStatePoint]!} held={row.rightPoint === null} differences={differences} /></div>
      <DifferenceTable key={comparison.cursor} differences={differences} language={comparison.left.program.runtime.language} />
    </>}
  </section>;
}
