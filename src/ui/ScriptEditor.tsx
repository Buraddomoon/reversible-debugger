import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { MAX_SOURCE_CHARS, validateSourceSize } from '../core/language';
import { runtimes, type LanguageId } from '../core/runtime';

interface Props {
  source: string;
  filename: string;
  language: LanguageId;
  version: string;
  onSource: (source: string) => void;
  onFilename: (name: string) => void;
  onRuntime: (language: LanguageId, version: string) => void;
  onApply: () => void;
  onError: (message: string | null) => void;
}

export function ScriptEditor(props: Props) {
  const upload = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const [loading, setLoading] = useState(false);
  const runtime = runtimes.find(item => item.id === props.language)!;
  useEffect(() => () => { request.current++; }, []);
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const currentRequest = ++request.current;
    setLoading(true); props.onError(null);
    try {
      if (!/\.(py|rw|txt)$/i.test(file.name)) throw new Error('Escolha um arquivo .py, .rw ou .txt.');
      if (file.size > MAX_SOURCE_CHARS * 4) throw new Error('Arquivo grande demais. O limite é de 1 milhão de caracteres.');
      const source = await file.text();
      validateSourceSize(source);
      if (currentRequest !== request.current) return;
      if (/\.py$/i.test(file.name)) props.onRuntime('python', '3');
      if (/\.rw$/i.test(file.name)) props.onRuntime('rewind', '0.1');
      props.onFilename(file.name); props.onSource(source);
    } catch (error) {
      if (currentRequest === request.current) props.onError(error instanceof Error ? error.message : String(error));
    } finally { if (currentRequest === request.current) setLoading(false); }
  };
  return <div className="editor-wrap">
    <div className="script-settings">
      <label htmlFor="script-language">Linguagem<select id="script-language" value={props.language} disabled={loading} onChange={event => {
        const selected = runtimes.find(item => item.id === event.target.value)!;
        props.onRuntime(selected.id, selected.versions[0]); props.onError(null);
      }}>{runtimes.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label htmlFor="script-version">Versão<select id="script-version" value={props.version} disabled={loading} onChange={event => props.onRuntime(props.language, event.target.value)}>{runtime.versions.map(version => <option value={version} key={version}>{runtime.versionLabel}</option>)}</select></label>
      <button type="button" disabled={loading} onClick={() => upload.current?.click()}>{loading ? 'Lendo arquivo…' : 'Importar arquivo'}</button>
      <input ref={upload} className="sr-only" type="file" tabIndex={-1} aria-label="Arquivo do script" accept=".py,.rw,.txt,text/plain" onChange={importFile} />
    </div>
    <p className="runtime-description">{runtime.description}</p>
    <div className="editor-file-meta"><code>{props.filename}</code><span className={props.source.length > MAX_SOURCE_CHARS ? 'over-limit' : ''} data-testid="character-count">{props.source.length.toLocaleString('pt-BR')} / {MAX_SOURCE_CHARS.toLocaleString('pt-BR')} caracteres</span></div>
    <label className="sr-only" htmlFor="source-editor">Código do programa</label>
    <textarea id="source-editor" spellCheck={false} autoFocus value={props.source} disabled={loading} onChange={event => props.onSource(event.target.value)} placeholder={props.language === 'python' ? 'def double(n):\n    return n * 2\n\nresult = double(21)' : 'fn double(n) {\n  return n * 2;\n}\n\nlet result = double(21);'} />
    <div className="editor-footer"><span>Aplicar inicia uma nova execução.</span><button className="primary" disabled={loading} onClick={props.onApply}>Aplicar código</button></div>
  </div>;
}
