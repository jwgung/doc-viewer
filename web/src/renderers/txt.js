// 텍스트 파일(.txt, 설정·소스 코드·자막 등). 줄바꿈과 공백을 그대로 두고 화면 폭에 맞춰 접는다.
// 구문 색은 입히지 않고(2026-10-19 결정) 설정·코드 파일만 고정폭 글꼴로 보인다. 아주 큰 파일은 화면이 멈추지 않게 앞부분만 보인다.
import { t } from '../strings.js';
import { decodeText } from '../text.js';

const MAX_CHARS = 3_000_000;
/**
 * 가변폭 글꼴로 읽는 글(산문·자막·마크업 원고). 그 밖의 확장자(설정·소스 코드·diff)와 확장자 없는 이름(Makefile·Dockerfile)은
 * 고정폭으로 보인다. 이름 없이 온 글은 산문으로 본다. 확장자 목록은 Android `DocFormat.PLAIN_TEXT_EXTENSIONS`와 함께 고친다.
 */
const PROSE_EXTENSIONS = new Set(['txt', 'text', 'nfo', 'srt', 'vtt', 'rst', 'tex']);

export async function render(bytes, container, ctx) {
  const text = decodeText(bytes);
  const article = document.createElement('article');
  const name = ctx.name ?? '';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const prose = name === '' || PROSE_EXTENSIONS.has(ext);
  article.className = prose ? 'flow plaintext' : 'flow plaintext mono';
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
