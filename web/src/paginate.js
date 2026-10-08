// 흐르는 문서(doc·docx)를 용지 높이로 나눠 쪽을 만든다(Word의 자동 쪽 나눔).
// 렌더러는 쪽 나누기가 있는 곳에서만 쪽을 나누므로, 쪽 나누기가 없는 문서는 긴 쪽 하나가 된다. 그래서 본문
// 블록(문단·표·그림)을 용지에 하나씩 채우다 아래 끝을 넘으면 다음 쪽으로 넘긴다. 문단은 줄 단위로, 표는 행
// 단위로 나눈다. 블록 하나가 빈 쪽에도 안 들어가면(큰 그림 등) 그 쪽만 용지보다 길어진다.
// 글꼴·줄 간격이 Word와 조금 달라 쪽이 바뀌는 자리는 Word와 완전히 같지 않다.
//
// 쪽은 화면 밖(.offscreen)에 붙여 재며 만든다. 첫 쪽(이어보기면 그 쪽까지)을 먼저 만들어 보여 주고, 나머지는
// 쉬는 틈에 만들어 쪽 뷰어에 더한다(createPager).

/** 이만큼(px)까지 넘친 것은 넘친 것으로 보지 않는다(반올림 오차). */
const SLACK = 1;
/** 큰 행을 나눌 때 이 쪽에 이만큼(px)도 못 남기면 나누지 않고 다음 쪽에서 나눈다(두어 줄). */
const MIN_PIECE = 40;
/** 쪽이 HTML 글자인 문서(doc·docx)의 인쇄 쪽 수 상한. 쪽 그림(SVG·캔버스)보다 가벼워 기본 상한(100)보다 높다. */
export const HTML_PRINT_LIMIT = 500;
/** 한 번에 쪽을 만드는 시간(ms). 이보다 길면 스크롤·터치가 끊긴다. */
const SLICE_MS = 12;

/**
 * blocks(떼어 낸 본문 블록)를 차례로 쪽에 채운다. shell()은 화면 밖에 붙인 빈 쪽을 { page, body }로 돌려준다.
 * body 다음 요소(꼬리말 등)가 있으면 그 위까지, 없으면 쪽 아래 여백 위까지 채운다. 쪽이 하나 차면 내보낸다.
 */
export async function* fillPages(blocks, shell) {
  const queue = [...blocks];
  let current = open(shell);
  while (queue.length) {
    const block = queue.shift();
    await breathe();
    current.body.appendChild(block);
    await imagesReady(block);
    if (bottomOf(current.body) <= current.limit + SLACK) continue;
    const alone = current.body.firstChild === block;
    let rest = null;
    try {
      rest = splitBlock(block, current.limit, alone, current.room);
    } catch (error) {
      console.warn('블록을 나누지 못해 통째로 넘깁니다:', error);
    }
    if (rest) {
      queue.unshift(...rest);
    } else if (!alone) {
      block.remove();
      queue.unshift(block);
    }
    // 나누지 못했고 빈 쪽에도 안 들어가는 블록이면 이 쪽을 용지보다 길게 둔다.
    yield finish(current);
    current = open(shell);
  }
  yield finish(current);
}

/** 쪽 끝 블록의 아래 간격은 없앤다(Word도 쪽 끝에서는 무시한다). 남겨 두면 쪽이 그만큼 용지보다 길어진다. */
function finish({ page, body }) {
  const last = body.lastElementChild;
  if (last && Number.parseFloat(getComputedStyle(last).marginBottom) > 0) last.style.marginBottom = '0';
  return page;
}

/**
 * 크기 정보가 없는 그림은 풀리기 전 높이가 0이라, 그런 그림이 든 블록은 그림이 풀린 뒤에 잰다. 너비·높이가 정해진
 * 그림은 풀기를 기다리지 않는다(표지의 큰 사진을 기다리느라 저사양 기기에서 첫 쪽이 0.5초 늦었다).
 */
