import { t } from '../strings.js';
import { connect } from '../worker-client.js';

export async function render(bytes, container, ctx) {
  const worker = new Worker(new URL('../workers/sheet-worker.js', import.meta.url), { type: 'module' });
  const request = connect(worker);
  const opened = await request({ type: 'open', fmt: ctx.fmt, bytes: bytes.buffer }, 'opened', [bytes.buffer]);
  addEventListener('pagehide', () => worker.terminate(), { once: true });

  const tabs = document.createElement('nav');
  tabs.className = 'sheet-tabs';
  tabs.hidden = opened.names.length < 2;
  const body = document.createElement('div');
  body.className = 'sheet-body';
  const note = document.createElement('p');
  note.className = 'sheet-note';
  container.append(tabs, body, note);

  const show = (index, view) => {
    tabs.querySelectorAll('button').forEach((button, i) => button.setAttribute('aria-selected', String(i === index)));
    body.innerHTML = view.html;
    note.textContent =
      view.totalRows > view.shownRows
        ? t.rowsLimited(view.shownRows.toLocaleString(), view.totalRows.toLocaleString())
        : '';
  };
  opened.names.forEach((name, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.addEventListener('click', async () => show(index, await request({ type: 'sheet', index }, 'sheet')));
    tabs.appendChild(button);
  });
  show(0, opened.first);
  ctx.markFirstPage();
  return { pages: opened.names.length };
}
