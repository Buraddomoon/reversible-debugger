import type { RunMode } from '../core/execution-control';

export const actionLabels: Record<RunMode, string> = {
  continue: 'Execução', 'reverse-continue': 'Busca para trás', into: 'Entrar', over: 'Passar sobre', out: 'Sair da função', 'back-statement': 'Voltar comando',
};

export function StepControls({ disabled, canForward, canBackward, canStepOut, running, onStart }: {
  disabled: boolean;
  canForward: boolean;
  canBackward: boolean;
  canStepOut: boolean;
  running: boolean;
  onStart: (mode: RunMode) => void;
}) {
  return <section className="source-controls" aria-label="Navegação por comandos">
    <span>POR COMANDO</span>
    <div>
      <button onClick={() => onStart('into')} disabled={disabled || running || !canForward} title="Executar até o próximo comando, entrando na primeira função chamada">Entrar</button>
      <button onClick={() => onStart('over')} disabled={disabled || running || !canForward} title="Concluir o comando atual, incluindo suas chamadas; breakpoints continuam ativos">Passar sobre</button>
      <button onClick={() => onStart('out')} disabled={disabled || running || !canStepOut} title="Continuar até o frame atual retornar; breakpoints continuam ativos">Sair da função</button>
      <button onClick={() => onStart('back-statement')} disabled={disabled || running || !canBackward} title="Desfazer até o início do comando anterior no histórico">Voltar comando</button>
      <button onClick={() => onStart('reverse-continue')} disabled={disabled || running || !canBackward} title="Retroceder até um breakpoint anterior ou o estado inicial">Continuar para trás</button>
    </div>
  </section>;
}

export function BreakpointBar({ lines, enabled, disabled = false, onToggle, onEnabled, onClear }: {
  disabled?: boolean;
  lines: readonly number[];
  enabled: boolean;
  onToggle: (line: number) => void;
  onEnabled: (enabled: boolean) => void;
  onClear: () => void;
}) {
  return <div className="breakpoint-bar" aria-label="Breakpoints">
    <span className="breakpoint-caption"><span aria-hidden="true">●</span> Breakpoints <strong>{lines.length}</strong></span>
    {lines.length ? <div className="breakpoint-list">{lines.map(line => <button key={line} disabled={disabled} aria-label={`Remover breakpoint L${line}`} onClick={() => onToggle(line)}>L{line} <span aria-hidden="true">×</span></button>)}</div> : <p>Clique no número de uma linha executável.</p>}
    {lines.length > 0 && <div className="breakpoint-settings"><label><input type="checkbox" disabled={disabled} checked={enabled} onChange={event => onEnabled(event.target.checked)} />Ativos</label><button disabled={disabled} onClick={onClear}>Limpar breakpoints</button></div>}
  </div>;
}
