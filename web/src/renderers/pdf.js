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

export async function render(bytes, container, ctx) {
  const task = pdfjs.getDocument({
    data: bytes,
    cMapUrl: './cmaps/',
    cMapPacked: true,
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

  const renderInto = async (index, el) => {
    const page = await pdf.getPage(index + 1);
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
    const canvas = document.createElement('canvas');
    const pixels = page.getViewport({ scale: scale * devicePixelRatio });
    canvas.width = Math.floor(pixels.width);
    canvas.height = Math.floor(pixels.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: pixels }).promise;
    // 글자 위치에 투명한 텍스트를 겹쳐 길게 눌러 선택·복사할 수 있게 한다.
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    el.style.setProperty('--scale-factor', String(scale));
    el.style.setProperty('--total-scale-factor', String(scale));
    el.replaceChildren(canvas, textLayer);
    // 그림이 보이면 첫 쪽으로 알린다(스피너를 걷는다). 글자 층은 그 뒤에 붙고, 검색은 이 함수가 끝나기를 기다린다.
    ctx.markFirstPage();
    await new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayer,
      viewport: page.getViewport({ scale }),
    }).render();
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
  addEventListener('pagehide', () => pdf.destroy(), { once: true });
  return { pages: pdf.numPages };
}
