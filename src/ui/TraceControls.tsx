import { useEffect, useRef, useState } from 'react';
import type { DebugSession } from '../core/debugger';
import { checkImportBudget, exportHistory, MAX_TRACE_BYTES, type ImportedHistory, type TraceMetadata } from '../core/portable-history';
import { importHistoryInWorker } from './import-history';

export interface OpenHistory extends ImportedHistory { id: string; displayName: string }
export function TraceControls({ session, metadata, histories, disabled, onPause, onImport, onError }: {
  session: DebugSession; metadata: TraceMetadata; histories: readonly OpenHistory[]; disabled: boolean;
  onPause: () => void; onImport: (history: ImportedHistory) => void; onError: (message: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const [busy, setBusy] = useState<'import' | 'export' | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    generation.current++; abort.current?.abort(); setBusy(null); setMessage(null);
    return () => { generation.current++; abort.current?.abort(); };
  }, [session]);
  const transfer = async (kind: 'import' | 'export', file?: File) => {
    onPause(); onError(null); setMessage(null); setProgress({ done: 0, total: 0 }); setBusy(kind);
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    const id = ++generation.current;
    const job = { signal: controller.signal, onProgress: (done: number, total: number) => { if (generation.current === id) setProgress({ done, total }); } };
    try {
      if (kind === 'import') {
        if (!file) throw new Error('Selecione um arquivo de histórico');
        if (file.size > MAX_TRACE_BYTES) throw new Error('O histórico excede 32 MiB. A sessão aberta foi preservada.');
        checkImportBudget(histories, file.size);
        const restored = await importHistoryInWorker(await file.text(), job);
        controller.signal.throwIfAborted();
        if (generation.current === id) { checkImportBudget(histories, restored.bytes); onImport(restored); }
      } else {
        const exportedCursor = session.cursor;
        const content = await exportHistory(session, metadata, job);
        controller.signal.throwIfAborted();
        if (generation.current !== id) return;
        const blob = new Blob([content], { type: 'application/json' }), url = URL.createObjectURL(blob);
        const link = document.createElement('a'); link.href = url;
        link.download = `${metadata.filename.replace(/\.(py|rw|txt)$/i, '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'execucao'}.rewind.json`;
        link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage(`Histórico exportado · ${(blob.size / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KiB · cursor ${exportedCursor}`);
      }
    } catch (cause) {
      if (generation.current === id) {
        if (controller.signal.aborted) setMessage('Transferência cancelada. A sessão aberta foi preservada.');
        else onError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally { if (generation.current === id) { setBusy(null); if (input.current) input.current.value = ''; } }
  };
  return <section className="trace-controls" aria-label="Históricos portáveis">
    <div><span className="trace-symbol" aria-hidden="true">↔</span><div><strong>Guarde esta execução.</strong><p>Código, estados e posição em um arquivo. Importar preserva seus scripts.</p></div></div>
    <div className="trace-actions"><button disabled={disabled || Boolean(busy)} onClick={() => void transfer('export')}>Exportar histórico</button><button disabled={disabled || Boolean(busy)} onClick={() => input.current?.click()}>Importar histórico</button>
      <input ref={input} id="trace-file" className="sr-only" type="file" accept=".json,application/json" aria-label="Arquivo de histórico" disabled={disabled || Boolean(busy)} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void transfer('import', file); }} />
    </div>
    {busy && <div className="trace-progress"><progress max={Math.max(1, progress.total)} value={progress.done} aria-label={busy === 'import' ? 'Validação do histórico' : 'Exportação do histórico'} /><span>{busy === 'import' ? `Validando histórico · ${progress.total ? `${Math.round(progress.done / progress.total * 100)}%` : 'preparando'}` : `Exportando · ${progress.done} / ${progress.total} registros`}</span><button onClick={() => abort.current?.abort()}>Cancelar transferência</button></div>}
    {message && <p className="trace-message" aria-live="polite">{message}</p>}
  </section>;
}
