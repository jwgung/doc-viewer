import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PagedViewer } from '../paged-viewer.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

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
      sizes[index] = { width: base.width, height: base.height };
      if (el.style.aspectRatio) el.style.aspectRatio = `${base.width} / ${base.height}`;
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
    await new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayer,
      viewport: page.getViewport({ scale }),
    }).render();
    page.cleanup();
  };

  const viewer = new PagedViewer(container, { count: pdf.numPages, sizes, renderInto }, { mode: ctx.mode });
  ctx.setViewer(viewer);
  await viewer.render();
  ctx.markFirstPage();
  addEventListener('pagehide', () => pdf.destroy(), { once: true });
  return { pages: pdf.numPages };
}
