// 엑셀 인쇄·PDF로 저장: 지금 보는 시트를 파일의 인쇄 설정대로 쪽으로 나눠 인쇄용 층에 그린다.
// 따르는 설정: 인쇄 영역, 용지 방향, 여백, 배율·한 쪽에 맞춤, 직접 넣은 쪽 나누기, 반복할 행·열, 가운데 맞춤,
// 눈금선 인쇄, 머리글·바닥글(글자·그림). 용지는 A4로 둔다(앱이 인쇄 화면을 A4로 연다).
// 쪽마다 SVG(foreignObject) 안에 용지 크기(96dpi px)로 그려, 인쇄할 때 용지 폭에 맞춰 함께 줄고 는다.
// 칸은 화면 표(SheetGrid)의 paint로 같은 서식을 그대로 그린다.

const PAPER = { portrait: [794, 1123], landscape: [1123, 794] }; // A4, 96dpi
const XHTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';

function upperBound(prefix, value, count) {
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prefix[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** start~end를 한 쪽 길이(avail) 안에 들게 나눈다. 직접 넣은 쪽 나누기(breaks: 새 쪽이 시작하는 번호)를 따른다. */
function split(edges, start, end, avail, breaks) {
  const out = [];
  let from = start;
  for (let i = start; i <= end; i++) {
    const tooLong = edges[i + 1] - edges[from] > avail(from) && i > from;
    if (tooLong || (breaks.has(i) && i > from)) {
      out.push([from, i - 1]);
      from = i;
    }
  }
  out.push([from, end]);
  return out;
}

/**
 * 머리글·바닥글 글자(&L…&C…&R…)를 세 구역으로 나누고 코드를 바꾼다.
 * &P 쪽 번호, &N 전체 쪽 수, &D 날짜, &T 시각, &F 파일 이름, &A 시트 이름, &G 그림. 글꼴·크기·색 코드는 뺀다.
 */
function headerSections(text, vars) {
  const out = { L: '', C: '', R: '' };
  let section = 'C';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '&') {
      out[section] += ch;
      continue;
    }
    const code = text[++i];
    if (code === undefined) break;
    if (code === 'L' || code === 'C' || code === 'R') section = code;
    else if (code === '&') out[section] += '&';
    else if (code === 'P') out[section] += vars.page;
    else if (code === 'N') out[section] += vars.pages;
    else if (code === 'D') out[section] += vars.date;
    else if (code === 'T') out[section] += vars.time;
    else if (code === 'F') out[section] += vars.file;
    else if (code === 'A') out[section] += vars.sheet;
    else if (code === 'Z') out[section] += '';
    else if (code === 'G') out[section] += '\u0007'; // 그림 자리
    else if (code === '"') i = text.indexOf('"', i + 1); // 글꼴 이름
    else if (code === 'K') i += /^[0-9A-Fa-f]{6}/.test(text.slice(i + 1)) ? 6 : 3; // 글자색
    else if (/\d/.test(code)) while (/\d/.test(text[i + 1] ?? '')) i++; // 글자 크기
    // 그 밖의 코드(굵게·기울임·밑줄 등)는 모양만이라 뺀다.
  }
  return out;
}

function el(tag, className, style = '', ns = XHTML) {
  const node = document.createElementNS(ns, tag);
  if (className) node.setAttribute('class', className);
  if (style) node.setAttribute('style', style);
  return node;
}

/**
 * 인쇄용 쪽을 root에 그린다. 너무 많으면 TooManyPagesError(limit)를 던지도록 makeError를 부른다.
 * @returns {Promise<{width: number, height: number}>} 용지 크기(앱이 용지 방향을 고른다)
 */
