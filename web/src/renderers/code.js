// 설정·데이터 파일(JSON·XML·TOML·YAML)과 로그(.log). 구문별로 색을 입히고 줄 번호를 붙인다.
// JSON은 한 줄로 압축된 것이 많아 항상 다시 들여쓴다(JSON.parse를 쓰지 않아 큰 정수·키 순서·잘못된 JSON도 그대로 보인다).
// XML은 본문 공백이 뜻을 가질 수 있어 압축된 파일(태그 3개 이상이고 태그 4개당 줄바꿈 1개 미만)만 다시 들여쓴다. TOML·YAML은 원문 그대로 색만 입힌다.
// JSON의 {}·[]와 XML 요소는 줄 번호 옆 표시를 눌러 접는다.
// 큰 파일: 처음 조각만 바로 보이고 나머지는 쉬어 가며 넣는다. MAX_DECORATED_LINES를 넘는 줄은 색·줄 번호 없이 글자만 잇고,
// MAX_CHARS를 넘는 글자는 보이지 않는다(각각 안내 문구). 로그는 끝이 중요하므로 앞이 아니라 뒤를 남긴다. 토크나이저는 모두 입력 길이에 비례하는 시간만 쓴다(만든 파일로 멈추지 않게).
import { nextTurn } from '../next-turn.js';
import { t } from '../strings.js';
import { decodeText } from '../text.js';

const MAX_CHARS = 3_000_000;
const INDENT = '  ';
/** 다시 들여쓸 때의 깊이 상한. '[[[[…'처럼 깊게만 판 파일이 줄마다 긴 들여쓰기를 만들어 메모리를 다 쓰지 않게. */
const MAX_INDENT_DEPTH = 40;
const indentOf = (depth) => INDENT.repeat(Math.min(depth, MAX_INDENT_DEPTH));

const TOKENIZERS = { json: tokenizeJson, xml: tokenizeXml, toml: tokenizeToml, yaml: tokenizeYaml, log: tokenizeLog };

/** 구문 색·줄 번호·접기를 붙이는 줄 수 상한. 그 뒤는 색 없는 글자로 잇는다(줄마다 요소를 만들면 큰 파일에서 메모리·시간이 너무 든다). */
const MAX_DECORATED_LINES = 60_000;
/**
 * 다시 들여쓸 때 넣는 줄바꿈. counter는 토크나이저가 지금까지 만든 줄 수({n})로, 꾸밈 상한을 넘긴 줄은 색 없이 보이므로
 * 들여쓰기도 넣지 않는다(깊게만 판 파일이 입력의 수십 배로 불어나지 않게).
 */
const newlineFor = (counter, depth) => `\n${counter.n++ < MAX_DECORATED_LINES ? indentOf(depth) : ''}`;
/** 처음 화면에 바로 넣는 줄 수. 나머지는 뒤에서 조각마다 쉬어 가며 넣는다(스크롤·탭을 막지 않게). */
const FIRST_CHUNK = 1_500;
const CHUNK = 1_000;
/** 상한을 넘긴 색 없는 글자를 한 번에 넣는 길이 */
const REST_CHUNK_CHARS = 200_000;

export async function render(bytes, container, ctx) {
  const text = decodeText(bytes);
  // 상한을 넘으면 앞부분만. 로그는 끝이 중요하므로 뒷부분을 줄 경계부터 보인다. 안내 숫자는 실제로 보이는 글자 수(shown.length)라
  // 잘린 줄 하나 길이만큼 MAX_CHARS보다 작을 수 있다.
  const keepTail = ctx.fmt === 'log';
  const shown = text.length <= MAX_CHARS ? text : keepTail ? tailFrom(text, text.length - MAX_CHARS) : text.slice(0, MAX_CHARS);
  const tokens = TOKENIZERS[ctx.fmt](shown);
  const lines = countLines(tokens);

  const article = document.createElement('article');
  article.className = 'flow code';
  const pre = document.createElement('pre');
  pre.style.setProperty('--gutter', `${String(Math.min(lines, MAX_DECORATED_LINES)).length}ch`);
  pre.addEventListener('click', (event) => {
    const line = event.target.closest('.fold')?.parentElement;
    line?.classList.toggle('folded');
  });
  article.appendChild(pre);
  const notes = [];
  if (lines > MAX_DECORATED_LINES) notes.push(t.codeLimited(MAX_DECORATED_LINES.toLocaleString()));
  if (text.length > MAX_CHARS) notes.push((keepTail ? t.textLimitedTail : t.textLimited)(shown.length.toLocaleString(), text.length.toLocaleString()));
  for (const note of notes) {
    const p = document.createElement('p');
    p.className = 'sheet-note';
    p.textContent = note;
    article.appendChild(p);
  }

  const sink = new DomSink(pre);
  const builder = buildLines(tokens, sink);
  let step = builder.next();
  sink.flush();
  container.appendChild(article);
  ctx.markFirstPage();
  while (!step.done) {
    await nextTurn();
    step = builder.next();
    sink.flush();
  }
  return { pages: null, extra: { chars: text.length, lines } };
}

/** from 뒤의 첫 줄 경계부터 끝까지(줄 중간에서 시작하지 않게) */
function tailFrom(text, from) {
  const nl = text.indexOf('\n', from);
  return text.slice(nl < 0 ? from : nl + 1);
}

