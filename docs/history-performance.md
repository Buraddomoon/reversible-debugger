# Checkpoints: medidas e escolhas

O histórico combina deltas em todos os passos com checkpoints ocasionais. O intervalo inicial escolhido foi **128 passos**, com **128 checkpoints no máximo**, incluindo o estado inicial. A configuração pode mudar pelo construtor de `DebugSession`.

As medidas abaixo são do marco inicial de checkpoints, antes de heap/orçamento. A política atual também aplica [64 MiB de payload por sessão](storage-budget.md) por padrão, podendo reduzir cópias auxiliares para preservar deltas. Consulte o benchmark desse marco para o custo de saltos com orçamento apertado.

## Reproduzir

```bash
npm run bench:history
# Opcional: guardar os resultados em um arquivo do projeto.
npm run bench:history -- --output .artifacts/history-benchmark.json
```

O script usa as dependências já instaladas, sem abrir portas, baixar browsers ou alterar ferramentas do sistema. [Resultados completos desta execução](history-benchmark.json): Node 24.18.0, Linux, seed 20261009, 200 destinos por cenário. Cada busca é comparada com o estado completo da referência. Vinte buscas aquecem o caminho antes da medição; o cronômetro da busca exclui asserts e cópias usadas na comparação.

Os bytes abaixo são o tamanho UTF-8 de payloads JSON com tags para `bigint`, `-0` e valores não finitos. **Não são uma medida de heap JavaScript.** Os snapshots de referência incluem apenas estados; os deltas incluem descrição, span, opcode e valores antes/depois. O código compilado e a projeção de eventos da UI não entram nessa conta. A referência mantém também os deltas durante a gravação, por isso `snapshotRecordMs` mede execução, deltas e cópias completas por passo.

## Resultados observados

| Programa | Passos | Snapshots por passo | Deltas | Checkpoints (início em 128) | Busca p95: deltas / checkpoints |
|---|---:|---:|---:|---:|---:|
| Loop, 2 locais | 2.609 | 628.007 B | 1.012.924 B | 5.115 B | 0,378 / 0,018 ms |
| Loop, 252 locais | 3.109 | 17.929.825 B | 1.243.469 B | 141.605 B | 0,547 / 0,047 ms |
| Loop longo, 2 locais | 19.509 | 4.760.034 B | 7.625.416 B | 19.306 B | 1,938 / 0,033 ms |
| Fatorial(25) + print | 304 | 478.396 B | 127.684 B | 4.306 B | 0,082 / 0,046 ms |

No caso de 252 locais, deltas + checkpoints somaram **1.385.074 B**, contra 17.929.825 B da referência de snapshots. A busca copiou um checkpoint e reaplicou no máximo 64 transações nos destinos medidos; o modo de deltas chegou a 2.903. Copiar diretamente o snapshot de cada destino teve p95 de 0,033 ms nesse cenário, ao custo de guardar todos os estados.

Com apenas dois locais, snapshots têm menos bytes porque cada estado é muito pequeno e cada delta contém metadados. A estratégia evita copiar a memória inteira a cada passo e reduz buscas distantes, mas não promete deltas menores em todos os programas.

## Por que 128

| Intervalo inicial, 252 locais | Checkpoints retidos | Bytes de checkpoints | Busca p95 | Máximo de deltas na busca |
|---|---:|---:|---:|---:|
| 64 | 49 | 279.967 B | 0,040 ms | 32 |
| 128 | 25 | 141.605 B | 0,047 ms | 64 |
| 256 | 13 | 72.440 B | 0,048 ms | 128 |

128 reduz aproximadamente pela metade as cópias retidas em relação a 64, mantendo buscas curtas nesses cenários. 256 também é uma opção viável; a decisão é configurável, não uma garantia universal de desempenho. Na execução longa, as configurações 64 e 128 chegaram ao teto e aumentaram o intervalo para 256: os três casos terminaram com os mesmos 77 checkpoints e no máximo 127 deltas por busca medida.

Os tempos variam com JIT, coleta de lixo, hardware e conteúdo dos frames. Uma execução isolada serve para orientar a escolha inicial; não é um limite de latência nem um teste de regressão de desempenho. No marco original, somente a quantidade de checkpoints era limitada. O orçamento por payload já foi implementado; navegação cancelável, histórico persistente e compressão continuam como evoluções possíveis.
