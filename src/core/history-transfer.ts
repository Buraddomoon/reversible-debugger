import type { ImportedHistory } from './portable-history';
import type { Step, DeepReadonly } from './machine';
import type { RuntimeSelection } from './runtime';

export interface TransferHeader {
  name: string; filename: string; bytes: number; checksum: string;
  source: string; runtime: RuntimeSelection; maxSteps: number; maxFrames: number; cursor: number; count: number;
}
export type TransferRequest = { kind: 'import'; content: string } | { kind: 'ack' };
export type TransferResponse =
  | { kind: 'progress'; done: number; total: number }
  | { kind: 'header'; header: TransferHeader }
  | { kind: 'chunk'; records: readonly DeepReadonly<Step>[] }
  | { kind: 'done' }
  | { kind: 'error'; message: string };
export function transferHeader(history: ImportedHistory): TransferHeader {
  const { session, name, filename, bytes, checksum } = history;
  return { name, filename, bytes, checksum, source: session.program.source, runtime: session.runtime, maxSteps: session.maxSteps, maxFrames: session.maxFrames, cursor: session.cursor, count: session.history.length };
}
