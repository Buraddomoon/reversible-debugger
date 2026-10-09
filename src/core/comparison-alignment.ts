import type { ComparisonPoint, ComparisonRow } from './comparison-types';

/** Unique keys include call context and occurrence. LIS keeps both traces monotonic,
 * rejoins common returns after extra iterations, and avoids a quadratic LCS table. */
export function alignComparison(left: readonly ComparisonPoint[], right: readonly ComparisonPoint[]): ComparisonRow[] {
  const rightByKey = new Map(right.map((point, index) => [point.key, index]));
  const candidates: Array<{ left: number; right: number }> = [];
  left.forEach((point, index) => {
    const match = rightByKey.get(point.key);
    if (match !== undefined) candidates.push({ left: index, right: match });
  });
  const tails: number[] = [], previous = new Int32Array(candidates.length).fill(-1);
  candidates.forEach((candidate, index) => {
    let low = 0, high = tails.length;
    while (low < high) { const mid = (low + high) >>> 1; if (candidates[tails[mid]!]!.right < candidate.right) low = mid + 1; else high = mid; }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  });
  const anchors: Array<{ left: number; right: number }> = [];
  for (let index = tails.at(-1) ?? -1; index !== -1; index = previous[index]!) anchors.push(candidates[index]!);
  anchors.reverse();
  const rows: ComparisonRow[] = [];
  let a = 0, b = 0, leftCursor = 0, rightCursor = 0, leftStatePoint = 0, rightStatePoint = 0;
  const append = (leftPoint: number | null, rightPoint: number | null) => {
    if (leftPoint !== null) { leftCursor = left[leftPoint]!.cursor; leftStatePoint = leftPoint; }
    if (rightPoint !== null) { rightCursor = right[rightPoint]!.cursor; rightStatePoint = rightPoint; }
    rows.push({ leftPoint, rightPoint, leftCursor, rightCursor, leftStatePoint, rightStatePoint, differenceCount: 0 });
  };
  for (const anchor of anchors) {
    while (a < anchor.left) append(a++, null);
    while (b < anchor.right) append(null, b++);
    append(a++, b++);
  }
  while (a < left.length) append(a++, null);
  while (b < right.length) append(null, b++);
  return rows;
}
