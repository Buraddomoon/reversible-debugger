# Arquitetura

## Decisões da primeira entrega

**Stack:** TypeScript estrito em todo o projeto; React + Vite para a interface; Vitest + fast-check para o núcleo. Playwright define a matriz de Firefox, Chromium, WebKit e layout móvel. Um smoke test adicional usa o Firefox existente por WebDriver BiDi, sem downloads nem instalação de driver.

**Pipeline:** fonte → tokens → AST → instruções com spans → máquina virtual → histórico reversível → interface. O núcleo é independente da interface. Não há backend, rede ou dependência de relógio na linguagem. A biblioteca de execuções persiste capturas em IndexedDB, com datas usadas somente para catálogo/recuperação, fora do estado da VM.

**Runtimes:** a sessão guarda uma seleção imutável de linguagem e versão. `runtime.ts` valida o catálogo: Python 3 usa `python.ts` e `python-values.ts`; Experimental 0.1 usa o parser original. Ambos produzem o AST compartilhado. Os detalhes da semântica Python, seu escopo e limitações estão em [Python 3](python.md). Runtimes inexistentes são rejeitados, sem fallback para outro parser.

**Granularidade:** cada registro continua representando uma instrução da VM. Os controles por comando agrupam a navegação sem substituir esses registros. A posição apresentada corresponde à próxima instrução; em uma pausa por comando ou breakpoint, o destaque usa o cabeçalho do comando. Em um erro, identifica a instrução que falhou. Repetições da mesma linha são esperadas.

## Por que usar uma máquina virtual

Um interpretador que percorre o AST usando chamadas recursivas do JavaScript esconderia parte do estado em sua própria pilha de execução. Retroceder através de um retorno exigiria reconstruir essa continuação. Instruções pequenas deixam posição, pilhas, ponto de retorno e valores temporários explícitos e serializáveis.

O compilador é deliberadamente simples: `PUSH`, `LOAD`, `DECLARE`, `STORE`, `BINARY`, `UNARY`, `POP`, `JUMP`, `JUMP_IF_FALSE`, `CALL`, `RETURN`, `HALT`. Cada instrução preserva o trecho do código que a originou. O programa compilado permanece congelado durante a sessão.

Python acrescenta `SET` (atribuição no frame atual), `DEFINE` (binding de função) e `DUP` (curto-circuito). `LOAD` pode ter escopo local/global explícito, calculado a partir de todas as atribuições da função Python. Uma chamada avalia o callee antes dos argumentos e `CALL` consome essa referência da pilha. Os builtins implementados usam o mesmo fluxo de chamadas e registram a saída capturada por `print` como delta. Expressões são compiladas com uma pilha de trabalho explícita, permitindo expressões longas sem recursão do JavaScript no compilador.

## Estado completo da execução

Listas acrescentam `BUILD_LIST`, `LIST_GET`, `LIST_SET`, `CHECK_LIST` e `LIST_APPEND`. `CHECK_LIST` valida o receptor antes do argumento de append. A escrita por índice compila RHS, alvo e índice nessa ordem.

```ts
interface MachineState {
  control: {
    pc: number;
    status: 'running' | 'halted' | 'error';
    error: string | null;
    nextFrameId: number;
    nextObjectId: number;
    heapItems: number;
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
  heap: Record<number, { kind: 'list'; items: Value[] }>;
}

type Value = number | bigint | boolean | null
  | { readonly kind: 'function' | 'builtin'; readonly name: string }
  | { readonly kind: 'list'; readonly id: number };
```

O frame 0 guarda as variáveis globais. Cada chamada cria um frame com parâmetros, locais e endereço de retorno. `operandBase` separa seus temporários dos operandos que o chamador já tinha preparado, como o `n` de `n * factorial(n - 1)`.

`nextFrameId` integra o estado reversível: desfazer uma chamada restaura também o próximo identificador. Identificadores e variáveis chamados `constructor` ou `__proto__` não são confundidos com propriedades herdadas de objetos JavaScript.

