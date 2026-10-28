import type { Program } from './compiler';
export const LEGACY_VM = 'rewind-vm/2';
export const STRING_VM = 'rewind-vm/3';
export function knownVM(vm: unknown): vm is string { return vm === LEGACY_VM || vm === STRING_VM; }
export function programVM(program: Program): string { return program.vm ?? LEGACY_VM; }
