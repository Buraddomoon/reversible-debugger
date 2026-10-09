import { useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { DebugSession } from '../core/debugger';
import { describeInstruction } from '../core/compiler';
import type { DeepReadonly, Step } from '../core/machine';
import { examples } from '../examples';
import { formatValue, runtimes, type LanguageId } from '../core/runtime';
import { ScriptEditor } from './ScriptEditor';
import { NewScriptModal, type NewScript } from './NewScriptModal';
import { DeleteScriptModal } from './DeleteScriptModal';
import { newSavedScript, readScriptLibrary, uniqueScriptName, type SavedScript } from './script-library';
import { useScriptLibrary } from './useScriptLibrary';
import { Timeline } from './Timeline';
import { SourceView } from './SourceView';
import { ExecutionControl, type RunMode } from '../core/execution-control';
import { actionLabels, BreakpointBar, StepControls } from './DebugControls';
import { ComparisonPanel, type ComparisonCandidate } from './ComparisonPanel';
const initialExample = examples.find(example => example.id === 'python-sum-bug')!;

function openSavedScript(script: SavedScript) {
  try { return { session: new DebugSession(script.source, script), editing: script.source.length === 0, notice: null as string | null }; }
  catch (error) { return { session: new DebugSession('', script), editing: true, notice: error instanceof Error ? error.message : String(error) }; }
}

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

interface Navigation { step: DeepReadonly<Step>; direction: 'forward' | 'backward' | 'seek'; group?: { from: number; to: number; label: string } }
function ChangeView({ navigation, language }: { navigation: Navigation | null; language: LanguageId }) {
  if (!navigation) return <div className="change-empty"><span className="empty-symbol">↔</span><p>Um passo, uma mudança.</p><span>Avance para acompanhar o que acontece.</span></div>;
  if (navigation.direction === 'seek') return <div className="change-empty"><span className="empty-symbol">↔</span><p>Estado restaurado no histórico.</p><span>Veja na linha do tempo o passo que produziu este estado. Avance ou volte para acompanhar uma mudança.</span></div>;
  if (navigation.group) return <div className="change-content"><div className="change-direction">{navigation.group.label}<span>{Math.abs(navigation.group.to - navigation.group.from)} instruções</span></div><p className="change-description">Do passo {navigation.group.from} ao {navigation.group.to}.</p><p className="muted">Última instrução {navigation.direction === 'forward' ? 'aplicada' : 'desfeita'}: {navigation.step.description}</p></div>;
  const forward = navigation.direction === 'forward';
  const changes = navigation.step.changes.filter(change => change.kind !== 'control');
  if (!forward) changes.reverse();
  const format = (value: Parameters<typeof formatValue>[0]) => formatValue(value, language);
  return <div className="change-content">
    <div className="change-direction">{forward ? 'PASSO APLICADO' : 'PASSO DESFEITO'} <span>{navigation.step.op}</span></div>
    <p className="change-description">{navigation.step.description}</p>
    {changes.length === 0 && <p className="muted">{navigation.step.op === 'HALT' ? (forward ? 'Programa concluído.' : 'Programa pronto para concluir novamente.') : 'A posição ou a situação da execução mudou.'}</p>}
    {changes.map((change, index) => {
      if (change.kind === 'binding') {
        const before = forward ? change.before : change.after;
        const after = forward ? change.after : change.before;
        return <div className="binding-change" key={index}><code>{change.name}</code><span>{before.exists ? format(before.value) : 'ausente'}</span><span className="change-arrow">→</span><strong>{after.exists ? format(after.value) : 'removida'}</strong></div>;
      }
      if (change.kind === 'frames') {
        const added = forward ? change.added : change.removed;
        const removed = forward ? change.removed : change.added;
        return <div className="frame-change" key={index}><Icon name="layers" />{added.map(frame => `${frame.name} entrou na pilha`).concat(removed.map(frame => `${frame.name} saiu da pilha`)).join(', ')}</div>;
      }
      if (change.kind === 'operands') {
        const added = forward ? change.added : change.removed;
        const removed = forward ? change.removed : change.added;
        return <div className="operand-change" key={index}><span>Pilha de valores</span><code>{removed.length ? `− [${removed.map(format).join(', ')}]` : ''} {added.length ? `+ [${added.map(format).join(', ')}]` : ''}</code></div>;
      }
      if (change.kind === 'output') return <div className="operand-change" key={index}><span>{forward ? 'Saída adicionada' : 'Saída removida'}</span><code>{(forward ? change.added : change.removed).join('')}</code></div>;
      return null;
    })}
  </div>;
}

export function App() {
  const [initial] = useState(() => {
    const stored = readScriptLibrary();
    const script = stored.library.scripts.find(item => item.id === stored.library.selection);
    const example = examples.find(item => item.id === stored.library.selection) ?? initialExample;
    const runtime = runtimes.find(item => item.id === (example.language ?? 'rewind'))!;
    const view = script ? openSavedScript(script) : { session: new DebugSession(example.source, { language: runtime.id }), editing: false, notice: null };
    return { stored, ...view, selection: script?.id ?? example.id, source: script?.source ?? example.source, filename: script?.filename ?? `${example.id}${runtime.extension}` };
  });
  const store = useScriptLibrary(initial.stored);
  const [session, setSession] = useState(initial.session);
  const controller = useMemo(() => new ExecutionControl(session), [session]);
  const [exampleId, setExampleId] = useState(initial.selection);
  const [draft, setDraft] = useState(initial.source);
  const [editing, setEditing] = useState(initial.editing);
  const [creating, setCreating] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [deleting, setDeleting] = useState<SavedScript | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const [draftLanguage, setDraftLanguage] = useState<LanguageId>(initial.session.runtime.language);
  const [draftVersion, setDraftVersion] = useState(initial.session.runtime.version);
  const [filename, setFilename] = useState(initial.filename);
  const [draftFilename, setDraftFilename] = useState(initial.filename);
  const [speed, setSpeed] = useState(4);
  const [notice, setNotice] = useState<string | null>(initial.notice);
  const [navigation, setNavigation] = useState<Navigation | null>(null);
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const [revision, refresh] = useReducer(value => value + 1, 0);
  const example = examples.find(item => item.id === exampleId);
  const selectedScript = store.library.scripts.find(item => item.id === exampleId);
  const state = session.state;
  const activeFrame = state.frames.at(-1)!;
  const frame = state.frames.find(item => item.id === selectedFrame) ?? activeFrame;
  const next = state.control.status === 'running' ? session.program.instructions[state.control.pc] : undefined;
  const result = state.frames[0]!.locals.result;
  const hasResult = Object.hasOwn(state.frames[0]!.locals, 'result');
  const highlightSteps = navigation?.group ? session.history.slice(Math.min(navigation.group.from, navigation.group.to), Math.max(navigation.group.from, navigation.group.to)) : navigation && navigation.direction !== 'seek' ? [navigation.step] : [];
  const changedNames = new Set(highlightSteps.flatMap(step => step.changes.filter(change => change.kind === 'binding' && change.frameId === frame.id).map(change => change.kind === 'binding' ? change.name : '')));
  const breakpoints = controller.breakpoints;
  const breakpointLine = controller.stop?.reason === 'breakpoint' ? controller.stop.line : null;
  const status = rewinding ? 'Retrocedendo' : playing ? controller.mode === 'reverse-continue' || controller.mode === 'back-statement' ? 'Retrocedendo' : 'Executando' : breakpointLine !== null ? `Breakpoint · L${breakpointLine}` : state.control.status === 'error' ? 'Erro na execução' : state.control.status === 'halted' ? 'Concluído' : 'Pausado';
  const format = (value: Parameters<typeof formatValue>[0]) => formatValue(value, session.runtime.language);

  const move = (direction: 'forward' | 'backward') => {
    if (rewinding) return;
    controller.cancel(); setPlaying(false); setNotice(null); setSelectedFrame(null);
    try {
      const step = direction === 'forward' ? session.forward() : session.backward();
      if (step) setNavigation({ step, direction });
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    refresh();
  };
  const seek = (cursor: number) => {
    controller.cancel();
    setPlaying(false); setRewinding(false); setNotice(null); setSelectedFrame(null); setNavigation(null);
    try { session.seek(cursor); if (session.lastStep) setNavigation({ step: session.lastStep, direction: 'seek' }); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    refresh();
  };
  const begin = (mode: RunMode) => {
    setNotice(null); setSelectedFrame(null); setNavigation(null);
    try { controller.start(mode); setPlaying(true); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    refresh();
  };
  const pause = () => { controller.cancel(); setPlaying(false); setRewinding(false); refresh(); };
  const toggleBreakpoint = (line: number) => { pause(); controller.toggleBreakpoint(line); };
  useEffect(() => {
    if (!playing && !rewinding) return;
    const timer = window.setTimeout(() => {
      try {
        if (rewinding) {
          session.backwardBatch(500);
          if (!session.canBackward) { setRewinding(false); setNavigation(null); }
        } else {
          const mode = controller.mode!;
          const grouped = mode !== 'continue' && mode !== 'reverse-continue';
          const result = controller.runBatch(grouped ? 256 : speed);
          if (result.lastStep) setNavigation({ step: result.lastStep, direction: result.direction, ...(grouped ? { group: { from: result.origin, to: session.cursor, label: actionLabels[mode] } } : {}) });
          if (!controller.running) setPlaying(false);
        }
        setSelectedFrame(null);
      } catch (error) {
        controller.cancel(); setPlaying(false); setRewinding(false); setNavigation(null); setNotice(error instanceof Error ? error.message : String(error));
      }
      refresh();
    }, rewinding || (controller.mode && controller.mode !== 'continue' && controller.mode !== 'reverse-continue') ? 0 : speed === 1 ? 180 : 80);
    return () => window.clearTimeout(timer);
  }, [playing, rewinding, session, controller, speed, revision]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (comparing || creating || deleting || editing || rewinding || element.matches('input, textarea, select, button') || element.isContentEditable || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); move('forward'); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); move('backward'); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });
  const load = (id: string) => {
    setComparing(false);
    controller.cancel();
    setPlaying(false); setRewinding(false); setNavigation(null); setSelectedFrame(null);
    store.update(library => ({ ...library, selection: id }));
    const script = store.library.scripts.find(item => item.id === id);
    if (script) {
      const opened = openSavedScript(script);
      setSession(opened.session); setEditing(opened.editing); setNotice(opened.notice); setExampleId(id);
      setDraft(script.source); setFilename(script.filename); setDraftFilename(script.filename);
      setDraftLanguage(script.language); setDraftVersion(script.version);
      return;
    }
    const item = examples.find(example => example.id === id) ?? initialExample;
    setEditing(false); setNotice(null);
    const language = item.language ?? 'rewind';
    const runtime = runtimes.find(entry => entry.id === language)!;
    setSession(new DebugSession(item.source, { language })); setExampleId(id); setDraft(item.source);
    setFilename(`${id}${runtime.extension}`);
    setDraftFilename(`${id}${runtime.extension}`); setDraftLanguage(language); setDraftVersion(runtime.versions[0]);
  };
  const patchSelectedScript = (patch: Partial<SavedScript>) => store.update(library => ({ ...library, scripts: library.scripts.map(script => script.id === exampleId ? { ...script, ...patch } : script) }));
  const changeSource = (source: string) => { setDraft(source); if (selectedScript) patchSelectedScript({ source }); };
  const applyDraft = () => {
    try {
      const replacement = new DebugSession(draft, { language: draftLanguage, version: draftVersion });
      const script = selectedScript ? { ...selectedScript, filename: draftFilename, source: draft, language: draftLanguage, version: draftVersion } : newSavedScript({ name: uniqueScriptName(draftFilename.replace(/\.(py|rw|txt)$/i, ''), store.library.scripts), filename: draftFilename, source: draft, language: draftLanguage, version: draftVersion });
      store.update(library => ({ ...library, selection: script.id, scripts: selectedScript ? library.scripts.map(item => item.id === script.id ? script : item) : [...library.scripts, script] })); store.flush();
      setPlaying(false); setRewinding(false); setSession(replacement); setExampleId(script.id); setEditing(false); setFilename(draftFilename);
      setNotice(null); setNavigation(null); setSelectedFrame(null);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };
  const newScript = () => {
    controller.cancel();
    setPlaying(false); setRewinding(false); setCreating(true);
  };
  const createScript = ({ name, filename, language, version }: NewScript) => {
    setComparing(false);
    const script = newSavedScript({ name, filename, language, version, source: '' });
    store.update(library => ({ ...library, scripts: [...library.scripts, script], selection: script.id })); store.flush();
    setSession(new DebugSession('', { language, version }));
    setFilename(filename); setDraftFilename(filename); setExampleId(script.id);
    setDraft(''); setDraftLanguage(language); setDraftVersion(version);
    setNotice(null); setNavigation(null); setSelectedFrame(null);
    setCreating(false); setEditing(true);
  };
  const deleteScript = () => {
    if (!deleting) return;
    const remaining = store.library.scripts.filter(script => script.id !== deleting.id);
    const nextId = remaining.at(-1)?.id ?? initialExample.id;
    store.update(library => ({ ...library, scripts: remaining, selection: nextId }));
    load(nextId); store.flush(); setDeleting(null);
  };
  const restartProgram = () => {
    controller.cancel();
    setPlaying(false); setRewinding(false); setNavigation(null); setNotice(null); setSelectedFrame(null);
    session.restart(); refresh();
  };
  const comparisonCandidates: ComparisonCandidate[] = [
    ...store.library.scripts.map(script => ({ ...script, group: 'script' as const })),
    ...examples.map(item => ({ id: item.id, name: item.title, source: item.source, language: item.language ?? 'rewind', version: runtimes.find(runtime => runtime.id === (item.language ?? 'rewind'))!.versions[0], group: 'example' as const })),
  ].filter(item => item.language === session.runtime.language && item.version === session.runtime.version);
  const comparisonPrimary: ComparisonCandidate = { id: exampleId, name: selectedScript?.name ?? example?.title ?? filename, source: session.program.source, language: session.runtime.language, version: session.runtime.version, group: selectedScript ? 'script' : 'example' };
  return <div className="app-shell">
    <header className="app-header">
      <a href="#" className="brand" aria-label="Rewind — início"><span className="brand-icon"><Icon name="rewind" /></span><span>rewind<span className="brand-dot">.</span></span></a>
      <span className="header-caption">Debugger reversível</span>
      <div className="header-meta"><span>Execução local</span><span className="version">v0.1</span></div>
    </header>
    <main>
      <div className="intro-row"><div><p className="eyebrow">LABORATÓRIO DE EXECUÇÃO</p><h1>Veja o programa pensar.<br /><span>E volte quando ele errar.</span></h1></div><div className="intro-note"><span className="note-mark">01 /</span><p>Explore cada decisão.<br />O estado acompanha você nos dois sentidos.</p></div></div>
      <section className="example-bar" aria-label="Escolha do programa">
        <div className="example-select"><label htmlFor="example">Programa</label><select id="example" value={exampleId} onChange={event => load(event.target.value)}>{store.library.scripts.length > 0 && <optgroup label="Seus scripts">{store.library.scripts.map(script => <option key={script.id} value={script.id}>{script.name}</option>)}</optgroup>}<optgroup label="Exemplos">{examples.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</optgroup></select></div>
        <p>{example?.description ?? 'Seu código está pronto. Use os controles para explorar a execução.'}</p>
        <span className="example-tag">{example?.tag ?? 'Programa personalizado'}</span>
        <button className="add-script" onClick={newScript}><Icon name="code" />Adicionar script</button>
        <button className="compare-script" disabled={editing || rewinding || comparing} onClick={() => { pause(); setComparing(true); }}>Comparar execuções</button>
        {selectedScript && <button className="delete-script" onClick={() => { pause(); setRewinding(false); setDeleting(selectedScript); }}>Excluir script</button>}
      </section>
      {comparing ? <ComparisonPanel primary={comparisonPrimary} candidates={comparisonCandidates} onClose={() => setComparing(false)} /> : <section className="debugger" aria-label="Debugger visual">
        <div className="control-bar">
          <div className="navigation-controls">
            <button onClick={() => move('backward')} disabled={!session.canBackward || editing || rewinding} title="Voltar uma instrução (tecla esquerda)"><Icon name="back" /><span>Voltar</span></button>
            <button className="primary" onClick={() => move('forward')} disabled={!session.canForward || editing || rewinding} title="Avançar uma instrução (tecla direita)"><Icon name="next" /><span>Avançar</span></button>
            <span className="control-divider" />
            <button className="play-button" onClick={() => playing ? pause() : begin('continue')} disabled={(!session.canForward && !playing) || editing || rewinding}><Icon name={playing ? 'pause' : 'play'} /><span>{playing ? 'Pausar' : 'Executar'}</span></button>
            <label className="speed-label"><span className="sr-only">Velocidade de execução</span><select value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={1}>1×</option><option value={4}>4×</option></select></label>
            <button title="Desfazer todos os passos mantendo o histórico" onClick={() => { controller.cancel(); setPlaying(false); setRewinding(true); setNavigation(null); setNotice(null); setSelectedFrame(null); }} disabled={!session.canBackward || editing || rewinding}><Icon name="rewind" /><span>Retroceder tudo</span></button>
            <button onClick={restartProgram} disabled={editing || rewinding} title="Iniciar uma execução nova sem remover o código ou os scripts salvos"><Icon name="reset" /><span>Reiniciar programa</span></button>
          </div>
          <div className="execution-meta"><span className={`status ${state.control.status}`} role="status">{status}</span><span className="step-number">Passo <strong data-testid="step-count">{session.cursor.toString().padStart(3, '0')}</strong></span></div>
        </div>
        <StepControls disabled={editing || rewinding} canForward={session.canForward} canBackward={session.canBackward} canStepOut={controller.canStepOut} running={playing} onStart={begin} />
        {breakpointLine !== null && <div className="breakpoint-pause" data-testid="debug-pause"><strong>Breakpoint na linha {breakpointLine}</strong><span>Parado antes do comando. Executar retoma esta passagem; o breakpoint continua ativo nas próximas.</span></div>}
        {(notice || store.error || (!editing && state.control.error)) && <div className="error-banner" role="alert">{store.error ?? notice ?? state.control.error}</div>}
        <div className="workspace">
          <section className="source-panel" aria-label="Programa em execução">
            <div className="panel-header"><div><Icon name="code" /><span>{editing ? draftFilename : filename}</span><span className="source-runtime">{(editing ? draftLanguage : session.runtime.language) === 'python' ? 'Python 3' : 'Experimental 0.1'}</span></div><button className="text-button" onClick={() => { pause(); setRewinding(false); if (!editing) { setDraft(selectedScript?.source ?? session.program.source); setDraftLanguage(selectedScript?.language ?? session.runtime.language); setDraftVersion(selectedScript?.version ?? session.runtime.version); setDraftFilename(selectedScript?.filename ?? filename); } setEditing(!editing); setNotice(null); }}>{editing ? 'Fechar editor' : 'Editar código'}</button></div>
            {editing ? <ScriptEditor key={exampleId} saved={Boolean(selectedScript) && !store.error} source={draft} filename={draftFilename} language={draftLanguage} version={draftVersion} onSource={changeSource} onFilename={name => { setDraftFilename(name); if (selectedScript) patchSelectedScript({ filename: name }); }} onRuntime={(language, version) => { setDraftLanguage(language); setDraftVersion(version); if (selectedScript) patchSelectedScript({ language, version }); }} onApply={applyDraft} onError={setNotice} /> : <><BreakpointBar lines={breakpoints} enabled={controller.breakpointsEnabled} onToggle={toggleBreakpoint} onEnabled={enabled => { pause(); controller.breakpointsEnabled = enabled; }} onClear={() => { pause(); controller.clearBreakpoints(); }} /><SourceView source={session.program.source} language={session.runtime.language} breakableLines={session.program.breakableLines} breakpoints={breakpoints} enabled={controller.breakpointsEnabled} onToggle={toggleBreakpoint} span={(controller.stop?.reason === 'step' || breakpointLine !== null) && controller.location?.entry ? controller.location.span : next?.span ?? (state.control.status === 'error' ? session.lastStep?.span : undefined)} /></>}
            <div className="next-instruction"><span>PRÓXIMA INSTRUÇÃO</span><strong data-testid="next-instruction">{next ? describeInstruction(next, session.runtime.language) : state.control.status === 'error' ? 'Volte para desfazer o erro' : 'Programa concluído'}</strong><code>{next ? `L${next.span.line}:${next.span.column} · ${next.op}` : '—'}</code></div>
            <div className="result-panel"><span className="result-label">Resultado <code>result</code></span><strong data-testid="result-value">{hasResult ? format(result!) : '—'}</strong><span className={hasResult && example?.expected !== undefined && result !== example.expected ? 'result-warning' : 'result-expected'}>{example?.expected !== undefined ? `Esperado: ${example.expected}` : hasResult ? 'Valor global' : 'Ainda não calculado'}</span></div>
            {session.runtime.language === 'python' && <section className="output-panel" aria-label="Saída do programa"><span>SAÍDA</span><pre data-testid="program-output">{state.output.join('') || 'Nenhuma saída ainda.'}</pre></section>}
            <div className="source-footnote"><span>Um passo executa uma instrução. Uma linha pode ter vários passos.</span><kbd>←</kbd><kbd>→</kbd></div>
          </section>
          <aside className="state-panel">
            <section className="variables-panel"><div className="panel-header"><div><span className="panel-square" /><h2>Variáveis</h2></div><span className="scope-badge">{frame.name} <span>#{frame.id}</span></span></div>
              <div className="variable-table"><div className="variable-table-header"><span>Nome</span><span>Valor</span><span>Tipo</span></div>{Object.entries(frame.locals).length === 0 ? <p className="variables-empty">Este escopo ainda não tem variáveis.</p> : Object.entries(frame.locals).map(([name, value]) => <div className={`variable-row ${changedNames.has(name) ? 'changed' : ''}`} key={name}><code>{name}</code><strong>{format(value)}</strong><span>{value === null ? 'None' : typeof value === 'bigint' ? 'int' : typeof value === 'number' ? (session.runtime.language === 'python' ? 'float' : 'número') : typeof value === 'boolean' ? 'booleano' : 'função'}</span></div>)}</div>
            </section>
            <section className="stack-panel"><div className="panel-header"><div><Icon name="layers" /><h2>Pilha de chamadas</h2></div><span className="count-badge">{state.frames.length}</span></div>
              <div className="frames" data-testid="call-stack">{[...state.frames].reverse().map(item => <button key={item.id} className={`frame ${item.id === frame.id ? 'selected' : ''}`} onClick={() => setSelectedFrame(item.id)} aria-pressed={item.id === frame.id}><span className="frame-depth">{item.id.toString().padStart(2, '0')}</span><code>{item.name}{item.id !== 0 ? '()' : ''}</code><span className="frame-label">{item.id === activeFrame.id ? 'Atual' : 'Aguardando'}</span></button>)}</div>
              <details className="operand-details"><summary>Pilha de valores <span>{state.operands.length}</span></summary><div className="operand-values">{state.operands.length ? state.operands.map((value, index) => <code key={index}>{format(value)}</code>) : <span>Vazia</span>}</div></details>
            </section>
            <section className="changes-panel"><div className="panel-header"><div><span className="change-icon">↔</span><h2>O que mudou</h2></div></div><ChangeView navigation={navigation} language={session.runtime.language} /></section>
          </aside>
        </div>
        <Timeline key={`${exampleId}:${editing}`} history={session.history} cursor={session.cursor} disabled={editing || rewinding} onSeek={seek} />
      </section>}
      <footer className="page-footer"><span>REWIND / uma pequena linguagem, um estado exato.</span><span>{store.library.scripts.length ? `${store.library.scripts.length} ${store.library.scripts.length === 1 ? 'script salvo' : 'scripts salvos'} neste navegador` : 'Variáveis · Decisões · Chamadas'}</span></footer>
    </main>
    {creating && <NewScriptModal existingNames={store.library.scripts.map(script => script.name)} onCreate={createScript} onCancel={() => setCreating(false)} />}
    {deleting && <DeleteScriptModal name={deleting.name} onCancel={() => setDeleting(null)} onDelete={deleteScript} />}
  </div>;
}
