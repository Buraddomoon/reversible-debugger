# Arquitetura

## Decisões da primeira entrega

**Stack:** TypeScript estrito em todo o projeto; React + Vite para a interface; Vitest + fast-check para o núcleo. Playwright define a matriz de Firefox, Chromium, WebKit e layout móvel. Um smoke test adicional usa o Firefox existente por WebDriver BiDi, sem downloads nem instalação de driver.

**Pipeline:** fonte → tokens → AST → instruções com spans → máquina virtual → histórico reversível → interface. O núcleo é independente da interface. Não há backend, persistência em disco de sessões, rede ou dependência de relógio na linguagem.

**Runtimes:** a sessão guarda uma seleção imutável de linguagem e versão. `runtime.ts` valida o catálogo: Python 3 usa `python.ts` e `python-values.ts`; Experimental 0.1 usa o parser original. Ambos produzem o AST compartilhado. Os detalhes da semântica Python, seu escopo e limitações estão em [Python 3](python.md). Runtimes inexistentes são rejeitados, sem fallback para outro parser.

**Granularidade:** um passo é uma instrução da VM. A posição apresentada corresponde à próxima instrução; a última mudança é apresentada separadamente. Em um erro, o destaque identifica a instrução que falhou. Repetições da mesma linha são esperadas. Um futuro modo por comando deverá agrupar várias transações, sem perder o histórico de instruções.

## Por que usar uma máquina virtual

Um interpretador que percorre o AST usando chamadas recursivas do JavaScript esconderia parte do estado em sua própria pilha de execução. Retroceder através de um retorno exigiria reconstruir essa continuação. Instruções pequenas deixam posição, pilhas, ponto de retorno e valores temporários explícitos e serializáveis.

O compilador é deliberadamente simples: `PUSH`, `LOAD`, `DECLARE`, `STORE`, `BINARY`, `UNARY`, `POP`, `JUMP`, `JUMP_IF_FALSE`, `CALL`, `RETURN`, `HALT`. Cada instrução preserva o trecho do código que a originou. O programa compilado permanece congelado durante a sessão.

Python acrescenta `SET` (atribuição no frame atual), `DEFINE` (binding de função) e `DUP` (curto-circuito). `LOAD` pode ter escopo local/global explícito, calculado a partir de todas as atribuições da função Python. Uma chamada avalia o callee antes dos argumentos e `CALL` consome essa referência da pilha. Os builtins implementados usam o mesmo fluxo de chamadas e registram a saída capturada por `print` como delta. Expressões são compiladas com uma pilha de trabalho explícita, permitindo expressões longas sem recursão do JavaScript no compilador.

## Estado completo da execução

```ts
interface MachineState {
  control: {
    pc: number;
    status: 'running' | 'halted' | 'error';
    error: string | null;
    nextFrameId: number;
  };
  frames: Array<{
    id: number;
    name: string;
    locals: Record<string, Value>;
    returnPc: number | null;
    operandBase: number;
  }>;
  operands: Value[];
  output: string[];
}

type Value = number | bigint | boolean | null
  | { readonly kind: 'function' | 'builtin'; readonly name: string };
```

O frame 0 guarda as variáveis globais. Cada chamada cria um frame com parâmetros, locais e endereço de retorno. `operandBase` separa seus temporários dos operandos que o chamador já tinha preparado, como o `n` de `n * factorial(n - 1)`.

`nextFrameId` integra o estado reversível: desfazer uma chamada restaura também o próximo identificador. Identificadores e variáveis chamados `constructor` ou `__proto__` não são confundidos com propriedades herdadas de objetos JavaScript.

A interface recebe uma visão tipada como somente leitura; apenas as operações do núcleo devem alterar o estado. Pausa, reprodução, seleção de frame e texto em edição são estado da interface, separado do estado do programa. O cursor é a quantidade de transações atualmente aplicadas.

## Transações e deltas

Uma instrução registra uma lista ordenada de mudanças:

| Delta | Informação preservada |
|---|---|
| Controle | Campos de controle antes e depois |
| Binding | Frame, nome e presença/valor antes e depois |
| Operandos | Índice, valores removidos e adicionados |
| Frames | Índice, frames removidos e adicionados |
| Saída | Índice, textos removidos e adicionados |

`applyStep(state, step, 'forward')` aplica a lista em ordem. A direção contrária aplica as inversas em ordem reversa. Distinguir variável ausente de variável com valor é essencial: a inversa de uma declaração precisa remover o binding.

Frames guardados no histórico são cópias dos frames **alterados**, nunca referências mutáveis ao frame ativo. O payload de cada passo é congelado, inclusive seus arrays e objetos. Um retorno guarda o frame removido para permitir restaurar seus locais. Isso copia aquele frame, sem copiar todos os demais frames e variáveis da máquina. Inteiros `bigint` e nomes de função são preservados exatamente; o histórico não usa JSON como formato de cópia. Uma futura serialização precisará codificar `bigint` explicitamente.

