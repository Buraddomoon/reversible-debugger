import type { Value } from './language';
import type { DeepReadonly } from './machine';
import type { ComparisonRow, DifferenceValue, StateDifference } from './comparison-types';
import type { RecordedComparisonRun } from './comparison-trace';
import { isList } from './heap';
import { compareHeapRoots } from './heap-comparison';
import { previewValue } from './runtime';

const present = (value: Extract<DifferenceValue, { present: true }>['value']): DifferenceValue => ({ present: true, value });
const absent: DifferenceValue = { present: false };
export function sameValue(a: DeepReadonly<Value>, b: DeepReadonly<Value>): boolean {
  if (isList(a) || isList(b)) return isList(a) && isList(b) && a.id === b.id;
  return a !== null && b !== null && typeof a === 'object' && typeof b === 'object' ? a.kind === b.kind && a.name === b.name : Object.is(a, b);
}
function sameArray<T>(a: readonly T[], b: readonly T[], equals: (a: T, b: T) => boolean = Object.is): boolean {
  return a.length === b.length && a.every((value, index) => equals(value, b[index]!));
}
/** Compare observable state at selected semantic points; bytecode addresses and
 * allocation counters are execution-specific, while seek still restores them exactly. */
export function compareStates(left: RecordedComparisonRun, right: RecordedComparisonRun, row: ComparisonRow): StateDifference[] {
  const differences: StateDifference[] = [];
  const add = (category: StateDifference['category'], name: string, a: DifferenceValue, b: DifferenceValue) => differences.push({ category, name, left: a, right: b });
  const pointA = row.leftPoint === null ? null : left.points[row.leftPoint]!;
  const pointB = row.rightPoint === null ? null : right.points[row.rightPoint]!;
  if (!pointA || !pointB) add('flow', 'Evento executado', pointA ? present(pointA.description) : absent, pointB ? present(pointB.description) : absent);
  else {
    if (pointA.phase !== pointB.phase) add('control', 'Tipo de parada', present(pointA.phase), present(pointB.phase));
    if (pointA.outcome !== pointB.outcome) add('decision', 'Resultado da condição', pointA.outcome === null ? absent : present(pointA.outcome), pointB.outcome === null ? absent : present(pointB.outcome));
  }
  const a = left.state, b = right.state;
  if (a.control.status !== b.control.status) add('control', 'Situação da execução', present(a.control.status), present(b.control.status));
  if (a.control.error !== b.control.error) add('control', 'Erro', a.control.error === null ? absent : present(a.control.error), b.control.error === null ? absent : present(b.control.error));
  const aContexts = a.frames.map(frame => left.contextForFrame(frame.id));
  const bContexts = b.frames.map(frame => right.contextForFrame(frame.id));
  if (!sameArray(aContexts, bContexts)) add('stack', 'Pilha de chamadas', present(a.frames.map(frame => left.frameLabel(frame.id))), present(b.frames.map(frame => right.frameLabel(frame.id))));
  const bFrames = new Map(b.frames.map(frame => [right.contextForFrame(frame.id), frame]));
  const roots: Array<{ left: Value; right: Value; name: string | null }> = [];
  for (const frameA of a.frames) {
    const frameB = bFrames.get(left.contextForFrame(frameA.id));
    if (!frameB) continue;
    for (const name of [...new Set([...Object.keys(frameA.locals), ...Object.keys(frameB.locals)])].sort()) {
      const existsA = Object.hasOwn(frameA.locals, name), existsB = Object.hasOwn(frameB.locals, name);
      const label = `${left.frameLabel(frameA.id)} · ${name}`;
      if (existsA !== existsB) add('variables', label, existsA ? present(previewValue(frameA.locals[name]!, left.program.runtime.language, a.heap)) : absent, existsB ? present(previewValue(frameB.locals[name]!, right.program.runtime.language, b.heap)) : absent);
      else if (existsA) roots.push({ left: frameA.locals[name]!, right: frameB.locals[name]!, name: label });
    }
  }
  const variableCount = roots.length;
  for (let i = 0; i < Math.min(a.operands.length, b.operands.length); i++) roots.push({ left: a.operands[i]!, right: b.operands[i]!, name: null });
  const graph = compareHeapRoots(roots, a.heap, b.heap);
  for (let i = 0; i < variableCount; i++) if (!graph.equal[i]) {
    const root = roots[i]!;
    const formatA = isList(root.left) ? previewValue(root.left, left.program.runtime.language, a.heap) : root.left;
    const formatB = isList(root.right) ? previewValue(root.right, right.program.runtime.language, b.heap) : root.right;
    add('variables', root.name!, present(formatA), present(formatB));
  }
  for (const difference of graph.differences) add('heap', difference.name, difference.left === undefined ? absent : present(difference.left), difference.right === undefined ? absent : present(difference.right));
  if (a.operands.length !== b.operands.length || graph.equal.slice(variableCount).some(equal => !equal)) add('operands', 'Pilha de valores', present([...a.operands]), present([...b.operands]));
  if (!sameArray(a.output, b.output)) add('output', 'Saída acumulada', present([...a.output]), present([...b.output]));
  return differences;
}
