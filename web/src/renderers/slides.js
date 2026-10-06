import { parse, renderSlideToSvg } from '@web-ppt/core';
import { PagedViewer } from '../paged-viewer.js';

export async function render(bytes, container, ctx) {
  const pres = await parse(bytes);
  const size = { width: pres.width, height: pres.height };
  const renderInto = async (index, el) => {
    el.innerHTML = renderSlideToSvg(pres, pres.slides[index], { textMode: 'html' });
  };
  const viewer = new PagedViewer(container, { count: pres.slides.length, sizes: pres.slides.map(() => size), renderInto }, { mode: ctx.mode, fit: ctx.fit });
  ctx.setViewer(viewer);
  await viewer.render();
  ctx.markFirstPage();
  addEventListener('pagehide', () => pres.dispose?.(), { once: true });
  return { pages: pres.slides.length, extra: { source: pres.source } };
}
