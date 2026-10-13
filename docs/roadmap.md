# Etapas de implementação

## Primeira entrega — implementada

1. **Especificação:** semântica da linguagem, granularidade das instruções, estado explícito e contrato de transações.
2. **Execução:** lexer, parser, compilador e VM com variáveis, matemática, condicionais, loops e funções, incluindo recursão.
3. **Reversibilidade:** histórico de deltas, cursor, inversão, replay e erros atômicos. Testes de todo o estado e navegação gerada.
4. **Demo:** código destacado, avanço/retrocesso, reprodução/pausa, variáveis por frame, pilha, mudanças, resultado e edição. Cinco exemplos.
5. **Documentação e validação:** build estático, testes do núcleo e smoke test com o Firefox instalado. Fluxos Playwright preparados para Firefox, Chromium, WebKit e layout móvel; validação desses engines adicionais fica pendente de ambiente com browsers de teste disponíveis.

Critério de aceite: executar a soma incorreta, observar `10`, voltar através do resultado e retorno, restaurar a função com seus locais e avançar novamente com os mesmos estados. Também restaurar completamente a execução inicial e reproduzir até o mesmo resultado.

## Scripts próprios e Python — implementado

- Botão **Adicionar script**, colagem e importação de `.py`, `.rw` ou `.txt`.
- Seleção explícita de linguagem e versão; Python 3 e Experimental da demo 0.1 são os runtimes disponíveis.
- Parser e semântica para um subconjunto documentado de Python 3, com inteiros exatos, funções, recursão, escopos locais, `if/elif/else`, `while`, operações e curto-circuito.
- Saída de `print` registrada como delta reversível.
- Limite ampliado para 1 milhão de caracteres e visualização do código com renderização das linhas visíveis.
- **Retroceder tudo** em lotes, mantendo os registros para replay.
- Testes de reversibilidade de Python, comparação com o Python instalado e fluxo de importação/arquivos grandes no Firefox.

JavaScript fica como próximo adaptador de linguagem, seguindo a prioridade de Python definida para esta entrega. Versões novas só devem aparecer no seletor depois de existir um parser/runtime correspondente e testes da semântica.

## Modal e scripts preservados — implementado

- Criação em modal com nome, linguagem e versão; depois de **Criar**, o editor abre vazio em uma sessão limpa.
- Biblioteca compacta no seletor **Seus scripts**, com salvamento automático de código e metadados no navegador.
- Restauração da seleção e do código após recarregar, incluindo rascunhos com sintaxe incompleta.
- **Reiniciar programa** limpa apenas a execução, mantendo os scripts; **Retroceder tudo** continua preservando o histórico.
- **Excluir script** com confirmação e preservação dos outros registros, sem apagar os arquivos importados do computador.
- Fluxos verificados no Firefox instalado, com perfil isolado e sem downloads.

## Linha do tempo e checkpoints — implementado

- Interface `HistoryStore` e armazenamento de deltas com checkpoints congelados e isolados da VM.
- Intervalo inicial configurável de 128 passos e teto de 128 checkpoints; espaçamento dobra ao atingir o teto, preservando o início e todos os deltas.
- `seek(cursor)` restaura posições já registradas pelo caminho com menos transações: estado atual ou checkpoint próximo, aplicando deltas nos dois sentidos.
- Testes de todos os estados de exemplos, navegação gerada, erros, recursão, saída, valores especiais, continuidade e descarte dos checkpoints ao reiniciar.
- [Benchmark reproduzível](history-performance.md) com payloads e tempos de busca, comparando deltas, intervalos 64/128/256 e snapshots por passo de referência.
- Linha do tempo com controle deslizante, salto pelo número do passo, início/último estado, eventos de chamada, retorno, decisão, saída e erro, e navegação entre eventos.
- Interface mantém até oito cartões de eventos e marcadores agregados para não montar milhares de controles. Saltar pausa a execução; o destino representa o estado após aquele passo.

Critério atendido: buscar qualquer posição testada reproduz o mesmo estado completo da referência sequencial. Firefox instalado validou controles, teclado, chamadas, resultado, erro, saída, pausa ao navegar, reinício e layout móvel.

## Breakpoints e passos por comando — implementado

