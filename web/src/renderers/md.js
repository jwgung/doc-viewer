import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { decodeText } from '../text.js';

// 마크다운 안의 HTML은 살리되 스크립트·이벤트 속성은 DOMPurify로 걸러낸다(CSP로도 한 번 더 막힌다).
// 외부 이미지·링크는 앱이 네트워크 요청을 막으므로 불러오지 않는다.
export async function render(bytes, container, ctx) {
  const article = document.createElement('article');
  article.className = 'flow markdown';
  article.innerHTML = DOMPurify.sanitize(marked.parse(decodeText(bytes), { gfm: true }));
  container.appendChild(article);
  ctx.markFirstPage();
  return { pages: null };
}
