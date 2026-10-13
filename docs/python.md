# Python 3 no Rewind

O Rewind agora interpreta **código Python 3**, com parser e regras de execução específicos, convertendo-o para instruções da máquina reversível. O suporte é um subconjunto da linguagem. Não se executa o código no Python instalado nem se tenta reproduzir toda a biblioteca padrão.

O seletor **Python / Python 3** identifica essa implementação das regras comuns de Python 3; não seleciona um executável CPython nem promete suporte a todos os recursos de uma versão minor como 3.12 ou 3.14. Só há uma versão Python disponível neste estágio. A linguagem experimental 0.1 continua disponível separadamente para os arquivos `.rw` antigos. JavaScript será outro adaptador.

## Recursos implementados

- Atribuição `x = expressão` e atribuição aumentada `+=`, `-=`, `*=`, `/=`, `//=`, `%=` e `**=`.
- Inteiros exatos, inclusive além de `2**53`, floats, booleanos `True`/`False` e `None`.
- Literais inteiros decimais, hexadecimais, binários e octais; floats com ponto ou expoente.
- Operadores `+`, `-`, `*`, `/`, `//`, `%`, `**`, comparações, sinais unários, `not`, `and` e `or`.
- Precedência de Python, inclusive `-2 ** 2`, potência associativa à direita e curto-circuito de `and`/`or`, que retornam operandos.
- `if/elif/else`, `while` e `pass`; condições usam as regras de verdade dos valores suportados.
- `def`, parâmetros posicionais, chamadas, recursão e `return`. Retorno vazio ou implícito produz `None`.
- Funções de nível superior podem ser referenciadas por aliases e recebidas por parâmetros; closures não são suportadas.
- `abs` com um argumento; `int`, `float` e `bool` com zero ou um argumento. Os builtins podem ser referenciados por aliases e respeitam variáveis/definições que os sombreiam.
- `print` com argumentos posicionais dos tipos suportados, separado por espaços e terminando com uma quebra de linha. A saída fica no estado do programa e é reversível.
- Comentários `#`, arquivos CRLF e expressões/chamadas que continuem em outras linhas dentro de parênteses.
- Listas `[]`/`[1, 2]`, aninhamento, vírgula final e continuação entre colchetes.
- Leitura/escrita por índice, inclusive negativo e `bool`; `a.append(valor)` com um argumento e retorno `None`; `len(lista)`.
- Referências compartilhadas em variáveis, parâmetros e retornos; igualdade por conteúdo (`==`/`!=`), verdade pelo comprimento e impressão de listas com ciclos.

```python
def sum_to(n):
    total = 0
    i = 1
    while i <= n:
        total += i
        i += 1
    return total

result = sum_to(5)
print(result)
```

Importe um `.py`, cole o código em **Adicionar script**, ou escolha um exemplo Python. Ao aplicar, o debugger inicia uma sessão nova. **Retroceder tudo** restaura inclusive as definições de funções, o heap e a saída inicial vazia; avançar depois reaplica os registros existentes.

**Adicionar script** abre o modal de nome, linguagem e versão. Depois de criar, o editor começa vazio. Scripts criados e seu código em edição ficam guardados no navegador; recarregar a página ou usar **Reiniciar programa** não os remove. **Excluir script** pede confirmação antes de remover o registro selecionado.

## Semântica que merece atenção