export async function buildSheetPrint(grid, root, { file, sheetName, limit, makeError }) {
  const meta = grid.meta;
  const geo = grid.geo;
  const print = meta.print ?? {};
  const { rowTop, colLeft, nRows, nCols } = geo;
  // 인쇄 영역: 정해 두지 않았으면 데이터와 그림이 있는 범위
  let [r1, c1, r2, c2] = print.area ?? [0, 0, Math.max(0, meta.rowCount - 1), Math.max(0, meta.colCount - 1)];
  if (!print.area) {
    for (const p of meta.pictures) {
      const r = grid.pictureRect(p);
      if (r.w < 1 && r.h < 1) continue;
      r2 = Math.max(r2, upperBound(rowTop, r.y + r.h - 1, nRows + 1));
      c2 = Math.max(c2, upperBound(colLeft, r.x + r.w - 1, nCols + 1));
    }
  }
  r2 = Math.min(r2, nRows - 1);
  c2 = Math.min(c2, nCols - 1);
  r1 = Math.min(r1, r2);
  c1 = Math.min(c1, c2);
  const titleRows = print.titleRows && print.titleRows[0] <= print.titleRows[1] && print.titleRows[1] < nRows ? print.titleRows : null;
  const titleCols = print.titleCols && print.titleCols[0] <= print.titleCols[1] && print.titleCols[1] < nCols ? print.titleCols : null;
  await grid.loadRows(Math.min(r1, titleRows?.[0] ?? r1), r2);

  const [PW, PH] = print.landscape ? PAPER.landscape : PAPER.portrait;
  const m = print.margins ?? { l: 0.7, r: 0.7, t: 0.75, b: 0.75, header: 0.3, footer: 0.3 };
  const box = { x: m.l * 96, y: m.t * 96, w: Math.max(50, PW - (m.l + m.r) * 96), h: Math.max(50, PH - (m.t + m.b) * 96) };
  const TH = titleRows ? rowTop[titleRows[1] + 1] - rowTop[titleRows[0]] : 0;
  const TW = titleCols ? colLeft[titleCols[1] + 1] - colLeft[titleCols[0]] : 0;
  const totalW = colLeft[c2 + 1] - colLeft[c1];
  const totalH = rowTop[r2 + 1] - rowTop[r1];
  // 배율: 한 쪽에 맞춤이면 가로 fit.w쪽·세로 fit.h쪽(0이면 제한 없음)에 들게 줄인다.
  let scale = print.scale ?? 1;
  if (print.fit) {
    const sx = print.fit.w > 0 ? (print.fit.w * box.w) / (totalW + print.fit.w * TW) : Infinity;
    const sy = print.fit.h > 0 ? (print.fit.h * box.h) / (totalH + print.fit.h * TH) : Infinity;
    scale = Math.min(1, sx, sy);
  }
  // 반복할 행·열은 그 행·열이 이미 지나간 쪽에만 붙는다(엑셀처럼 첫 쪽에 두 번 찍히지 않게).
  const titleH = (from) => (titleRows && from > titleRows[1] ? TH : 0);
  const titleW = (from) => (titleCols && from > titleCols[1] ? TW : 0);
  const colRanges = split(colLeft, c1, c2, (from) => Math.max(20, box.w / scale - titleW(from)), new Set(print.colBreaks ?? []));
  const rowRanges = split(rowTop, r1, r2, (from) => Math.max(20, box.h / scale - titleH(from)), new Set(print.rowBreaks ?? []));
  const pages = [];
  for (const cols of colRanges) for (const rows of rowRanges) pages.push({ rows, cols }); // 아래로 먼저, 그다음 오른쪽
  if (pages.length > limit) throw makeError(limit);

  const now = new Date();
  const vars = { pages: pages.length, date: now.toLocaleDateString(), time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), file, sheet: sheetName };
  for (let index = 0; index < pages.length; index++) {
    const { rows, cols } = pages[index];
    const th = titleH(rows[0]);
    const tw = titleW(cols[0]);
    const page = el('div', 'page print-page');
    page.style.aspectRatio = `${PW} / ${PH}`;
    page.style.setProperty('--ratio', String(PW / PH));
    const svg = el('svg', '', '', SVG);
    svg.setAttribute('viewBox', `0 0 ${PW} ${PH}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    const fo = el('foreignObject', '', '', SVG);
    fo.setAttribute('width', String(PW));
    fo.setAttribute('height', String(PH));
    const sheetEl = el('div', 'sheet-body sheet-print', `width:${PW}px;height:${PH}px`);
    fo.appendChild(sheetEl);
    svg.appendChild(fo);
    page.appendChild(svg);
    root.appendChild(page);

    // 표: 반복할 행·열(제목)과 이 쪽의 본문을 칸 단위로 그린다. 왼쪽·위 1px은 첫 칸 테두리 자리다.
    const bodyW = colLeft[cols[1] + 1] - colLeft[cols[0]];
    const bodyH = rowTop[rows[1] + 1] - rowTop[rows[0]];
    const contentW = (tw + bodyW + 1) * scale;
    const contentH = (th + bodyH + 1) * scale;
    const left = box.x + (print.center?.h ? Math.max(0, (box.w - contentW) / 2) : 0);
    const top = box.y + (print.center?.v ? Math.max(0, (box.h - contentH) / 2) : 0);
    const content = el('div', 'sheet-print-content', `left:${left}px;top:${top}px;width:${tw + bodyW + 1}px;height:${th + bodyH + 1}px;transform:scale(${scale})`);
    sheetEl.appendChild(content);
    const area = (rr, cc, x, y) => {
      const w = colLeft[cc[1] + 1] - colLeft[cc[0]] + 1;
      const h = rowTop[rr[1] + 1] - rowTop[rr[0]] + 1;
      const target = el('div', 'sg-cells', `left:${x}px;top:${y}px;width:${w}px;height:${h}px`);
      content.appendChild(target);
      const ox = colLeft[cc[0]] - 1;
      const oy = rowTop[rr[0]] - 1;
      grid.paint(target, rr[0], rr[1], cc[0], cc[1], ox, oy, { grid: Boolean(print.grid), measure: false });
      // 그림·차트·도형: 이 칸 범위에 걸치는 것만, 범위 밖은 잘린다.
      meta.pictures.forEach((p, i) => {
        const r = grid.pictureRect(p);
        const pad = p.shapes ? 6 : 0;
        if (r.w < 1 && r.h < 1) return;
        if (r.x + r.w < colLeft[cc[0]] || r.x > colLeft[cc[1] + 1] || r.y + r.h < rowTop[rr[0]] || r.y > rowTop[rr[1] + 1]) return;
        const drawn = ['chart', 'chartex', 'shapes'].includes(grid.media[p.media]?.type);
        const url = drawn ? grid.chartUrl(i, p) : grid.mediaUrls[p.media];
        if (!url) return;
        const pic = el('div', 'sg-pic', `left:${r.x - ox - pad}px;top:${r.y - oy - pad}px;width:${r.w + 2 * pad}px;height:${r.h + 2 * pad}px`);
        if (p.rot || p.flipH || p.flipV) pic.style.transform = `rotate(${p.rot}deg) scale(${p.flipH ? -1 : 1},${p.flipV ? -1 : 1})`;
        const img = el('img');
        img.setAttribute('src', url);
        img.setAttribute('alt', '');
        if (p.crop) {
          const [l, t, rr2, b] = p.crop;
          const iw = r.w / Math.max(0.01, 1 - l - rr2);
          const ih = r.h / Math.max(0.01, 1 - t - b);
          img.setAttribute('style', `width:${iw}px;height:${ih}px;left:${-l * iw}px;top:${-t * ih}px`);
        }
        pic.appendChild(img);
        const layer = target.querySelector(':scope > .sg-pics') ?? target.appendChild(el('div', 'sg-pics'));
        layer.appendChild(pic);
      });
    };
    if (th && tw) area(titleRows, titleCols, 0, 0);
    if (th) area(titleRows, cols, tw, 0);
    if (tw) area(rows, titleCols, 0, th);
    area(rows, cols, tw, th);

    // 머리글·바닥글
    const pageVars = { ...vars, page: index + 1 };
    const band = (text, y, kind) => {
      if (!text) return;
      const sections = headerSections(text, pageVars);
      for (const [key, align] of [['L', 'left'], ['C', 'center'], ['R', 'right']]) {
        const value = sections[key];
        if (!value) continue;
        const edge = kind === 'header' ? `top:${y}px` : `bottom:${y}px`;
        const node = el('div', `sheet-print-hf ${kind}`, `left:${box.x}px;width:${box.w}px;${edge};text-align:${align}`);
        const image = print.images?.[`${key}${kind === 'header' ? 'H' : 'F'}`];
        for (const [i, part] of value.split('\u0007').entries()) {
          if (i > 0 && image) {
            const img = el('img', '', `width:${image.w}px;height:${image.h}px;vertical-align:${kind === 'header' ? 'top' : 'bottom'}`);
            img.setAttribute('src', (image.url ??= URL.createObjectURL(new Blob([image.data], { type: image.type }))));
            node.appendChild(img);
          }
          if (part) node.appendChild(document.createTextNode(part));
        }
        sheetEl.appendChild(node);
      }
    };
    band(print.header, m.header * 96, 'header');
    band(print.footer, m.footer * 96, 'footer');
  }
  return { width: PW, height: PH };
}