function imagesReady(block) {
  if (block.nodeType !== Node.ELEMENT_NODE) return null;
  const images = [...(block.tagName === 'IMG' ? [block] : block.querySelectorAll('img'))].filter((img) => !img.complete && !sized(img));
  return images.length ? Promise.all(images.map((img) => img.decode().catch(() => {}))) : null;
}

// 너비·높이를 고정 단위(px·pt 등)로 정한 그림. 'auto'·%는 그림이 풀려야 크기가 정해진다.
const fixed = (value) => /^[\d.]+(px|pt|pc|cm|mm|in|em|rem)$/.test(value ?? '');
const sized = (img) =>
  (fixed(img.style.width) && fixed(img.style.height)) || (/^\d+$/.test(img.getAttribute('width') ?? '') && /^\d+$/.test(img.getAttribute('height') ?? ''));

function open(shell) {
  const { page, body } = shell();
  // 빈 쪽은 용지 높이(최소 높이)라, 꼬리말이 있으면 그 위 끝이, 없으면 아래 여백 위가 본문이 끝나야 할 자리다.
  const below = body.nextElementSibling;
  const limit = below
    ? below.getBoundingClientRect().top
    : page.getBoundingClientRect().bottom - (Number.parseFloat(getComputedStyle(page).paddingBottom) || 0);
  // room: 빈 쪽 하나에 들어가는 본문 높이. 이보다 큰 블록은 어느 쪽에도 안 들어가므로 나눠야 한다.
  return { page, body, limit, room: limit - body.getBoundingClientRect().top };
}

function bottomOf(body) {
  return (body.lastElementChild ?? body).getBoundingClientRect().bottom;
}

/** 블록을 limit에서 나누고 뒤쪽 조각들을 돌려준다(앞쪽은 제자리에 남는다). 나눌 수 없으면 null. */
function splitBlock(block, limit, alone, room) {
  if (block.nodeType !== Node.ELEMENT_NODE) return null;
  if (block.tagName === 'TABLE') return splitTable(block, limit, room);
  const rest = block.tagName === 'P' ? splitParagraph(block, limit, alone) : CONTAINERS.has(block.tagName) ? splitContainer(block, limit, alone, room) : null;
  return rest && [rest];
}

/** 안의 블록 단위로 나눌 수 있는 상자(각주 목록·글상자 묶음 등) */
const CONTAINERS = new Set(['DIV', 'SECTION', 'OL', 'UL', 'BLOCKQUOTE']);

/** 상자를 안의 블록 단위로 나눈다. 넘치는 첫 블록은 다시 나눠 보고, 그 뒤 블록은 뒤쪽 상자로 옮긴다. */
function splitContainer(box, limit, alone, room) {
  // 글자만 든 상자나 여러 단으로 흐르는 상자는 안에서 나누지 않는다.
  if (!box.firstElementChild || getComputedStyle(box).columnCount !== 'auto') return null;
  const kids = [...box.childNodes];
  let at = kids.findIndex((kid) => kid.nodeType === Node.ELEMENT_NODE && kid.getBoundingClientRect().bottom > limit + SLACK);
  if (at < 0) return null;
  const pieces = splitBlock(kids[at], limit, alone && at === 0, room);
  if (!pieces && at === 0) return null; // 첫 블록부터 안 들어가고 나눌 수도 없다
  const rest = box.cloneNode(false);
  rest.removeAttribute('id');
  if (pieces) {
    rest.append(...pieces);
    at += 1;
  }
  for (const kid of kids.slice(at)) rest.appendChild(kid);
  if (box.tagName === 'OL') {
    // 번호가 이어지게: 앞쪽에 온전히 남은 항목 수만큼 시작 번호를 민다. 나뉜 항목의 뒤 조각에는 번호를 다시 달지 않는다.
    const split = pieces?.[0]?.tagName === 'LI';
    rest.start = (box.start || 1) + [...box.children].filter((kid) => kid.tagName === 'LI').length - (split ? 1 : 0);
    if (split) pieces[0].style.listStyleType = 'none';
  }
  return rest;
}

