import { parse, renderSlideToSvg } from '@web-ppt/core';
import { mountLazyPages } from '../lazy-pages.js';

export async function render(bytes, container, ctx) {
  const pres = await parse(bytes);
  const size = { width: pres.width, height: pres.height };
  mountLazyPages(
    container,
    pres.slides.map(() => size),
    (i) => renderSlideToSvg(pres, pres.slides[i], { textMode: 'html' }),
  );
  ctx.markFirstPage();
  addEventListener('pagehide', () => pres.dispose?.(), { once: true });
  return { pages: pres.slides.length, extra: { source: pres.source } };
}
