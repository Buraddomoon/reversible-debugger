# Linguagem Rewind v0.1

Arquivos `.rw`; sintaxe inspirada em JavaScript. Esta linguagem é interpretada pela própria VM, não pelo JavaScript do navegador.

## Valores e expressões

- Números finitos de dupla precisão, com literais inteiros ou decimais (`1`, `0.5`). Não há notação exponencial em literais nesta versão.
- Booleanos `true` e `false`.
- Aritmética: `+`, `-`, `*`, `/`, `%`; sinal unário `-`.
- Comparações: `<`, `<=`, `>`, `>=`, `==`, `!=`; negação booleana `!`.
- Parênteses e chamadas de funções podem aparecer dentro das expressões.

Precedência, da menor para a maior: igualdade; comparação; soma/subtração; multiplicação/divisão/resto; operadores unários. Operadores binários são associativos à esquerda. Argumentos e operandos são avaliados da esquerda para a direita.

Aritmética e comparações de ordem exigem números. Igualdade exige tipos iguais. `!` e condições exigem booleanos: não existe conversão implícita para verdadeiro/falso. Divisão ou resto por zero, resultados não finitos e operações entre tipos incompatíveis geram erro de execução reversível. O valor `-0` é preservado no estado interno, embora sua apresentação textual seja `0`.

## Variáveis

```javascript
let total = 0;
total = total + 5;
```

Identificadores: letras ASCII ou `_` no início; letras ASCII, `_` e dígitos depois. Palavras reservadas não podem ser identificadores. Declaração e atribuição exigem `;` e a declaração exige inicialização.

Existem escopo global e um escopo por chamada de função. Blocos de `if` e `while` não criam novos escopos. Redeclarar no mesmo escopo é erro; declarar uma variável dentro de um loop que a executa novamente causará esse erro. Declare variáveis de trabalho antes do loop e atribua dentro dele.

Uma leitura ou atribuição procura primeiro no frame atual e depois no global; nunca nos locais do chamador. Parâmetros podem sombrear globais. Usar ou atribuir uma variável inexistente é erro. Não há coerção de tipos nem tipagem estática da linguagem; um binding pode receber qualquer um dos dois tipos válidos por atribuição.

## Controle de fluxo

```javascript
if (total > 0) {
  total = total - 1;
} else {
  total = 10;
}

while (total < 20) {
  total = total + 1;
}
```

Parênteses e chaves são obrigatórios. `else` é opcional. Não há `for`, `break`, `continue`, `else if` abreviado nem operadores `&&` e `||` nesta versão.

## Funções

```javascript
fn factorial(n) {
  if (n <= 1) {
    return 1;
  }
  return n * factorial(n - 1);
}

let result = factorial(5);
```

Funções são declaradas apenas no nível superior e podem ser chamadas antes da declaração textual. Nomes de funções e parâmetros duplicados são rejeitados. A quantidade de argumentos deve corresponder à de parâmetros. Há suporte a recursão até o limite de frames.

`return` exige expressão e só é válido dentro de função. Chegar ao fim de uma função equivale a retornar `0`. Chamadas usadas como comando, como `factorial(5);`, descartam o resultado. Funções não são valores: não existem funções anônimas, closures ou passagem de função como argumento.

## Comentários e diagnóstico

`//` comenta até o fim da linha. Espaços e quebras de linha são ignorados. Erros de léxico, sintaxe e validação de funções indicam linha e coluna. Erros em execução ficam no estado da VM e podem ser desfeitos. O debugger destaca a posição da instrução que falhou.

## Limites e exclusões

O parser aceita até 50.000 caracteres e 128 níveis de aninhamento. Sessões têm, por padrão, 20.000 passos e 256 frames, incluindo o global. Ao atingir o limite de histórico, nenhum novo passo é executado; desfazer e reaplicar registros existentes permanece possível. O limite de frames aparece como erro reversível da VM.

Não há strings, arrays, objetos, acesso a arquivos, rede, relógio, aleatoriedade, entrada/saída externa, exceções capturáveis ou alterações no código durante uma sessão. O resultado convencional dos exemplos é a variável global `result`.
