# Rewind

Debugger visual reversível implementado em TypeScript. Interpreta um subconjunto de **Python 3** e mantém os exemplos da linguagem experimental criada para a primeira demo. Permite navegar pela execução nos dois sentidos, observando variáveis, chamadas, instruções, saída e mudanças.

**Rewind é o nome do projeto.** A linguagem experimental dos arquivos `.rw` foi criada aqui; não é uma linguagem padrão. O suporte a Python tem parser e regras próprios, com limitações explícitas em [Python 3](docs/python.md).

![Demo no Firefox: script Python importado, resultado 42 e saída reversível de print](docs/demo.png)

## Rodar a demo

Requer um Node compatível com as dependências fixadas no lockfile. O projeto foi validado com **Node 24.18.0** e npm 11.16.0 já existentes nesta máquina. Nenhuma atualização global é necessária.

```bash
cd /home/IVPTER/codes/reversible-debugger
npm ci
npm run dev -- --port 5179 --strictPort
```

Abra <http://127.0.0.1:5179> no Firefox ou em outro navegador moderno. Se as dependências já estão instaladas, basta o último comando.

As dependências ficam em `node_modules/` e o cache em `.npm-cache/`, conforme `.npmrc`. Não há instalação global, fonte remota, backend ou serviço externo usado pela demo. Instalar dependências requer rede; executar a demo depois disso não requer acesso à internet.

## Experimentar

1. Mantenha o exemplo **Python · Soma com bug**.
2. Avance até `sum_to` entrar na pilha. A definição da função e a preparação do argumento também são passos.
3. Continue com **Avançar**, ou use **Executar** para reproduzir a execução.
4. O resultado é `10`, embora a soma inclusiva de 1 a 5 devesse ser `15`.
5. Volte através da atribuição de `result` e do retorno: o resultado desaparece e o frame de `sum_to` reaparece com suas variáveis.
6. Continue voltando até `i < n` comparar `5 < 5`. Avance novamente para reproduzir exatamente as mudanças registradas.
7. Escolha **Python · Soma corrigida** para executar `i <= n`, obtendo `15`.

**Retroceder tudo** desfaz os passos em lotes e restaura o estado inicial, inclusive saída, preservando o histórico para reaplicação. Trocar de exemplo ou aplicar código editado cria uma nova sessão. As teclas esquerda/direita navegam quando o foco não está em um controle de edição. Cada passo representa uma instrução da VM: uma linha do código pode exigir vários passos.

## Usar seu próprio script

1. Clique em **Adicionar script** para abrir um rascunho independente da execução atual.
2. Selecione **Python** e **Python 3**, ou a linguagem **Experimental da demo / 0.1** para arquivos `.rw`.
3. Cole o código ou use **Importar arquivo** para carregar `.py`, `.rw` ou `.txt`. Arquivos `.py` e `.rw` selecionam a linguagem correspondente automaticamente.
4. Confira o contador de caracteres e clique em **Aplicar código**. Erros preservam a sessão anterior e o rascunho para correção.
5. Use **Executar**, **Voltar** e **Retroceder tudo**. `print` aparece no painel **Saída** e também é desfeito ao retroceder.

O limite passou de 50.000 para **1.000.000 de caracteres**, tanto no editor quanto na importação e no núcleo. A tela renderiza apenas as linhas próximas ao trecho visível, inclusive quando o programa tem milhares de linhas. O seletor oferece apenas versões realmente implementadas: Python 3 e Experimental 0.1. JavaScript ainda não está implementado.

Outros exemplos: fatorial recursivo (`120`), algoritmo de Euclides (`6`) e divisão por zero. No último, voltar desfaz o erro e restaura os operandos da divisão.

## Estrutura

```text
src/core/language.ts   Lexer, parser, AST e posições no código
src/core/python.ts     Parser Python, indentação e posições originais
src/core/python-values.ts  Regras de valores e operações Python
src/core/runtime.ts    Linguagens, versões e apresentação dos valores
src/core/compiler.ts   Instruções, funções e metadados de origem
src/core/machine.ts    Estado explícito, transações e deltas
src/core/debugger.ts   Sessão, histórico, cursor e navegação
src/ui/               Interface React e estilos responsivos
examples/             Programas .rw usados pela demo e pelos testes
tests/core.test.ts    Semântica, reversibilidade e propriedades geradas
tests/browser/        Fluxos Playwright para múltiplos engines
scripts/              Teste com Firefox instalado e launcher Playwright
docs/                 Arquitetura, linguagem e etapas futuras
```

