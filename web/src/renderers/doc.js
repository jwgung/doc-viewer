import { formatPageNumber, parseMsDoc, renderMsDoc } from '@file-viewer/doc/core';
import { placePage } from '../fit-page.js';
import { HTML_PRINT_LIMIT, createPager, fillPages, loadPage } from '../paginate.js';
import { PagedViewer } from '../paged-viewer.js';
import './doc.css';

// 구형 Word(.doc). 렌더러가 쪽 나누기·새 쪽 구역 나누기로 나눈 쪽을 다시 용지 높이로 나눠(자동 쪽 나눔, paginate.js)
// 쪽 뷰어에 넘긴다. 쪽은 구역의 용지 크기·여백으로 그리고, 쪽마다 그 구역의 머리말·꼬리말(첫 쪽·기본·짝수 쪽)과
// 쪽 번호를 새로 넣는다. 각주는 참조한 원래 쪽(쪽 나누기 단위)의 끝에, 미주는 마지막 쪽에 둔다.

// 문서에 용지·여백이 없을 때 쓰는 Word 기본값(twips): Letter 8.5×11in, 좌우 1.25in, 위아래 1in.
const DEFAULT_PAPER = { width: 12240, height: 15840, left: 1800, right: 1800, top: 1440, bottom: 1440 };
const TWIPS_PER_PX = 15;

export async function render(bytes, container, ctx) {
  const parsed = parseMsDoc(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const rendered = renderMsDoc(parsed);
  // 쪽 뷰어가 문서 영역을 비우고 다시 채우므로 스타일은 문서 영역 밖에 둔다.
  const style = document.createElement('style');
  style.textContent = rendered.css;
  document.head.appendChild(style);
  const holder = document.createElement('div');
  holder.className = 'offscreen';
  document.body.appendChild(holder);
  await document.fonts.ready;

  const pager = createPager(pageElements(rendered, parsed.sections ?? [], holder));
  const sizes = [];
  const sync = () => {
    for (let index = sizes.length; index < pager.pages.length; index++) sizes.push(pager.pages[index].size);
  };
  // 첫 쪽(이어보기면 그 쪽까지)만 먼저 나눈다. 나머지는 첫 쪽을 보인 뒤 쉬는 틈에 나눈다.
  // 두 쪽씩 보기면 첫 화면에 짝 쪽까지 나눠 둔다.
  await pager.fill((ctx.startPage ?? 0) + (ctx.mode === 'spread' ? 2 : 1));
  sync();

  /** 보관한 쪽을 요소로 되살린다. 전체 쪽 수 필드는 다 센 뒤에만 채운다. */
  const pageAt = (index) => {
    const page = loadPage(pager.pages[index].saved);
    if (pager.done) page.querySelectorAll('[data-field="numpages"]').forEach((field) => setField(field, String(sizes.length)));
    return page;
  };
  let viewer = null;
  const doc = {
    get count() {
      return sizes.length;
    },
    get complete() {
      return pager.done;
    },
    paginated: pager.finished,
    printLimit: HTML_PRINT_LIMIT,
    sizes,
    measure: (index) => sizes[index],
    renderInto: async (index, el) => placePage(pageAt(index), index, el, sizes, viewer),
  };
  viewer = new PagedViewer(container, doc, { mode: ctx.mode, fit: ctx.fit });
  ctx.setViewer(viewer);
  // 검색: 보관한 쪽의 글자. template 안에서는 그림을 불러오지 않는다.
  const template = document.createElement('template');
  ctx.setTextSource(async (index) => {
    template.innerHTML = pager.pages[index].saved;
    return template.content.textContent;
  });
  await viewer.render();
  ctx.markFirstPage();
  pager.background(() => {
    sync();
    viewer.grow();
    if (pager.done) {
      // 다 셌으면 이미 그린 쪽의 전체 쪽 수 필드도 고친다.
      container.querySelectorAll('[data-field="numpages"]').forEach((field) => setField(field, String(sizes.length)));
      holder.remove();
    }
  }, () => viewer.settled());
  return {
    pages: sizes.length,
    extra: { warnings: parsed.warnings?.length ?? 0, wordVersion: parsed.meta?.fib?.version ?? null, docSegments: rendered.pages?.length ?? 1 },
  };
}

/**
 * 렌더러가 나눈 쪽(쪽 나누기 단위)마다 본문 블록을 용지 높이로 채워 쪽 요소를 차례로 내놓는다.
 * 쪽 번호는 구역 설정(다시 시작·시작 번호·서식)을 따라 나눈 쪽마다 매긴다.
 */
async function* pageElements(rendered, sections, holder) {
  const segments = rendered.pages?.length ? rendered.pages : [{ html: rendered.html, sectionIndex: 0, firstOfSection: true }];
  const kinds = rendered.sectionHeaders ?? [];
  let pageNumber = 0;
  for (const segment of segments) {
    const section = sections[segment.sectionIndex];
    const headers = kinds[segment.sectionIndex];
    const paper = paperOf(section);
    const template = document.createElement('template');
    template.innerHTML = segment.bodyHtml ?? segment.html;
    let first = true;
    const shell = () => {
      const firstOfSection = first && segment.firstOfSection !== false;
      if (firstOfSection && section?.pageNumberRestart) pageNumber = (section.pageNumberStart ?? 1) - 1;
      pageNumber += 1;
      // 머리말·꼬리말: 구역 첫 쪽(첫 쪽 다르게 설정)·짝수 쪽·기본 중에서 고른다(Word와 같다).
      const pick = (map) => (headers.titlePage && firstOfSection ? map.first : map.even && pageNumber % 2 === 0 ? map.even : map.default) ?? '';
      const header = headers ? pick(headers.header) : first ? (segment.headerHtml ?? '') : '';
      const footer = headers ? pick(headers.footer) : first ? (segment.footerHtml ?? '') : '';
      first = false;
      const card = pageCard(paper, header, footer);
      const label = formatPageNumber(pageNumber, section?.pageNumberFormat ?? 0) || String(pageNumber);
      card.querySelectorAll('[data-field="page"]').forEach((field) => setField(field, label));
      holder.appendChild(card);
      return { page: card, body: card.querySelector('.doc-page-body') };
    };
    yield* fillPages([...template.content.childNodes], shell);
  }
}

/** 필드 자리의 글자를 바꾼다(글자 모양을 담은 span은 그대로 둔다). */
function setField(field, text) {
  const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
  const first = walker.nextNode();
  if (!first) {
    field.textContent = text;
    return;
  }
  first.data = text;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) node.data = '';
}

