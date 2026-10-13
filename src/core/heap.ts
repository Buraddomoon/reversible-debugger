import type { ListReference, Value } from './language';

export interface ListObject { kind: 'list'; items: Value[] }
export type Heap = Record<number, ListObject>;
export type ReadonlyHeap = Readonly<Record<number, { readonly kind: 'list'; readonly items: readonly Value[] }>>;
export const MAX_HEAP_OBJECTS = 4096;
export const MAX_HEAP_ITEMS = 20_000;
export function isList(value: Value): value is ListReference { return value !== null && typeof value === 'object' && value.kind === 'list'; }
export function getList(value: Value, heap: ReadonlyHeap): ReadonlyHeap[number] {
  if (!isList(value)) throw new Error('Esta operação exige uma lista Python');
  const object = heap[value.id];
  if (!object) throw new Error(`Referência de lista inexistente: #L${value.id}`);
  return object;
}
export function listIndex(value: Value, length: number): number {
  if (typeof value !== 'bigint' && typeof value !== 'boolean') throw new Error('Índice de lista deve ser int ou bool; float não é aceito');
  const index = typeof value === 'boolean' ? value ? 1n : 0n : value;
  const normalized = index < 0n ? index + BigInt(length) : index;
  if (normalized < 0n || normalized >= BigInt(length)) throw new Error('Índice de lista fora do intervalo');
  return Number(normalized);
}