`nextObjectId` e `heapItems` também são reversíveis. Listas são referências por ID, presentes em bindings, parâmetros, retornos, operandos e itens de outras listas. O heap contém cada objeto uma única vez; ciclos não são objetos JavaScript recursivos. Desfazer uma alocação remove o objeto e restaura o contador. Não há coleta de lixo: objetos sem referências permanecem até desfazer sua criação ou reiniciar.

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
| Alocação de heap | ID e conteúdo inicial do objeto criado |
| Mutação de heap | ID, índice e itens removidos/adicionados |

`applyStep(state, step, 'forward')` aplica a lista em ordem. A direção contrária aplica as inversas em ordem reversa. Distinguir variável ausente de variável com valor é essencial: a inversa de uma declaração precisa remover o binding.

Frames guardados no histórico são cópias dos frames **alterados**, nunca referências mutáveis ao frame ativo. O payload de cada passo é congelado, inclusive seus arrays e objetos. Um retorno guarda o frame removido para permitir restaurar seus locais. Isso copia aquele frame, sem copiar todos os demais frames e variáveis da máquina. Inteiros `bigint`, funções e referências de lista são preservados exatamente; o histórico não usa JSON como formato de cópia. O codec portável codifica `bigint` explicitamente.

Alocação copia somente a lista nova. Escrita/append guardam somente o item afetado; `applyChange` muta o objeto identificado, mantendo todos os aliases. Clonar/restaurar um checkpoint copia o heap completo ocasionalmente, preservando as referências numéricas. [Semântica, testes e medidas](reversible-lists.md).

Se uma instrução falha após remover operandos, a transação desfaz suas mudanças parciais e registra apenas a passagem do controle para erro. Voltar remove o erro e restaura o estado anterior; reaplicar reproduz o mesmo erro registrado.

## Navegação

- No fim do histórico, avançar executa uma instrução e grava um novo delta.
- Antes do fim, avançar aplica o delta já existente; não reavalia a instrução.
- Voltar aplica a inversa do passo anterior.
- `seek(cursor)` restaura um estado já registrado, escolhendo entre aplicar deltas a partir do estado atual e copiar o checkpoint mais próximo. O replay pode avançar ou retroceder a partir desse checkpoint, sem executar novamente o código.
- O cursor 0 representa o estado inicial. O cursor N representa o estado após aplicar N transações. Buscar posições negativas, fracionárias ou ainda não registradas é rejeitado antes de qualquer alteração.
- **Retroceder tudo** desfaz todos os passos em lotes, preservando o histórico para replay, inclusive saída e definições de funções.
- **Reiniciar programa** cria o estado inicial e um histórico vazio, mantendo o mesmo programa compilado e seu código.
- Aplicar código editado ou trocar exemplo cria uma sessão nova. Não há edição de variáveis durante replay nem ramificação de histórico na versão inicial.

Uma sessão é definida por seu código imutável, estado inicial, transações e cursor. O código e as regras atuais da linguagem produzem execução determinística. A futura introdução de entrada, aleatoriedade ou efeitos externos exigirá modelar e registrar essas entradas explicitamente.

## Breakpoints e controle por comando

`beginSeek`/`seekBatch`/`cancelSeek` são a navegação cooperativa: IDs por pedido, deltas completos por lote e último cursor válido preservado ao cancelar. A UI usa `useHistorySeek`, um timer por pedido e até 128 transações/alvo de 6 ms por lote; o range mantém destino solicitado distinto do cursor atual. Ações manuais/reinício/troca de sessão invalidam pedidos antigos. `seekAsync` usa AbortSignal/progresso/yield e também restaura o cursor final de importações, antes da publicação. `seek` continua síncrono por compatibilidade. Cópias/transações individuais são indivisíveis; o alvo de tempo não é uma garantia de tempo real. [Contrato e testes](cancellable-navigation.md).

