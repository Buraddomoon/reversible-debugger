import type { Value } from './language';
import { isList, type ReadonlyHeap } from './heap';

function scalarEqual(a: Value, b: Value): boolean {
  if (isList(a) || isList(b)) return false;
  return a !== null && b !== null && typeof a === 'object' && typeof b === 'object' ? a.kind === b.kind && a.name === b.name : Object.is(a, b);
}
export interface HeapDifference { name: string; left: Value | undefined; right: Value | undefined }
interface Pair { a: number; b: number; parents: Set<number> }
/** A bijection across corresponding roots detects aliasing, independent of raw
 * allocation IDs. Scan each pair once; propagate differences through cycles/DAGs. */
export function compareHeapRoots(roots: readonly { left: Value; right: Value }[], aHeap: ReadonlyHeap, bHeap: ReadonlyHeap): { equal: readonly boolean[]; differences: readonly HeapDifference[] } {
  const pairs: Pair[] = [], aMap = new Map<number, number>(), bMap = new Map<number, number>();
  const bad = new Set<number>(), differences: HeapDifference[] = [];
  const register = (a: Value, b: Value): number | boolean => {
    if (!isList(a) || !isList(b)) return scalarEqual(a, b);
    const previousA = aMap.get(a.id), previousB = bMap.get(b.id);
    if (previousA !== undefined && pairs[previousA]!.b !== b.id || previousB !== undefined && pairs[previousB]!.a !== a.id) {
      if (previousA !== undefined) bad.add(previousA);
      if (previousB !== undefined) bad.add(previousB);
      differences.push({ name: `Referências compartilhadas · #L${a.id} ↔ #L${b.id}`, left: a, right: b }); return false;
    }
    if (previousA !== undefined) return previousA;
    const index = pairs.length;
    pairs.push({ a: a.id, b: b.id, parents: new Set() }); aMap.set(a.id, index); bMap.set(b.id, index); return index;
  };
  const results = roots.map(root => register(root.left, root.right));
  for (let p = 0; p < pairs.length; p++) {
    const pair = pairs[p]!, a = aHeap[pair.a]!.items, b = bHeap[pair.b]!.items;
    if (a.length !== b.length) { bad.add(p); differences.push({ name: `#L${pair.a} ↔ #L${pair.b} · comprimento`, left: BigInt(a.length), right: BigInt(b.length) }); }
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const child = a[i] === undefined || b[i] === undefined ? false : register(a[i]!, b[i]!);
      if (typeof child === 'number') pairs[child]!.parents.add(p);
      else if (!child) { bad.add(p); differences.push({ name: `#L${pair.a} ↔ #L${pair.b} · item [${i}]`, left: a[i], right: b[i] }); }
    }
  }
  const queue = [...bad];
  for (let i = 0; i < queue.length; i++) for (const parent of pairs[queue[i]!]!.parents) if (!bad.has(parent)) { bad.add(parent); queue.push(parent); }
  return { equal: results.map(result => typeof result === 'number' ? !bad.has(result) : result), differences };
}
