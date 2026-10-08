import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { DebugSession } from '../core/debugger';
import { describeInstruction } from '../core/compiler';
import type { DeepReadonly, Step } from '../core/machine';
import type { Span } from '../core/language';
import { examples } from '../examples';

type IconName = 'rewind' | 'back' | 'next' | 'play' | 'pause' | 'reset' | 'code' | 'layers';
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    rewind: <><path d="m12 5-9 7 9 7V5Z" /><path d="m21 5-9 7 9 7V5Z" /></>,
    back: <><path d="M6 5v14" /><path d="m19 5-10 7 10 7V5Z" /></>,
    next: <><path d="M18 5v14" /><path d="m5 5 10 7-10 7V5Z" /></>,
    play: <path d="m7 4 14 8-14 8V4Z" />,
    pause: <><path d="M8 5v14" /><path d="M16 5v14" /></>,
    reset: <><path d="M4 10a8 8 0 1 1 1 8" /><path d="M4 4v6h6" /></>,
    code: <><path d="m8 6-6 6 6 6" /><path d="m16 6 6 6-6 6" /><path d="m14 3-4 18" /></>,
    layers: <><path d="m12 3 10 6-10 6L2 9l10-6Z" /><path d="m2 13 10 6 10-6M2 17l10 6 10-6" /></>,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function syntax(text: string): ReactNode[] {
  return text.split(/(\/\/.*|\b(?:fn|let|while|if|else|return|true|false)\b|\b\d+(?:\.\d+)?\b|[+*/%<>=!\-]+|\b[A-Za-z_]\w*(?=\())/g).filter(Boolean).map((piece, index) => {
    const kind = piece.startsWith('//') ? 'comment' : /^(fn|let|while|if|else|return|true|false)$/.test(piece) ? 'keyword' : /^\d/.test(piece) ? 'number' : /^[+*/%<>=!\-]+$/.test(piece) ? 'operator' : /^[A-Za-z_]/.test(piece) ? 'function' : '';
    return <span className={`syntax-${kind}`} key={index}>{piece}</span>;
  });
}

function SourceView({ source, span }: { source: string; span?: Span }) {
  const current = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!current.current || !container.current) return;
    const line = current.current.getBoundingClientRect();
    const viewport = container.current.getBoundingClientRect();
    if (line.top < viewport.top) container.current.scrollTop -= viewport.top - line.top;
    if (line.bottom > viewport.bottom) container.current.scrollTop += line.bottom - viewport.bottom;
  }, [span?.line]);
  return <div className="source-scroll" ref={container} tabIndex={0} aria-label="Código-fonte em execução">
    {source.trimEnd().split('\n').map((line, index) => {
      const active = index + 1 === span?.line;
      return <div className={`code-line ${active ? 'current' : ''}`} key={index} ref={active ? current : undefined} data-testid={active ? 'current-line' : undefined} aria-current={active ? 'step' : undefined}>
        <span className="line-number">{index + 1}</span>
        <span className="line-marker" aria-hidden="true">{active ? '▸' : ''}</span>
        <code>{syntax(line || ' ')}</code>
      </div>;
    })}
  </div>;
}

interface Navigation { step: DeepReadonly<Step>; direction: 'forward' | 'backward' }
function ChangeView({ navigation }: { navigation: Navigation | null }) {
  if (!navigation) return <div className="change-empty"><span className="empty-symbol">↔</span><p>Um passo, uma mudança.</p><span>Avance para acompanhar o que acontece.</span></div>;
  const forward = navigation.direction === 'forward';
  const changes = navigation.step.changes.filter(change => change.kind !== 'control');
  return <div className="change-content">
    <div className="change-direction">{forward ? 'PASSO APLICADO' : 'PASSO DESFEITO'} <span>{navigation.step.op}</span></div>
    <p className="change-description">{navigation.step.description}</p>
    {changes.length === 0 && <p className="muted">{navigation.step.op === 'HALT' ? (forward ? 'Programa concluído.' : 'Programa pronto para concluir novamente.') : 'A posição ou a situação da execução mudou.'}</p>}
    {changes.map((change, index) => {
      if (change.kind === 'binding') {
        const before = forward ? change.before : change.after;
        const after = forward ? change.after : change.before;
        return <div className="binding-change" key={index}><code>{change.name}</code><span>{before.exists ? String(before.value) : 'ausente'}</span><span className="change-arrow">→</span><strong>{after.exists ? String(after.value) : 'removida'}</strong></div>;
      }
      if (change.kind === 'frames') {
        const added = forward ? change.added : change.removed;
        const removed = forward ? change.removed : change.added;
        return <div className="frame-change" key={index}><Icon name="layers" />{added.map(frame => `${frame.name} entrou na pilha`).concat(removed.map(frame => `${frame.name} saiu da pilha`)).join(', ')}</div>;
      }
      if (change.kind === 'operands') {
        const added = forward ? change.added : change.removed;
        const removed = forward ? change.removed : change.added;
        return <div className="operand-change" key={index}><span>Pilha de valores</span><code>{removed.length ? `− [${removed.join(', ')}]` : ''} {added.length ? `+ [${added.join(', ')}]` : ''}</code></div>;
      }
      return null;
    })}
  </div>;
}

