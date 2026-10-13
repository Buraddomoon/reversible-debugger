import type { DeepReadonly, Frame, MachineState, Step } from './machine';
import type { ListObject } from './heap';

/** Deterministic UTF-8 payload accounting, not JavaScript heap measurements.
 * A delimiter is reserved per collection entry, including its last entry.
 * Values are references by ID; there is no recursive heap expansion. */
export function encodedBytes(value: unknown): number {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return { $bigint: item.toString() };
    if (typeof item === 'number' && (Object.is(item, -0) || !Number.isFinite(item))) return { $number: String(Object.is(item, -0) ? '-0' : item) };
    return item;
  });
  return new TextEncoder().encode(encoded).byteLength;
}
const entries = (values: readonly unknown[]) => values.reduce<number>((sum, value) => sum + encodedBytes(value) + 1, 0);
const bindingBytes = (name: string, binding: DeepReadonly<Extract<Step['changes'][number], { kind: 'binding' }>['before']>) => binding.exists ? encodedBytes(name) + 2 + encodedBytes(binding.value) : 0;
const frameBytes = (frame: DeepReadonly<Frame>) => encodedBytes({ ...frame, locals: {} }) + Object.entries(frame.locals).reduce((sum, [name, value]) => sum + bindingBytes(name, { exists: true, value }), 0);
const listBytes = (list: DeepReadonly<ListObject>) => encodedBytes({ kind: 'list', items: [] }) + entries(list.items);
const objectBytes = (id: number, list: DeepReadonly<ListObject>) => encodedBytes(String(id)) + 2 + listBytes(list);
const shell = 2 + ['control', 'frames', 'operands', 'output', 'heap'].reduce((sum, key) => sum + encodedBytes(key) + 2, 0);
export interface MachinePayload {
  readonly controlBytes: number;
  readonly frameBytes: number;
  readonly operandBytes: number;
  readonly heapBytes: number;
  readonly outputBytes: number;
  readonly totalBytes: number;
}
function total(bytes: Omit<MachinePayload, 'totalBytes'>): MachinePayload {
  return { ...bytes, totalBytes: shell + bytes.controlBytes + bytes.frameBytes + bytes.operandBytes + bytes.heapBytes + bytes.outputBytes };
}
/** Full scan only at initialization/checkpoint restoration, never per instruction. */
export function measureMachine(state: DeepReadonly<MachineState>): MachinePayload {
  return total({ controlBytes: encodedBytes(state.control), frameBytes: 2 + state.frames.reduce((sum, frame) => sum + frameBytes(frame) + 1, 0), operandBytes: 2 + entries(state.operands), heapBytes: 2 + Object.entries(state.heap).reduce((sum, [id, list]) => sum + objectBytes(Number(id), list), 0), outputBytes: 2 + entries(state.output) });
}
/** Update using only values already present in the transaction. */
export function accountStep(before: MachinePayload, step: DeepReadonly<Step>, direction: 'forward' | 'backward'): MachinePayload {
  const next = { ...before };
  const sign = direction === 'forward' ? 1 : -1;
  for (const change of step.changes) {
    switch (change.kind) {
      case 'control': next.controlBytes += sign * (encodedBytes(change.after) - encodedBytes(change.before)); break;
      case 'binding': next.frameBytes += sign * (bindingBytes(change.name, change.after) - bindingBytes(change.name, change.before)); break;
      case 'frames': next.frameBytes += sign * (change.added.reduce((sum, frame) => sum + frameBytes(frame) + 1, 0) - change.removed.reduce((sum, frame) => sum + frameBytes(frame) + 1, 0)); break;
      case 'operands': next.operandBytes += sign * (entries(change.added) - entries(change.removed)); break;
      case 'output': next.outputBytes += sign * (entries(change.added) - entries(change.removed)); break;
      case 'heap-allocation': next.heapBytes += sign * objectBytes(change.id, change.object); break;
      case 'heap-splice': next.heapBytes += sign * (entries(change.added) - entries(change.removed)); break;
    }
  }
  return total(next);
}
