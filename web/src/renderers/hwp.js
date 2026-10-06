import { mountLazyPages } from '../lazy-pages.js';
import { connect } from '../worker-client.js';

export async function render(bytes, container, ctx) {
  const worker = new Worker(new URL('../workers/hwp-worker.js', import.meta.url), { type: 'module' });
  const request = connect(worker);
  const opened = await request({ type: 'open', bytes: bytes.buffer }, 'opened', [bytes.buffer]);
  await mountLazyPages(container, opened.sizes, async (index) => (await request({ type: 'page', index }, 'page')).svg);
  ctx.markFirstPage();
  addEventListener('pagehide', () => worker.terminate(), { once: true });
  return { pages: opened.pages, extra: { wasmMemoryBytes: opened.wasmMemoryBytes } };
}
