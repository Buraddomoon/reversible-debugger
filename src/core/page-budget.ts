import type { DebugSession } from './debugger';
import { DEFAULT_HISTORY_BYTES, MAX_HISTORY_BYTES } from './history';

/** Conservative payload reservations. Shared frozen payloads are charged again.
 * JSON/codec/UI/engine overhead is outside this estimate; this is not a RAM limit. */
export const PAGE_HISTORY_BYTES = 256 * 1024 * 1024;
export function heldHistoryBytes(histories: readonly { session: DebugSession }[]): number {
  return histories.reduce((sum, h) => sum + h.session.storageStats.limitBytes, 0);
}
export function activeHistoryBudget(histories: readonly { session: DebugSession }[]): number {
  return Math.max(0, Math.min(MAX_HISTORY_BYTES, PAGE_HISTORY_BYTES - heldHistoryBytes(histories)));
}
export function stagingHistoryBudget(histories: readonly { session: DebugSession }[], active: DebugSession, copies: number, requested = active.storageStats.limitBytes): number {
  if (!Number.isSafeInteger(copies) || copies < 1 || copies > 4) throw new Error('Reserva de sessões inválida');
  const available = Math.floor((PAGE_HISTORY_BYTES - heldHistoryBytes(histories) - active.storageStats.limitBytes) / copies);
  const budget = Math.min(requested, available);
  if (budget < 64 * 1024) throw new Error('O orçamento agregado da página está reservado. Feche um histórico ou reduza o limite da sessão antes de carregar outra execução.');
  return budget;
}
export function defaultActiveBudget(histories: readonly { session: DebugSession }[]): number {
  return Math.min(DEFAULT_HISTORY_BYTES, activeHistoryBudget(histories));
}