function countLines(tokens) {
  let count = 1;
  for (const [, text] of tokens) for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) count++;
  return count;
}

/*
 * 토큰: [종류, 글자]. 종류 ''는 색 없는 글자, 그 밖에는 tk-<종류> 클래스로 색을 입힌다. 글자 안의 줄바꿈은 줄을 나눈다.
 * 글자가 없는 표시 토큰 둘: ['open', 닫는 글자]는 여기서 접을 수 있는 묶음이 열린다는 뜻(닫는 글자는 접었을 때 보여 준다),
 * ['close', '']는 묶음이 닫힌다는 뜻이다. 같은 줄에서 열리고 닫힌 묶음은 접지 않는다.
 */

/**
 * HTML 조각을 모아 두었다가 한 번에 넣는다. 접는 묶음(<span class="blk">)은 조각 경계를 넘어 열려 있을 수 있어,
 * 넣은 뒤에는 아직 닫히지 않은 가장 안쪽 blk를 다음 조각을 넣을 자리로 삼고, 앞 조각에서 연 묶음을 닫을 때는 그 부모로 올라간다.
 */
class DomSink {
  constructor(root) {
    this.cursor = root;
    this.buffer = [];
    this.localOpen = 0; // 아직 넣지 않은 글에서 연 blk 수
  }
  text(html) {
    this.buffer.push(html);
  }
  open(count) {
    if (!count) return;
    this.buffer.push('<span class="blk">'.repeat(count));
    this.localOpen += count;
  }
  close(count) {
    for (; count > 0; count--) {
      if (this.localOpen > 0) {
        this.buffer.push('</span>');
        this.localOpen--;
      } else {
        this.flush();
        this.cursor = this.cursor.parentElement;
      }
    }
  }
  flush() {
    if (!this.buffer.length) return;
    const pending = this.localOpen;
    this.cursor.insertAdjacentHTML('beforeend', this.buffer.join(''));
    this.buffer = [];
    this.localOpen = 0;
    // 닫히지 않은 blk는 파서가 닫아 두었다. 각각 그 자리의 마지막 요소이므로 따라 내려가 이어 넣을 자리를 잡는다.
    for (let k = 0; k < pending; k++) this.cursor = this.cursor.lastElementChild;
  }
}

/**
 * 토큰을 줄 단위 HTML로 만들어 sink에 넣는다. 줄마다 <span class="l" data-n="줄 번호">이고, 접을 수 있는 줄 뒤에는
 * 닫는 줄까지를 <span class="blk">로 감싸 한 번에 숨긴다. FIRST_CHUNK 줄을 만든 뒤, 그 뒤로는 CHUNK 줄마다 양보한다.
 * MAX_DECORATED_LINES를 넘는 줄은 꾸밈 없이 글자만 잇는다.
 */
