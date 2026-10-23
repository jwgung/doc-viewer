// 텍스트 파일(.txt, 설정·소스 코드·자막 등). 줄바꿈과 공백을 그대로 두고 화면 폭에 맞춰 접는다.
// 구문 색은 입히지 않고(2026-10-19 결정) 설정·코드 파일만 고정폭 글꼴로 보인다. 아주 큰 파일은 화면이 멈추지 않게 앞부분만 보인다.
// 글은 줄 경계에서 블록(.chunk)으로 나눠 넣어 화면 밖 블록은 배치를 건너뛴다(한 덩어리면 20MB 파일을 열 때 저사양에서 2.6초 멈췄다).
import { t } from '../strings.js';
import { decodeText } from '../text.js';

const MAX_CHARS = 3_000_000;
/** 블록 하나의 줄 수와 글자 수 상한. 화면에 들어온 블록은 통째로 배치하므로 작게 둔다. */
const CHUNK_LINES = 200;
const CHUNK_CHARS = 20_000;
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
  article.appendChild(pre);
  container.appendChild(article); // 블록의 자리 높이를 줄 높이로 어림하려고 먼저 붙인다
  const lineHeight = Number.parseFloat(getComputedStyle(pre).lineHeight) || 24;
  for (const { text: part, lines } of chunks(text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text)) {
    const chunk = document.createElement('div');
    chunk.className = 'chunk';
    chunk.textContent = part;
    chunk.style.containIntrinsicSize = `auto ${Math.round(lines * lineHeight)}px`;
    pre.appendChild(chunk);
  }
  if (text.length > MAX_CHARS) {
    const note = document.createElement('p');
    note.className = 'sheet-note';
    note.textContent = t.textLimited(MAX_CHARS.toLocaleString(), text.length.toLocaleString());
    article.appendChild(note);
  }
  ctx.markFirstPage();
  return { pages: null, extra: { chars: text.length } };
}

/**
 * 글을 CHUNK_LINES줄(또는 CHUNK_CHARS자)씩 나눈다. 블록 사이의 줄바꿈은 빼낸다(블록이 바뀌면 줄이 바뀐다). 한 줄이 CHUNK_CHARS보다
 * 길면 줄 중간에서 나누므로 그 자리에서 줄이 바뀌어 보인다(화면 폭으로 접히는 긴 줄이라 거의 티 나지 않는다).
 */
function* chunks(text) {
  let start = 0;
  do {
    let end = start;
    let lines = 0;
    for (let nl = text.indexOf('\n', end); lines < CHUNK_LINES && nl >= 0 && nl - start <= CHUNK_CHARS; nl = text.indexOf('\n', end)) {
      end = nl + 1;
      lines++;
    }
    if (end > start) {
      yield { text: text.slice(start, end - 1), lines };
      start = end;
    } else if (text.length - start <= CHUNK_CHARS) {
      yield { text: text.slice(start), lines: 1 };
      return;
    } else {
      yield { text: text.slice(start, start + CHUNK_CHARS), lines: 1 };
      start += CHUNK_CHARS;
    }
  } while (start < text.length);
}
