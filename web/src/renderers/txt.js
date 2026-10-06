// 텍스트 파일(.txt·.log 등). 줄바꿈과 공백을 그대로 두고 화면 폭에 맞춰 접는다.
// 아주 큰 파일은 화면이 멈추지 않게 앞부분만 보인다.
import { t } from '../strings.js';
import { decodeText } from '../text.js';

const MAX_CHARS = 3_000_000;

export async function render(bytes, container, ctx) {
  const text = decodeText(bytes);
  const article = document.createElement('article');
  article.className = 'flow plaintext';
  const pre = document.createElement('pre');
  pre.textContent = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  article.appendChild(pre);
  if (text.length > MAX_CHARS) {
    const note = document.createElement('p');
    note.className = 'sheet-note';
    note.textContent = t.textLimited(MAX_CHARS.toLocaleString(), text.length.toLocaleString());
    article.appendChild(note);
  }
  container.appendChild(article);
  ctx.markFirstPage();
  return { pages: null, extra: { chars: text.length } };
}