export function App() {
  const [session, setSession] = useState(() => new DebugSession(examples[0]!.source));
  const [exampleId, setExampleId] = useState(examples[0]!.id);
  const [draft, setDraft] = useState(session.program.source);
  const [editing, setEditing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [notice, setNotice] = useState<string | null>(null);
  const [navigation, setNavigation] = useState<Navigation | null>(null);
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const [revision, refresh] = useReducer(value => value + 1, 0);
  const example = examples.find(item => item.id === exampleId);
  const state = session.state;
  const activeFrame = state.frames.at(-1)!;
  const frame = state.frames.find(item => item.id === selectedFrame) ?? activeFrame;
  const next = state.control.status === 'running' ? session.program.instructions[state.control.pc] : undefined;
  const result = state.frames[0]!.locals.result;
  const hasResult = Object.hasOwn(state.frames[0]!.locals, 'result');
  const changedNames = new Set(navigation?.step.changes.filter(change => change.kind === 'binding' && change.frameId === frame.id).map(change => change.kind === 'binding' ? change.name : '') ?? []);
  const status = state.control.status === 'error' ? 'Erro na execução' : state.control.status === 'halted' ? 'Concluído' : playing ? 'Executando' : 'Pausado';

  const move = (direction: 'forward' | 'backward') => {
    setPlaying(false); setNotice(null); setSelectedFrame(null);
    try {
      const step = direction === 'forward' ? session.forward() : session.backward();
      if (step) setNavigation({ step, direction });
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    refresh();
  };
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      try {
        session.runBatch(speed);
        if (session.lastStep) setNavigation({ step: session.lastStep, direction: 'forward' });
        setSelectedFrame(null);
        if (!session.canForward) setPlaying(false);
      } catch (error) {
        setPlaying(false); setNotice(error instanceof Error ? error.message : String(error));
      }
      refresh();
    }, speed === 1 ? 180 : 80);
    return () => window.clearTimeout(timer);
  }, [playing, session, speed, revision]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (editing || element.matches('input, textarea, select, button') || element.isContentEditable || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); move('forward'); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); move('backward'); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });
  const load = (id: string) => {
    if (id === 'custom') return;
    const item = examples.find(example => example.id === id)!;
    setPlaying(false); setEditing(false); setNotice(null); setNavigation(null); setSelectedFrame(null);
    setSession(new DebugSession(item.source)); setExampleId(id); setDraft(item.source);
  };
  const applyDraft = () => {
    try {
      const replacement = new DebugSession(draft);
      setPlaying(false); setSession(replacement); setExampleId('custom'); setEditing(false);
      setNotice(null); setNavigation(null); setSelectedFrame(null);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };
  return <div className="app-shell">
    <header className="app-header">
      <a href="#" className="brand" aria-label="Rewind — início"><span className="brand-icon"><Icon name="rewind" /></span><span>rewind<span className="brand-dot">.</span></span></a>
      <span className="header-caption">Debugger reversível</span>
      <div className="header-meta"><span>Execução local</span><span className="version">v0.1</span></div>
    </header>
    <main>
      <div className="intro-row"><div><p className="eyebrow">LABORATÓRIO DE EXECUÇÃO</p><h1>Veja o programa pensar.<br /><span>E volte quando ele errar.</span></h1></div><div className="intro-note"><span className="note-mark">01 /</span><p>Explore cada decisão.<br />O estado acompanha você nos dois sentidos.</p></div></div>
      <section className="example-bar" aria-label="Escolha do programa">
        <div className="example-select"><label htmlFor="example">Programa</label><select id="example" value={exampleId} onChange={event => load(event.target.value)}>{examples.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}{exampleId === 'custom' && <option value="custom">Seu programa</option>}</select></div>
        <p>{example?.description ?? 'Seu código está pronto. Use os controles para explorar a execução.'}</p>
        <span className="example-tag">{example?.tag ?? 'Programa personalizado'}</span>
      </section>
      <section className="debugger" aria-label="Debugger visual">
        <div className="control-bar">
          <div className="navigation-controls">
            <button onClick={() => move('backward')} disabled={!session.canBackward || editing} title="Voltar uma instrução (tecla esquerda)"><Icon name="back" /><span>Voltar</span></button>
            <button className="primary" onClick={() => move('forward')} disabled={!session.canForward || editing} title="Avançar uma instrução (tecla direita)"><Icon name="next" /><span>Avançar</span></button>
            <span className="control-divider" />
            <button className="play-button" onClick={() => { setNotice(null); setPlaying(!playing); }} disabled={!session.canForward || editing}><Icon name={playing ? 'pause' : 'play'} /><span>{playing ? 'Pausar' : 'Executar'}</span></button>
            <label className="speed-label"><span className="sr-only">Velocidade de execução</span><select value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={1}>1×</option><option value={4}>4×</option></select></label>
            <button className="icon-button" aria-label="Reiniciar" title="Voltar ao início mantendo o histórico" onClick={() => { setPlaying(false); session.rewind(); setNavigation(null); setNotice(null); setSelectedFrame(null); refresh(); }} disabled={!session.canBackward || editing}><Icon name="reset" /></button>
          </div>
          <div className="execution-meta"><span className={`status ${state.control.status}`} role="status">{status}</span><span className="step-number">Passo <strong data-testid="step-count">{session.cursor.toString().padStart(3, '0')}</strong></span></div>
        </div>
        {(notice || state.control.error) && <div className="error-banner" role="alert">{notice ?? state.control.error}</div>}
        <div className="workspace">
          <section className="source-panel" aria-label="Programa em execução">
            <div className="panel-header"><div><Icon name="code" /><span>{exampleId === 'custom' ? 'programa.rw' : `${exampleId}.rw`}</span></div><button className="text-button" onClick={() => { setPlaying(false); setDraft(session.program.source); setEditing(!editing); setNotice(null); }}>{editing ? 'Cancelar edição' : 'Editar código'}</button></div>
            {editing ? <div className="editor-wrap"><label className="sr-only" htmlFor="source-editor">Código do programa</label><textarea id="source-editor" spellCheck={false} value={draft} onChange={event => setDraft(event.target.value)} /><div className="editor-footer"><span>Aplicar inicia uma nova execução.</span><button className="primary" onClick={applyDraft}>Aplicar código</button></div></div> : <SourceView source={session.program.source} span={next?.span ?? (state.control.status === 'error' ? session.lastStep?.span : undefined)} />}
            <div className="next-instruction"><span>PRÓXIMA INSTRUÇÃO</span><strong data-testid="next-instruction">{next ? describeInstruction(next) : state.control.status === 'error' ? 'Volte para desfazer o erro' : 'Programa concluído'}</strong><code>{next ? `L${next.span.line}:${next.span.column} · ${next.op}` : '—'}</code></div>
            <div className="result-panel"><span className="result-label">Resultado <code>result</code></span><strong data-testid="result-value">{hasResult ? String(result) : '—'}</strong><span className={hasResult && example?.expected !== undefined && result !== example.expected ? 'result-warning' : 'result-expected'}>{example?.expected !== undefined ? `Esperado: ${example.expected}` : hasResult ? 'Valor global' : 'Ainda não calculado'}</span></div>
            <div className="source-footnote"><span>Um passo executa uma instrução. Uma linha pode ter vários passos.</span><kbd>←</kbd><kbd>→</kbd></div>
          </section>
          <aside className="state-panel">
            <section className="variables-panel"><div className="panel-header"><div><span className="panel-square" /><h2>Variáveis</h2></div><span className="scope-badge">{frame.name} <span>#{frame.id}</span></span></div>
              <div className="variable-table"><div className="variable-table-header"><span>Nome</span><span>Valor</span><span>Tipo</span></div>{Object.entries(frame.locals).length === 0 ? <p className="variables-empty">Este escopo ainda não tem variáveis.</p> : Object.entries(frame.locals).map(([name, value]) => <div className={`variable-row ${changedNames.has(name) ? 'changed' : ''}`} key={name}><code>{name}</code><strong>{String(value)}</strong><span>{typeof value === 'number' ? 'número' : 'booleano'}</span></div>)}</div>
            </section>
            <section className="stack-panel"><div className="panel-header"><div><Icon name="layers" /><h2>Pilha de chamadas</h2></div><span className="count-badge">{state.frames.length}</span></div>
              <div className="frames" data-testid="call-stack">{[...state.frames].reverse().map(item => <button key={item.id} className={`frame ${item.id === frame.id ? 'selected' : ''}`} onClick={() => setSelectedFrame(item.id)} aria-pressed={item.id === frame.id}><span className="frame-depth">{item.id.toString().padStart(2, '0')}</span><code>{item.name}{item.id !== 0 ? '()' : ''}</code><span className="frame-label">{item.id === activeFrame.id ? 'Atual' : 'Aguardando'}</span></button>)}</div>
              <details className="operand-details"><summary>Pilha de valores <span>{state.operands.length}</span></summary><div className="operand-values">{state.operands.length ? state.operands.map((value, index) => <code key={index}>{String(value)}</code>) : <span>Vazia</span>}</div></details>
            </section>
            <section className="changes-panel"><div className="panel-header"><div><span className="change-icon">↔</span><h2>O que mudou</h2></div></div><ChangeView navigation={navigation} /></section>
          </aside>
        </div>
        <footer className="history-strip"><div><span className="history-label">HISTÓRICO</span><span>{session.history.length} passos registrados</span></div><div className="history-track" aria-hidden="true">{Array.from({ length: 36 }, (_, index) => <span key={index} className={index < Math.round(session.history.length ? session.cursor / session.history.length * 36 : 0) ? 'filled' : ''} />)}</div><span className="replay-label">{session.cursor < session.history.length ? 'Reaplicando mudanças registradas' : 'Registrando mudanças'}</span></footer>
      </section>
      <footer className="page-footer"><span>REWIND / uma pequena linguagem, um estado exato.</span><span>Variáveis · Decisões · Chamadas</span></footer>
    </main>
  </div>;
}
