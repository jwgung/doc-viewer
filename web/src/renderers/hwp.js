import { PagedViewer } from '../paged-viewer.js';
import { connect } from '../worker-client.js';

/**
 * 선택·복사용 글자 층. HWP 쪽은 글자마다 따로 그린 SVG라 그대로 고르면 글자마다 줄이 바뀌므로,
 * 글자 조각(run) 위치에 투명한 글자를 겹치고 SVG 글자는 고르지 못하게 한다(PDF의 텍스트 층과 같은 방식).
 * 폭은 조각마다 실제 폭에 맞춰 가로로 늘이거나 줄인다.
 */
const measure = new OffscreenCanvas(1, 1).getContext('2d');
function textLayer(runs, size, el) {
  const layer = document.createElement('div');
  layer.className = 'hwp-text-layer';
  layer.style.setProperty('--scale', String(el.clientWidth / size.width));
  for (const run of runs) {
    const span = document.createElement('span');
    span.textContent = run.text;
    span.dataset.p = run.p;
    span.style.left = `${(run.x / size.width) * 100}%`;
    span.style.top = `${(run.y / size.height) * 100}%`;
    span.style.fontSize = `calc(var(--scale) * ${run.size}px)`;
    measure.font = `${run.size}px sans-serif`;
    const natural = measure.measureText(run.text).width;
    if (natural > 0 && run.w > 0) span.style.transform = `scaleX(${run.w / natural})`;
    layer.appendChild(span);
  }
  return layer;
}

/**
 * 복사: 고른 글자 층 조각들을 이을 때 같은 문단이면 그대로 잇고(줄바꿈 자리의 띄어쓰기는 조각에 들어 있다),
 * 문단이 바뀌면 줄을 바꾼다. 그래서 여러 줄을 골라도 원문 문단 그대로 붙여 넣어진다.
 */
function copyParagraphs(event) {
  const selection = getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const spans = [...document.querySelectorAll('.hwp-text-layer span')].filter((span) => range.intersectsNode(span));
  if (!spans.length) return;
  let text = '';
  let previous = null;
  for (const span of spans) {
    const content = span.textContent;
    const start = span.contains(range.startContainer) ? range.startOffset : 0;
    const end = span.contains(range.endContainer) ? range.endOffset : content.length;
    if (previous !== null && previous !== span.dataset.p) text += '\n';
    text += content.slice(start, end);
    previous = span.dataset.p;
  }
  event.clipboardData.setData('text/plain', text);
  event.preventDefault();
}

/**
 * 쪽 SVG의 id를 쪽마다 다르게 바꾼다. rhwp는 쪽마다 id를 새로 매겨(cell-clip-6 등) 여러 쪽을 한 문서에 넣으면
 * 같은 id가 되풀이되고, url(#id)는 문서에서 먼저 나온 요소를 가리켜 2쪽 상자가 1쪽의 자르기 영역으로 잘렸다.
 */
let svgSerial = 0;
function uniqueIds(svg) {
  const prefix = `s${++svgSerial}-`;
  return svg
    .replace(/\bid="([^"]+)"/g, (_, id) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${prefix}${id})`)
    .replace(/\bhref="#([^"]+)"/g, (_, id) => `href="#${prefix}${id}"`);
}

export async function render(bytes, container, ctx) {
  const worker = new Worker(new URL('../workers/hwp-worker.js', import.meta.url), { type: 'module' });
  const request = connect(worker);
  let opened = await request({ type: 'open', bytes: bytes.buffer }, 'opened', [bytes.buffer]);
  // 암호 문서: 암호를 묻고, 틀리면 다시 묻는다. 취소하면 askPassword가 실패를 던진다.
  for (let incorrect = false; opened.needsPassword || opened.wrongPassword; incorrect = true) {
    const password = await ctx.askPassword(incorrect);
    opened = await request({ type: 'unlock', password }, 'opened');
  }
  const firstSvg = {};
  const renderInto = async (index, el) => {
    el.classList.add('hwp-page');
    const page = await request({ type: 'page', index }, 'page');
    const t0 = performance.now();
    el.innerHTML = uniqueIds(page.svg);
    if (firstSvg.renderMs === undefined) Object.assign(firstSvg, { renderMs: page.renderMs, insertMs: Math.round(performance.now() - t0), svgKb: Math.round(page.svg.length / 1024) });
    // 글자 층은 그림을 보인 뒤에 붙인다(첫 쪽을 늦추지 않게).
    request({ type: 'layout', index }, 'layout')
      .then(({ runs }) => {
        if (runs.length && el.isConnected) el.appendChild(textLayer(runs, opened.sizes[index], el));
      })
      .catch(() => {});
  };
  document.addEventListener('copy', copyParagraphs);
  const viewer = new PagedViewer(container, { count: opened.pages, sizes: opened.sizes, renderInto }, { mode: ctx.mode, fit: ctx.fit });
  ctx.setViewer(viewer);
  // 검색: 쪽 SVG의 글자(화면에 그린 글자와 같은 방식). 큰 문서는 쪽마다 조판 결과를 그려야 해서 시간이 걸린다.
  ctx.setTextSource(async (index) => (await request({ type: 'text', index }, 'text')).text);
  await viewer.render();
  ctx.markFirstPage();
  // 첫 쪽을 그린 뒤에 묻는다(워커는 요청을 차례로 처리하므로 첫 쪽 앞에 끼어들지 않게).
  // 목차: 개요 번호가 붙은 문단. 가장 높은 단계를 0으로 맞춘다.
  request({ type: 'outline' }, 'outline')
    .then(({ items }) => {
      if (!items.length) return;
      const top = Math.min(...items.map((item) => item.level));
      ctx.setOutline(async () =>
        items.map((item) => ({
          title: `${item.number ?? ''} ${item.title ?? ''}`.trim(),
          level: item.level - top,
          page: item.page + 1,
          go: () => viewer.goTo(item.page),
        })),
      );
    })
    .catch(() => {});
  addEventListener('pagehide', () => worker.terminate(), { once: true });
  return { pages: opened.pages, extra: { wasmMemoryBytes: opened.wasmMemoryBytes, ...opened.timing, firstSvg } };
}
