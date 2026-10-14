import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { DebugSession } from '../core/debugger';
import { ExecutionLibrary, MAX_DISK_BYTES, MAX_SAVED_EXECUTIONS, type LibraryStats, type SavedExecution } from '../core/execution-library';
import type { TraceMetadata } from '../core/portable-history';
import { checkImportBudget, type ImportedHistory } from '../core/portable-history';
import { stagingHistoryBudget } from '../core/page-budget';
import type { OpenHistory } from './TraceControls';
import { formatBytes } from './StoragePanel';
import { PagedRecordingClient } from './paged-client';
import { loadExecutionInWorker } from './load-execution';

function ExecutionDialog({ kind, initialName, closesPaged, onCancel, onConfirm }: { kind: 'save' | 'delete'; initialName: string; closesPaged?: boolean; onCancel: () => void; onConfirm: (name: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(initialName.slice(0, 160));
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  const submit = (event: FormEvent) => { event.preventDefault(); if (name.trim()) onConfirm(name.trim()); };
  return <dialog ref={dialog} className="new-script-dialog" aria-labelledby="execution-dialog-title" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <form onSubmit={submit}><div className="dialog-heading"><h2 id="execution-dialog-title">{kind === 'save' ? 'Salvar execução' : 'Excluir execução salva'}</h2></div>
      {kind === 'save' ? <><label htmlFor="execution-name">Nome da execução<input id="execution-name" value={name} onChange={event => setName(event.target.value)} required maxLength={160} autoFocus /></label><p className="dialog-runtime-note">Guarda o código, todos os passos registrados e a posição atual neste navegador.</p></> : <p>Excluir <strong>{initialName}</strong> da biblioteca de execuções? {closesPaged ? 'Esta execução será fechada. Seus scripts e os outros históricos serão preservados.' : 'Seus scripts e os históricos já carregados serão preservados.'}</p>}
      <div className="dialog-actions"><button type="button" onClick={onCancel}>Cancelar</button><button className={kind === 'save' ? 'primary' : 'delete-script'} type="submit" disabled={!name.trim()}>{kind === 'save' ? 'Salvar' : 'Excluir execução'}</button></div>
    </form>
  </dialog>;
}

export function ExecutionLibraryPanel({ session, metadata, histories, disabled, pagedId, pagedReservation = 0, onBusyChange, onPause, onOpenPaged, onOpenFull, onDeletePaged, onSelect }: {
  session: DebugSession; metadata: TraceMetadata; histories: readonly OpenHistory[]; disabled: boolean;
  pagedId?: string; pagedReservation?: number;
  onPause: () => void; onOpenPaged: (client: PagedRecordingClient) => void; onDeletePaged: (id: string) => void; onSelect: (id: string) => void;
  onOpenFull: (history: ImportedHistory, savedId: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [backend] = useState(() => { try { return { library: new ExecutionLibrary(), error: null }; } catch (cause) { return { library: null, error: String(cause) }; } });
  const [entries, setEntries] = useState<SavedExecution[]>([]);
  const [stats, setStats] = useState<LibraryStats>({ count: 0, bytes: 0, pending: 0 });
  const [busy, setBusy] = useState<'save' | 'load' | 'full' | 'delete' | null>(null);
  const [dialog, setDialog] = useState<'save' | SavedExecution | null>(null);
  const [error, setError] = useState<string | null>(backend.error);
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [page, setPage] = useState(0);
  const abort = useRef<AbortController | null>(null), generation = useRef(0), mounted = useRef(false), channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => { onBusyChange(Boolean(busy)); return () => onBusyChange(false); }, [busy, onBusyChange]);
  const refresh = async () => {
    if (!backend.library) return;
    const [list, usage] = await Promise.all([backend.library.list(), backend.library.stats()]);
    if (mounted.current) { setEntries(list); setStats(usage); }
  };
  useEffect(() => {
    mounted.current = true;
    void (async () => { try { await backend.library?.recover(); await refresh(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); } })();
    const update = () => { void refresh().catch(cause => { if (mounted.current) setError(String(cause)); }); };
    if (typeof BroadcastChannel !== 'undefined') { channel.current = new BroadcastChannel('rewind.execution-library.changes'); channel.current.onmessage = update; }
    window.addEventListener('focus', update);
    return () => { mounted.current = false; generation.current++; abort.current?.abort(); channel.current?.close(); channel.current = null; window.removeEventListener('focus', update); };
  }, [backend]);
  useEffect(() => { generation.current++; abort.current?.abort(); setBusy(null); setDialog(null); return () => { generation.current++; abort.current?.abort(); }; }, [session, pagedId]);
  const pages = Math.max(1, Math.ceil(entries.length / 6)), currentPage = Math.min(page, pages - 1);
  const run = async (kind: 'save' | 'load' | 'full' | 'delete', value: string | SavedExecution) => {
    if (!backend.library) return;
    onPause(); setDialog(null); setError(null); setMessage(null); setBusy(kind); setProgress({ done: 0, total: 0 });
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller; const id = ++generation.current;
    const job = { signal: controller.signal, onProgress: (done: number, total: number) => { if (generation.current === id) setProgress({ done, total }); } };
    try {
      if (kind === 'save') {
        const entry = await backend.library.save(session, { ...metadata, name: value as string }, job);
        channel.current?.postMessage('changed'); await refresh();
        if (generation.current === id) { setPage(0); setMessage(`Execução salva · ${entry.name} · passo ${entry.cursor} de ${entry.count}`); }
      } else if (kind === 'delete') {
        await backend.library.delete((value as SavedExecution).id); onDeletePaged((value as SavedExecution).id); channel.current?.postMessage('changed'); await refresh();
        if (generation.current === id) setMessage('Execução removida da biblioteca.');
      } else {
        const entry = value as SavedExecution;
        const maxHistoryBytes = stagingHistoryBudget(histories, session, 2, session.storageStats.limitBytes, pagedReservation);
        if (kind === 'full') {
          checkImportBudget(histories, entry.bytes);
          const history = await loadExecutionInWorker(entry.id, { ...job, maxHistoryBytes }); controller.signal.throwIfAborted();
          if (generation.current === id) { checkImportBudget(histories, history.bytes); onOpenFull(history, entry.id); setMessage(`Execução aberta · ${entry.name}`); }
          return;
        }
        const client = await PagedRecordingClient.open(entry.id, { maxHistoryBytes }, job);
        if (controller.signal.aborted || generation.current !== id) { client.dispose(); return; }
        onOpenPaged(client); setMessage(`Execução aberta · ${entry.name}`);
      }
    } catch (cause) {
      if (generation.current === id) {
        if (controller.signal.aborted) setMessage('Operação cancelada. A sessão aberta foi preservada.');
        else setError(cause instanceof Error ? cause.message : String(cause));
      }
      await refresh().catch(() => {});
    } finally { if (generation.current === id) setBusy(null); }
  };
  const open = (entry: SavedExecution) => {
    const cached = histories.find(item => item.savedId === entry.id);
    if (cached) { onSelect(cached.id); return; }
    void run('load', entry);
  };
  return <section className="execution-library" aria-label="Execuções salvas" data-testid="execution-library">
    <div className="library-heading"><div><p className="eyebrow">BIBLIOTECA DE EXECUÇÕES</p><h2>Retome de onde parou.</h2><p>Execuções salvas neste navegador, neste endereço. Abra uma para carregar seus estados.</p></div><button className="primary" disabled={!backend.library || disabled || Boolean(busy) || Boolean(pagedId)} title={pagedId ? 'Abra o debugger completo para salvar uma nova captura' : undefined} onClick={() => { onPause(); setDialog('save'); }}>Salvar execução</button></div>
    <div className="library-usage"><span>{stats.count} / {MAX_SAVED_EXECUTIONS} execuções · {formatBytes(stats.bytes)} / {formatBytes(MAX_DISK_BYTES)} de payload salvo{stats.pending > 0 ? ` · ${stats.pending} gravação em andamento` : ''}</span><span>Exporte um arquivo para manter uma cópia fora do navegador.</span></div>
    {entries.length ? <div className="library-entries">{entries.slice(currentPage * 6, currentPage * 6 + 6).map(entry => <article key={entry.id} data-saved-execution={entry.id}><div><strong>{entry.name}</strong><span>{entry.language === 'python' ? 'Python' : 'Experimental'} {entry.version} · passo {entry.cursor} / {entry.count} · {formatBytes(entry.bytes)}</span></div><div className="library-entry-actions"><button aria-label={`Abrir execução ${entry.name}`} disabled={disabled || Boolean(busy)} onClick={() => open(entry)}>Abrir</button><button aria-label={`Abrir execução completa ${entry.name}`} title="Carregar todos os registros para editar, exportar ou comparar" disabled={disabled || Boolean(busy)} onClick={() => void run('full', entry)}>Completo</button><button aria-label={`Excluir execução ${entry.name}`} disabled={Boolean(busy)} onClick={() => setDialog(entry)}>Excluir</button></div></article>)}</div> : <p className="library-empty">Salve uma execução para voltar a ela depois de recarregar a página.</p>}
    {pages > 1 && <div className="library-pagination"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Execuções anteriores</button><span>{currentPage + 1} / {pages}</span><button disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>Mais execuções</button></div>}
    {busy && <div className="trace-progress" data-testid="library-progress"><progress max={Math.max(1, progress.total)} value={progress.done} aria-label="Progresso da biblioteca" /><span>{busy === 'save' ? 'Salvando' : busy === 'load' || busy === 'full' ? 'Carregando e validando' : 'Excluindo'} · {progress.total ? `${progress.done} / ${progress.total} passos` : 'preparando'}</span>{busy !== 'delete' && <button onClick={() => abort.current?.abort()}>Cancelar operação</button>}</div>}
    {error && <p className="dialog-error" role="alert">{error}</p>}{message && <p className="trace-message" aria-live="polite" data-testid="library-message">{message}</p>}
    {dialog && <ExecutionDialog kind={dialog === 'save' ? 'save' : 'delete'} closesPaged={dialog !== 'save' && dialog.id === pagedId} initialName={dialog === 'save' ? `${metadata.name} · passo ${session.cursor}` : dialog.name} onCancel={() => setDialog(null)} onConfirm={name => void run(dialog === 'save' ? 'save' : 'delete', dialog === 'save' ? name : dialog)} />}
  </section>;
}