/** 문단을 넘치는 줄 앞에서 둘로 나누고 뒤쪽을 돌려준다. */
function splitParagraph(p, limit, alone) {
  // 여러 단으로 흐르는 본문은 줄이 위아래로만 이어지지 않아 나누지 않는다.
  if (getComputedStyle(p.parentElement).columnCount !== 'auto') return null;
  const lines = lineBoxes(p);
  let cut = lines.findIndex((line) => line.bottom > limit + SLACK);
  if (cut <= 0) return null;
  // 외톨이 줄 막기: 앞 쪽에 한 줄만 남으면 문단째 넘기고, 다음 쪽에 마지막 한 줄만 가면 한 줄 더 넘긴다.
  if (cut === 1 && !alone) return null;
  if (cut === lines.length - 1 && cut >= 2) cut -= 1;
  const at = lineStart(p, lines[cut].top);
  if (!at) return null;
  const range = document.createRange();
  range.setStart(at.node, at.offset);
  range.setEnd(p, p.childNodes.length);
  const rest = p.cloneNode(false);
  rest.appendChild(range.extractContents());
  rest.removeAttribute('id');
  // 첫 줄 들여쓰기·문단 앞 간격·쪽 앞 나눔은 앞 조각에만, 문단 뒤 간격은 뒤 조각에만 둔다.
  rest.style.textIndent = '0';
  rest.style.marginTop = '0';
  rest.style.breakBefore = 'auto';
  p.style.marginBottom = '0';
  return rest;
}

function textNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.length) nodes.push(node);
  return nodes;
}

/** 문단의 줄(글자가 차지한 세로 범위). 글자 조각의 위치를 모아 세로로 겹치는 것끼리 한 줄로 묶는다. */
function lineBoxes(p) {
  const rects = [];
  const range = document.createRange();
  for (const node of textNodes(p)) {
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) if (rect.height > 0 && rect.width > 0) rects.push(rect);
  }
  rects.sort((a, b) => a.top - b.top);
  const lines = [];
  for (const rect of rects) {
    const line = lines.at(-1);
    if (line && rect.top < (line.top + line.bottom) / 2) {
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else {
      lines.push({ top: rect.top, bottom: rect.bottom });
    }
  }
  return lines;
}

/**
 * 위 끝이 top인 줄의 첫 글자 위치. 화면 밖이라 좌표로 글자를 찾는 API(caretRangeFromPoint)를 쓸 수 없어,
 * 글자마다 위치를 재며 찾는다. 글자는 문서 순서대로 아래로 내려가므로 글자 조각 안에서는 이분 탐색한다.
 */
function lineStart(p, top) {
  const range = document.createRange();
  const topOf = (node, i) => {
    // 접힌 공백은 자리가 없으므로 다음 글자로 본다.
    for (let k = i; k < node.length && k < i + 8; k++) {
      range.setStart(node, k);
      range.setEnd(node, k + 1);
      const rects = range.getClientRects();
      if (rects.length) return rects[rects.length - 1].top;
    }
    return -Infinity;
  };
  const onLine = (node, i) => topOf(node, i) >= top - SLACK;
  for (const node of textNodes(p)) {
    range.selectNodeContents(node);
    const rects = range.getClientRects();
    if (!rects.length || rects[rects.length - 1].bottom <= top + SLACK) continue; // 이 조각은 그 줄보다 위에서 끝난다
    let lo = 0;
    let hi = node.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (onLine(node, mid)) hi = mid;
      else lo = mid + 1;
    }
    if (lo < node.length) return { node, offset: lo };
  }
  return null;
}