Se uma instrução falha após remover operandos, a transação desfaz suas mudanças parciais e registra apenas a passagem do controle para erro. Voltar remove o erro e restaura o estado anterior; reaplicar reproduz o mesmo erro registrado.

## Navegação

- No fim do histórico, avançar executa uma instrução e grava um novo delta.
- Antes do fim, avançar aplica o delta já existente; não reavalia a instrução.
- Voltar aplica a inversa do passo anterior.
- **Retroceder tudo** desfaz todos os passos em lotes, preservando o histórico para replay, inclusive saída e definições de funções.
- **Reiniciar programa** cria o estado inicial e um histórico vazio, mantendo o mesmo programa compilado e seu código.
- Aplicar código editado ou trocar exemplo cria uma sessão nova. Não há edição de variáveis durante replay nem ramificação de histórico na versão inicial.

Uma sessão é definida por seu código imutável, estado inicial, transações e cursor. O código e as regras atuais da linguagem produzem execução determinística. A futura introdução de entrada, aleatoriedade ou efeitos externos exigirá modelar e registrar essas entradas explicitamente.

## Custo e evolução

O histórico ocupa espaço proporcional à soma dos payloads alterados, mais os metadados constantes de cada passo. Uma atribuição preserva seu binding e os operandos usados; seu tamanho não depende de quantas outras variáveis existem. Chamadas e retornos podem ter custo proporcional ao tamanho do frame afetado. A versão inicial não promete memória constante: o histórico continua crescendo e possui um limite explícito.

O próximo estágio será um `HistoryStore` que combine deltas e checkpoints periódicos. Para buscar um cursor distante, restaura-se um checkpoint e aplicam-se deltas até a posição desejada. O intervalo será escolhido a partir de medidas de memória e tempo, mantendo o formato das transações como contrato estável. Snapshots por passo permanecerão uma implementação de referência nos testes.

A VM suporta estados que podem futuramente ser serializados e enviados por um Web Worker. Isso não é necessário para os exemplos iniciais: reprodução em lotes de até quatro instruções, limite de histórico e limite de frames mantêm a demo pequena. Não se usa `eval` nem `Function` para executar a linguagem.

## Garantias verificadas

Para cada passo válido `T`, os testes exigem:

```text
undo(apply(S, T), T) = S
apply(undo(S', T), T) = S'
```

A igualdade inclui todos os campos internos. Os testes percorrem os estados de programas conhecidos, desfazem todos os passos e reaplicam todos; sequências arbitrárias de navegação são comparadas com o estado de referência de cada cursor. Resultados conhecidos são verificados separadamente.

## Arquivos grandes e interface

O limite de fonte é compartilhado entre os dois parsers, editor e importação: 1 milhão de caracteres. A importação lê um arquivo local como texto; `.py` e `.rw` selecionam o runtime e `.txt` preserva a seleção feita pelo usuário. Falhas de leitura, tamanho ou compilação preservam o rascunho e a sessão atual.

`SourceView` mantém as linhas do código em memória, mas monta no DOM apenas as linhas visíveis e uma margem pequena. O cursor pode navegar até uma linha fora do viewport sem renderizar todas as anteriores. Um `ResizeObserver` ajusta a medida das linhas em mudanças de viewport. **Retroceder tudo** usa `backwardBatch(500)` entre retornos ao loop de eventos, preservando as mesmas transações e o estado exato obtido por retrocesso individual.

## Criação e biblioteca de scripts

`NewScriptModal` usa um `dialog` nativo para nome, linguagem e versão, com foco inicial, cancelamento por Escape e normalização da extensão. A criação registra um script vazio com ID estável e troca a sessão, sem carregar variáveis, saída ou histórico da sessão anterior. Nomes repetidos são rejeitados para não criar entradas ambíguas. `DeleteScriptModal` confirma a exclusão pelo nome.

`script-library.ts` descreve a biblioteca de scripts e seu formato versionado. `useScriptLibrary` salva nome, arquivo, fonte, runtime e seleção em `localStorage`, sob a chave exclusiva `rewind.script-library.v1`. Editar um exemplo só o transforma em script próprio ao aplicar; scripts criados são atualizados durante a edição. A gravação usa debounce de 250 ms e flush síncrono ao esconder ou sair da página, preservando a última edição mesmo em recarga imediata.

Essa biblioteca é separada da VM. Ao recarregar a página, o código selecionado é compilado novamente em uma sessão limpa. Se houver erro no rascunho salvo, o texto é mantido e aberto no editor; não é substituído por um exemplo ou por fonte vazia. Apenas o estado temporário da VM usa uma sessão vazia enquanto esse código é corrigido.

Falhas de leitura não sobrescrevem a chave existente; falhas de gravação deixam o código na página e mostram um erro. A exclusão remove um ID da biblioteca e seleciona outro script, ou o exemplo inicial quando a biblioteca fica vazia. Scripts usam IDs em vez de nomes de arquivo para evitar que uma importação sobrescreva outro registro. O editor tem uma chave por ID, cancelando leituras de arquivo pendentes quando o usuário troca de script.
