import { useEffect, useRef, useState } from 'react';
import { RecordingJournal } from '../core/recording-journal';
import { ExecutionLibrary } from '../core/execution-library';
import type { ComparisonRecording } from '../core/paged-comparison';
import type { RuntimeSelection } from '../core/runtime';
import { PagedComparisonClient } from './paged-comparison-client';
import { ComparisonLane, DifferenceTable, differenceText } from './ComparisonLane';
import { formatBytes } from './StoragePanel';

export function PagedComparisonPanel({ primary, runtime, budget, onClose }: { primary: ComparisonRecording; runtime: RuntimeSelection; budget: number; onClose: () => void }) {
  const [candidates, setCandidates] = useState<ComparisonRecording[]>([]), [target, setTarget] = useState(''), [client, setClient] = useState<PagedComparisonClient | null>(null), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null), [progress, setProgress] = useState({ stage: '', done: 0, total: 1 });
  const abort = useRef<AbortController | null>(null), generation = useRef(0), current = useRef<PagedComparisonClient | null>(null);
  useEffect(() => {
    const journal = new RecordingJournal(), library = new ExecutionLibrary(); let mounted = true;
    void (async () => {
      try {
        const rows = [...(await journal.list()).map(row => ({ ...row, kind: 'journal' as const })), ...(await library.list()).map(row => ({ ...row, kind: 'saved' as const }))].filter(row => row.language === runtime.language && row.version === runtime.version && !(row.kind === primary.kind && row.id === primary.id));
        if (mounted) { setCandidates(rows); setTarget(rows[0] ? `${rows[0].kind}:${rows[0].id}` : ''); }
      } catch (cause) { if (mounted) setError(String(cause)); }
    })();
    return () => { mounted = false; generation.current++; abort.current?.abort(); current.current?.dispose(); void journal.close(); void library.close(); };
  }, [primary.id, primary.kind, runtime.language, runtime.version]);
  const prepare = async () => {
    const right = candidates.find(c => `${c.kind}:${c.id}` === target); if (!right) return;
    abort.current?.abort(); current.current?.dispose(); current.current = null; setClient(null); const controller = new AbortController(); abort.current = controller; const id = ++generation.current;
    setBusy(true); setError(null); setMessage(null); setProgress({ stage: 'indexing', done: 0, total: 1 });
    try { const opened = await PagedComparisonClient.open(primary, right, budget, { signal: controller.signal, onProgress: (stage, done, total) => { if (generation.current === id) setProgress({ stage, done, total }); } }); if (id !== generation.current) { opened.dispose(); return; } current.current = opened; setClient(opened); }
    catch (cause) { if (id === generation.current) { if (controller.signal.aborted) setMessage('Preparação cancelada. As gravações foram preservadas.'); else setError(cause instanceof Error ? cause.message : String(cause)); } }
    finally { if (id === generation.current) setBusy(false); }
  };
  const seek = async (index: number) => {
    if (!client) return; abort.current?.abort(); const controller = new AbortController(); abort.current = controller; const id = ++generation.current; setBusy(true); setError(null); setMessage(null); setProgress({ stage: 'seeking', done: 0, total: 1 });
    try { await client.seek(index, { signal: controller.signal, onProgress: (stage, done, total) => { if (id === generation.current) setProgress({ stage, done, total }); } }); if (id === generation.current) setRevision(v => v + 1); }
    catch (cause) { if (id === generation.current) { if (controller.signal.aborted) setMessage('Navegação cancelada. O par anterior foi preservado.'); else setError(cause instanceof Error ? cause.message : String(cause)); } }
    finally { if (id === generation.current) setBusy(false); }
  };
  const snapshot = client?.snapshot, header = client?.header, row = header && snapshot ? header.rows[snapshot.cursor]! : null, differences = snapshot?.differences ?? [];
  const differenceIndexes = header?.rows.flatMap((r, i) => r.differenceCount ? [i] : []) ?? [], next = differenceIndexes.find(i => i > (snapshot?.cursor ?? 0)), previous = [...differenceIndexes].reverse().find(i => i < (snapshot?.cursor ?? 0));
  const left = client?.view('left'), right = client?.view('right');
  return <section className="execution-comparison" data-testid="paged-comparison-panel" data-revision={revision}>
    <div className="comparison-header"><div><p className="eyebrow">COMPARAÇÃO EM BLOCOS</p><h2>Duas execuções. Somente os blocos necessários.</h2><p>Escolha outra gravação salva. A sessão original mantém seu cursor e seu futuro.</p></div><button onClick={onClose}>Voltar ao debugger</button></div>
    <form className="comparison-setup" onSubmit={event => { event.preventDefault(); void prepare(); }}><div><span>EXECUÇÃO A</span><strong>{primary.name}</strong></div><label><span>EXECUÇÃO B</span><select aria-label="Gravação da execução B" value={target} disabled={busy} onChange={event => { setTarget(event.target.value); current.current?.dispose(); current.current = null; setClient(null); setError(null); }}>{candidates.map(c => <option key={`${c.kind}:${c.id}`} value={`${c.kind}:${c.id}`}>{c.name} · {c.kind === 'journal' ? 'sessão' : 'captura'}</option>)}</select></label><button className="primary" disabled={busy || !target}>Preparar comparação</button></form>
    {!candidates.length && <p className="comparison-intro">Grave ou salve outra versão na mesma linguagem para compará-la aqui. Exemplos e scripts continuam disponíveis no comparador completo.</p>}
    {busy && <div className="comparison-progress" data-testid="paged-comparison-progress"><progress max={Math.max(1, progress.total)} value={progress.done} /><p role="status">{progress.stage === 'indexing' ? 'Lendo eventos' : progress.stage === 'analyzing' ? 'Comparando estados' : 'Restaurando o par'} · {progress.done} / {progress.total}</p><button onClick={() => abort.current?.abort()}>{client ? 'Cancelar navegação' : 'Cancelar preparação'}</button></div>}
    {error && <div className="error-banner" role="alert">{error}</div>}{message && <p className="seek-message" data-testid="seek-message">{message}</p>}
    {client && snapshot && header && row && left && right && <>
      <div className="comparison-overview"><div><span>RESULTADO NA GRAVAÇÃO · A</span><strong data-testid="comparison-final-a">{differenceText(left.finalResult, runtime.language, true)}</strong><small>{left.history.length} instruções</small></div><div><span>RESULTADO NA GRAVAÇÃO · B</span><strong data-testid="comparison-final-b">{differenceText(right.finalResult, runtime.language, true)}</strong><small>{right.history.length} instruções</small></div><div><span>DIFERENÇAS OBSERVADAS</span><strong>{differenceIndexes.length} pontos</strong><small data-testid="comparison-cache">Cache A {formatBytes(snapshot.stats.left.bytes)} / {formatBytes(snapshot.stats.left.limitBytes)} · B {formatBytes(snapshot.stats.right.bytes)} / {formatBytes(snapshot.stats.right.limitBytes)} · índice {formatBytes(snapshot.stats.indexBytes)}</small></div></div>
      <nav className="comparison-navigation"><div><button disabled={!snapshot.cursor} onClick={() => void seek(0)}>Início da comparação</button><button disabled={!snapshot.cursor} onClick={() => void seek(snapshot.cursor - 1)}>Ponto anterior</button><button disabled={snapshot.cursor === header.rows.length - 1} onClick={() => void seek(snapshot.cursor + 1)}>Próximo ponto</button><button onClick={() => void seek(header.rows.length - 1)}>Final da comparação</button></div><div><button disabled={header.firstDifference === null} onClick={() => void seek(header.firstDifference!)}>Primeira diferença</button><button disabled={previous === undefined} onClick={() => void seek(previous!)}>Diferença anterior</button><button disabled={next === undefined} onClick={() => void seek(next!)}>Próxima diferença</button></div></nav>
      <div className="comparison-position"><label htmlFor="paged-comparison-position">Ponto <strong data-testid="comparison-position">{snapshot.cursor + 1}</strong> de {header.rows.length}</label><input id="paged-comparison-position" type="range" min={0} max={header.rows.length - 1} value={snapshot.cursor} onChange={event => void seek(Number(event.target.value))} /></div>
      <div className="comparison-lanes"><ComparisonLane key={`a:${snapshot.cursor}`} side="A" run={left} point={left.points[row.leftStatePoint]!} held={row.leftPoint === null} differences={differences} /><ComparisonLane key={`b:${snapshot.cursor}`} side="B" run={right} point={right.points[row.rightStatePoint]!} held={row.rightPoint === null} differences={differences} /></div><DifferenceTable key={snapshot.cursor} differences={differences} language={runtime.language} />
    </>}
  </section>;
}
