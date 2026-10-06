import { parseMsDoc, renderMsDoc } from '@file-viewer/doc/core';
import './doc.css';

// 구형 Word(.doc). 명시적 쪽 나누기·새 쪽 구역 나누기마다 흰 카드 한 장으로 그리고,
// 카드마다 그 구역의 머리말·꼬리말과 그 쪽에서 참조한 각주를 넣는다(미주는 마지막 카드).
// 글자 흐름에 따른 자동 쪽 나눔은 하지 않는다. 화면 폭에 맞춰 줄이 다시 흐르므로 원본 쪽 수와 다를 수 있다.
export async function render(bytes, container, ctx) {
  const parsed = parseMsDoc(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const rendered = renderMsDoc(parsed);
  const style = document.createElement('style');
  style.textContent = rendered.css;
  container.appendChild(style);
  const pages = rendered.pages?.length ? rendered.pages : [{ html: rendered.html }];
  pages.forEach((page, index) => {
    const card = document.createElement('div');
    card.className = 'flow doc-page';
    card.innerHTML = `<div class="msdoc-root">${page.html}</div>`;
    container.appendChild(card);
    if (index === 0) ctx.markFirstPage();
  });
  return {
    pages: null,
    extra: { warnings: parsed.warnings?.length ?? 0, docPages: pages.length, wordVersion: parsed.meta?.fib?.version ?? null },
  };
}