`Program.locations[pc]` descreve o comando que originou uma instrução: ID estático, span, início do comando e tipo. `Program.breakableLines` lista os cabeçalhos executáveis. Esses metadados são congelados junto com o programa e não integram os deltas. Saltos internos de fluxo e `HALT` não têm entrada de comando. O retorno implícito tem uma entrada sintética para permitir observar uma função vazia, mas não cria uma linha elegível para breakpoint.

Um loop volta à mesma entrada estática em ocorrências diferentes do histórico. Dois comandos na mesma linha possuem IDs diferentes; uma expressão multilinha pertence ao cabeçalho do comando, não a cada linha dos operandos. Essa identificação evita depender de uma mudança no número da linha para detectar o próximo passo.

`ExecutionControl` guarda breakpoints, plano em andamento e motivo de parada **fora de `MachineState`**. Ele utiliza somente `forward()` e `backward()` da sessão. Continuar para frente testa breakpoints antes da execução; retomar uma pausa ignora apenas o cursor atual. Continuar para trás desfaz pelo menos uma transação e procura uma entrada anterior. Assim, nenhum sentido modifica o programa ou fabrica registros de execução.

Entrar para na próxima entrada ou mudança do frame ativo. Passar sobre ignora entradas de frames chamados e para na próxima entrada do frame original, ou imediatamente após seu retorno. Sair espera a remoção do ID do frame original, mesmo durante recursão. Breakpoints podem interromper qualquer uma dessas ações. Voltar comando percorre o histórico até a entrada anterior, incluindo retornos implícitos. [O contrato completo](breakpoints-stepping.md) detalha os casos de chamadas dentro de expressões e comandos compostos.

Os planos sobrevivem entre lotes limitados a 1.000 transações. A UI usa 256 para ações por comando e mantém os lotes de 1/4 instruções na reprodução, devolvendo o controle ao navegador entre lotes. Pausa, passos manuais, busca na linha do tempo e reinício cancelam o plano antes de alterar a navegação. O controle deve ser cancelado também por consumidores do núcleo que naveguem diretamente na sessão.

Reiniciar conserva os breakpoints e a opção de ativação do mesmo controlador. Trocar de programa, aplicar código ou recarregar cria outro controlador; breakpoints não são persistidos na biblioteca de scripts. O painel de mudanças informa a quantidade de instruções de uma ação agrupada e identifica a última instrução, sem apresentá-la como explicação de todas as alterações atravessadas.

## Comparação entre execuções

`ExecutionComparison` cria duas sessões próprias a partir de fontes imutáveis ou gravações importadas. Para uma gravação, faz fork dos payloads congelados e navega somente pelos registros existentes; para uma fonte comum, registra uma execução nova. A execução principal da interface é pausada e permanece com seu estado, cursor e histórico. Identidades guardam o código completo, runtime e uma cópia congelada do estado inicial. Um fingerprint curto rotula a identidade; ele não é usado como prova de igualdade nem como chave do alinhamento.

O compilador acrescenta `semanticKey` e `flowDecision` aos metadados de comandos. A chave combina escopo, caminho do bloco, tipo/alvo do comando e sua ocorrência entre comandos semelhantes. Condições consideram os nomes lidos/chamados, preservando a correspondência ao trocar `<` por `<=`. Espaços, comentários e números físicos de linha não fazem parte da chave. `flowDecision` distingue a decisão de `if`/`while` dos saltos internos de curto-circuito.

`RecordedComparisonRun` projeta pontos dos deltas de atribuição, decisão de fluxo, chamada, retorno, saída e término. Cada ponto guarda cursor, âncora, fase e ocorrência; não contém cópia da VM. Contextos de chamada são internados por contexto pai, âncora/posição da chamada, nome da função e ocorrência. Isso permite comparar frames correspondentes mesmo quando uma chamada extra deslocou seus IDs reais. Recursão preserva contextos distintos sem duplicar a pilha inteira em cada ponto.