/** 표를 넘치는 행 앞에서 둘로 나누고 뒤쪽 표를 돌려준다. 머리글 행 반복(data-repeat="header")은 뒤쪽 표에도 넣는다. */
function splitTable(table, limit, room) {
  const rows = [...table.rows];
  let headers = rows.findIndex((row) => row.dataset.repeat !== 'header');
  if (headers < 0) headers = 0;
  let cut = rows.findIndex((row) => row.getBoundingClientRect().bottom > limit + SLACK);
  if (cut < 0) return null;
  // 빈 쪽에도 안 들어가는 큰 행(칸 하나에 긴 글이 든 표)은 칸 안의 내용을 나눠 행째로 둘로 나눈다
  // (Word의 '행을 여러 쪽에 나누기'). 작은 행은 나누지 않고 통째로 다음 쪽으로 넘긴다.
  const row = rows[cut];
  if (cut >= headers && row.offsetHeight > room && row.getBoundingClientRect().top < limit - MIN_PIECE) {
    const tail = splitRow(row, limit, room);
    if (tail) {
      row.after(tail);
      rows.splice(cut + 1, 0, tail);
      cut += 1;
    }
  }
  // 세로로 합친 칸이 나눌 자리를 넘어가면 그 묶음 앞에서 나눈다.
  while (cut > headers && spansAcross(rows, cut)) cut--;
  if (cut <= headers) return null; // 머리글 말고 한 행도 못 남긴다
  // 남은 행은 지금 잰 위치로 미리 한 쪽 크기씩 묶는다. 남은 표 전체를 쪽마다 다시 배치하면 행 수의 제곱만큼
  // 느려진다(236쪽 문서에서 표를 붙이고 재는 데만 8초). 묶음이 다음 쪽에서 안 들어가면 그때 다시 나눈다.
  const top = rows.map((row) => row.getBoundingClientRect().top);
  const bottom = rows.map((row) => row.getBoundingClientRect().bottom);
  const header = headers ? bottom[headers - 1] - top[0] : 0;
  // 행 밖의 표 높이(테두리·칸 간격·위아래 여백)도 조각마다 든다.
  const box = table.getBoundingClientRect();
  const frame = box.height - (bottom.at(-1) - top[0]) + (Number.parseFloat(getComputedStyle(table).marginTop) || 0);
  const pieces = [];
  for (let start = cut; start < rows.length; ) {
    let end = start + 1;
    while (end < rows.length && bottom[end] - top[start] + header + frame <= room - SLACK) end++;
    while (end < rows.length && end > start + 1 && spansAcross(rows, end)) end--;
    pieces.push(tablePiece(table, rows.slice(0, headers), rows.slice(start, end)));
    start = end;
  }
  return pieces;
}

/** table과 같은 모양(열 너비·머리글 행)의 새 표에 rows를 옮긴다. */
function tablePiece(table, headerRows, rows) {
  const piece = table.cloneNode(false);
  piece.removeAttribute('id');
  const columns = table.querySelector(':scope > colgroup');
  if (columns) piece.appendChild(columns.cloneNode(true));
  const parts = new Map(); // 원래 thead·tbody → 새 표의 같은 칸
  const into = (row) => {
    const parent = row.parentElement;
    if (parent === table) return piece;
    if (!parts.has(parent)) parts.set(parent, piece.appendChild(parent.cloneNode(false)));
    return parts.get(parent);
  };
  for (const row of headerRows) into(row).appendChild(row.cloneNode(true));
  for (const row of rows) into(row).appendChild(row);
  return piece;
}

/** 칸마다 안의 블록을 limit에서 나눠 뒤쪽을 새 행으로 돌려준다. 세로로 합친 칸이 있거나 앞쪽에 남는 것이 없으면 null. */
function splitRow(row, limit, room) {
  if ([...row.cells].some((cell) => cell.rowSpan > 1)) return null;
  const tail = row.cloneNode(false);
  tail.removeAttribute('id');
  delete tail.dataset.repeat;
  for (const cell of row.cells) {
    const next = cell.cloneNode(false);
    next.removeAttribute('id');
    const kids = [...cell.childNodes];
    let at = kids.findIndex((kid) => kid.nodeType === Node.ELEMENT_NODE && kid.getBoundingClientRect().bottom > limit + SLACK);
    if (at >= 0) {
      const pieces = splitBlock(kids[at], limit, at === 0, room);
      if (pieces) {
        next.append(...pieces);
        at += 1;
      }
      for (const kid of kids.slice(at)) next.appendChild(kid);
    }
    tail.appendChild(next);
  }
  if ([...row.cells].some((cell) => cell.childNodes.length)) return tail;
  // 앞쪽에 남은 것이 없으면(칸마다 첫 블록부터 나눌 수 없다) 옮긴 내용을 제자리로 되돌리고 나누지 않는다.
  [...tail.cells].forEach((next, index) => row.cells[index].append(...next.childNodes));
  return null;
}

