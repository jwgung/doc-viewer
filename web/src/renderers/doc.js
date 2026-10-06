import { parseMsDoc, renderMsDoc } from '@file-viewer/doc';

export async function render(bytes, container, ctx) {
  const parsed = parseMsDoc(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const rendered = renderMsDoc(parsed);
  const flow = document.createElement('div');
  flow.className = 'flow';
  flow.innerHTML = `<style>${rendered.css}</style><div class="msdoc-root">${rendered.html}</div>`;
  container.appendChild(flow);
  ctx.markFirstPage();
  return { pages: null, extra: { warnings: parsed.warnings?.length ?? 0 } };
}
