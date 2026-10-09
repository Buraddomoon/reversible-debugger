import type { Value } from './language';
import type { DeepReadonly } from './machine';
import type { ComparisonRow, DifferenceValue, StateDifference } from './comparison-types';
import type { RecordedComparisonRun } from './comparison-trace';

const present = (value: Extract<DifferenceValue, { present: true }>['value']): DifferenceValue => ({ present: true, value });
const absent: DifferenceValue = { present: false };
export function sameValue(a: DeepReadonly<Value>, b: DeepReadonly<Value>): boolean {
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
  for (const frameA of a.frames) {
    const frameB = bFrames.get(left.contextForFrame(frameA.id));
    if (!frameB) continue;
    for (const name of new Set([...Object.keys(frameA.locals), ...Object.keys(frameB.locals)])) {
      const existsA = Object.hasOwn(frameA.locals, name), existsB = Object.hasOwn(frameB.locals, name);
      if (existsA !== existsB || (existsA && !sameValue(frameA.locals[name]!, frameB.locals[name]!))) add('variables', `${left.frameLabel(frameA.id)} · ${name}`, existsA ? present(frameA.locals[name]!) : absent, existsB ? present(frameB.locals[name]!) : absent);
    }
  }
  if (!sameArray(a.operands, b.operands, sameValue)) add('operands', 'Pilha de valores', present([...a.operands]), present([...b.operands]));
  if (!sameArray(a.output, b.output)) add('output', 'Saída acumulada', present([...a.output]), present([...b.output]));
  return differences;
}