`alignComparison` encontra chaves comuns e mantém uma subsequência crescente de posições da segunda execução, usando busca binária. O custo é O(P log P) em tempo e O(P) em espaço para P pontos, sem matriz quadrática. Eventos que ficam entre âncoras são apresentados em apenas um lado; o outro permanece em seu último ponto representado. Essa ordem não inventa simultaneidade entre eventos exclusivos. O algoritmo pode reencontrar o mesmo retorno após uma iteração adicional.

Início e término são âncoras globais comuns; término pode corresponder a conclusão, erro, limite ou fim de uma gravação parcial. Os motivos permanecem distintos nos dados do ponto e na comparação.

Os estados são restaurados em lotes para analisar cada par. VMs privadas compartilham somente payloads congelados e começam de uma cópia próxima dos destinos; ambos os estados e o ponto são publicados juntos. Cancelar uma navegação descarta essas VMs, preservando o par anterior. A análise usa essa mesma preparação e devolve controle por contagem/tempo. São comparados resultado das decisões, controle de término/erro, pilha por contexto de chamada, bindings presentes/ausentes em frames correspondentes, valores/tipos, operandos e saída. PC, endereços de retorno e contador de alocação não são comparados como valores entre fontes diferentes; a restauração de cada sessão continua incluindo esses campos exatamente. A análise guarda somente a contagem de diferenças e o índice da primeira. Detalhes são calculados no ponto selecionado.

Gravação e análise devolvem o controle entre lotes; a UI usa 256 operações para gravar e 32 pontos para analisar. Cancelar, trocar a segunda fonte ou sair encerra a preparação. Ao atingir o limite de histórico, há um ponto de limite com estado da VM ainda válido, sem fabricar um erro de execução. A UI identifica gravações incompletas e mostra o resultado na parada.

O alinhamento é uma heurística estrutural, não uma prova de equivalência entre programas arbitrários. Inserir comandos de outro tipo/alvo não renumera comandos existentes, mas inserir um comando repetido do mesmo tipo/alvo no mesmo bloco pode mudar sua ocorrência. Renomear variáveis/funções ou reorganizar blocos pode produzir eventos exclusivos. A comparação atual requer o mesmo runtime e observa os pontos projetados, sem analisar diferenças transitórias de cada operação matemática. [O contrato](execution-comparison.md) explicita esses limites.

## Custo e evolução

Alocações/mutações de listas também projetam pontos de comparação. `compareHeapRoots` constrói uma correspondência bijetiva de IDs a partir dos bindings/operandos correspondentes: compara conteúdo, ciclos e compartilhamento, ignorando diferenças nos números de alocação e objetos inalcançáveis. Pares são percorridos uma vez; divergências propagam pelos pais, inclusive ciclos. Ao haver conflito de aliases, os detalhes mostram o conflito e os pares já associados, sem prometer correspondência adicional para cada item.

O histórico ocupa espaço proporcional à soma dos payloads alterados, mais os metadados constantes de cada passo. Uma atribuição preserva seu binding e os operandos usados; seu tamanho não depende de quantas outras variáveis existem. Chamadas e retornos podem ter custo proporcional ao tamanho do frame afetado. A versão inicial não promete memória constante: o histórico continua crescendo e possui um limite explícito.

`HistoryStore` separa armazenamento e execução. `CheckpointHistory` guarda os deltas congelados e cópias completas **esparsas**, feitas com `structuredClone`. Restaurar também produz uma cópia: continuar uma execução nunca altera o checkpoint salvo. Isso preserva `bigint`, `-0`, infinitos e `NaN`, além de frames, IDs, retornos, temporários, bindings ausentes, controle e saída. `encodedBytes` serve apenas para medir payload; o codec portável é uma implementação separada com validação.

O padrão é um checkpoint a cada 128 instruções, com teto de 128 checkpoints incluindo o inicial. Antes de ultrapassar esse teto, o intervalo dobra e checkpoints intermediários são removidos uniformemente. O inicial permanece; nenhum delta é descartado. Assim, estados antigos continuam acessíveis, com um custo maior de replay conforme aumenta o espaçamento. `restart()` limpa registros e checkpoints e recupera o intervalo configurado inicialmente. O limite de passos da sessão continua independente.

