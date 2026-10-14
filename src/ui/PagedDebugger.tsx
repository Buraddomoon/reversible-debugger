import { useEffect, useRef, useState } from 'react';
import type { PagedRecordingClient } from './paged-client';
import type { PagedSnapshot } from '../core/paged-transfer';
import type { PagedSeekProgress } from '../core/paged-history';
import type { ImportedHistory } from '../core/portable-history';
import { checkImportBudget } from '../core/portable-history';
import type { OpenHistory } from './TraceControls';
import { loadExecutionInWorker } from './load-execution';
import { describeInstruction } from '../core/compiler';
import { previewValue } from '../core/runtime';
import { SourceView } from './SourceView';
import { VariablesTable } from './VariablesTable';
import { HeapInspector } from './HeapInspector';
import { Timeline } from './Timeline';
import { Evidence } from './ExplanationPanel';
import { SeekStatus } from './SeekStatus';
import { formatBytes } from './StoragePanel';

export type FullAction = 'full' | 'compare' | 'restart';
export function PagedDebugger({ client, histories, materializeBudget, pauseEpoch, onFull }: { client: PagedRecordingClient; histories: readonly OpenHistory[]; materializeBudget: () => number; pauseEpoch: number; onFull: (history: ImportedHistory, action: FullAction) => void }) {
  const [snapshot, setSnapshot] = useState<PagedSnapshot>(client.snapshot);
  const [busy, setBusy] = useState<'seek' | 'full' | null>(null), [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState<PagedSeekProgress | null>(null), [transfer, setTransfer] = useState({ done: 0, total: 0 });
  const [message, setMessage] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null), [selectedObject, setSelectedObject] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null), generation = useRef(0);
  const header = client.header, language = header.program.runtime.language, state = snapshot.state;
  const frame = state.frames.find(f => f.id === selectedFrame) ?? state.frames.at(-1)!;
  const next = state.control.status === 'running' ? header.program.instructions[state.control.pc] : undefined;
  const result = state.frames[0]!.locals.result, hasResult = Object.hasOwn(state.frames[0]!.locals, 'result');
  const format = (value: Parameters<typeof previewValue>[0]) => previewValue(value, language, state.heap);
  useEffect(() => { setSnapshot(client.snapshot); return () => { generation.current++; abort.current?.abort(); client.cancel(); }; }, [client]);
  useEffect(() => client.subscribe(setSnapshot), [client]);
  useEffect(() => { setPlaying(false); abort.current?.abort(); }, [pauseEpoch]);
  const navigate = async (target: number, keepPlaying = false) => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller; const id = ++generation.current;
    if (!keepPlaying) setPlaying(false); setBusy('seek'); setProgress({ from: snapshot.cursor, to: target, cursor: snapshot.cursor, completed: 0, total: Math.abs(target - snapshot.cursor) }); setError(null); setMessage(null);
    try {
      const job = { signal: controller.signal, onSeekProgress: (p: PagedSeekProgress) => { if (generation.current === id) setProgress(p); } };
      const restored = keepPlaying && client.isLive ? await client.run(job) : await client.seek(target, job);
      if (generation.current === id) { setSnapshot(restored); setSelectedFrame(null); }
    } catch (cause) {
      if (generation.current === id) { setPlaying(false); if (controller.signal.aborted || cause instanceof Error && cause.name === 'AbortError') setMessage(`Navegação cancelada. A posição anterior, passo ${snapshot.cursor}, foi preservada.`); else setError(cause instanceof Error ? cause.message : String(cause)); }
    } finally { if (generation.current === id) { setBusy(null); setProgress(null); } }
  };
  const full = async (action: FullAction) => {
    setPlaying(false); abort.current?.abort(); const controller = new AbortController(); abort.current = controller; const id = ++generation.current;
    setBusy('full'); setProgress(null); setTransfer({ done: 0, total: 0 }); setError(null); setMessage(null);
    try {
      checkImportBudget(histories, header.entry.bytes);
      const job = { signal: controller.signal, maxHistoryBytes: materializeBudget(), onProgress: (done: number, total: number) => { if (generation.current === id) setTransfer({ done, total }); } };
      const history = client.isLive ? await client.capture(job.maxHistoryBytes, job) : await loadExecutionInWorker(header.entry.id, job);
      await history.session.seekAsync(snapshot.cursor, { signal: controller.signal }); controller.signal.throwIfAborted();
      if (generation.current === id) { checkImportBudget(histories, history.bytes); onFull(history, action); }
    } catch (cause) { if (generation.current === id) { if (controller.signal.aborted) setMessage('Carregamento cancelado. A execução aberta foi preservada.'); else setError(cause instanceof Error ? cause.message : String(cause)); } }
    finally { if (generation.current === id) setBusy(null); }
  };
  useEffect(() => {
    if (!playing || busy) return; if (snapshot.cursor === snapshot.count && !snapshot.recording?.canRecord) { setPlaying(false); return; }
    const timer = window.setTimeout(() => void navigate(snapshot.cursor + 1, true), client.isLive ? 0 : 80); return () => window.clearTimeout(timer);
  }, [playing, busy, snapshot.cursor]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => { const element = event.target as HTMLElement; if (busy || document.querySelector('dialog[open]') || element.matches('input,textarea,select,button') || element.isContentEditable || event.ctrlKey || event.metaKey || event.altKey) return; if (event.key === 'ArrowRight' && (snapshot.cursor < snapshot.count || snapshot.recording?.canRecord)) { event.preventDefault(); void navigate(snapshot.cursor + 1); } if (event.key === 'ArrowLeft' && snapshot.cursor > 0) { event.preventDefault(); void navigate(snapshot.cursor - 1); } };
    window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle);
  });
  const budget = async (bytes: number) => { setPlaying(false); try { const updated = await client.setCacheBudget(bytes); setSnapshot(updated); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  const flush = async () => { setPlaying(false); setBusy('seek'); try { const saved = await client.flush(); setSnapshot(saved); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(null); } };
  const stats = snapshot.stats;
  return <>
    <div className="recording-banner" data-testid="recording-banner"><strong>{client.isLive ? 'Sessão em gravação' : 'Execução salva'} · {snapshot.count} passos</strong><span>{client.isLive ? 'Avance para registrar novos passos; voltar e avançar no histórico usa somente os deltas.' : 'Navegue pela gravação. Abra o debugger completo para editar, exportar ou comparar.'}</span></div>
    <section className="debugger paged-debugger" aria-label="Debugger visual" data-testid="paged-debugger">
      <div className="control-bar"><div className="navigation-controls">
        <button disabled={snapshot.cursor === 0 || busy === 'full'} onClick={() => void navigate(snapshot.cursor - 1)}>Voltar</button><button className="primary" disabled={snapshot.cursor === snapshot.count && !snapshot.recording?.canRecord || busy === 'full'} onClick={() => void navigate(snapshot.cursor + 1)}>Avançar</button>
        <button disabled={snapshot.cursor === snapshot.count && !snapshot.recording?.canRecord && !playing || busy === 'full'} onClick={() => { if (playing) { setPlaying(false); abort.current?.abort(); } else setPlaying(true); }}>{playing ? 'Pausar' : 'Executar'}</button>
        <button disabled={snapshot.cursor === 0 || busy === 'full'} onClick={() => void navigate(0)}>Retroceder tudo</button>
        <button disabled={Boolean(busy)} onClick={() => void full('restart')}>Executar código de novo</button>
      </div><div className="execution-meta"><span role="status" className={`status ${state.control.status}`}>{busy ? 'Restaurando histórico' : playing ? 'Executando' : snapshot.recording?.pauseReason ? 'Gravação pausada' : state.control.status === 'error' ? 'Erro na execução' : state.control.status === 'halted' ? 'Concluído' : snapshot.cursor === snapshot.count && !snapshot.recording?.canRecord ? 'Fim do histórico parcial' : 'Pausado'}</span><span className="step-number">Passo <strong data-testid="step-count">{String(snapshot.cursor).padStart(3, '0')}</strong></span></div></div>
      {snapshot.recording && <section className={`storage-panel ${snapshot.recording.pauseReason ? 'storage-paused' : ''}`} aria-label="Fronteira durável" data-testid="recording-ledger"><div className="storage-heading"><div><strong>Salvo até o passo <span data-testid="durable-frontier">{snapshot.recording.durable}</span>.</strong><span><span data-testid="pending-steps">{snapshot.recording.pendingSteps}</span> passos somente nesta aba · {formatBytes(snapshot.recording.pendingBytes)} / {formatBytes(snapshot.recording.bufferLimit)} no buffer{snapshot.recording.oversized ? ' · transação grande isolada' : ''}.</span></div><button disabled={Boolean(busy)} onClick={() => void flush()}>Salvar pendências</button></div>{snapshot.recording.pauseReason && <div className="storage-stop" role="alert"><strong>Gravação pausada. Os passos pendentes foram preservados.</strong><p>{snapshot.recording.pauseReason}</p></div>}<p className="paged-cache-note">Recarregar recupera a fronteira salva. Use Salvar pendências antes de sair. Pausar conclui o lote aceito, de até 16 passos; replay não gera novas instruções.</p></section>}
      <div className="paged-tools"><button disabled={Boolean(busy)} onClick={() => void full('full')}>Abrir debugger completo</button><button disabled={Boolean(busy)} onClick={() => void full('compare')}>Comparar execuções</button><span>A navegação carrega os blocos necessários; o debugger completo carrega todos os registros.</span></div>
      {progress && <SeekStatus current={snapshot.cursor} target={progress.to} completed={progress.completed} total={progress.total} onCancel={() => { setPlaying(false); abort.current?.abort(); }} />}
      {busy === 'full' && <div className="trace-progress"><progress max={Math.max(1, transfer.total)} value={transfer.done} /><span>Carregando debugger completo · {transfer.done} / {transfer.total} registros</span><button onClick={() => abort.current?.abort()}>Cancelar transferência</button></div>}
      {message && <p className="seek-message" data-testid="seek-message" aria-live="polite">{message}</p>}{error && <div className="error-banner" role="alert">{error}</div>}
      <section className="storage-panel" aria-label="Cache da execução" data-testid="paged-cache"><div className="storage-heading"><div><strong>Somente os blocos necessários.</strong><span>Cache de deltas · payload estimado, não RAM real.</span></div><label>Cache <select aria-label="Limite do cache de blocos" value={stats.limitBytes} disabled={Boolean(busy)} onChange={event => void budget(Number(event.target.value))}>{[...new Set([64 * 1024, 256 * 1024, 1 * 1024 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024, stats.limitBytes])].sort((a, b) => a - b).map(bytes => <option value={bytes} key={bytes} disabled={bytes + stats.reservedMachineBytes + stats.indexBytes > stats.limitTotalBytes}>{formatBytes(bytes)}</option>)}</select></label></div>
        <div className="storage-meter"><progress max={stats.limitBytes} value={stats.bytes} aria-label="Payload do cache" /><span data-testid="paged-cache-bytes">{formatBytes(stats.bytes)} / {formatBytes(stats.limitBytes)}</span></div>
        <div className="storage-breakdown"><span>Blocos carregados <strong data-testid="paged-cache-blocks">{stats.blocks}</strong> / {snapshot.recording?.blocks ?? header.entry.blocks}</span><span>Leituras <strong data-testid="paged-reads">{stats.reads}</strong></span><span>Reutilizações <strong>{stats.hits}</strong></span><span>Despejos <strong data-testid="paged-evictions">{stats.evictions}</strong></span></div>
        <p className="paged-cache-note">{client.isLive ? 'Checkpoint na fronteira durável · índice compacto de eventos' : `${stats.checkpoints} checkpoints persistidos · índice ${stats.indexBuilt ? 'criado nesta abertura' : 'reutilizado'}`} · índice e reserva de estado {formatBytes(stats.indexBytes + stats.reservedMachineBytes)}. Despejar blocos libera o cache; os passos salvos permanecem no navegador.{stats.largeBlocks > 0 ? ' Uma transação maior que o cache foi lida isoladamente, sem ser retida.' : ''}</p>
      </section>
      <div className="workspace"><section className="source-panel" aria-label="Programa em execução"><div className="panel-header"><div><span>{header.entry.filename}</span><span className="source-runtime">{language === 'python' ? 'Python 3' : 'Experimental 0.1'}</span></div></div>
        <SourceView source={header.program.source} language={language} breakableLines={[]} breakpoints={[]} enabled={false} onToggle={() => {}} span={next?.span ?? (state.control.status === 'error' ? snapshot.step?.span : undefined)} />
        <div className="next-instruction"><span>PRÓXIMA INSTRUÇÃO</span><strong data-testid="next-instruction">{next ? describeInstruction(next, language) : state.control.status === 'error' ? 'Volte para desfazer o erro' : 'Programa concluído'}</strong><code>{next ? `L${next.span.line}:${next.span.column} · ${next.op}` : '—'}</code></div>
        <div className="result-panel"><span className="result-label">Resultado <code>result</code></span><strong data-testid="result-value">{hasResult ? format(result!) : '—'}</strong><span className="result-expected">{hasResult ? 'Valor global' : 'Ainda não calculado'}</span></div>
        {language === 'python' && <section className="output-panel" aria-label="Saída do programa"><span>SAÍDA</span><pre data-testid="program-output">{state.output.join('') || 'Nenhuma saída ainda.'}</pre></section>}<div className="source-footnote"><span>Estado restaurado exclusivamente a partir dos registros.</span><kbd>←</kbd><kbd>→</kbd></div>
      </section><aside className="state-panel"><section className="variables-panel"><div className="panel-header"><div><span className="panel-square" /><h2>Variáveis</h2></div><span className="scope-badge">{frame.name} <span>#{frame.id}</span></span></div><VariablesTable key={frame.id} frame={frame} changedNames={new Set(snapshot.changedNames)} language={language} cursor={snapshot.cursor} heap={state.heap} onList={setSelectedObject} /></section>
        <section className="stack-panel"><div className="panel-header"><div><h2>Pilha de chamadas</h2></div><span className="count-badge">{state.frames.length}</span></div><div className="frames" data-testid="call-stack">{[...state.frames].reverse().map(item => <button key={item.id} className={`frame ${item.id === frame.id ? 'selected' : ''}`} onClick={() => setSelectedFrame(item.id)} aria-pressed={item.id === frame.id}><span className="frame-depth">{String(item.id).padStart(2, '0')}</span><code>{item.name}{item.id ? '()' : ''}</code><span className="frame-label">{item.id === state.frames.at(-1)!.id ? 'Atual' : 'Aguardando'}</span></button>)}</div><details className="operand-details"><summary>Pilha de valores <span>{state.operands.length}</span></summary><div className="operand-values">{state.operands.length ? state.operands.map((value, index) => <code key={index}>{format(value)}</code>) : <span>Vazia</span>}</div></details></section>
        {language === 'python' && <HeapInspector state={state} language={language} selectedId={selectedObject} onSelect={setSelectedObject} />}
        <section className="changes-panel"><div className="panel-header"><div><span className="change-icon">↔</span><h2>O que mudou</h2></div></div>{snapshot.evidence ? <div className="visual-explanation" data-testid="visual-explanation"><Evidence explanation={snapshot.evidence} language={language} reverse={snapshot.reverse} /></div> : <div className="flow-evidence"><p>Estado restaurado no histórico. Avance ou volte uma instrução para observar sua mudança.</p></div>}</section>
      </aside></div>
      <Timeline persistedEvents={header.events} recordedLength={snapshot.count} selectedStep={snapshot.step} cursor={snapshot.cursor} disabled={busy === 'full'} pendingTarget={progress?.to} onSeek={target => void navigate(target)} />
    </section>
  </>;
}
