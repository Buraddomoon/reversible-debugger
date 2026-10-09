import { useEffect, useRef, useState, type FormEvent } from 'react';
import { getRuntime, runtimes, type LanguageId } from '../core/runtime';

export interface NewScript {
  name: string;
  filename: string;
  language: LanguageId;
  version: string;
}

interface Props {
  existingNames: readonly string[];
  onCreate: (script: NewScript) => void;
  onCancel: () => void;
}

export function NewScriptModal({ onCreate, onCancel, existingNames }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<LanguageId>('python');
  const [version, setVersion] = useState('3');
  const [error, setError] = useState<string | null>(null);
  const runtime = runtimes.find(item => item.id === language)!;
  const basename = name.trim().replace(/\.(py|rw|txt)$/i, '').replace(/[. ]+$/, '');
  const filename = basename ? `${basename}${runtime.extension}` : '';

  useEffect(() => {
    const element = dialog.current!;
    const previousOverflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = 'hidden';
    return () => { element.close(); document.body.style.overflow = previousOverflow; };
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!basename) { setError('Dê um nome ao script.'); return; }
    if (existingNames.some(existing => existing.toLocaleLowerCase() === basename.toLocaleLowerCase())) { setError('Já existe um script com esse nome. Escolha outro nome.'); return; }
    if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) { setError('O nome não pode conter barras ou os caracteres : * ? " < > |.'); return; }
    try {
      const selected = getRuntime(language, version);
      onCreate({ name: basename, filename, ...selected });
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };

  return <dialog ref={dialog} className="new-script-dialog" aria-labelledby="new-script-title" onCancel={event => { event.preventDefault(); onCancel(); }} onClick={event => {
    if (event.target !== dialog.current) return;
    const rect = dialog.current!.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onCancel();
  }}>
    <form onSubmit={submit}>
      <div className="dialog-heading"><span className="dialog-mark" aria-hidden="true">&lt;/&gt;</span><h2 id="new-script-title">Criar script</h2></div>
      <label htmlFor="new-script-name">Nome do script<input id="new-script-name" autoFocus required maxLength={80} autoComplete="off" placeholder="Minha soma" value={name} onChange={event => { setName(event.target.value); setError(null); }} /></label>
      <label htmlFor="script-language">Linguagem<select id="script-language" value={language} onChange={event => {
        const selected = runtimes.find(item => item.id === event.target.value)!;
        setLanguage(selected.id); setVersion(selected.versions[0]); setError(null);
      }}>{runtimes.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label htmlFor="script-version">Versão<select id="script-version" value={version} onChange={event => setVersion(event.target.value)}>{runtime.versions.map(item => <option key={item} value={item}>{runtime.versionLabel}</option>)}</select></label>
      <p className="dialog-runtime-note">{runtime.description}</p>
      {filename && <p className="dialog-filename">Arquivo <code>{filename}</code></p>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" onClick={onCancel}>Cancelar</button><button type="submit" className="primary" disabled={!basename}>Criar</button></div>
    </form>
  </dialog>;
}