`seek()` compara a distância do cursor atual e do checkpoint mais próximo. Empates favorecem o estado atual para evitar a cópia. Essa heurística minimiza a quantidade de transações, sem estimar o custo de clonar frames grandes; o benchmark também mede a latência desse custo. `SeekResult` informa origem, destino, checkpoint utilizado e número de transações reaplicadas. `historyStats` e `measureHistory()` permitem inspecionar a retenção sem expor os estados salvos.

O teto de checkpoints limita a quantidade de cópias. O orçamento adicional de payload é 64 MiB por sessão por padrão, ajustável até 256 MiB. [As medições](history-performance.md) mostram o ganho com muitos locais e também o caso em que snapshots minúsculos ocupam menos bytes que os deltas ricos em metadados. Snapshots por passo permanecem uma referência nos testes e no benchmark.

`storage-accounting.ts` conta a VM incrementalmente pelos deltas (controle, bindings/frames, operandos, heap e saída), sem varrer o estado todo a cada instrução. Só inicialização/restauração de checkpoint fazem medição completa. `storageStats` soma deltas, cópias retidas e uma reserva para o maior estado observado, impedindo que voltar libere orçamento necessário ao futuro gravado. Bytes usam um modelo de payload UTF-8 com delimitadores conservadores; não medem RAM/overhead de JavaScript, código, índices, UI, temporários ou outras sessões.

`CheckpointHistory.append` planeja a admissão atomicamente: preserva o checkpoint inicial e todos os deltas; reduz cópias auxiliares se necessário e só cria outra se couber. Se o mínimo não cabe, lança `HistoryBudgetError` antes de alterar o armazenamento. `DebugSession` desfaz a instrução candidata e mantém estado/cursor/contadores anteriores; `recordingStop` é política do debugger fora da VM. `ExecutionControl` sinaliza parada `budget`, preservando o intervalo efetivamente aplicado. Replay não faz admissão nova; aumentar o limite permite continuar da fronteira, e reiniciar limpa métricas/pausa conservando o limite. [Contrato e custo dos saltos sem checkpoints](storage-budget.md).

A VM suporta estados serializados pelo codec portável. Um Worker local valida arquivos e envia deltas em lotes para a UI; execução normal e navegação continuam em lotes no núcleo existente. Não se usa `eval` nem `Function` para executar a linguagem.

## Garantias verificadas

Para cada passo válido `T`, os testes exigem:

```text
undo(apply(S, T), T) = S
apply(undo(S', T), T) = S'
```

A igualdade inclui todos os campos internos. Os testes percorrem os estados de programas conhecidos, desfazem todos os passos e reaplicam todos; sequências arbitrárias de navegação são comparadas com o estado de referência de cada cursor. Resultados conhecidos são verificados separadamente.

Testes adicionais saltam a cada cursor a partir das duas pontas, misturam saltos e passos em sessões parcialmente registradas, continuam gravando após restaurar checkpoints e forçam o teto de retenção. Uma spy exige que saltar não chame `executeInstruction`. Recursão, valores especiais, saída e erros são comparados com snapshots independentes.

Os testes de `ExecutionControl` verificam motivos e posições de parada, loops vazios, comandos na mesma linha, cabeçalhos multilinha, recursão, temporários no chamador, saída, erros e limites. Sequências geradas de ações nos dois runtimes são comparadas com todo o estado da referência de cada cursor. Uma spy também exige que os controles não reexecutem código durante replay.

Os testes da comparação identificam a quinta decisão divergente, iterações extras e retornos com cursores diferentes. Verificam deslocamentos de linhas e bytecode, IDs de frames após chamadas adicionais, recursão, curto-circuito, ausência de bindings, `bigint`, `-0`, tipos numéricos, `NaN`, saída, erros e limites. Todos os estados de cada ponto, incluindo os exclusivos, são comparados com referências completas nos dois sentidos; saltos gerados também são verificados. Navegar depois da preparação não chama `executeInstruction` nem cria novos registros.

