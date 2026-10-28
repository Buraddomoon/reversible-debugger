/** Limits are independent from VM semantics and payload/disk budgets. */
export const LEGACY_MAX_STEPS = 20_000;
export const MAX_EXECUTION_STEPS = 50_000;
export const MAX_EXECUTION_FRAMES = 256;
export interface ExecutionLimits { maxSteps: number; maxFrames: number }
export const DEFAULT_EXECUTION_LIMITS: Readonly<ExecutionLimits> = Object.freeze({ maxSteps: LEGACY_MAX_STEPS, maxFrames: MAX_EXECUTION_FRAMES });
export function validateExecutionLimits(limits: ExecutionLimits, maxSteps = MAX_EXECUTION_STEPS): void {
  if (!Number.isSafeInteger(limits.maxSteps) || Object.is(limits.maxSteps, -0) || limits.maxSteps < 1 || limits.maxSteps > maxSteps) throw new Error(`Escolha entre 1 e ${maxSteps.toLocaleString('pt-BR')} passos.`);
  if (!Number.isSafeInteger(limits.maxFrames) || limits.maxFrames < 2 || limits.maxFrames > MAX_EXECUTION_FRAMES) throw new Error(`Escolha entre 2 e ${MAX_EXECUTION_FRAMES} níveis da pilha, incluindo o programa.`);
}
export const extendedLimits = (limits: ExecutionLimits) => limits.maxSteps > LEGACY_MAX_STEPS;
