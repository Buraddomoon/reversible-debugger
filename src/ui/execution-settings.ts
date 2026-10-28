import { DEFAULT_EXECUTION_LIMITS, validateExecutionLimits, type ExecutionLimits } from '../core/execution-limits';
const KEY = 'rewind.execution-limits.v1';
function entries(): Record<string, ExecutionLimits> {
  const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Configuração inválida');
  return raw as Record<string, ExecutionLimits>;
}
export function readExecutionSettings(id: string): ExecutionLimits {
  try { const value = entries()[id]; if (value) { validateExecutionLimits(value); return { maxSteps: value.maxSteps, maxFrames: value.maxFrames }; } } catch { /* Keep unreadable data untouched. */ }
  return { ...DEFAULT_EXECUTION_LIMITS };
}
export function writeExecutionSettings(id: string, limits: ExecutionLimits): string | null {
  try { validateExecutionLimits(limits); const saved = entries(); localStorage.setItem(KEY, JSON.stringify({ ...saved, [id]: { ...limits } })); return null; }
  catch { return 'Os limites foram aplicados nesta execução, mas não puderam ser salvos para a próxima abertura.'; }
}
export function removeExecutionSettings(id: string): void {
  try { const saved = entries(); if (Object.hasOwn(saved, id)) { delete saved[id]; localStorage.setItem(KEY, JSON.stringify(saved)); } }
  catch { /* Deleting a script must not overwrite unreadable preferences. */ }
}