## Arquivos grandes e interface

O limite de fonte é compartilhado entre os dois parsers, editor e importação: 1 milhão de caracteres. A importação lê um arquivo local como texto; `.py` e `.rw` selecionam o runtime e `.txt` preserva a seleção feita pelo usuário. Falhas de leitura, tamanho ou compilação preservam o rascunho e a sessão atual.

`SourceView` mantém as linhas do código em memória, mas monta no DOM apenas as linhas visíveis e uma margem pequena. O cursor pode navegar até uma linha fora do viewport sem renderizar todas as anteriores. Um `ResizeObserver` ajusta a medida das linhas em mudanças de viewport. **Retroceder tudo** usa `backwardBatch(500)` entre retornos ao loop de eventos, preservando as mesmas transações e o estado exato obtido por retrocesso individual.

`Timeline` projeta os eventos a partir das transações registradas, sem um segundo histórico de execução. Seu range vai de 0 ao último estado registrado; não tenta prever o futuro do programa. Eventos apontam para o estado após a transação, inclusive a passagem para erro. O painel de código continua destacando a próxima instrução. Após um salto, o painel de mudanças informa que o estado foi restaurado; ele não apresenta uma única transação como explicação de todas as mudanças atravessadas.

O DOM da linha do tempo é limitado a oito cartões próximos do cursor e até 96 marcadores agregados. Os botões anterior/próximo percorrem todos os eventos registrados, inclusive os que não estão na janela visível. O range nativo oferece teclado e identificação acessível do passo; o campo numérico permite escolher um destino exato. A interface pausa a reprodução ao navegar e desabilita a busca durante edição ou retrocesso em lotes.

## Explicações e projeções

`explanations.ts` lê os deltas sem executar instruções ou expressões. Operações usam valores removidos/adicionados da pilha; decisões seguem splices para identificar o produtor da condição; leituras reconstruem somente presença de bindings e nomes de frames. Chamadas/retornos usam os payloads imutáveis dos frames. A direção muda a ação descrita, preservando operandos e resultados originais. Resumos de intervalos agregam escritas por ID de frame/variável na ordem da navegação e distinguem escopos encerrados dos atuais.

`ExplanationPanel` apresenta essas evidências. Selecionar um registro num intervalo mantém o estado no cursor final. Animações CSS respeitam movimento reduzido e não comandam a VM. Variáveis têm páginas de 24; atribuições, de 12. `HistoryEventIndex` evita reclassificar o histórico inteiro a cada lote; buscar o próximo evento usa busca binária, mantendo os limites de cartões/marcadores.

Explicações de heap mostram os itens gravados no delta, sem expandir o conteúdo atual de uma referência histórica. Decisões usam o caminho registrado no controle posterior; a lista pode ter mudado desde aquela condição. `HeapInspector` mostra o heap do cursor atual, com oito objetos, 16 itens e 12 referências por página, incluindo navegação entre listas. Linhas de código acima de 4.000 caracteres mantêm todo o texto em um único nó, evitando milhares de spans de sintaxe.

As [medidas e decisões de escala](visual-explanations.md) mantêm a execução em lotes nos limites atuais. O marco seguinte implementou o codec e as quotas de arquivos, usando um Worker para importações após medir seus custos. Retenção de sessões maiores em disco/heap continua exigindo uma política própria.

## Históricos portáveis

`portable-history.ts` define envelope v2 / `rewind-vm/2`, codec de valores, identidade SHA-256 de programa/arquivo e quotas. Referências de lista usam tags por ID; alocações/mutações e contadores são validados. Arquivos v1 recebem diagnóstico explícito para abrir na branch anterior; não são migrados. `trace-validation.ts` valida a cadeia de estados e a estrutura dos deltas em uma VM privada, sem avaliar expressões. Checkpoints e projeções são reconstruídos. A sessão só é publicada depois de validar todos os registros e restaurar o cursor do arquivo.

