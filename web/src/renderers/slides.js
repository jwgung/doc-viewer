import { parse, renderSlideToSvg, slideText, WrongPasswordError } from '@web-ppt/core';
import { PagedViewer } from '../paged-viewer.js';
import { t } from '../strings.js';

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

/**
 * 슬라이드 제목 추정: 자리표시자 종류는 모형에 없으므로 가장 위에 있는 글상자의 첫 줄을 쓴다.
 * 쪽 번호·날짜처럼 숫자·기호만 있는 글상자는 건너뛴다.
 */
function slideTitle(slide) {
  const candidates = [];
  const walk = (elements) => {
    for (const el of elements) {
      if (el.kind === 'group') walk(el.children);
      if (el.kind !== 'shape' || !el.text) continue;
      const text = slideText({ elements: [el] }).trim();
      if (text && !/^[\d\s./:()-]+$/.test(text)) candidates.push({ y: el.y, text });
    }
  };
  walk(slide.elements);
  candidates.sort((a, b) => a.y - b.y);
  return candidates[0]?.text.split('\n')[0].trim().slice(0, 80);
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
  // 목차: 슬라이드마다 제목(맨 위 글상자의 첫 줄). 목차를 열 때 만든다(pptx는 슬라이드를 처음 볼 때 해석하므로).
  ctx.setOutline(async () =>
    pres.slides.map((slide, index) => ({
      title: slideTitle(slide) || t.fallbackSlide(index + 1),
      level: 0,
      page: index + 1,
      go: () => viewer.goTo(index),
    })),
  );
  await viewer.render();
  ctx.markFirstPage();
  addEventListener('pagehide', () => pres.dispose?.(), { once: true });
  return { pages: pres.slides.length, extra: { source: pres.source } };
}