function spansAcross(rows, cut) {
  for (let r = 0; r < cut; r++) for (const cell of rows[r].cells) if (r + cell.rowSpan > cut) return true;
  return false;
}

const serializer = new XMLSerializer();
const parser = new DOMParser();

/**
 * 쪽 요소를 보관용 문자열로. HTML로 저장했다 다시 읽으면 브라우저가 규칙에 안 맞게 겹친 요소(docx 렌더러가
 * 만드는 표 안의 div 등)를 다른 자리로 옮겨 배치가 달라지므로(쪽이 길어져 넘친다), 구조를 그대로 지키는 XHTML로 둔다.
 */
export const savePage = (page) => serializer.serializeToString(page);

/** savePage로 보관한 쪽을 요소로 되살린다. XML로 읽지 못하는 글자가 있으면 HTML로 읽는다(구조가 조금 달라질 수 있다). */
export function loadPage(saved) {
  const parsed = parser.parseFromString(saved, 'application/xhtml+xml');
  if (!parsed.getElementsByTagName('parsererror').length) return document.importNode(parsed.documentElement, true);
  const wrapper = document.createElement('div');
  wrapper.innerHTML = saved;
  return wrapper.firstElementChild;
}

/**
 * 다음 차례. 낮은 우선순위 작업으로 미뤄 터치·스크롤·화면 그리기를 먼저 하게 한다. requestIdleCallback은
 * 저사양 기기에서 좀처럼 한가해지지 않아 매번 최대 대기까지 기다렸다(238쪽 문서에서 대기만 22초).
 */
const nextTurn = () =>
  globalThis.scheduler?.postTask
    ? scheduler.postTask(() => {}, { priority: 'background' })
    : new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 뒤에서 나눌 때는 블록 사이에서도 SLICE_MS마다 쉬어, 저사양 기기에서 쪽 하나를 만드는 동안(100ms 넘게)
 * 화면에 들어온 쪽을 못 그려 빈 쪽이 보이지 않게 한다. 처음 보일 쪽을 만드는 동안은 쉬지 않는다.
 */
const pace = { background: false, since: 0 };
async function breathe() {
  if (!pace.background || performance.now() - pace.since < SLICE_MS) return;
  await nextTurn();
  pace.since = performance.now();
}

/**
 * 쪽 요소를 내놓는 반복자(fillPages를 감싼 것)에서 화면 쪽을 쌓는다. 쪽은 문자열(savePage)과 크기로 보관하고
 * (DOM보다 가볍다) 요소는 바로 떼어 낸다. pages: [{ saved, size }], finished: 다 나누면 풀리는 약속.
 */
export function createPager(iterator) {
  const pages = [];
  let done = false;
  let finish;
  const finished = new Promise((resolve) => (finish = resolve));
  async function step() {
    if (done) return false;
    let next;
    try {
      next = await iterator.next();
    } catch (error) {
      console.warn('쪽 나누기를 멈춥니다:', error);
      next = { done: true };
    }
    if (next.done) {
      done = true;
      finish();
      return false;
    }
    const page = next.value;
    pages.push({ saved: savePage(page), size: { width: page.offsetWidth, height: page.offsetHeight } });
    page.remove();
    return true;
  }
  return {
    pages,
    finished,
    get done() {
      return done;
    },
    /** 쪽이 count개가 될 때까지(또는 끝까지) 바로 만든다. */
    async fill(count) {
      while (pages.length < count && (await step()));
    },
    /** 나머지를 뒤에서 조금씩(SLICE_MS) 만든다. 쪽이 늘거나 다 나누면 onGrow를 부른다. */
    async background(onGrow) {
      pace.background = true;
      while (!done) {
        await nextTurn();
        pace.since = performance.now();
        const until = pace.since + SLICE_MS;
        let grew = false;
        while ((await step()) && ((grew = true), performance.now() < until));
        if (grew || done) onGrow();
      }
    },
  };
}
