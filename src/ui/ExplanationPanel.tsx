import { useMemo, useState } from 'react';
import type { DebugSession } from '../core/debugger';
import { explainStep, summarizeNavigation, type OperationEvidence, type RecordedBinding, type StepExplanation } from '../core/explanations';
import type { DeepReadonly, Step } from '../core/machine';
import { formatValue, type LanguageId } from '../core/runtime';
import type { Value } from '../core/language';

export interface Navigation { step: DeepReadonly<Step>; direction: 'forward' | 'backward' | 'seek'; group?: { from: number; to: number; label: string } }
function ValueBox({ value, label }: { value: string; label: string }) {
  return <div className="evidence-value"><small>{label}</small><code>{value}</code></div>;
}
// Formatted text is passed to ValueBox; diagram data always keeps its recorded type.
function Formula({ operation, language, reverse }: { operation: OperationEvidence; language: LanguageId; reverse: boolean }) {
  const format = (value: DeepReadonly<Value>) => formatValue(value, language);
  return <div className={`operation-diagram ${reverse ? 'reverse' : ''}`} data-testid="operation-diagram">
    <div className="operation-inputs">{operation.inputs.map((value, index) => <div key={index}>{index > 0 && <span className="operation-symbol">{operation.operator}</span>}{operation.inputs.length === 1 && <span className="operation-symbol">{operation.operator}</span>}<ValueBox value={format(value)} label={operation.inputs.length === 1 ? 'Operando' : index === 0 ? 'Esquerda' : 'Direita'} /></div>)}</div>
    <span className="evidence-arrow" aria-hidden="true">{reverse ? '←' : '→'}</span><ValueBox value={format(operation.result)} label="Resultado registrado" />
  </div>;
}
function bindingText(binding: RecordedBinding, language: LanguageId): string { return binding.exists ? formatValue(binding.value, language) : 'ausente'; }
function Evidence({ explanation, language, reverse }: { explanation: StepExplanation; language: LanguageId; reverse: boolean }) {
  const format = (value: DeepReadonly<Value>) => formatValue(value, language);
  switch (explanation.kind) {
    case 'heap': {
      const labels = { create: 'Lista criada', delete: 'Criação desfeita', append: 'Item acrescentado', remove: 'Append desfeito', replace: reverse ? 'Item restaurado' : 'Item alterado' };
      const values = (items: readonly Value[]) => items.length ? items.slice(0, 12).map(format).join(', ') + (items.length > 12 ? ', …' : '') : 'ausente';
      const before = explanation.action === 'delete' ? `[${explanation.before.length ? values(explanation.before) : ''}]` : values(explanation.before);
      const after = explanation.action === 'create' ? `[${explanation.after.length ? values(explanation.after) : ''}]` : values(explanation.after);
      return <><div className="heap-evidence" data-testid="heap-explanation"><header><strong>{labels[explanation.action]}</strong><code>#L{explanation.id}{explanation.action === 'create' || explanation.action === 'delete' ? '' : `[${explanation.index}]`}</code></header><div><ValueBox label="Antes desta mudança" value={before} /><span className="evidence-arrow" aria-hidden="true">→</span><ValueBox label="Depois desta mudança" value={after} /></div></div><p className="evidence-note">{explanation.action === 'create' || explanation.action === 'delete' ? 'O ID e o contador de alocação também são restaurados. Uma lista vazia continua sendo um objeto.' : 'Todas as referências a este ID observam a mesma lista. O delta guarda somente os itens afetados.'}</p></>;
    }
    case 'item-read': return <><div className="read-diagram"><ValueBox label="Item consultado" value={`#L${explanation.id}[${format(explanation.index)}]`} /><span className="evidence-arrow" aria-hidden="true">{reverse ? '←' : '→'}</span><ValueBox label="Pilha de valores" value={format(explanation.value)} /></div><p className="evidence-note">A leitura conserva o objeto e copia o valor ou a referência registrados.</p></>;
    case 'operation': return <><Formula operation={explanation.operation} language={language} reverse={reverse} /><p className="evidence-note">{reverse ? 'Os operandos originais voltam à pilha; o resultado é retirado. Nenhuma operação inversa é calculada.' : 'Os operandos são consumidos e o resultado registrado entra na pilha.'}</p></>;
    case 'read': return <><div className="read-diagram"><div className="evidence-value"><small>{explanation.scope}{explanation.frameId !== null ? ` · #${explanation.frameId}` : ''}</small><code>{explanation.name}</code></div><span className="evidence-arrow" aria-hidden="true">{reverse ? '←' : '→'}</span><ValueBox label="Pilha de valores" value={format(explanation.value)} /></div><p className="evidence-note">{reverse ? 'A cópia lida sai da pilha. A variável conserva seu valor.' : 'Uma cópia do valor lido entra na pilha. A variável conserva seu valor.'}</p></>;
    case 'binding': return <><div className="binding-diagram"><span>{explanation.scope} · #{explanation.frameId}</span><code>{explanation.name}</code><div><strong>{bindingText(explanation.before, language)}</strong><span aria-hidden="true">→</span><strong>{bindingText(explanation.after, language)}</strong></div></div><p className="evidence-note">{explanation.after.exists ? reverse ? 'A variável recupera sua presença, tipo e valor anteriores.' : 'A variável recebe o valor registrado neste escopo.' : 'A variável deixa de existir neste escopo; seu valor não vira zero ou None.'}</p></>;
    case 'decision': return <>
      {explanation.operation ? <Formula operation={explanation.operation} language={language} reverse={false} /> : <div className="condition-value"><code>{format(explanation.value)}</code><span>valor usado como condição</span></div>}
      <div className={`decision-diagram ${reverse ? 'undone' : ''}`} data-testid="decision-diagram"><div className={explanation.satisfied ? 'chosen' : ''}><span>Verdadeira</span><small>Caminho verdadeiro</small></div><span aria-hidden="true">◇</span><div className={!explanation.satisfied ? 'chosen' : ''}><span>Falsa</span><small>Caminho falso</small></div></div>
      <p className="evidence-note">{reverse ? `Decisão desfeita: ${format(explanation.value)} volta à pilha. A escolha destacada é a registrada, agora desfeita.` : `Escolha registrada: ${explanation.satisfied ? 'verdadeira' : 'falsa'}.`} {explanation.destinationLine === null ? 'Destino: conclusão.' : `Próxima posição: linha ${explanation.destinationLine}.`}</p>
    </>;
    case 'frame': {
      const enters = explanation.action === 'enter' || explanation.action === 'restore';
      const locals = Object.entries(explanation.frame.locals);
      return <><div className={`frame-diagram ${enters ? 'enter' : 'leave'}`} data-testid="frame-diagram"><div><small>Chamador</small><code>{explanation.caller}</code></div><span className="evidence-arrow" aria-hidden="true">{enters ? '→' : '←'}</span><div className="evidence-frame"><small>{explanation.action === 'restore' ? 'Frame restaurado' : explanation.action === 'remove' ? 'Frame removido' : enters ? 'Frame criado' : 'Frame encerrado'}</small><code>{explanation.frame.name}() · #{explanation.frame.id}</code></div></div>
        {explanation.result.exists && <div className="returned-value"><span>{reverse ? 'Valor retirado do chamador' : 'Valor recebido pelo chamador'}</span><code>{format(explanation.result.value)}</code></div>}
        <details className="frame-evidence" open><summary>{explanation.action === 'enter' || explanation.action === 'remove' ? 'Parâmetros registrados' : 'Locais preservados no retorno'} <span>{locals.length}</span></summary><div>{locals.slice(0, 12).map(([name, value]) => <span key={name}><code>{name}</code><strong>{format(value)}</strong></span>)}</div>{locals.length > 12 && <p>Mais {locals.length - 12} locais no registro. Navegue até o frame para inspecioná-los.</p>}</details>
      </>;
    }
    case 'output': return <><div className={`output-evidence ${reverse ? 'removed' : ''}`}><span>{explanation.action === 'append' ? 'Saída adicionada' : 'Saída removida'}</span><pre>{explanation.text}</pre></div><p className="evidence-note">A saída faz parte do estado reversível.</p></>;
    case 'error': return <div className="error-evidence" data-testid="error-evidence"><strong>{explanation.action === 'raise' ? 'Transação rejeitada' : 'Erro desfeito'}</strong><p>{explanation.message}</p><span>{explanation.action === 'raise' ? 'As alterações parciais foram revertidas. Operandos, variáveis, frames e saída foram preservados.' : 'O estado anterior ao erro foi restaurado. A instrução pode ser reaplicada pelo histórico.'}</span></div>;
    case 'flow': return <div className="flow-evidence"><p>{explanation.description}</p><div><code>{explanation.sourceLine === null ? 'Concluído' : `L${explanation.sourceLine}`}</code><span aria-hidden="true">→</span><code>{explanation.destinationLine === null ? 'Concluído' : `L${explanation.destinationLine}`}</code></div></div>;
  }
}

