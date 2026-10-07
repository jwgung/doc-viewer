// 인쇄·PDF로 저장. 화면에는 보이는 근처 쪽만 그려 두므로, 인쇄할 때는 모든 쪽을 인쇄용 층에 따로 그린다.
// 앱이 window.viewer.preparePrint()를 부르면 다 그린 뒤 'printReady'를 알리고, 앱이 WebView 인쇄를 시작한다.
// 인쇄가 끝나면 앱이 finishPrint()를 불러 인쇄용 층을 걷어 낸다. 쪽 없는 문서는 화면의 문서를 그대로 인쇄한다.

/** 인쇄용으로 한꺼번에 그리는 쪽 수 상한. 모든 쪽을 동시에 DOM에 두므로 넘으면 렌더러 메모리가 바닥난다. */
export const MAX_PRINT_PAGES = 100;

export class TooManyPagesError extends Error {
  constructor() {
    super('too many pages to print');
    this.name = 'TooManyPagesError';
  }
}

/** @returns {Promise<{width: number, height: number} | null>} 첫 쪽 크기(앱이 용지 방향을 고르는 데 쓴다) */
export async function preparePrint(viewer) {
  finishPrint(null);
  if (viewer && viewer.doc.count > MAX_PRINT_PAGES) throw new TooManyPagesError();
  document.body.classList.add('printing');
  if (!viewer) return null;
  const root = document.createElement('div');
  root.className = 'print-root';
  document.body.appendChild(root);
  let first = null;
  for (let index = 0; index < viewer.doc.count; index++) {
    const size = viewer.doc.measure?.(index) ?? viewer.doc.sizes[index];
    first ??= size;
    const page = document.createElement('div');
    page.className = 'page print-page';
    page.style.aspectRatio = `${size.width} / ${size.height}`;
    page.style.setProperty('--ratio', String(size.width / size.height));
    root.appendChild(page);
    await viewer.doc.renderInto(index, page);
  }
  return first;
}

/** 인쇄용 층을 걷어 낸다. 쪽 요소를 옮겨 다는 렌더러(docx)가 있으므로 화면의 쪽을 다시 그린다. */
export function finishPrint(viewer) {
  const root = document.querySelector('.print-root');
  document.body.classList.remove('printing');
  if (!root) return;
  root.remove();
  viewer?.render();
}
