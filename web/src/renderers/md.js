import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { nextTurn } from '../next-turn.js';
import { decodeText } from '../text.js';

// 마크다운 안의 HTML은 살리되 스크립트·이벤트 속성은 DOMPurify로 걸러낸다(CSP로도 한 번 더 막힌다).
// 외부 이미지·링크는 앱이 네트워크 요청을 막으므로 불러오지 않는다.
// 큰 문서는 최상위 블록을 묶음으로 나눠 앞 묶음만 바로 보이고 나머지는 쉬어 가며 넣는다(4MB 문서를 한 번에 바꾸면
// 저사양에서 12초 멈췄다). 묶음마다 따로 HTML로 바꿔 이어 붙여도 한 번에 바꾼 것과 같다.
// 화면 밖 배치 생략(content-visibility)은 쓰지 않는다: 요소마다 높이를 어림해야 해서 이어보기 위치(스크롤 비율)가 어긋났다.
/** 한 번에 HTML로 바꿔 넣는 원문 글자 수 */
const BATCH_CHARS = 20_000;
/** 닫는 태그가 없는 HTML 요소(열린 태그로 세지 않는다) */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

export async function render(bytes, container, ctx) {
  const article = document.createElement('article');
  article.className = 'flow markdown';
  const tokens = marked.lexer(decodeText(bytes), { gfm: true });
  const batches = batchesOf(tokens);
  const insert = (batch) => article.insertAdjacentHTML('beforeend', DOMPurify.sanitize(marked.parser(batch, { gfm: true })));
  insert(batches[0]);
  container.appendChild(article);
  ctx.markFirstPage();
  for (const batch of batches.slice(1)) {
    await nextTurn();
    insert(batch);
  }
  return { pages: null };
}

/**
 * 최상위 토큰을 원문 BATCH_CHARS자 남짓씩 묶는다. 원문 HTML 블록이 연 요소(<details> 등)가 닫히기 전에는 나누지 않는다
 * (따로 넣으면 브라우저가 앞 묶음 끝에서 요소를 닫아 버려 구조가 달라진다). 묶음은 참조 링크 정의(links)를 함께 갖는다.
 */
function batchesOf(tokens) {
  const batches = [];
  let batch = [];
  let chars = 0;
  let depth = 0;
  for (const token of tokens) {
    batch.push(token);
    chars += token.raw?.length ?? 0;
    if (token.type === 'html') depth = Math.max(0, depth + openedBy(token.raw));
    if (chars >= BATCH_CHARS && depth === 0) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
  }
  if (batch.length || !batches.length) batches.push(batch);
  for (const each of batches) each.links = tokens.links;
  return batches;
}

/**
 * HTML 조각이 열고 닫지 않은 요소 수(닫기만 했으면 음수). 주석 안의 태그는 세지 않는다. 태그 안에 '<'가 없다고 보고 찾아
 * ('>'가 없는 '<a<a<a…'에서도 입력 길이에 비례하는 시간만 쓴다) 속성 값 안의 '<'·'>'는 어긋날 수 있다(그러면 덜 나눌 뿐이다).
 */
function openedBy(html) {
  let count = 0;
  for (const [, close, name, selfClosing] of withoutComments(html).matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^<>]*?(\/?)>/g)) {
    if (close) count--;
    else if (!selfClosing && !VOID_TAGS.has(name.toLowerCase())) count++;
  }
  return count;
}

/** HTML 주석을 뺀 글자. 닫히지 않은 주석은 끝까지 주석으로 본다(브라우저와 같다). */
function withoutComments(html) {
  let out = '';
  let from = 0;
  for (let start = html.indexOf('<!--'); start >= 0; start = html.indexOf('<!--', from)) {
    out += html.slice(from, start);
    const end = html.indexOf('-->', start + 4);
    if (end < 0) return out;
    from = end + 3;
  }
  return out + html.slice(from);
}
