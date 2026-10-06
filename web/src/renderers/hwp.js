import { PagedViewer } from '../paged-viewer.js';
import { connect } from '../worker-client.js';

export async function render(bytes, container, ctx) {
  const worker = new Worker(new URL('../workers/hwp-worker.js', import.meta.url), { type: 'module' });
  const request = connect(worker);
  const opened = await request({ type: 'open', bytes: bytes.buffer }, 'opened', [bytes.buffer]);
  const renderInto = async (index, el) => {
    el.innerHTML = (await request({ type: 'page', index }, 'page')).svg;
  };
  const viewer = new PagedViewer(container, { count: opened.pages, sizes: opened.sizes, renderInto }, { mode: ctx.mode, fit: ctx.fit });
  ctx.setViewer(viewer);
  await viewer.render();
  ctx.markFirstPage();
  addEventListener('pagehide', () => worker.terminate(), { once: true });
  return { pages: opened.pages, extra: { wasmMemoryBytes: opened.wasmMemoryBytes } };
}
