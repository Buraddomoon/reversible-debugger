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

## Próximo marco — linha do tempo e checkpoints

- Extrair a interface `HistoryStore` do armazenamento atual em array.
- Implementar checkpoints em intervalo configurável, preservando deltas.
- Implementar busca por cursor e testar equivalência com navegação sequencial em todas as posições.
- Medir memória e latência em programas com muitos passos e muitos locais, antes de escolher um intervalo padrão.
- Trocar o indicador do histórico por uma linha do tempo navegável, com eventos de chamada, retorno, decisão e erro.

Critério: buscar qualquer posição reproduz o mesmo estado completo; medir o efeito de checkpoints contra deltas sequenciais e snapshots por passo de referência.

## Breakpoints e passos por comando

- Associar breakpoints a spans/instruções e parar antes de executar a posição escolhida.
- Definir comportamento ao repetir uma linha em um loop, ao voltar e ao retomar exatamente no breakpoint.
- Agrupar instruções em passos por comando, mantendo eventos de chamadas dentro de expressões observáveis.
- Adicionar entrar, passar sobre e sair da função sobre o histórico existente.

Critério: navegação, agrupamento e breakpoints não alteram a execução da VM nem o resultado do replay.

## Comparação entre execuções

- Identificar sessões pelo código e pelo estado inicial.
- Comparar estados e mudanças de dois programas, começando pela soma incorreta/corrigida.
- Definir alinhamento semântico por posição de código e ocorrência de evento. Mesmo número de passo não implica mesma etapa lógica quando programas divergem.
- Evidenciar a primeira diferença relevante e permitir navegar pelas duas sessões.

## Explicações visuais e escala

- Usar os próprios deltas para explicar leituras, atribuições, decisões, chamadas e retornos.
- Animar mudanças com preferência por movimento reduzido respeitada.
- Acrescentar diagramas de expressões ou frames somente quando ajudarem a entender a execução.
- Mover execução e busca para Web Worker se os benchmarks indicarem necessidade.
- Considerar serialização/versionamento do histórico e política de retenção antes de permitir sessões grandes ou efeitos externos.

Cada marco preserva os testes de reversibilidade. Arrays, objetos e closures exigirão uma modelagem explícita de heap e identidades, e devem ser uma evolução própria da linguagem.
