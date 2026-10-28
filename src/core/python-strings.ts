import { LanguageError, type Span, type Value } from './language';

/** UTF-16 quota bounds storage before allocating concatenations/repetitions.
 * Python operations below count Unicode scalar values, not UTF-16 units. */
export const MAX_STRING_UNITS = 100_000;
export function checkedString(text: string): string {
  if (text.length > MAX_STRING_UNITS) throw new Error('String excede 100.000 unidades UTF-16');
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const low = text.charCodeAt(++i); if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error('Surrogates isolados não são suportados em strings'); }
    else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Surrogates isolados não são suportados em strings');
  }
  return text;
}
export function stringLiteral(source: string, start: number, span: Span): { text: string; end: number } {
  const quote = source[start]!, parts: string[] = []; let i = start + 1;
  const fail = (message: string): never => { throw new LanguageError(message, span); };
  if (source.slice(start, start + 3) === quote.repeat(3)) fail('Strings com aspas triplas ainda não são suportadas');
  while (i < source.length) {
    let char = source[i++]!;
    if (char === quote) { try { return { text: checkedString(parts.join('')), end: i }; } catch (cause) { return fail((cause as Error).message); } }
    if (char === '\0') fail('Byte nulo literal não é permitido no código; use um escape');
    if (char === '\n' || char === '\r') fail('String não foi fechada nesta linha');
    if (char === '\\') {
      char = source[i++] ?? '';
      const escapes: Record<string, string> = { '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
      if (Object.hasOwn(escapes, char)) char = escapes[char]!;
      else if (char === 'x' || char === 'u' || char === 'U') {
        const size = char === 'x' ? 2 : char === 'u' ? 4 : 8, hex = source.slice(i, i + size);
        if (hex.length !== size || !/^[0-9a-fA-F]+$/.test(hex)) fail('Escape hexadecimal Unicode incompleto ou inválido');
        const code = parseInt(hex, 16); if (code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) fail('Escape Unicode fora dos valores escalares suportados');
        char = String.fromCodePoint(code); i += size;
      } else if (/[0-7]/.test(char) && char.length) {
        let octal = char; while (octal.length < 3 && /[0-7]/.test(source[i] ?? '') && i < source.length) octal += source[i++]!;
        const code = parseInt(octal, 8); if (code > 255) fail('Escape octal deve estar entre 000 e 377'); char = String.fromCodePoint(code);
      } else fail('Escape de string ainda não suportado');
    }
    parts.push(char);
    if (parts.length > MAX_STRING_UNITS) fail('String excede 100.000 unidades UTF-16');
  }
  return fail('String não foi fechada nesta linha');
}
export function stringLength(text: string): number { let size = 0; for (const _char of text) size++; return size; }
export function stringIndex(text: string, index: Value): string {
  if (typeof index !== 'bigint' && typeof index !== 'boolean') throw new Error('Índice de string deve ser int ou bool; float não é aceito');
  const chars = Array.from(text), raw = typeof index === 'boolean' ? index ? 1n : 0n : index, position = raw < 0n ? raw + BigInt(chars.length) : raw;
  if (position < 0n || position >= BigInt(chars.length)) throw new Error('Índice de string fora do intervalo');
  return chars[Number(position)]!;
}
export function repeatString(text: string, count: Value): string {
  if (typeof count !== 'bigint' && typeof count !== 'boolean') throw new Error('Repetição de string exige int ou bool');
  const copies = typeof count === 'boolean' ? count ? 1n : 0n : count;
  if (copies <= 0n || text.length === 0) return '';
  if (BigInt(text.length) * copies > BigInt(MAX_STRING_UNITS)) throw new Error('String excede 100.000 unidades UTF-16');
  return text.repeat(Number(copies));
}
export function compareStrings(left: string, right: string): number {
  const a = left[Symbol.iterator](), b = right[Symbol.iterator]();
  while (true) { const x = a.next(), y = b.next(); if (x.done || y.done) return x.done ? y.done ? 0 : -1 : 1; const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!; if (d) return d; }
}
/** Python-style repr for supported scalar Unicode strings. maxUnits is a
 * display bound; callers needing exact output omit it and enforce print quotas. */
export function reprString(text: string, maxUnits = Infinity, truncate = true): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'", parts = [quote]; let units = 1;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const next = char === quote || char === '\\' ? '\\' + char : char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : char !== ' ' && /[\p{C}\p{Z}]/u.test(char) ? code <= 255 ? `\\x${code.toString(16).padStart(2, '0')}` : code <= 65535 ? `\\u${code.toString(16).padStart(4, '0')}` : `\\U${code.toString(16).padStart(8, '0')}` : char;
    if (units + next.length + 1 > maxUnits) { if (!truncate) throw new Error('Saída de print excede 100.000 caracteres'); parts.push('…'); break; }
    parts.push(next); units += next.length;
  }
  parts.push(quote); return parts.join('');
}
