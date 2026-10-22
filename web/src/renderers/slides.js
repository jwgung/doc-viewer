import { parse, renderSlideToSvg, slideText, WrongPasswordError } from '@web-ppt/core';
import { attachMediaPlayers } from '../media-player.js';
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

const NOTES_PART = new TextEncoder().encode('ppt/notesSlides/');

/**
 * 노트가 있는지. pptx는 슬라이드를 처음 볼 때 해석하므로 모든 슬라이드를 읽지 않고 ZIP 안에 노트 파일 이름이 있는지만 본다
 * (빈 노트 파일만 있을 수도 있다). ppt는 열 때 다 해석하므로 노트 글자를 바로 본다.
 */
function hasNotes(pres, bytes) {
  if (pres.source !== 'pptx') return pres.slides.some((slide) => slide.notes?.trim());
  outer: for (let i = bytes.indexOf(NOTES_PART[0]); i >= 0; i = bytes.indexOf(NOTES_PART[0], i + 1)) {
    for (let k = 1; k < NOTES_PART.length; k++) if (bytes[i + k] !== NOTES_PART[k]) continue outer;
    return true;
  }
  return false;
}

export async function render(bytes, container, ctx) {
  const pres = await parseWithPassword(bytes, ctx);
  const size = { width: pres.width, height: pres.height };
  const renderInto = async (index, el) => {
    el.innerHTML = renderSlideToSvg(pres, pres.slides[index], { textMode: 'html' });
    // 동영상·소리 자리에 재생 단추를 얹는다(인쇄용 쪽은 빼고). 매체 데이터는 누를 때 만든다.
    if (!el.classList.contains('print-page')) attachMediaPlayers(el, (info) => pres.mediaUrl?.(info) ?? null);
  };
  // pptx 슬라이드는 처음 읽을 때 해석된다(web-ppt lazy). slides.map은 모든 슬라이드를 읽어 다 해석하므로
  // 개수만 쓴다(28장 6.5MB XML 파일에서 첫 슬라이드가 그만큼 늦었다).
  const count = pres.slides.length;
  const viewer = new PagedViewer(container, { count, sizes: Array.from({ length: count }, () => size), renderInto }, { mode: ctx.mode, fit: ctx.fit });
  ctx.setViewer(viewer);
  // 발표자 노트: 노트가 있는 발표 자료만 앱에 알린다(앱이 '발표자 노트' 메뉴를 보인다).
  if (hasNotes(pres, bytes)) ctx.setNotes((index) => pres.slides[index]?.notes);
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