`DebugSession.replayOnly` impede gravar além de uma importação parcial. `restart()` cria uma execução gravável nova. `forkRecording()` compartilha programa e payloads congelados, copia os índices de armazenamento e mantém VM/cursor próprios, sem reprocessar a execução inteira. A comparação usa esse fork para consumir arquivos sem executar código de novo.

`history-import.worker.ts` recebe o JSON, verifica a gravação e envia blocos de até 256 registros com confirmação da UI. `import-history.ts` encerra o Worker no cancelamento e restaura sua sessão privada em lotes de até 256 ou aproximadamente 8 ms. Quotas: 32 MiB por arquivo e 8 históricos/64 MiB abertos; são bytes de arquivos, não heap. Recusa/cancelamento preservam a sessão principal. Históricos ficam na página e são reabertos por arquivo; não alteram `localStorage` dos scripts. [Contrato e medidas](portable-histories.md).

O Worker e a sessão privada de restauração recebem o orçamento de payload reservado ao iniciar a importação. A gravação inteira precisa caber antes da publicação, sem truncamento. O envelope v2 não armazena limite local nem motivo de pausa; sua semântica permanece igual. Comparações aplicam o limite por lado e identificam orçamento como gravação incompleta. Forks têm índices, contadores, limite e VM próprios; `page-budget.ts` cobra suas reservas novamente para proteger o orçamento agregado de payload da interface.

## Persistência em blocos

`history-blocks.ts` usa as tags do codec v2 para blocos versionados e manifestos com checksums. `execution-library.ts` mantém banco v1 com catálogo leve, manifestos e blocos por `[runId,index]`. Codificação/hash ficam fora de transações curtas; cada append verifica reservas entre abas. O status `ready` é publicado atomicamente com o manifesto, depois da cadeia completa. Recuperação só remove reservas `writing` expiradas; dados publicados não são excluídos automaticamente.

`execution-library.worker.ts` lê um bloco por vez e valida o programa/estado/transações em builder privado. Transferência de até 16 registros aguarda confirmação. `load-execution.ts` alimenta outro builder privado diretamente, encerra o Worker ao cancelar e publica somente depois de todos os registros e do cursor restaurado. Esse caminho integral agora é acionado por **Completo** ou materialização para edição/exportação/comparação; **Abrir** usa o viewer paginado descrito abaixo. Checkpoints do caminho integral são reconstruídos esparsamente, sem snapshots completos por passo.

`ExecutionLibraryPanel` oferece salvar com nome, lista paginada, abertura e exclusão confirmada. `page-budget.ts` reserva até 256 MiB de payload entre histórico retido, VM ativa e temporárias: duas na importação/materialização, quatro na comparação/navegação de pares, mais a reserva do viewer/espelho ao coexistirem. Biblioteca tem até 16 capturas/128 MiB, cada uma até 32 MiB; históricos completos abertos mantêm o teto de oito/64 MiB. Esses valores não medem RAM real nem ocupação física do IndexedDB. [Formato, recuperação e limites](persistent-histories.md).

## Navegação com deltas paginados

`PagedHistoryStore` tem estado publicado e staging de busca separados, cache LRU por bytes e índice compacto de eventos/checkpoints. `ExecutionLibrary.openRecording/readBlock` dão acesso validado ao manifesto e a um bloco, mantendo `load` integral para consumidores anteriores. A primeira indexação valida a cadeia num único estado mutável, descarta blocos anteriores e persiste checkpoints auxiliares. Reabrir usa checkpoint próximo e verifica somente os blocos necessários ao destino; ausência por despejo permite replay da origem. Corrupção é recusada.

`CheckpointCache` é um banco v1 separado, limitado a 64 MiB/16 indexações, com até 8 MiB de checkpoints e 8 MiB de índice por entrada. Tokens isolam indexações concorrentes; manifesto original identifica sua fonte. Publicação, quotas e recuperação são transacionais. Despejos afetam somente dados derivados, preservando gravações originais/scripts. Checkpoints decodificados também validam IDs, heap, frames, contadores e reserva.

