import { useEffect, useRef } from 'react';

export function DeleteScriptModal({ name, onCancel, onDelete }: { name: string; onCancel: () => void; onDelete: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previousOverflow = document.body.style.overflow;
    element.showModal(); document.body.style.overflow = 'hidden';
    return () => { element.close(); document.body.style.overflow = previousOverflow; };
  }, []);
  return <dialog ref={dialog} className="new-script-dialog delete-script-dialog" aria-labelledby="delete-script-title" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <div className="dialog-heading"><h2 id="delete-script-title">Excluir script?</h2></div>
    <p className="delete-description">O script <strong>{name}</strong> e seu código salvo serão removidos deste navegador.</p>
    <div className="dialog-actions"><button type="button" autoFocus onClick={onCancel}>Cancelar</button><button type="button" className="danger" onClick={onDelete}>Excluir</button></div>
  </dialog>;
}