/** 구역의 용지 크기와 여백(px). 값이 없거나 터무니없으면 Word 기본값을 쓴다. */
function paperOf(section) {
  // 22인치(31680twips)를 넘는 값은 깨진 값으로 본다.
  const twips = (value, fallback) => (value > 0 && value < 31680 ? value : fallback);
  const width = twips(section?.pageWidthTwips, DEFAULT_PAPER.width) / TWIPS_PER_PX;
  const height = twips(section?.pageHeightTwips, DEFAULT_PAPER.height) / TWIPS_PER_PX;
  // 여백이 용지를 거의 다 차지하는 문서가 있어 한쪽 여백은 용지의 30%까지만 쓴다.
  const margin = (value, fallback, of) => Math.round(Math.min(twips(value, fallback) / TWIPS_PER_PX, of * 0.3));
  return {
    width: Math.round(width),
    height: Math.round(height),
    left: margin(section?.marginLeftTwips, DEFAULT_PAPER.left, width),
    right: margin(section?.marginRightTwips, DEFAULT_PAPER.right, width),
    top: margin(section?.marginTopTwips, DEFAULT_PAPER.top, height),
    bottom: margin(section?.marginBottomTwips, DEFAULT_PAPER.bottom, height),
  };
}

/**
 * 빈 쪽: 용지 크기(높이는 최소값)와 여백, 위에서부터 머리말·본문·꼬리말. 꼬리말은 용지 아래쪽에 붙는다.
 * 렌더러 CSS가 .msdoc-root 아래에 걸려 있으므로 셋 다 .msdoc-root로 감싼다.
 */
function pageCard(paper, headerHtml, footerHtml) {
  const card = document.createElement('div');
  card.className = 'doc-page';
  card.style.width = `${paper.width}px`;
  card.style.minHeight = `${paper.height}px`;
  card.style.padding = `${paper.top}px ${paper.right}px ${paper.bottom}px ${paper.left}px`;
  card.innerHTML =
    `<div class="msdoc-root doc-page-top">${headerHtml}</div>` +
    '<div class="msdoc-root doc-page-body"></div>' +
    `<div class="msdoc-root doc-page-bottom">${footerHtml}</div>`;
  return card;
}
