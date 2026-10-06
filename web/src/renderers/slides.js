import { parse, renderSlideToSvg, slideText, WrongPasswordError } from '@web-ppt/core';
import { PagedViewer } from '../paged-viewer.js';

/**
 * 암호 걸린 .ppt(RC4 CryptoAPI)는 web-ppt가 암호를 받아 푼다. 암호가 필요하면 묻고, 틀리면 다시 묻는다.
 * (암호 걸린 .pptx는 main.js가 먼저 풀어서 넘긴다.)
 */
async function parseWithPassword(bytes, ctx) {
  try {
    return await parse(bytes);
  } catch (error) {
    if (!String(error?.message).includes('提供打开密码')) throw error;
  }
  for (let incorrect = false; ; incorrect = true) {
    const password = await ctx.askPassword(incorrect);
    try {
      return await parse(bytes, { password });
    } catch (error) {
      if (!(error instanceof WrongPasswordError)) throw error;
    }
  }
}

export async function render(bytes, container, ctx) {
  const pres = await parseWithPassword(bytes, ctx);
  const size = { width: pres.width, height: pres.height };
  const renderInto = async (index, el) => {
    el.innerHTML = renderSlideToSvg(pres, pres.slides[index], { textMode: 'html' });
  };
  const viewer = new PagedViewer(container, { count: pres.slides.length, sizes: pres.slides.map(() => size), renderInto }, { mode: ctx.mode, fit: ctx.fit });
  ctx.setViewer(viewer);
  // 검색: 화면에 그리지 않는 발표자 노트는 빼고 슬라이드 글자만 센다.
  ctx.setTextSource(async (index) => slideText({ ...pres.slides[index], notes: undefined }));
  await viewer.render();
  ctx.markFirstPage();
  addEventListener('pagehide', () => pres.dispose?.(), { once: true });
  return { pages: pres.slides.length, extra: { source: pres.source } };
}
