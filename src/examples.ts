import bug from '../examples/sum-bug.rw?raw';
import fixed from '../examples/sum-fixed.rw?raw';
import factorial from '../examples/factorial.rw?raw';
import euclid from '../examples/euclid.rw?raw';
import runtimeError from '../examples/runtime-error.rw?raw';
import pythonBug from '../examples/python-sum-bug.py?raw';
import pythonFixed from '../examples/python-sum-fixed.py?raw';
import pythonFactorial from '../examples/python-factorial.py?raw';
import listBug from '../examples/python-list-alias-bug.py?raw';
import listFixed from '../examples/python-list-alias-fixed.py?raw';
import listCycle from '../examples/python-list-cycle.py?raw';
import type { LanguageId } from './core/runtime';

export interface Example {
  id: string;
  title: string;
  tag: string;
  source: string;
  expected?: number | bigint;
  language?: LanguageId;
  description: string;
}
export const examples: Example[] = [
  { id: 'python-list-alias-bug', title: 'Python · Cópia que altera o original', tag: 'Referências compartilhadas', source: listBug, language: 'python', expected: 2n,
    description: 'copy = original compartilha a mesma lista. A função altera ambas: o resultado vira 99 em vez de 2. Observe o ID e desfaça as mutações.' },
  { id: 'python-list-alias-fixed', title: 'Python · Cópia independente', tag: 'Heap reversível', source: listFixed, language: 'python', expected: 2n,
    description: 'Uma lista nova separa copy de original. A função modifica a cópia e o resultado original continua sendo 2.' },
  { id: 'python-list-cycle', title: 'Python · Uma lista aponta para si', tag: 'Ciclos e identidade', source: listCycle, language: 'python', expected: 9n,
    description: 'items, alias e o item [2] apontam para #L1. Volte pelo append e pela alteração para restaurar o ciclo e os valores sem duplicar objetos.' },
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
  { id: 'python-sum-bug', title: 'Python · Soma com bug', tag: 'Python 3', source: pythonBug, language: 'python', expected: 15n,
    description: 'Código Python: a soma deveria ser 15. Acompanhe i < n e volte pela execução para encontrar o número que faltou.' },
  { id: 'python-sum-fixed', title: 'Python · Soma corrigida', tag: 'Python 3', source: pythonFixed, language: 'python', expected: 15n,
    description: 'A condição i <= n inclui o último número. O resultado agora é 15.' },
  { id: 'python-factorial', title: 'Python · Fatorial recursivo', tag: 'Python 3', source: pythonFactorial, language: 'python', expected: 120n,
    description: 'Código Python com chamadas recursivas. Observe os frames entrando e restaure cada retorno ao voltar.' },
];