- Metadados imutáveis de comandos no compilador, separados dos spans de cada instrução. A VM e o formato dos deltas permanecem iguais.
- Breakpoints pelo número da linha, antes da primeira instrução do comando; retomada ignora somente a passagem atual e permite parar nas iterações seguintes.
- **Continuar para trás** busca ocorrências anteriores nos registros existentes, restaurando exatamente o mesmo estado anterior ao comando.
- **Entrar**, **Passar sobre**, **Sair da função** e **Voltar comando**, usando os mesmos deltas e IDs de frames para distinguir chamadas recursivas.
- Breakpoints internos interrompem passar sobre/sair. Chamadas e retornos dentro de expressões continuam observáveis ao entrar.
- Controle de execução em lotes, fora da VM, com pausa/cancelamento e tratamento dos limites existentes.
- Lista compacta, remoção e desativação dos breakpoints; reiniciar o programa preserva os pontos da sessão. Aplicar código ou trocar programa cria uma configuração nova.
- [Regras e API documentadas](breakpoints-stepping.md), testes de estados completos, navegação gerada nos dois runtimes e fluxo verificado no Firefox, inclusive em 390 px.

Critério atendido: as paradas e o agrupamento correspondem aos estados da referência sequencial, e replay com controles não chama o executor nem cria registros duplicados.

## Comparação entre execuções — implementado

- Duas execuções isoladas, identificadas por fonte, runtime e estado inicial, preservando a sessão principal e os scripts.
- Comparação dos exemplos e dos scripts salvos da mesma linguagem/versão, começando pela soma incorreta/corrigida.
- Âncoras de comandos por escopo, bloco, tipo/alvo e ocorrência, com contextos de chamada internados para distinguir recursão e chamadas repetidas.
- Alinhamento monotônico de atribuições, decisões, chamadas, retornos, saída e términos; eventos exclusivos ficam explícitos e retornos comuns são reencontrados depois de iterações extras.
- Primeira divergência da soma na quinta decisão: `False` versus `True`, enquanto `i = 5` e `total = 10` ainda coincidem.
- Navegação nos dois sentidos, controle deslizante, primeira/próxima diferença, código e estados lado a lado, escopos selecionáveis e tabelas paginadas.
- Preparação e análise em lotes canceláveis, tratamento de sintaxe inválida e limites de gravação sem perder o replay.
- [Contrato, critérios de comparação e limites do alinhamento](execution-comparison.md) documentados; snapshots de referência comprovam restauração de todos os campos em cada ponto.

Critério atendido: a comparação evidencia a decisão divergente e os resultados 10/15; retornos correspondentes podem ter cursores diferentes. Navegar restaura exatamente cada estado registrado sem executar código de novo. Firefox validou exemplos, scripts salvos, saída, cancelamento, erros de sintaxe, teclado, layout móvel e preservação da sessão principal.

## Explicações visuais e escala — implementado

- Projeções dos deltas para leituras, atribuições, operações, decisões, chamadas, retornos, saída e erros; nenhuma reexecução para explicar.
- Diagramas com valores efetivamente registrados e ações corretas ao desfazer, inclusive frame restaurado e operandos originais recuperados.
- Intervalos por comando com atribuições agregadas por frame/variável e seleção de registro sem mover o cursor.
- Animações CSS desativadas por movimento reduzido, verificadas em dois modos no Firefox isolado.
- Variáveis e atribuições paginadas, índice incremental de eventos e busca binária na linha do tempo.
- [Benchmark e critérios de escala](visual-explanations.md): cerca de 18–19 mil passos, 2.502 locais, testes de restauração, DOM limitado e navegação móvel. Worker adiado pelas medidas nos limites atuais.
- Proposta documentada de codec versionado, validação e retenção por bytes antes de permitir sessões maiores ou efeitos externos.

Critério atendido: observar `5 < 5 → False`, desfazer a decisão e a comparação, restaurar uma função com seus locais e reaplicar os mesmos registros. Explicar e selecionar instruções não altera o estado da VM. Núcleo e Firefox validaram essas garantias, movimento reduzido e navegação com milhares de variáveis.

## Próximo marco — históricos portáveis

- Codec versionado para valores e transações, preservando todos os tipos especiais.
- Exportação/importação de uma execução registrada, com identidade de fonte/runtime e validação de integridade/limites.
- Reabrir uma execução no mesmo cursor e comparar execuções salvas, mantendo a biblioteca de scripts separada.
- Testes de round trip, versões incompatíveis, arquivos corrompidos e replay sem execução.
- Medir orçamento de bytes e definir comportamento explícito ao atingir quota; aumentar limites somente depois desses critérios.

Cada marco preserva os testes de reversibilidade. Arrays, objetos e closures exigirão uma modelagem explícita de heap e identidades, e devem ser uma evolução própria da linguagem.
