import { useState } from 'react';
import type { DebugSession } from '../core/debugger';

export const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / (bytes < 1024 * 1024 ? 1024 : 1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${bytes < 1024 * 1024 ? 'KiB' : 'MiB'}`;
const limits = [64 * 1024, ...[1, 4, 16, 64, 128, 256].map(value => value * 1024 * 1024)];
export function StoragePanel({ session, disabled, onBudget }: { session: DebugSession; disabled: boolean; onBudget: (bytes: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const stats = session.storageStats, current = session.machinePayload;
  const stopped = session.recordingStop !== null;
  const options = limits.includes(stats.limitBytes) ? limits : [...limits, stats.limitBytes].sort((a, b) => a - b);
  const ratio = stats.estimatedBytes / stats.limitBytes;
  return <section className={`storage-panel ${stopped ? 'storage-paused' : ratio >= .8 ? 'storage-near' : ''}`} aria-label="Armazenamento desta execução" data-testid="storage-panel">
    <div className="storage-heading"><div><strong>Armazenamento desta execução</strong><span>Payload estimado · a memória real do navegador pode ser maior.</span></div><label>Limite por sessão <select aria-label="Limite do histórico" value={stats.limitBytes} disabled={disabled} onChange={event => onBudget(Number(event.target.value))}>{options.map(bytes => <option key={bytes} value={bytes} disabled={bytes < stats.estimatedBytes}>{formatBytes(bytes)}{bytes < stats.estimatedBytes ? ' · abaixo do consumo' : ''}</option>)}</select></label></div>
    <div className="storage-meter"><progress aria-label="Consumo do orçamento do histórico" max={stats.limitBytes} value={stats.estimatedBytes} /><span><strong data-testid="storage-total">{formatBytes(stats.estimatedBytes)}</strong> / {formatBytes(stats.limitBytes)}</span></div>
    <div className="storage-breakdown"><span>Deltas <strong data-testid="storage-deltas">{formatBytes(stats.deltaBytes)}</strong></span><span>Checkpoints <strong data-testid="storage-checkpoints">{formatBytes(stats.checkpointBytes)}</strong></span><span>Reserva do estado <strong data-testid="storage-reserve">{formatBytes(stats.reservedMachineBytes)}</strong></span></div>
    {stopped && <div className="storage-stop" data-testid="storage-stop" aria-live="polite"><strong>Gravação pausada pelo orçamento</strong><p>A próxima instrução precisa de pelo menos {formatBytes(session.recordingStop!.requiredBytes)} no total. Todos os {session.history.length} passos continuam disponíveis, do início ao fim. Aumente o limite para continuar ou exporte a execução.</p></div>}
    {!stopped && ratio >= .8 && <p className="storage-advisory">O orçamento está perto do limite. A gravação vai pausar se a próxima instrução não couber; você continuará podendo navegar e exportar.</p>}
    <button className="storage-details-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Ocultar detalhes do consumo' : 'Detalhes do consumo'}</button>
    {expanded && <div className="storage-details"><dl><div><dt>Heap atual</dt><dd data-testid="storage-live-heap">{formatBytes(current.heapBytes)}</dd></div><div><dt>Saída atual</dt><dd>{formatBytes(current.outputBytes)}</dd></div><div><dt>Frames e temporários atuais</dt><dd>{formatBytes(current.frameBytes + current.operandBytes)}</dd></div><div><dt>Estado atual completo</dt><dd>{formatBytes(current.totalBytes)}</dd></div></dl><p>A reserva cobre o maior estado já registrado, incluindo heap e saída. Voltar não libera essa reserva, pois o futuro continua disponível. Código, interface, índices, outras sessões e memória temporária ficam fora desta estimativa.</p><p>{session.historyStats.checkpointCursors.length} checkpoints · {stats.skippedCheckpoints} cópias adiadas pelo orçamento. Cópias auxiliares podem ser reduzidas para priorizar os deltas. Nenhum passo é descartado.</p><p>O limite vale para esta sessão e suas importações. Reiniciar o preserva; trocar/aplicar código ou recarregar usa 64 MiB. Comparações usam o mesmo limite por lado; ele não é um teto de memória da página.</p></div>}
  </section>;
}
