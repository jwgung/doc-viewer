// 설정·데이터 파일(JSON·XML·TOML·YAML). 구문별로 색을 입히고 줄 번호를 붙인다.
// JSON은 한 줄로 압축된 것이 많아 항상 다시 들여쓴다(JSON.parse를 쓰지 않아 큰 정수·키 순서·잘못된 JSON도 그대로 보인다).
// XML은 본문 공백이 뜻을 가질 수 있어 한 줄로 압축된 파일만 다시 들여쓴다. TOML·YAML은 원문 그대로 색만 입힌다.
// JSON의 {}·[]와 XML 요소는 줄 번호 옆 표시를 눌러 접는다. 아주 큰 파일은 화면이 멈추지 않게 앞부분만 보인다.
import { t } from '../strings.js';
import { decodeText } from '../text.js';

const MAX_CHARS = 3_000_000;
const INDENT = '  ';

const TOKENIZERS = { json: tokenizeJson, xml: tokenizeXml, toml: tokenizeToml, yaml: tokenizeYaml };

/** 구문 색·줄 번호·접기를 붙이는 줄 수 상한. 그 뒤는 색 없는 글자로 잇는다(줄마다 요소를 만들면 큰 파일에서 메모리·시간이 너무 든다). */
const MAX_DECORATED_LINES = 60_000;
/** 처음 화면에 바로 넣는 줄 수. 나머지는 뒤에서 조각마다 쉬어 가며 넣는다(스크롤·탭을 막지 않게). */
const FIRST_CHUNK = 1_500;
const CHUNK = 1_000;

export async function render(bytes, container, ctx) {
  const text = decodeText(bytes);
  const shown = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  const tokens = (TOKENIZERS[ctx.fmt] ?? tokenizeYaml)(shown);
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
  if (text.length > MAX_CHARS) notes.push(t.textLimited(MAX_CHARS.toLocaleString(), text.length.toLocaleString()));
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

/** 낮은 우선순위로 다음 차례를 기다린다(paginate.js와 같은 방식: requestIdleCallback은 저사양 기기에서 좀처럼 오지 않는다). */
const nextTurn = () =>
  globalThis.scheduler?.postTask ? scheduler.postTask(() => {}, { priority: 'background' }) : new Promise((resolve) => setTimeout(resolve, 0));

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
  const flush = () => {
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
        flush();
        if (--budget <= 0) {
          budget = CHUNK;
          yield;
        }
      }
      if (pieces[k]) line += type ? `<span class="tk-${type}">${escapeHtml(pieces[k])}</span>` : escapeHtml(pieces[k]);
    }
  }
  if (line || closing) flush();
  sink.close(stack.filter((entry) => entry.blk).length);
  // 상한을 넘긴 나머지: 색 없는 글자로(줄 번호 칸만큼 들여 맞춘다)
  let plain = '';
  for (; i < tokens.length; i++) {
    plain += tokens[i][1];
    if (plain.length > 200_000) {
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
  const emit = (type, text) => {
    out.push([type, text]);
    lineEmpty = false;
  };
  const newline = () => {
    if (lineEmpty && out.length) out[out.length - 1][1] = `\n${INDENT.repeat(depth)}`;
    else out.push(['', `\n${INDENT.repeat(depth)}`]);
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
      // 여러 줄 주석은 원래 줄 나눔을 두고 지금 들여쓰기만 앞에 붙인다.
      emit('cmt', src.slice(i, end).replace(/\n[ \t]*/g, `\n${INDENT.repeat(depth)}`));
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

const XML_NAME = /[^\s/>=]+/y;
const XML_ATTR_VALUE = /"[^"]*"|'[^']*'|[^\s>]+/y;

/**
 * 마디(node)로 먼저 나눈다: 여는 태그·닫는 태그·빈 요소 태그·글·주석·처리 명령·CDATA·DOCTYPE.
 * 한 줄로 압축된 파일이면 마디마다 줄을 나눠 들여쓰고, 아니면 원문 그대로 잇는다.
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
  const newline = () => {
    if (!first) out.push(['', `\n${INDENT.repeat(depth)}`]);
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
      out.push(...trimmed);
      if (inline && nodes[k + 1]) {
        depth = Math.max(0, depth - 1);
        out.push(...nodes[++k].tokens);
      }
      continue;
    }
    if (node.kind === 'close') {
      depth = Math.max(0, depth - 1);
      newline();
      out.push(...node.tokens);
      continue;
    }
    newline();
    out.push(...node.tokens);
    if (node.kind === 'open') depth++;
  }
  return out;
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
      let end = src.indexOf(']]>', i + 9);
      end = end < 0 ? n : end + 3;
      nodes.push({ kind: 'other', tokens: [['punct', '<![CDATA['], ['str', src.slice(i + 9, end - 3)], ['punct', ']]>']] });
      i = end;
    } else if (src.startsWith('<?', i)) {
      let end = src.indexOf('?>', i + 2);
      end = end < 0 ? n : end + 2;
      nodes.push({ kind: 'other', tokens: [['meta', src.slice(i, end)]] });
      i = end;
    } else if (src.startsWith('<!', i)) {
      // DOCTYPE: 내부 부분 집합([ ... ])이 있으면 그 뒤의 '>'까지
      const bracket = src.indexOf('[', i);
      let gt = src.indexOf('>', i);
      if (bracket >= 0 && gt > bracket) gt = src.indexOf('>', src.indexOf(']', bracket) + 1);
      const end = gt < 0 ? n : gt + 1;
      nodes.push({ kind: 'other', tokens: [['meta', src.slice(i, end)]] });
      i = end;
    } else {
      const tag = xmlTag(src, i);
      if (!tag) {
        // 태그가 아닌 '<'(닫히지 않음 등): 글로 둔다.
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
        let j = i;
        while (j < line.length && (line[j] === ' ' || line[j] === '\t' || line[j] === '\r')) j++;
        out.push(['', line.slice(i, j)]);
        i = j;
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

const YAML_KEY = /(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#&*!|>'"%@`,[\]{}][^#]*?)(?=\s*:(?:\s|$))/y;
/** 흐름([ ]·{ }) 안의 키: 쉼표·괄호 앞에서 끝난다. */
const YAML_KEY_FLOW = /(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#&*!|>'"%@`,[\]{}][^#,[\]{}]*?)(?=\s*:(?:\s|$))/y;
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
        let j = i;
        while (j < line.length && (line[j] === ' ' || line[j] === '\t' || line[j] === '\r')) j++;
        out.push(['', line.slice(i, j)]);
        i = j;
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
      const keyPattern = flow ? YAML_KEY_FLOW : YAML_KEY;
      keyPattern.lastIndex = i;
      const key = keyPattern.exec(line)?.[0];
      if (key) {
        out.push(['key', key]);
        i += key.length;
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
      const word = (stop < 0 ? rest : rest.slice(0, stop)).replace(/\s+$/, '') || c;
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