function NavigationEvidence({ session, navigation }: { session: DebugSession; navigation: Navigation }) {
  const reverse = navigation.direction === 'backward';
  const from = navigation.group?.from ?? (reverse ? session.cursor + 1 : session.cursor - 1);
  const to = navigation.group?.to ?? session.cursor;
  const summary = useMemo(() => summarizeNavigation(session.program, session.history, from, to), [session, from, to]);
  const [selected, setSelected] = useState(summary.focus);
  const [page, setPage] = useState(0);
  const explanation = useMemo(() => explainStep(session.program, session.history, selected, reverse ? 'backward' : 'forward'), [session, selected, reverse]);
  const low = Math.min(from, to), high = Math.max(from, to) - 1;
  const language = session.runtime.language;
  const pages = Math.max(1, Math.ceil(summary.bindings.length / 12));
  return <div className={`visual-explanation ${reverse ? 'backward' : 'forward'}`} data-testid="visual-explanation" data-direction={reverse ? 'backward' : 'forward'}>
    <div className="explanation-heading"><span>{navigation.group?.label ?? (reverse ? 'PASSO DESFEITO' : 'PASSO APLICADO')}</span><code>{session.history[selected]!.op}</code></div>
    <p className="explanation-caption">{summary.count} {summary.count === 1 ? 'instrução' : 'instruções'} · do passo {from} ao {to}</p>
    {navigation.group && <div className="explanation-selector"><button disabled={selected === low} onClick={() => setSelected(selected - 1)} aria-label="Instrução anterior do intervalo">←</button><span>Registro #{selected + 1} · L{session.history[selected]!.span.line}</span><button disabled={selected === high} onClick={() => setSelected(selected + 1)} aria-label="Próxima instrução do intervalo">→</button></div>}
    {navigation.group && <p className="evidence-note">Detalhe do registro selecionado. O estado atual permanece no passo {to}.</p>}
    <div className="evidence-animated" key={`${selected}:${reverse}`}><Evidence explanation={explanation} language={language} reverse={reverse} /></div>
    {navigation.group && summary.bindings.length > 0 && <details className="interval-bindings" open><summary>Atribuições no intervalo <span>{summary.bindings.length}</span></summary><div>{summary.bindings.slice(page * 12, (page + 1) * 12).map(binding => <div key={`${binding.frameId}:${binding.name}`}><span>{binding.scope} #{binding.frameId}{session.state.frames.some(frame => frame.id === binding.frameId) ? '' : ' · escopo encerrado'}</span><code>{binding.name}</code><p><span>{bindingText(binding.before, language)}</span> → <strong>{bindingText(binding.after, language)}</strong></p><small>{binding.writes} {binding.writes === 1 ? 'alteração registrada' : 'alterações registradas'}</small></div>)}</div>{pages > 1 && <div className="explanation-selector"><button disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Página anterior de atribuições">←</button><span>{page + 1} / {pages}</span><button disabled={page === pages - 1} onClick={() => setPage(page + 1)} aria-label="Próxima página de atribuições">→</button></div>}</details>}
  </div>;
}
export function ExplanationPanel({ session, navigation }: { session: DebugSession; navigation: Navigation | null }) {
  if (!navigation) return <div className="change-empty"><span className="empty-symbol">↔</span><p>Um passo, uma mudança.</p><span>Avance para acompanhar o que acontece.</span></div>;
  if (navigation.direction === 'seek') return <div className="change-empty"><span className="empty-symbol">↔</span><p>Estado restaurado no histórico.</p><span>Veja na linha do tempo o passo que produziu este estado. Avance ou volte para explicar uma mudança.</span></div>;
  return <NavigationEvidence key={`${navigation.direction}:${navigation.group?.from}:${session.cursor}`} session={session} navigation={navigation} />;
}