function* buildLines(tokens, sink) {
  let lineNo = 1;
  let line = '';
  /** 열린 묶음: 연 줄 번호, 접었을 때 보일 닫는 글자, 실제로 blk 요소를 만들었는지 */
  const stack = [];
  let closing = 0; // 이 줄 끝에서 닫을 blk 요소 수
  let budget = FIRST_CHUNK;
  const endLine = () => {
    // 이 줄에서 열려 아직 닫히지 않은 묶음(스택 위쪽)에 blk를 만든다. 다른 묶음을 닫는 줄에서 연 묶음은 형제 자리에 둘 수
    // 없어(닫는 span 뒤에 와야 한다) 접지 않는다.
    let opened = 0;
    for (let k = stack.length - 1; k >= 0 && stack[k].line === lineNo; k--) opened++;
    const foldable = opened > 0 && closing === 0;
    const first = foldable ? stack[stack.length - opened] : null;
    for (let k = stack.length - opened; k < stack.length; k++) stack[k].blk = foldable;
    sink.text(
      `<span class="l${foldable ? ' has-fold' : ''}" data-n="${lineNo}"${foldable ? ` data-close="${escapeHtml(first.close)}"` : ''}>` +
        `${foldable ? '<b class="fold"></b>' : ''}${line || '\n'}</span>`, // 빈 줄도 한 줄 높이를 갖게
    );
    sink.close(closing);
    if (foldable) sink.open(opened);
    line = '';
    closing = 0;
    lineNo++;
  };
  let i = 0;
  for (; i < tokens.length && lineNo <= MAX_DECORATED_LINES; i++) {
    const [type, text] = tokens[i];
    if (type === 'open') {
      stack.push({ line: lineNo, close: text, blk: false });
      continue;
    }
    if (type === 'close') {
      const entry = stack.pop();
      if (entry?.blk) closing++;
      continue;
    }
    if (!text) continue;
    const pieces = text.split('\n');
    for (let k = 0; k < pieces.length; k++) {
      if (k > 0) {
        endLine();
        if (--budget <= 0) {
          budget = CHUNK;
          yield;
        }
      }
      if (pieces[k]) line += type ? `<span class="tk-${type}">${escapeHtml(pieces[k])}</span>` : escapeHtml(pieces[k]);
    }
  }
  if (line || closing) endLine();
  sink.close(stack.filter((entry) => entry.blk).length);
  // 상한을 넘긴 나머지: 색 없는 글자로(줄 번호 칸만큼 들여 맞춘다)
  let plain = '';
  for (; i < tokens.length; i++) {
    plain += tokens[i][1];
    if (plain.length > REST_CHUNK_CHARS) {
      sink.text(`<span class="rest">${escapeHtml(plain)}</span>`);
      plain = '';
      yield;
    }
  }
  if (plain) sink.text(`<span class="rest">${escapeHtml(plain)}</span>`);
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

const isSpace = (code) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

/** 줄 안의 공백(스페이스·탭·CR)을 색 없는 토큰으로 넣고 그 다음 위치를 돌려준다. */
function skipBlanks(line, i, out) {
  let j = i;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t' || line[j] === '\r')) j++;
  if (j > i) out.push(['', line.slice(i, j)]);
  return j;
}

/** 따옴표로 시작하는 문자열의 끝(닫는 따옴표 다음) 위치. 줄 끝까지 닫히지 않으면 줄 끝에서 멈춘다. */
function scanQuoted(src, start, escapes = true) {
  const quote = src[start];
  for (let j = start + 1; j < src.length; j++) {
    const c = src[j];
    if (escapes && c === '\\') j++;
    else if (c === quote) return j + 1;
    else if (c === '\n') return j;
  }
  return src.length;
}

// ---- JSON: 토큰 단위로 다시 들여쓴다 -------------------------------------------------------------------------------

const JSON_NUMBER = /-?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/y;
const JSON_WORD = /[A-Za-z_$][\w$]*/y;

function tokenizeJson(src) {
  const out = [];
  const n = src.length;
  let depth = 0;
  let lineEmpty = true; // 지금 줄에 들여쓰기만 있다(빈 줄을 만들지 않게)
  const lines = { n: 1 };
  const emit = (type, text) => {
    out.push([type, text]);
    lineEmpty = false;
  };
  const newline = () => {
    const pad = newlineFor(lines, depth);
    if (lineEmpty && out.length) out[out.length - 1][1] = pad;
    else out.push(['', pad]);
    lineEmpty = true;
  };
  const nextNonSpace = (from) => {
    let j = from;
    while (j < n && isSpace(src.charCodeAt(j))) j++;
    return j;
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (isSpace(src.charCodeAt(i))) {
      i++;
      continue;
    }
    // 최상위에 값이 여럿(JSON Lines 등)이면 값마다 새 줄에
    if (depth === 0 && !lineEmpty && out.length && c !== ',' && c !== ':' && c !== '}' && c !== ']') newline();
    if (c === '"') {
      const end = scanQuoted(src, i);
      emit(src[nextNonSpace(end)] === ':' ? 'key' : 'str', src.slice(i, end));
      i = end;
    } else if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      const j = nextNonSpace(i + 1);
      if (src[j] === close) {
        emit('punct', c + close);
        i = j + 1;
      } else {
        emit('punct', c);
        out.push(['open', close]);
        depth++;
        newline();
        i++;
      }
    } else if (c === '}' || c === ']') {
      if (depth > 0) {
        depth--;
        newline();
        out.push(['close', '']);
      }
      emit('punct', c);
      i++;
    } else if (c === ',') {
      emit('punct', c);
      newline();
      i++;
    } else if (c === ':') {
      emit('punct', c);
      out.push(['', ' ']);
      i++;
    } else if (c === '/' && src[i + 1] === '/') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = n;
      emit('cmt', src.slice(i, end));
      newline();
      i = end;
    } else if (c === '/' && src[i + 1] === '*') {
      let end = src.indexOf('*/', i + 2);
      end = end < 0 ? n : end + 2;
      // 여러 줄 주석은 원래 줄 나눔을 두고 줄마다 지금 들여쓰기를 붙인다(newline()과 같은 상한 규칙).
      emit('cmt', src.slice(i, end).replace(/\n[ \t]*/g, () => newlineFor(lines, depth)));
      i = end;
      if (src[nextNonSpace(i)] !== ',') newline();
    } else {
      JSON_NUMBER.lastIndex = i;
      JSON_WORD.lastIndex = i;
      let m;
      if ((m = JSON_NUMBER.exec(src))) {
        emit('num', m[0]);
        i += m[0].length;
      } else if ((m = JSON_WORD.exec(src))) {
        const word = m[0];
        emit(word === 'true' || word === 'false' || word === 'null' ? 'kw' : word === 'NaN' || word === 'Infinity' ? 'num' : '', word);
        i += word.length;
      } else {
        emit('', c);
        i++;
      }
    }
  }
  return out;
}

// ---- XML ------------------------------------------------------------------------------------------------------

/** 태그·속성 이름. '<'를 빼야 '<<<<…'나 '<a<b>' 같은 깨진 입력에서 이름이 다음 태그를 삼키지 않는다. */
const XML_NAME = /[^\s/>=<]+/y;
const XML_ATTR_VALUE = /"[^"]*"|'[^']*'|[^\s>]+/y;

/**
 * 마디(node)로 먼저 나눈다: 여는 태그·닫는 태그·빈 요소 태그·글·주석·처리 명령·CDATA·DOCTYPE.
 * 압축된 파일(태그 4개당 줄바꿈 1개 미만, 태그 3개 이상)이면 마디마다 줄을 나눠 들여쓰고, 아니면 원문 그대로 잇는다.
 */
