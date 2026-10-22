import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PagedViewer } from '../paged-viewer.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** 책갈피 나무를 목차 항목 목록으로 편다. 대상이 이름이면 실제 위치로 바꾸고, 쪽 번호를 찾는다. */
async function outlineItems(pdf, outline, viewer) {
  const items = [];
  const walk = async (nodes, level) => {
    for (const node of nodes) {
      let index = null;
      try {
        const dest = typeof node.dest === 'string' ? await pdf.getDestination(node.dest) : node.dest;
        if (Array.isArray(dest) && dest[0] != null) index = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
      } catch {
        // 대상이 깨진 책갈피는 이동 없이 제목만 보인다.
      }
      items.push({ title: node.title, level, page: index === null ? undefined : index + 1, go: () => index !== null && viewer.goTo(index) });
      if (node.items?.length) await walk(node.items, level + 1);
    }
  };
  await walk(outline, 0);
  return items;
}

// 이보다 큰 PDF는 통째로 읽지 않고 필요한 구간만 앱에 달라고 한다(172MB 책이 열리는 데 6초 넘게 걸렸다).
const RANGE_MIN_BYTES = 4 * 1024 * 1024;
const RANGE_CHUNK_BYTES = 1024 * 1024;
// 한 쪽씩·두 쪽씩 보기에서 미리 그려 둘 넘김 수
const AHEAD_FLIPS = 2;

/**
 * 구간 읽기: 앱이 문서 길이를 알려 주면(파일처럼 건너뛰며 읽을 수 있는 문서) pdf.js가 필요한 구간만 받게 한다.
 * 주고받는 횟수를 줄이려고 구간을 1MB씩 받는다. 한 쪽씩 보기에서는 다음 쪽들을 미리 그려 둔다(drawAhead).
 * 길이를 모르면(스트림만 주는 주소) null — 통째로 읽는다.
 */
async function rangeSource(src) {
  const response = await fetch(`${src}?length`).catch(() => null);
  const length = response?.ok ? Number(await response.text()) : NaN;
  if (!(length >= RANGE_MIN_BYTES)) return null;
  const transport = new pdfjs.PDFDataRangeTransport(length, null);
  transport.requestDataRange = (begin, end) => {
    fetch(`${src}?start=${begin}&end=${end}`)
      .then((r) => {
        if (!r.ok) throw new Error(`구간 읽기 실패 (${r.status})`);
        return r.arrayBuffer();
      })
      .then((buffer) => transport.onDataRange(begin, new Uint8Array(buffer)))
      .catch((error) => console.warn('PDF 구간 읽기 실패:', error));
  };
  return { range: transport, length, rangeChunkSize: RANGE_CHUNK_BYTES, disableAutoFetch: true };
}

/** bytes가 없으면(main.js의 SELF_READING) ctx.src에서 읽는다(큰 PDF는 구간 읽기). 문서 크기를 돌려준다. */
async function source(bytes, ctx) {
  if (bytes) return [{ data: bytes }, bytes.length];
  const ranged = await rangeSource(ctx.src);
  if (ranged) return [ranged, ranged.length];
  const data = await ctx.fetchAll();
  return [{ data }, data.length];
}

