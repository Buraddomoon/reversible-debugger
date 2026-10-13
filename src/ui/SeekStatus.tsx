export function SeekStatus({ current, target, completed, total, unit = 'Passo', onCancel }: { current: number; target: number; completed: number; total: number; unit?: string; onCancel: () => void }) {
  return <div className="seek-progress" data-testid="seek-progress"><div><strong>Restaurando histórico</strong><span>{unit} atual {current} → destino {target} · {completed} / {total} registros</span></div><progress aria-label="Restauração do histórico" value={completed} max={Math.max(1, total)} /><button onClick={onCancel}>Cancelar navegação</button></div>;
}
