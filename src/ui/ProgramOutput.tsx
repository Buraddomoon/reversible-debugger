import { useState } from 'react';
import { outputPage } from './output-page';

export function ProgramOutput({ output, testId = 'program-output', comparison = false }: { output: readonly string[]; testId?: string; comparison?: boolean }) {
  // null follows the end as output grows/shrinks; a chosen page stays anchored.
  const [selected, setSelected] = useState<number | null>(null), view = outputPage(output, selected);
  const download = () => {
    const url = URL.createObjectURL(new Blob([output.join('')], { type: 'text/plain;charset=utf-8' })), link = document.createElement('a');
    link.href = url; link.download = 'saida.txt'; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className={comparison ? 'comparison-output' : 'output-panel'} aria-label="Saída do programa" data-output-total={view.total} data-output-page={view.page + 1}>
    <span>SAÍDA</span>
    {view.pages > 1 && <div className="output-navigation" role="group" aria-label="Páginas da saída">
      <button aria-label="Primeira página da saída" disabled={!view.page} onClick={() => setSelected(0)}>Primeira página</button>
      <button aria-label="Página anterior da saída" disabled={!view.page} onClick={() => setSelected(view.page - 1)}>←</button>
      <label>Página <input aria-label="Página da saída" type="number" min={1} max={view.pages} value={view.page + 1} onChange={event => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value >= 1 && value <= view.pages) setSelected(value - 1); }} /> de {view.pages}</label>
      <button aria-label="Próxima página da saída" disabled={view.page === view.pages - 1} onClick={() => setSelected(view.page + 1)}>→</button>
      <button aria-label="Acompanhar fim da saída" aria-pressed={selected === null} onClick={() => setSelected(null)}>Fim</button>
      <button onClick={download}>Baixar saída completa</button>
      <small>{view.total.toLocaleString('pt-BR')} caracteres · {selected === null ? 'acompanhando o fim' : 'página fixa'}</small>
    </div>}
    <pre data-testid={testId}>{view.text || 'Nenhuma saída ainda.'}</pre>
  </section>;
}
