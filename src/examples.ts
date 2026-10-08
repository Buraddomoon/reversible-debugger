import bug from '../examples/sum-bug.rw?raw';
import fixed from '../examples/sum-fixed.rw?raw';
import factorial from '../examples/factorial.rw?raw';
import euclid from '../examples/euclid.rw?raw';
import runtimeError from '../examples/runtime-error.rw?raw';

export interface Example {
  id: string;
  title: string;
  tag: string;
  source: string;
  expected?: number;
  description: string;
}
export const examples: Example[] = [
  { id: 'sum-bug', title: 'A soma que perdeu um número', tag: 'Bug de limite', source: bug, expected: 15,
    description: 'A soma de 1 a 5 deveria ser 15. Acompanhe o loop e descubra por que o resultado é 10.' },
  { id: 'sum-fixed', title: 'Soma corrigida', tag: 'Limite inclusivo', source: fixed, expected: 15,
    description: 'O limite agora inclui o último número. Observe a condição i <= n na última iteração.' },
  { id: 'factorial', title: 'Fatorial recursivo', tag: 'Chamadas aninhadas', source: factorial, expected: 120,
    description: 'Observe cinco chamadas de factorial e volte através dos retornos para reconstruir a pilha.' },
  { id: 'euclid', title: 'Algoritmo de Euclides', tag: 'Loop e atribuições', source: euclid, expected: 6,
    description: 'O maior divisor comum de 48 e 18 é 6. A cada volta, acompanhe a troca de a, b e rest.' },
  { id: 'runtime-error', title: 'Uma divisão impossível', tag: 'Erro reversível', source: runtimeError,
    description: 'Execute a divisão por zero. Voltar remove o erro e restaura os operandos da divisão.' },
];