Um nome atribuído dentro de uma função é local nessa função inteira, inclusive antes da primeira atribuição. Ler esse local antes de inicializá-lo gera erro; não se usa o global de mesmo nome como substituto. Leituras de nomes que não são locais usam o frame global, sem acessar locais do chamador. Esta regra é coberta por testes e segue o [modelo de execução do Python](https://docs.python.org/3/reference/executionmodel.html).

As funções ficam disponíveis quando seu `def` é executado. Uma chamada antes disso falha; isso difere da linguagem experimental original. O próprio binding que representa a função é um delta reversível. Identidades de funções de nível superior são representadas por seu nome único nesta sessão; redefinições de função são rejeitadas.

Em chamadas, o nome da função é avaliado antes dos argumentos. Essa referência fica na pilha de operandos e é preservada ao desfazer o passo; nomes inexistentes falham antes de se avaliar argumentos com efeitos ou erros.

Inteiros usam `bigint`; floats usam números de dupla precisão. `//` arredonda em direção ao menos infinito e `%` acompanha o sinal do divisor, inclusive com operandos negativos. Booleanos participam da aritmética como inteiros. Essas regras e a precedência/curto-circuito foram verificadas contra as [expressões de Python](https://docs.python.org/3/reference/expressions.html) e com casos executados no Python existente nesta máquina.

A interface mostra `int`, `float`, `None`, booleanos, funções e listas separadamente. Os valores de funções são apresentados descritivamente, sem um endereço de memória do CPython.

Uma atribuição `b = a` compartilha a lista, enquanto `[a[0], a[1]]` cria outra. Índices são avaliados com regras de Python: float é rejeitado, índices negativos contam a partir do fim e a escrita avalia o lado direito antes do alvo/índice. `append` verifica o receptor antes de avaliar o argumento. Ao desfazer uma mutação, todas as referências observam o conteúdo restaurado. [Contrato e exemplos](reversible-lists.md).

## Recursos ainda não suportados

Strings, tuplas, dicionários, sets, imports, bibliotecas, atributos além da chamada direta de `append`, classes, lambdas, closures, funções aninhadas/condicionais, `for`, `range`, `break`, `continue`, `global`, `nonlocal`, exceções capturáveis, async, generators, comprehensions, parâmetros default/keyword/variádicos e comparações encadeadas (`0 < x < 10`). Listas ainda não suportam slicing, concatenação/repetição, comparação de ordem, `is`, atribuição aumentada por índice, métodos armazenados ou outros métodos. Comparar ciclos distintos que exigem recursão falha explicitamente. Também não há separadores `_` em literais, identificadores Unicode, tabulações como indentação, múltiplos comandos separados por `;` ou blocos na mesma linha.

Esses casos recebem diagnóstico, não uma tradução silenciosa com outras regras. Aridade e nomes chamáveis são verificados em execução. Para comparar intervalos, use expressões explícitas com `and` quando os operandos não tenham efeitos de avaliação duplicados.

`print` não aceita os parâmetros `sep`, `end`, `file` ou `flush`. Não há efeitos em arquivos, rede, relógio ou aleatoriedade. Operações entre tipos sem uma regra implementada falham de forma reversível.

## Limites e validação

- Código: **1.000.000 de caracteres**, compartilhado com editor e importação. É um limite de texto, não de quantidade de passos.
- Sintaxe: até 128 níveis de aninhamento ou cadeia de condicionais.
- Histórico: 20.000 passos e 256 frames por padrão. Chegar ao limite de histórico preserva a navegação dos registros existentes.
- Armazenamento: [64 MiB de payload por sessão](storage-budget.md) por padrão, ajustável. Falta de orçamento pausa o debugger antes de gravar a próxima instrução, sem erro do programa ou descarte de passos.
- Heap: 4.096 listas e 20.000 itens totais entre elas. Objetos sem referências permanecem até desfazer a criação ou reiniciar; ainda não há coleta de lixo.
- Saída: 100.000 caracteres por chamada de `print`, incluindo espaços/quebra de linha. Excesso falha atomicamente, sem truncar a saída.
- Literais inteiros: até 4.300 dígitos; inteiros calculados: até 100.000 bits. Potências excessivas são rejeitadas antes de alocar um inteiro enorme.
- Conversões de inteiros em floats exigem que o inteiro caiba no intervalo float suportado. Casos com operandos gigantes que exigiriam uma conversão especializada do CPython são diagnosticados, inclusive certas divisões entre inteiros gigantes.

Os testes comparam resultados conhecidos, valores/tipos com o Python instalado e todos os campos da máquina ao desfazer/reaplicar. Uma suite adicional gera sequências de navegação de programas Python. A comparação nativa é opcional nos ambientes sem `python3`; os demais testes continuam independentes desse executável.

O código é virtualizado na tela: apenas linhas próximas ao viewport são renderizadas. O parser ainda compila o programa completo em memória. Execução e retrocesso em lotes devolvem o controle ao navegador; não há promessa de custo constante para compilar todo arquivo de 1 milhão de caracteres.
