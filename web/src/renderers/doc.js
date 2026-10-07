import { parseMsDoc, renderMsDoc } from '@file-viewer/doc/core';
import { PagedViewer } from '../paged-viewer.js';
import './doc.css';

// 구형 Word(.doc). 명시적 쪽 나누기·새 쪽 구역 나누기마다 한 쪽으로 나누고, 쪽마다 그 구역의 머리말·꼬리말과
// 그 쪽에서 참조한 각주를 넣는다(미주는 마지막 쪽). 쪽은 구역의 용지 크기·여백으로 그려 쪽 뷰어에 넘기므로
// 쪽 번호·쪽 이동·한 쪽씩/두 쪽씩 보기가 다른 형식과 같다. 쪽은 화면에 들어올 때 만든다.
// 글자 흐름에 따른 자동 쪽 나눔은 하지 않는다. 그래서 내용이 용지보다 긴 쪽은 용지보다 길게 그린다.

// 문서에 용지·여백이 없을 때 쓰는 Word 기본값(twips): Letter 8.5×11in, 좌우 1.25in, 위아래 1in.
const DEFAULT_PAPER = { width: 12240, height: 15840, left: 1800, right: 1800, top: 1440, bottom: 1440 };
const TWIPS_PER_PX = 15;
// 크기를 재 두고 아직 화면에 달지 않은 쪽을 이만큼만 들고 있는다(한 쪽씩·두 쪽씩 보기가 재고 곧 그린다).
const KEEP_MEASURED = 4;

export async function render(bytes, container, ctx) {
  const parsed = parseMsDoc(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const rendered = renderMsDoc(parsed);
  // 쪽 뷰어가 문서 영역을 비우고 다시 채우므로 스타일은 문서 영역 밖에 둔다.
  const style = document.createElement('style');
  style.textContent = rendered.css;
  document.head.appendChild(style);
  const pages = rendered.pages?.length ? rendered.pages : [{ html: rendered.html, sectionIndex: 0 }];
  const papers = pages.map((page) => paperOf(parsed.sections?.[page.sectionIndex]));
  // 쪽 크기는 용지 크기로 시작하고, 쪽을 만들어 재면 실제 크기(내용이 길면 더 길다)로 바꾼다.
  const sizes = papers.map(({ width, height }) => ({ width, height }));
  const holder = document.createElement('div');
  holder.className = 'offscreen';
  document.body.appendChild(holder);
  const measured = new Map(); // 쪽 번호 → 화면 밖에서 재 둔 쪽 요소
  // 쪽 크기는 배치 크기로 잰다. transform으로 줄인 뒤에도 같으므로 쪽 칸 안에서 재도 된다.
  const sizeOf = (card) => ({ width: card.offsetWidth, height: card.offsetHeight });

  let viewer = null;
  const doc = {
    count: pages.length,
    sizes,
    // 한 쪽씩·두 쪽씩 보기가 쪽 칸을 잡기 전에 실제 크기를 묻는다.
    measure: (index) => {
      if (!measured.has(index)) {
        if (measured.size >= KEEP_MEASURED) {
          measured.forEach((card) => card.remove());
          measured.clear();
        }
        const card = pageCard(pages[index], papers[index]);
        holder.appendChild(card);
        sizes[index] = sizeOf(card);
        measured.set(index, card);
      }
      return sizes[index];
    },
    renderInto: async (index, el) => {
      const card = measured.get(index) ?? pageCard(pages[index], papers[index]);
      measured.delete(index);
      el.replaceChildren(card);
      sizes[index] = sizeOf(card);
      const place = () => {
        viewer?.resizePage(index, sizes[index]); // 연속 스크롤 칸을 실제 크기로
        // 칸 폭에 맞춰 줄인다. zoom은 작은 글자로 줄을 다시 나눠 쪽이 길어지고 끝이 잘리므로, 배치를 그대로 두는 transform을 쓴다.
        card.style.transform = `scale(${el.clientWidth / sizes[index].width})`;
      };
      place();
      // 크기 정보가 없는 그림은 풀리기 전 높이가 0이다. 글자를 먼저 보이고, 그림이 자리 잡으면 다시 재서 칸을 바로잡는다.
      const images = [...card.querySelectorAll('img')];
      if (!images.length) return;
      Promise.all(images.map((img) => img.decode().catch(() => {}))).then(() => {
        if (!card.isConnected || card.offsetHeight === sizes[index].height) return;
        sizes[index] = sizeOf(card);
        // 한 쪽씩·두 쪽씩 칸은 쪽 뷰어가 잡은 크기라 높이만 같은 비율로 바로잡는다.
        if (viewer?.mode !== 'scroll') el.style.height = `${Math.floor((sizes[index].height * el.clientWidth) / sizes[index].width)}px`;
        place();
      });
    },
    // 인쇄: 쪽마다 새 용지에서 시작하고, 용지보다 긴 쪽은 줄이지 않고 다음 장으로 잇는다(쪽 뷰어 기본 인쇄는 한 장에 줄여 넣는다).
    printInto: async (root) => {
      const cards = pages.map((page, index) => root.appendChild(pageCard(page, papers[index])));
      await Promise.all(cards.flatMap((card) => [...card.querySelectorAll('img')].map((img) => img.decode().catch(() => {}))));
      return { width: papers[0].width, height: papers[0].height };
    },
  };
  viewer = new PagedViewer(container, doc, { mode: ctx.mode, fit: ctx.fit });
  ctx.setViewer(viewer);
  // 검색: 쪽 HTML의 글자. template 안에서는 그림을 불러오지 않는다.
  const template = document.createElement('template');
  ctx.setTextSource(async (index) => {
    template.innerHTML = pages[index].html;
    return template.content.textContent;
  });
  await viewer.render();
  ctx.markFirstPage();
  return {
    pages: pages.length,
    extra: { warnings: parsed.warnings?.length ?? 0, wordVersion: parsed.meta?.fib?.version ?? null },
  };
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
 * 한 쪽: 용지 크기(높이는 최소값)와 여백으로 그린다. 꼬리말은 본문이 짧아도 용지 아래쪽에 붙인다.
 * 렌더러 CSS가 .msdoc-root 아래에 걸려 있으므로 꼬리말도 .msdoc-root로 따로 감싼다.
 */
function pageCard(page, paper) {
  const card = document.createElement('div');
  card.className = 'doc-page';
  card.style.width = `${paper.width}px`;
  card.style.minHeight = `${paper.height}px`;
  card.style.padding = `${paper.top}px ${paper.right}px ${paper.bottom}px ${paper.left}px`;
  const body = document.createElement('div');
  body.className = 'msdoc-root';
  body.innerHTML = page.html;
  card.appendChild(body);
  const footer = body.querySelector(':scope > .msdoc-footer');
  if (footer) {
    const bottom = document.createElement('div');
    bottom.className = 'msdoc-root doc-page-bottom';
    bottom.appendChild(footer);
    card.appendChild(bottom);
  }
  return card;
}