`paged-history.worker.ts` controla a VM/cache e confirma destinos com a UI antes de publicar; cancelar a resposta preparada mantém o cursor anterior no Worker. `paged-client.ts` numeriza pedidos, descarta respostas antigas e envia ACK apenas para o destino aceito. `PagedDebugger` mostra estados, fonte, pilha, heap, explicações por instrução, cache e linha do tempo baseada em eventos. Materialização explícita mantém comparação/edição/exportação nos stores integrais, com orçamento/cancelamento. Nenhum limite de execução ampliado. [Contrato, diagnóstico e restrições](paged-history.md).

## Gravação contínua com journal

`LiveRecording` mantém uma VM na fronteira e outra no cursor observado, buffer de deltas congelados (128 passos/256 KiB), cache LRU e eventos compactos. Instruções novas são admitidas antes de publicar; navegação usa registros duráveis ou pendentes e nunca chama o executor. A escrita guarda somente o checkpoint da última fronteira por bloco, sem snapshots por passo.

`RecordingJournal` usa banco próprio v1 (`rewind.recording-journal`), fonte imutável e cadeia de selos SHA-256. Transações publicam bloco/cabeça/catálogo juntos; lease e revisão protegem o escritor entre abas. Falhas preservam prefixo durável e buffer volátil; resposta incerta é reconciliada sem duplicar. Retomada valida a cadeia em fluxo e compara seu estado final com o checkpoint antes de assumir o escritor.

`live-recording.worker.ts` serializa pedidos e exige confirmação antes do commit. Cancelamento anterior ao ACK abandona staging; posterior conclui o pedido aceito (execução em lotes de até 16). `PagedRecordingClient` transporta ambos os atores e materializa registros em lotes para edição/exportação/comparação. `RecordingSessionsPanel` separa sessões contínuas de scripts/capturas; `PagedDebugger` mostra a fronteira e pendências. Fechar/trocar pela UI tenta flush; reload abrupto recupera somente o prefixo salvo. Nenhum limite ampliado. [Contrato, quotas e demonstração](live-recording.md).

## Criação e biblioteca de scripts

`NewScriptModal` usa um `dialog` nativo para nome, linguagem e versão, com foco inicial, cancelamento por Escape e normalização da extensão. A criação registra um script vazio com ID estável e troca a sessão, sem carregar variáveis, saída ou histórico da sessão anterior. Nomes repetidos são rejeitados para não criar entradas ambíguas. `DeleteScriptModal` confirma a exclusão pelo nome.

`script-library.ts` descreve a biblioteca de scripts e seu formato versionado. `useScriptLibrary` salva nome, arquivo, fonte, runtime e seleção em `localStorage`, sob a chave exclusiva `rewind.script-library.v1`. Editar um exemplo só o transforma em script próprio ao aplicar; scripts criados são atualizados durante a edição. A gravação usa debounce de 250 ms e flush síncrono ao esconder ou sair da página, preservando a última edição mesmo em recarga imediata.

Essa biblioteca é separada da VM. Ao recarregar a página, o código selecionado é compilado novamente em uma sessão limpa. Se houver erro no rascunho salvo, o texto é mantido e aberto no editor; não é substituído por um exemplo ou por fonte vazia. Apenas o estado temporário da VM usa uma sessão vazia enquanto esse código é corrigido.

Falhas de leitura não sobrescrevem a chave existente; falhas de gravação deixam o código na página e mostram um erro. A exclusão remove um ID da biblioteca e seleciona outro script, ou o exemplo inicial quando a biblioteca fica vazia. Scripts usam IDs em vez de nomes de arquivo para evitar que uma importação sobrescreva outro registro. O editor tem uma chave por ID, cancelando leituras de arquivo pendentes quando o usuário troca de script.
