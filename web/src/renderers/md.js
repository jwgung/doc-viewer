import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { decodeText } from '../text.js';

// 마크다운 안의 HTML은 살리되 스크립트·이벤트 속성은 DOMPurify로 걸러낸다(CSP로도 한 번 더 막힌다).
// 외부 이미지·링크는 앱이 네트워크 요청을 막으므로 불러오지 않는다.
/**
 * 최상위 요소가 이보다 많으면 화면 밖 요소의 배치를 건너뛴다(viewer.css .markdown.large). 870KB 변경 기록이 첫 화면 뒤 저사양에서
 * 1.5초 멈췄다. 요소 안쪽 여백이 바깥과 겹치지 않게 되어(인용 안 문단 등) 작은 문서는 그대로 둔다.
 */
const LARGE_CHILDREN = 300;
export async function render(bytes, container, ctx) {
  const article = document.createElement('article');
  article.className = 'flow markdown';
  article.innerHTML = DOMPurify.sanitize(marked.parse(decodeText(bytes), { gfm: true }));
  article.classList.toggle('large', article.childElementCount > LARGE_CHILDREN);
  container.appendChild(article);
  ctx.markFirstPage();
  return { pages: null };
}