function tokenizeXml(src) {
  const nodes = xmlNodes(src);
  const tags = nodes.filter((node) => node.kind === 'open' || node.kind === 'close' || node.kind === 'self').length;
  const newlines = (src.match(/\n/g) ?? []).length;
  const minified = tags > 2 && newlines * 4 < tags;
  if (!minified) return nodes.flatMap((node) => node.tokens);

  const out = [];
  let depth = 0;
  let first = true;
  const lines = { n: 1 };
  const newline = () => {
    if (!first) out.push(['', newlineFor(lines, depth)]);
    first = false;
  };
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    if (node.kind === 'text') {
      const text = node.tokens.map(([, s]) => s).join('');
      if (!text.trim()) continue;
      // <a>글</a>처럼 글만 든 요소는 한 줄에 둔다.
      const inline = nodes[k - 1]?.kind === 'open' && nodes[k + 1]?.kind === 'close';
      if (!inline) newline();
      const trimmed = trimTokens(node.tokens);
      append(out, trimmed);
      if (inline && nodes[k + 1]) {
        depth = Math.max(0, depth - 1);
        append(out, nodes[++k].tokens);
      }
      continue;
    }
    if (node.kind === 'close') {
      depth = Math.max(0, depth - 1);
      newline();
      append(out, node.tokens);
      continue;
    }
    newline();
    append(out, node.tokens);
    if (node.kind === 'open') depth++;
  }
  return out;
}

/** 토큰을 뒤에 잇는다. push(...큰 배열)은 인자 수 한계(엔티티가 수십만 개인 글 마디)에서 RangeError가 난다. */
function append(out, tokens) {
  for (const token of tokens) out.push(token);
}

/** 글 토큰 묶음의 양 끝 공백을 뗀다. */
function trimTokens(tokens) {
  const copy = tokens.map(([type, text]) => [type, text]);
  if (copy.length) copy[0][1] = copy[0][1].trimStart();
  if (copy.length) copy[copy.length - 1][1] = copy[copy.length - 1][1].trimEnd();
  return copy.filter(([, text]) => text);
}

/** @returns {Array<{kind: string, tokens: Array<[string, string]>}>} */
function xmlNodes(src) {
  const nodes = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0 || lt > i) {
      const end = lt < 0 ? n : lt;
      nodes.push({ kind: 'text', tokens: textTokens(src.slice(i, end)) });
      i = end;
      if (lt < 0) break;
    }
    if (src.startsWith('<!--', i)) {
      let end = src.indexOf('-->', i + 4);
      end = end < 0 ? n : end + 3;
      nodes.push({ kind: 'other', tokens: [['cmt', src.slice(i, end)]] });
      i = end;
    } else if (src.startsWith('<![CDATA[', i)) {
      const close = src.indexOf(']]>', i + 9);
      // 닫히지 않은 CDATA는 끝까지 내용으로 보인다(없는 ']]>'를 그리지 않는다).
      const tokens = close < 0 ? [['punct', '<![CDATA['], ['str', src.slice(i + 9)]] : [['punct', '<![CDATA['], ['str', src.slice(i + 9, close)], ['punct', ']]>']];
      nodes.push({ kind: 'other', tokens });
      i = close < 0 ? n : close + 3;
    } else if (src.startsWith('<?', i)) {
      let end = src.indexOf('?>', i + 2);
      end = end < 0 ? n : end + 2;
      nodes.push({ kind: 'other', tokens: [['meta', src.slice(i, end)]] });
      i = end;
    } else if (src.startsWith('<!', i)) {
      // DOCTYPE: 첫 '>' 앞에 내부 부분 집합([ ... ])이 시작되면 그 ']' 뒤의 '>'까지('['는 태그 안에서만 찾아 큰 파일에서 되풀이 훑지 않게)
      let gt = src.indexOf('>', i);
      const bracket = gt < 0 ? -1 : src.slice(i, gt).indexOf('[');
      if (bracket >= 0) {
        const close = src.indexOf(']', i + bracket);
        gt = close < 0 ? -1 : src.indexOf('>', close + 1); // ']'가 없으면 끝까지 DOCTYPE
      }
      const end = gt < 0 ? n : gt + 1;
      nodes.push({ kind: 'other', tokens: [['meta', src.slice(i, end)]] });
      i = end;
    } else {
      const tag = xmlTag(src, i);
      if (!tag) {
        // 태그가 아닌 '<'(이름 없음: '< ', '<>', '<=' 등): 글로 둔다.
        nodes.push({ kind: 'text', tokens: [['', '<']] });
        i++;
      } else {
        nodes.push(tag.node);
        i = tag.end;
      }
    }
  }
  return nodes;
}