O núcleo não depende de React, DOM ou navegador. Ele também pode ser usado em Node:

```ts
import { DebugSession } from './src/core/debugger';

const session = new DebugSession('let result = 2 + 3;');
session.forward();
session.backward();
session.forward(); // Reaplica o registro existente.
console.log(session.state, session.cursor);
```

Para Python, informe o runtime:

```ts
const session = new DebugSession('result = 2 + 3\nprint(result)', {
  language: 'python',
  version: '3',
});
```

## Verificações

```bash
npm run check         # TypeScript + testes do núcleo
npm run build         # TypeScript + build estático em dist/
npm run test:firefox  # Firefox instalado, sem baixar outro navegador
```

`test:firefox` usa o executável `firefox` disponível no PATH. É possível escolher outro caminho com `FIREFOX_BIN`. Abre uma instância headless separada com `--no-remote` e perfil próprio em `.artifacts/`, usando WebDriver BiDi. Não usa o perfil pessoal, geckodriver ou um navegador fornecido pelo Playwright. O servidor e a instância de teste são encerrados ao final; screenshots e log ficam em `.artifacts/`. Se a porta local 5178 ou 9238 estiver ocupada, encerre o processo de teste conflitante; `REWIND_BIDI_PORT` permite escolher a segunda porta.

O ambiente precisa permitir executar o Firefox e abrir portas locais. O teste depende do protocolo disponível em versões recentes do Firefox. Referência: [conexão WebDriver BiDi na documentação da Mozilla](https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection).

Para ambientes que **já tenham os browsers de teste do Playwright** no diretório local `.playwright-browsers/`:

```bash
npm run test:e2e -- --project=firefox
npm run test:e2e -- --project=chromium
npm run test:e2e -- --project=webkit
npm run test:e2e -- --project=mobile-webkit
```

Esses comandos não baixam navegadores automaticamente. O Firefox comum instalado na máquina é usado por `test:firefox`; os projetos Playwright requerem seus próprios builds de teste. Nesta entrega, Chromium e WebKit estão configurados, mas não foram executados, para respeitar a preferência de não baixar browsers.

### O que os testes comprovam

- Resultados conhecidos, precedência, escopos lexicais, recursão e chamadas dentro de expressões.
- Estado completo igual após desfazer cada instrução e após reaplicá-la, inclusive temporários, identificadores e pontos de retorno.
- Erros atômicos e reversíveis; declarações removidas ao voltar; preservação de `-0`.
- Sequências geradas de navegação e programas de soma com limites e incrementos variados, com seeds reproduzíveis.
- Limites de histórico e chamadas sem perder a possibilidade de voltar.
- Deltas de atribuição cujo tamanho não acompanha a quantidade de outras variáveis.
- No Firefox: execução do bug, chamadas, retorno, reinício, replay, exemplo corrigido, erro reversível, edição, layout de 390 px sem overflow e ausência de erros no console.
- Python: inteiros exatos, divisão inteira e resto com sinais, precedência de potências, escopos locais, definição de funções em ordem e curto-circuito. Uma verificação opcional compara os valores/tipos com o Python instalado, sem instalar ou atualizar esse runtime.
- No Firefox: importação `.py`, linguagem/versão, execução e desfazimento de `print`, retrocesso completo, arquivo de 10.001 linhas e preservação do rascunho ao rejeitar um arquivo acima do limite.

Os snapshots completos existem **apenas nos testes como referência**. O histórico de produção armazena mudanças. Testes de ida e volta verificam reversibilidade; os testes com resultados conhecidos verificam a semântica, pois um interpretador incorreto também pode ser reversível.

## Documentação

- [Arquitetura e decisões](docs/architecture.md)
- [Especificação da linguagem](docs/language.md)
- [Python 3: recursos e limitações](docs/python.md)
- [Etapas e próximos marcos](docs/roadmap.md)

Limites atuais: 1.000.000 de caracteres, 128 níveis de aninhamento sintático, 20.000 passos registrados e 256 frames incluindo o global. Python também limita literais inteiros a 4.300 dígitos e cálculos a 100.000 bits por inteiro. A interface reproduz e retrocede em lotes pequenos para devolver o controle ao navegador. Checkpoints, saltos na linha do tempo, breakpoints e comparação entre execuções são próximos marcos.
