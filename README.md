# Rewind

Debugger visual reversível para uma linguagem pequena, implementado em TypeScript. A primeira entrega executa um algoritmo com bug e permite navegar pela execução nos dois sentidos, observando variáveis, chamadas, instruções e mudanças.

![Demo no Firefox: o retorno de sumTo foi desfeito e seu frame voltou com n=5, total=10 e i=5](docs/demo.png)

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

1. Mantenha o exemplo **A soma que perdeu um número**.
2. Avance duas instruções: o argumento `5` é preparado e `sumTo` entra na pilha.
3. Continue com **Avançar**, ou use **Executar** para reproduzir a execução.
4. O resultado é `10`, embora a soma inclusiva de 1 a 5 devesse ser `15`.
5. Volte através da declaração de `result` e do retorno: o resultado desaparece e o frame de `sumTo` reaparece com suas variáveis.
6. Continue voltando até `i < n` comparar `5 < 5`. Avance novamente para reproduzir exatamente as mudanças registradas.
7. Escolha **Soma corrigida** para executar `i <= n`, obtendo `15`.

**Reiniciar** volta ao estado inicial e preserva o histórico para reaplicação. Trocar de exemplo ou aplicar código editado cria uma nova sessão. As teclas esquerda/direita navegam quando o foco não está em um controle de edição. Cada passo representa uma instrução da VM: uma linha do código pode exigir vários passos.

Outros exemplos: fatorial recursivo (`120`), algoritmo de Euclides (`6`) e divisão por zero. No último, voltar desfaz o erro e restaura os operandos da divisão.

## Estrutura

```text
src/core/language.ts   Lexer, parser, AST e posições no código
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

Os snapshots completos existem **apenas nos testes como referência**. O histórico de produção armazena mudanças. Testes de ida e volta verificam reversibilidade; os testes com resultados conhecidos verificam a semântica, pois um interpretador incorreto também pode ser reversível.

## Documentação

- [Arquitetura e decisões](docs/architecture.md)
- [Especificação da linguagem](docs/language.md)
- [Etapas e próximos marcos](docs/roadmap.md)

Limites iniciais: 50.000 caracteres, 128 níveis de aninhamento sintático, 20.000 passos registrados e 256 frames incluindo o global. A interface reproduz em lotes pequenos para devolver o controle ao navegador. Checkpoints, saltos na linha do tempo, breakpoints e comparação entre execuções são próximos marcos, não recursos desta versão.
