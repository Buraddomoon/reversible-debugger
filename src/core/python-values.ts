import type { Value } from './language';

// Bound expensive arithmetic independently of source size and instruction count.
const MAX_INTEGER_BITS = 100_000;
export function pythonTruth(value: Value): boolean {
  return value !== null && value !== false && value !== 0 && value !== 0n;
}
export const pythonBuiltins: ReadonlySet<string> = new Set(['abs', 'int', 'float', 'bool', 'print']);
function number(value: Value): number | bigint {
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number' || typeof value === 'bigint') return value;
  throw new Error('Esta operação Python exige números');
}
function float(value: number | bigint): number {
  const result = Number(value);
  if (typeof value === 'bigint' && !Number.isFinite(result)) throw new Error('Inteiro grande demais para a conversão em float suportada');
  return result;
}
function checked(value: number | bigint): number | bigint {
  if (typeof value === 'bigint' && value.toString(2).length > MAX_INTEGER_BITS) throw new Error(`Limite de ${MAX_INTEGER_BITS.toLocaleString('pt-BR')} bits por inteiro atingido`);
  return value;
}
function floorDivision(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? quotient - 1n : quotient;
}
function floatDivmod(a: number, b: number): { quotient: number; remainder: number } {
  let remainder = a % b;
  let division = (a - remainder) / b;
  if (remainder !== 0) {
    if ((b < 0) !== (remainder < 0)) { remainder += b; division--; }
  } else remainder = b < 0 ? -0 : 0;
  let quotient: number;
  if (division !== 0) {
    quotient = Math.floor(division);
    if (division - quotient > 0.5) quotient++;
  } else quotient = a / b < 0 || Object.is(a / b, -0) ? -0 : 0;
  return { quotient, remainder };
}

export function pythonUnary(operator: string, value: Value): Value {
  if (operator === 'not' || operator === 'bool') return operator === 'not' ? !pythonTruth(value) : pythonTruth(value);
  const numeric = number(value);
  switch (operator) {
    case '+': return numeric;
    case '-': return -numeric;
    case 'abs': return typeof numeric === 'number' ? Math.abs(numeric) : numeric < 0n ? -numeric : numeric;
    case 'float': return float(numeric);
    case 'int':
      if (typeof numeric === 'bigint') return numeric;
      if (!Number.isFinite(numeric)) throw new Error('Não é possível converter esse float em int');
      return checked(BigInt(Math.trunc(numeric)));
    default: throw new Error(`Operador Python ainda não suportado: ${operator}`);
  }
}

export function pythonBinary(operator: string, left: Value, right: Value): Value {
  if (operator === '==' || operator === '!=') {
    let equal: boolean;
    if (left === null || right === null) equal = left === right;
    else if (typeof left === 'object' || typeof right === 'object') equal = typeof left === 'object' && typeof right === 'object' && left.kind === right.kind && left.name === right.name;
    else equal = number(left) == number(right); // Python bool/int/float equality, including exact bigint/float comparisons.
    return operator === '==' ? equal : !equal;
  }
  const a = number(left), b = number(right);
  switch (operator) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
  }
  if (['/', '//', '%'].includes(operator) && (b === 0 || b === 0n)) throw new Error('Divisão por zero');
  if (operator === '/') return float(a) / float(b);
  if (operator === '**') {
    if (typeof a === 'bigint' && typeof b === 'bigint' && b >= 0n) {
      if (b > BigInt(MAX_INTEGER_BITS) && a !== 0n && a !== 1n && a !== -1n) throw new Error('Expoente excede o limite de cálculo de inteiros');
      if (a === 0n) return b === 0n ? 1n : 0n;
      if (a === 1n) return 1n;
      if (a === -1n) return b % 2n === 0n ? 1n : -1n;
      if (BigInt((a < 0n ? -a : a).toString(2).length - 1) * b > BigInt(MAX_INTEGER_BITS)) throw new Error('Potência excede o limite de cálculo de inteiros');
      return checked(a ** b);
    }
    if ((a === 0n || a === 0) && b < 0) throw new Error('Zero não pode ser elevado a um expoente negativo');
    const result = float(a) ** float(b);
    if (Number.isNaN(result)) throw new Error('Resultados complexos ainda não são suportados');
    if (!Number.isFinite(result) && Number.isFinite(float(a)) && Number.isFinite(float(b))) throw new Error('Resultado da potência fora do intervalo float');
    return result;
  }
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    switch (operator) {
      case '+': return checked(a + b);
      case '-': return checked(a - b);
      case '*': return checked(a * b);
      case '//': return floorDivision(a, b);
      case '%': return a - floorDivision(a, b) * b;
    }
  } else {
    const x = float(a), y = float(b);
    switch (operator) {
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      case '//': return floatDivmod(x, y).quotient;
      case '%': return floatDivmod(x, y).remainder;
    }
  }
  throw new Error(`Operador Python ainda não suportado: ${operator}`);
}