/** 글 속 참조(&amp; 등)만 색을 입힌다. */
function textTokens(text) {
  const tokens = [];
  let last = 0;
  for (const m of text.matchAll(/&(?:#\d+|#x[0-9a-fA-F]+|\w+);/g)) {
    if (m.index > last) tokens.push(['', text.slice(last, m.index)]);
    tokens.push(['kw', m[0]]);
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push(['', text.slice(last)]);
  return tokens;
}

/** '<'에서 시작하는 여는·닫는·빈 요소 태그. 태그 이름이 없으면 null. */
function xmlTag(src, start) {
  const n = src.length;
  const tokens = [];
  let i = start + 1;
  const closing = src[i] === '/';
  if (closing) i++;
  XML_NAME.lastIndex = i;
  const name = XML_NAME.exec(src)?.[0];
  if (!name || /^[\s"'=<]/.test(name)) return null;
  tokens.push(['punct', closing ? '</' : '<'], ['tag', name]);
  i += name.length;
  let kind = closing ? 'close' : 'open';
  while (i < n) {
    const c = src[i];
    if (c === '>') {
      tokens.push(['punct', '>']);
      i++;
      break;
    }
    if (c === '/' && src[i + 1] === '>') {
      tokens.push(['punct', '/>']);
      kind = closing ? 'close' : 'self';
      i += 2;
      break;
    }
    if (c === '<') break; // 닫히지 않은 태그: 다음 태그 앞에서 끝낸다.
    if (isSpace(src.charCodeAt(i))) {
      let j = i;
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      tokens.push(['', src.slice(i, j)]);
      i = j;
      continue;
    }
    if (c === '=') {
      tokens.push(['punct', '=']);
      i++;
      XML_ATTR_VALUE.lastIndex = i;
      const value = XML_ATTR_VALUE.exec(src)?.[0];
      if (value) {
        tokens.push(['str', value]);
        i += value.length;
      }
      continue;
    }
    XML_NAME.lastIndex = i;
    const attr = XML_NAME.exec(src)?.[0] ?? c;
    tokens.push(['attr', attr]);
    i += attr.length;
  }
  // 묶음 표시는 태그 앞에 둔다: 여러 줄에 걸친 태그도 첫 줄에서 접게.
  if (kind === 'open') tokens.unshift(['open', `</${name}>`]);
  if (kind === 'close') tokens.unshift(['close', '']);
  return { node: { kind, tokens }, end: i };
}

// ---- TOML -----------------------------------------------------------------------------------------------------

const TOML_DATE = /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?/y;
const TOML_NUMBER = /[+-]?(?:inf|nan)|0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?/y;
const TOML_BARE = /[A-Za-z0-9_-]+/y;

function tokenizeToml(src) {
  const out = [];
  const lines = src.split('\n');
  let depth = 0; // 배열·인라인 표의 깊이(0이 아니면 다음 줄도 값이 이어진다)
  let multi = null; // 여러 줄 문자열의 닫는 따옴표('"""' 또는 "'''")
  for (let k = 0; k < lines.length; k++) {
    if (k > 0) out.push(['', '\n']);
    const line = lines[k];
    let i = 0;
    if (multi) {
      const end = line.indexOf(multi);
      if (end < 0) {
        out.push(['str', line]);
        continue;
      }
      out.push(['str', line.slice(0, end + 3)]);
      i = end + 3;
      multi = null;
    }
    let inValue = depth > 0;
    while (i < line.length) {
      const c = line[i];
      if (c === ' ' || c === '\t' || c === '\r') {
        i = skipBlanks(line, i, out);
        continue;
      }
      if (c === '#') {
        out.push(['cmt', line.slice(i)]);
        break;
      }
      if (!inValue && c === '[' && depth === 0) {
        // 표 머리 [table]·[[array]]
        const end = line.lastIndexOf(']');
        const stop = end < i ? line.length : end + 1;
        out.push(['sec', line.slice(i, stop)]);
        i = stop;
        continue;
      }
      if (c === '"' || c === "'") {
        const triple = line.startsWith(c.repeat(3), i);
        if (triple) {
          const end = line.indexOf(c.repeat(3), i + 3);
          if (end < 0) {
            out.push(['str', line.slice(i)]);
            multi = c.repeat(3);
            i = line.length;
          } else {
            out.push(['str', line.slice(i, end + 3)]);
            i = end + 3;
          }
          continue;
        }
        const end = scanQuoted(line, i, c === '"'); // 작은따옴표(리터럴 문자열)에는 이스케이프가 없다.
        out.push([inValue ? 'str' : 'key', line.slice(i, end)]);
        i = end;
        continue;
      }
      if (c === '=') {
        out.push(['punct', '=']);
        inValue = true;
        i++;
        continue;
      }
      if (c === '[' || c === '{') {
        depth++;
        out.push(['punct', c]);
        i++;
        continue;
      }
      if (c === ']' || c === '}') {
        depth = Math.max(0, depth - 1);
        out.push(['punct', c]);
        i++;
        continue;
      }
      if (c === ',' || c === '.') {
        out.push(['punct', c]);
        i++;
        continue;
      }
      if (!inValue) {
        TOML_BARE.lastIndex = i;
        const bare = TOML_BARE.exec(line)?.[0];
        if (bare) {
          out.push(['key', bare]);
          i += bare.length;
        } else {
          out.push(['', c]);
          i++;
        }
        continue;
      }
      // 값: 인라인 표 안의 키, 날짜, 숫자, 참·거짓
      TOML_BARE.lastIndex = i;
      const bare = TOML_BARE.exec(line)?.[0];
      if (bare && /^\s*=/.test(line.slice(i + bare.length)) && !/^(true|false|inf|nan)$/.test(bare)) {
        out.push(['key', bare]);
        i += bare.length;
        continue;
      }
      TOML_DATE.lastIndex = i;
      TOML_NUMBER.lastIndex = i;
      let m;
      if ((m = TOML_DATE.exec(line)) || (m = TOML_NUMBER.exec(line))) {
        out.push(['num', m[0]]);
        i += m[0].length;
      } else if (bare === 'true' || bare === 'false') {
        out.push(['kw', bare]);
        i += bare.length;
      } else if (bare) {
        out.push(['', bare]);
        i += bare.length;
      } else {
        out.push(['', c]);
        i++;
      }
    }
  }
  return out;
}

// ---- YAML -----------------------------------------------------------------------------------------------------

/** 키가 될 수 없는 첫 글자(지시자·따옴표·흐름 기호) */
const YAML_NOT_KEY_START = new Set([...'#&*!|>\'"%@`,[]{}']);

/**
 * i에서 시작하는 매핑 키의 길이(뒤따르는 ':'은 빼고). 키가 아니면 0. 따옴표 키 또는 ': '(줄 끝의 ':' 포함) 앞까지의 글자.
 * 정규식의 느린 되돌이(긴 공백 줄에서 제곱 시간) 대신 한 번만 훑는다. 흐름([ ]·{ }) 안에서는 쉼표·괄호 앞에서 끝난다.
 */
function yamlKeyLength(line, i, flow) {
  const c = line[i];
  let j = i;
  if (c === '"' || c === "'") {
    j = c === '"' ? scanQuoted(line, i) : scanSingle(line, i);
    if (line[j - 1] !== c || j - i < 2) return 0;
  } else {
    if (YAML_NOT_KEY_START.has(c)) return 0;
    for (; j < line.length; j++) {
      const ch = line[j];
      if (ch === ':' && (j + 1 === line.length || line[j + 1] === ' ' || line[j + 1] === '\t' || line[j + 1] === '\r')) break;
      if (ch === '#' && (line[j - 1] === ' ' || line[j - 1] === '\t')) return 0;
      if (flow && (ch === ',' || ch === '[' || ch === ']' || ch === '{' || ch === '}')) return 0;
    }
    if (j >= line.length) return 0;
    while (j > i && (line[j - 1] === ' ' || line[j - 1] === '\t')) j--;
    return j - i;
  }
  // 따옴표 키 뒤: 공백 다음 ':'
  let k = j;
  while (line[k] === ' ' || line[k] === '\t') k++;
  const colonAtEnd = line[k] === ':' && (k + 1 === line.length || line[k + 1] === ' ' || line[k + 1] === '\t' || line[k + 1] === '\r');
  return colonAtEnd ? j - i : 0;
}
const YAML_SCALAR_WORD = /^(?:true|false|yes|no|on|off|null|~)$/i;
const YAML_NUMBER = /^(?:[+-]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+|0x[0-9a-fA-F]+|0o[0-7]+|\.inf|\.nan)|\d{4}-\d{2}-\d{2}(?:[Tt ].*)?)$/;

function tokenizeYaml(src) {
  const out = [];
  const lines = src.split('\n');
  let block = null; // 블록 스칼라(| 또는 >) 안: 이보다 더 들여쓴 줄은 모두 글이다.
  for (let k = 0; k < lines.length; k++) {
    if (k > 0) out.push(['', '\n']);
    const line = lines[k];
    const indent = line.length - line.trimStart().length;
    if (block) {
      if (!line.trim() || indent > block.parent) {
        out.push(['str', line]);
        continue;
      }
      block = null;
    }
    let i = indent;
    if (indent) out.push(['', line.slice(0, indent)]);
    if (i >= line.length) continue;
    if (line[i] === '#') {
      out.push(['cmt', line.slice(i)]);
      continue;
    }
    if (indent === 0 && /^(---|\.\.\.)(\s|$)/.test(line)) {
      out.push(['sec', line.slice(0, 3)]);
      i = 3;
    }
    let flow = 0; // [ ]·{ } 안
    let keyIndent = indent; // 블록 스칼라의 부모 들여쓰기(항목 '- '가 있으면 그 뒤)
    while (i < line.length) {
      const c = line[i];
      if (c === ' ' || c === '\t' || c === '\r') {
        i = skipBlanks(line, i, out);
        continue;
      }
      if (c === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
        out.push(['cmt', line.slice(i)]);
        break;
      }
      if (c === '-' && !flow && (i + 1 === line.length || line[i + 1] === ' ')) {
        out.push(['punct', '-']);
        i++;
        keyIndent = i;
        continue;
      }
      if (c === '[' || c === '{') {
        flow++;
        out.push(['punct', c]);
        i++;
        continue;
      }
      if (c === ']' || c === '}') {
        flow = Math.max(0, flow - 1);
        out.push(['punct', c]);
        i++;
        continue;
      }
      if (c === ',' && flow) {
        out.push(['punct', c]);
        i++;
        continue;
      }
      if (c === '&' || c === '*' || c === '!') {
        const m = /^[&*!][^\s,\]}]*/.exec(line.slice(i));
        out.push(['meta', m[0]]);
        i += m[0].length;
        continue;
      }
      if ((c === '|' || c === '>') && !flow) {
        const m = /^[|>][+-]?\d*[+-]?(?=\s|$)/.exec(line.slice(i));
        if (m) {
          out.push(['punct', m[0]]);
          i += m[0].length;
          block = { parent: keyIndent };
          continue;
        }
      }
      const keyLength = yamlKeyLength(line, i, flow);
      if (keyLength) {
        out.push(['key', line.slice(i, i + keyLength)]);
        i += keyLength;
        let j = i;
        while (line[j] === ' ') j++;
        if (j > i) out.push(['', line.slice(i, j)]);
        out.push(['punct', ':']);
        i = j + 1;
        continue;
      }
      if (c === '"' || c === "'") {
        const end = c === '"' ? scanQuoted(line, i) : scanSingle(line, i);
        out.push(['str', line.slice(i, end)]);
        i = end;
        continue;
      }
      // 따옴표 없는 스칼라: ' #' 주석 앞까지(흐름 안에서는 , ] } 앞까지)
      const rest = line.slice(i);
      const stop = rest.search(flow ? /\s#|[,\]}]/ : /\s#/);
      // trimEnd: /\s+$/는 긴 공백 줄에서 제곱 시간이 든다.
      const word = (stop < 0 ? rest : rest.slice(0, stop)).trimEnd() || c;
      out.push([YAML_SCALAR_WORD.test(word) ? 'kw' : YAML_NUMBER.test(word) ? 'num' : '', word]);
      i += word.length;
    }
  }
  return out;
}

/** YAML 작은따옴표 문자열: ''가 따옴표 하나. */
function scanSingle(line, start) {
  for (let j = start + 1; j < line.length; j++) {
    if (line[j] === "'") {
      if (line[j + 1] === "'") j++;
      else return j + 1;
    }
  }
  return line.length;
}

// ---- 로그 ------------------------------------------------------------------------------------------------------
// 줄마다 [시간표시] [PID TID] [수준] [스레드] [태그·로거] 메시지 순으로 찾는다. 형식이 제각각이라 느슨한 규칙으로 보고,
// 못 알아보는 줄은 색 없이 둔다. 예외 머리줄은 짙은 빨강, 그 뒤의 들여쓴 스택 트레이스는 회색으로 가라앉힌다.
// 로그 전용 토큰 종류: lv-err·lv-warn·lv-info·lv-dbg(수준 배지), time(시간표시·PID), errmsg(오류 줄 메시지), trace(스택 트레이스).
// 공통 종류(meta: [스레드], attr: 태그·로거, punct: 구분 기호, '': 색 없음)는 다른 형식과 같다.

/** 줄 앞의 시간표시: ISO(날짜 시간), logcat(월-일 시간), syslog(영문 월 일 시간), 시간만. 대괄호로 감싼 것도. */
const LOG_TIME =
  /^\[?(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{2}:\d{2}:\d{2}|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\]?/;
/** 줄 안 어디든 대괄호 시간표시(nginx·Apache 접근 로그: [16/Oct/2026:22:16:03 +0900]) */
const LOG_TIME_INLINE = /\[\d{1,2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4}\]/;
/** 수준 단어와 배지 종류(한 곳에서만 적고 정규식은 여기서 만든다) */
const LEVEL_CLASS = {
  fatal: 'lv-err', critical: 'lv-err', severe: 'lv-err', error: 'lv-err', err: 'lv-err',
  warning: 'lv-warn', warn: 'lv-warn',
  info: 'lv-info', notice: 'lv-info',
  debug: 'lv-dbg', trace: 'lv-dbg', verbose: 'lv-dbg', fine: 'lv-dbg',
};
const LEVEL_WORDS = Object.keys(LEVEL_CLASS);
/**
 * 수준 단어 찾기. 메시지 속 'the error count' 같은 보통 말까지 배지로 만들지 않게 소문자는 자리를 가려 받는다.
 * 1) ERROR·Error처럼 대문자로 시작하는 단어 2) [warn]·(info)처럼 괄호 안이면 소문자도 3) logfmt level=warn, JSON lines "level":"warn"
 * 4) 'error: disk full'처럼 뒤에 ':'·' - '·'|'가 오는 소문자(수준 자리).
 * 경계: 앞은 줄 앞이나 공백·여는 괄호·| = " ' : /, 뒤는 줄 끝이나 공백·닫는 괄호·: > | / , " ' -. 그래서 STDERR·INFORMATION 같은
 * 긴 단어의 일부는 잡히지 않는다.
 */
const LEVEL_UPPER = LEVEL_WORDS.map((w) => `${w.toUpperCase()}|${w[0].toUpperCase()}${w.slice(1)}`).join('|');
const LEVEL_LOWER = LEVEL_WORDS.join('|');
const LOG_LEVEL = new RegExp(
  String.raw`(?:^|[\s[(<|="':/])(?:(${LEVEL_UPPER})|(?<=[[(<])(${LEVEL_LOWER})(?=[\])>])|(?<=\blevel["']?\s*[=:]\s*["']?)(${LEVEL_LOWER})|(${LEVEL_LOWER})(?=\s*(?::|\s-\s|\|)))(?=$|[\s\]):>|/,"'-])`,
);
/** logcat: `10-16 22:16:03.123  1234  5678 E Tag: msg` 또는 옛 `E/Tag( 123): msg` */
const LOGCAT = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})(\s+\d+\s+\d+\s+)([VDIWEF])(\s+)([^:]+?)(:)/;
const LOGCAT_OLD = /^([VDIWEF])(\/)([^(:]+)(\(\s*\d+\))(:)/;
const LOGCAT_CLASS = { V: 'lv-dbg', D: 'lv-dbg', I: 'lv-info', W: 'lv-warn', E: 'lv-err', F: 'lv-err' };
/** 수준 뒤의 [스레드]와 태그·로거: 뒤에 ' - '(en dash '–'도)나 ': '가 오는 낱말(점·대시 포함 가능). 둘 다 없으면 태그로 보지 않는다. */
const LOG_TAG = /^(\s*)(\[[^\]]{1,40}\])?(\s*)((?:[\w$.-]+(?=\s*(?: [-–] |: )))?)/;
/** 예외 머리줄: Java/JS/Python 예외 이름(…Exception·…Error·…Throwable), Caused by, Suppressed, Traceback */
const LOG_EXCEPTION = /^\s*(?:(?:[\w$]+\.)*[\w$]*(?:Exception|Error|Throwable)\b|Caused by:|Suppressed:|Traceback \(most recent call last\):)/;
/** 스택 트레이스 줄: 들여쓴 `at …`, `… N more`, `File "…"`, `모듈.함수(`. 그 밖의 들여쓴 줄은 예외 머리줄 뒤에서만 트레이스로 본다. */
const LOG_TRACE = /^\s+(?:at\s|\.\.\.\s*\d+\s+more|File\s+"|\w+\.\w+\()/;
/** 수준을 찾는 범위: 시간표시 뒤 이만큼 안. 메시지 깊숙한 곳의 단어는 배지로 만들지 않는다. */
const LOG_HEAD_CHARS = 160;

function tokenizeLog(src) {
  const out = [];
  const lines = src.split('\n');
  let inTrace = false; // 예외 머리줄 뒤: 들여쓴 줄은 스택 트레이스로 본다
  for (let k = 0; k < lines.length; k++) {
    if (k > 0) out.push(['', '\n']);
    const line = lines[k];
    if (!line.trim()) {
      out.push(['', line]);
    } else if (LOG_EXCEPTION.test(line)) {
      // 트레이스보다 먼저 본다: Java의 'Suppressed:'는 트레이스 안에 탭으로 들여써 나온다.
      out.push(['errmsg', line]);
      inTrace = true;
    } else if (LOG_TRACE.test(line) || (inTrace && /^\s/.test(line))) {
      out.push(['trace', line]);
    } else {
      inTrace = false;
      tokenizeLogLine(out, line);
    }
  }
  return out;
}

/** 로그 한 줄: logcat 두 형식을 먼저 보고, 아니면 시간표시 → 수준 → [스레드]·태그 → 메시지 순으로 자른다. */
function tokenizeLogLine(out, line) {
  let m;
  if ((m = LOGCAT.exec(line))) {
    const level = LOGCAT_CLASS[m[3]];
    out.push(['time', m[1]], ['time', m[2]], [level, m[3]], ['', m[4]], ['attr', m[5]], ['punct', m[6]]);
    pushMessage(out, line.slice(m[0].length), level);
    return;
  }
  if ((m = LOGCAT_OLD.exec(line))) {
    const level = LOGCAT_CLASS[m[1]];
    out.push([level, m[1]], ['punct', m[2]], ['attr', m[3]], ['time', m[4]], ['punct', m[5]]);
    pushMessage(out, line.slice(m[0].length), level);
    return;
  }
  let i = 0;
  if ((m = LOG_TIME.exec(line))) {
    out.push(['time', m[0]]);
    i = m[0].length;
  }
  let level = '';
  const lv = LOG_LEVEL.exec(line.slice(i, i + LOG_HEAD_CHARS));
  if (lv) {
    const word = lv[1] ?? lv[2] ?? lv[3] ?? lv[4];
    const at = i + lv.index + lv[0].indexOf(word);
    pushWithInlineTime(out, line.slice(i, at)); // 시간표시와 수준 사이(호스트·로거 이름 등)
    level = LEVEL_CLASS[word.toLowerCase()];
    out.push([level, word]);
    i = at + word.length;
    const tag = LOG_TAG.exec(line.slice(i));
    if (tag && (tag[2] || tag[4])) {
      if (tag[1]) out.push(['', tag[1]]);
      if (tag[2]) out.push(['meta', tag[2]]);
      if (tag[3]) out.push(['', tag[3]]);
      if (tag[4]) out.push(['attr', tag[4]]);
      i += tag[0].length;
    }
  }
  pushMessage(out, line.slice(i), level);
}

/** 수준 뒤 메시지: 오류 수준이면 통째로 짙은 빨강, 아니면 색 없이(접근 로그처럼 수준 없는 줄의 대괄호 시간은 찾는다). */
function pushMessage(out, text, level) {
  if (!text) return;
  if (level === 'lv-err') out.push(['errmsg', text]);
  else pushWithInlineTime(out, text);
}

/** 색 없는 글자. 그 안의 접근 로그 대괄호 시간([16/Oct/2026:22:16:03 +0900])만 시간으로 */
function pushWithInlineTime(out, text) {
  if (!text) return;
  const m = LOG_TIME_INLINE.exec(text);
  if (!m) {
    out.push(['', text]);
    return;
  }
  if (m.index) out.push(['', text.slice(0, m.index)]);
  out.push(['time', m[0]]);
  if (m.index + m[0].length < text.length) out.push(['', text.slice(m.index + m[0].length)]);
}