export async function render(bytes, container, ctx) {
  const [input, size] = await source(bytes, ctx);
  const task = pdfjs.getDocument({
    ...input,
    cMapUrl: './cmaps/',
    cMapPacked: true,
    wasmUrl: './pdf-wasm/', // JPEG 2000·JBIG2 그림 디코더
    isEvalSupported: false,
    enableXfa: false,
    // 내장하지 않은 표준 글꼴은 기기 글꼴로 대신한다(표준 글꼴 파일 820KB를 넣지 않는다).
    useSystemFonts: true,
  });
  task.onPassword = (update, reason) =>
    ctx.askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD).then(update, () => task.destroy());
  const pdf = await task.promise;
  const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
  // 모든 쪽 크기를 미리 읽으면 큰 PDF에서 느리므로 첫 쪽 크기로 자리를 잡고, 그릴 때 바로잡는다.
  const sizes = Array.from({ length: pdf.numPages }, () => ({ width: first.width, height: first.height }));

  /** 그 쪽을 scale(CSS 픽셀/PDF 단위)로 캔버스에 그린다. */
  const paint = async (page, index, scale) => {
    const canvas = document.createElement('canvas');
    const pixels = page.getViewport({ scale: scale * devicePixelRatio });
    canvas.width = Math.floor(pixels.width);
    canvas.height = Math.floor(pixels.height);
    try {
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: pixels }).promise;
    } catch (error) {
      // 그리다 만 쪽(글자 하나·그림 하나 오류)은 거기까지 그린 그림을 보여 준다. 첫 쪽에서 나면 문서 전체가 열리지 않았다.
      if (error?.name === 'RenderingCancelledException') throw error;
      console.warn(`PDF ${index + 1}쪽을 끝까지 그리지 못함:`, error);
    }
    return canvas;
  };

  // 한 쪽씩·두 쪽씩 보기: 지금 쪽을 다 그리고 스크롤이 멈추면 다음 쪽들(AHEAD_FLIPS번 넘길 만큼)을 차례로 미리 그려 둔다.
  // 큰 그림(JPEG 2000)이 많은 쪽은 태블릿(SM-P200)에서 그리는 데 2초 넘게 걸려 넘길 때마다 빈 쪽이 보였다.
  // 구간 읽기면 그 쪽 데이터도 이때 받는다.
  const ahead = new Map(); // 쪽 번호 → { width(CSS 폭), canvas: Promise<canvas> }
  const drawAhead = async (index, width) => {
    if (index >= pdf.numPages || ahead.has(index)) return;
    // 지금 쪽에서 멀어진 것은 버린다(캔버스 메모리).
    for (const i of ahead.keys()) if (Math.abs(i - viewer.current) > 2 * (AHEAD_FLIPS + 1)) ahead.delete(i);
    const canvas = (async () => {
      const page = await pdf.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const drawn = await paint(page, index, width / base.width);
      page.cleanup();
      return drawn;
    })();
    ahead.set(index, { width, canvas });
    await canvas.catch(() => {});
  };

  const renderInto = async (index, el) => {
    const page = await pdf.getPage(index + 1);
    // 그 사이 화면에서 빠진 쪽(넘기기·보기 바꿈)은 그리지 않는다.
    if (!el.isConnected) return;
    const base = page.getViewport({ scale: 1 });
    if (base.width !== sizes[index].width || base.height !== sizes[index].height) {
      // 자리는 첫 쪽 크기로 잡아 두었다. 크기가 다른 쪽이면 자리를 고친다: 연속 스크롤은 그 칸만,
      // 한 쪽씩·두 쪽씩은 칸 크기를 고정해 두었으므로 고친 크기로 다시 배치한다(이 칸에는 그리지 않는다).
      sizes[index] = { width: base.width, height: base.height };
      if (viewer.mode === 'scroll') viewer.resizePage(index, sizes[index]);
      else if (el.isConnected) {
        viewer.renderFlip();
        return;
      }
    }
    const scale = el.clientWidth / base.width;
    const early = ahead.get(index);
    ahead.delete(index);
    const canvas = (early?.width === el.clientWidth && (await early.canvas.catch(() => null))) || (await paint(page, index, scale));
    // 글자 위치에 투명한 텍스트를 겹쳐 길게 눌러 선택·복사할 수 있게 한다.
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    el.style.setProperty('--scale-factor', String(scale));
    el.style.setProperty('--total-scale-factor', String(scale));
    el.replaceChildren(canvas, textLayer);
    // 그림이 보이면 첫 쪽으로 알린다(스피너를 걷는다). 글자 층은 그 뒤에 붙고, 검색은 이 함수가 끝나기를 기다린다.
    ctx.markFirstPage();
    // 글자 층(글자 수천 개를 겹쳐 놓는다)은 스크롤이 멈춘 뒤 만든다: 넘기는 동안 만들면 화면이 멈칫거렸다.
    await viewer.settled();
    if (!textLayer.isConnected) {
      page.cleanup();
      return;
    }
    // 스크롤이 멈춘 지금 다음 쪽들을 미리 그린다. 연속 스크롤은 둘레 쪽을 이미 그린다.
    if (viewer.mode !== 'scroll') {
      const step = viewer.mode === 'spread' ? 2 : 1;
      if (index === viewer.current + step - 1) {
        const width = el.clientWidth;
        (async () => {
          for (let k = 1; k <= step * AHEAD_FLIPS; k++) await drawAhead(index + k, width);
        })();
      }
    }
    await new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayer,
      viewport: page.getViewport({ scale }),
    })
      .render()
      .catch((error) => console.warn(`PDF ${index + 1}쪽 글자 층을 만들지 못함:`, error));
    page.cleanup();
  };

  const viewer = new PagedViewer(container, { count: pdf.numPages, sizes, renderInto }, { mode: ctx.mode, fit: ctx.fit });
  ctx.setViewer(viewer);
  // 검색: 쪽 글자를 텍스트 층과 같은 방식(항목을 그대로 이어 붙임)으로 만들어, 그린 뒤 찾은 위치와 맞춘다.
  ctx.setTextSource(async (index) => {
    const content = await (await pdf.getPage(index + 1)).getTextContent();
    return content.items.map((item) => item.str ?? '').join('');
  });
  await viewer.render();
  ctx.markFirstPage();
  // 목차: PDF 책갈피. 대상 쪽은 목차를 열 때 찾는다.
  pdf
    .getOutline()
    .then((outline) => {
      if (outline?.length) ctx.setOutline(() => outlineItems(pdf, outline, viewer));
    })
    .catch(() => {});
  // pdf.js 6의 문서 객체에는 destroy가 없어 불러오기 작업으로 정리한다.
  addEventListener('pagehide', () => task.destroy(), { once: true });
  return { pages: pdf.numPages, bytes: size, extra: { ranged: !!input.range } };
}
