// 가상 스크롤 표: 화면에 보이는 행·열(과 앞뒤 여유분)만 DOM으로 그린다.
// 셀 내용은 워커에 행 묶음(64행) 단위로 요청해 받아 두고, 스크롤이 그린 범위를 벗어나면 다시 그린다.
//
// 배치(스크롤 상자 안의 큰 캔버스)
//   ┌ 머리글 띠(sticky top) ─ 모서리 │ 고정 열 머리글 │ 열 머리글
//   ├ 고정 행 띠(sticky top) ─ 행 머리글 │ 고정 모서리 셀 │ 고정 행 셀
//   └ 본문 띠 ─────────────── 행 머리글 │ 고정 열 셀 │ 본문 셀
// 각 띠 안에서 행 머리글과 고정 열은 sticky left라 가로 스크롤에도 제자리에 있다.
// 셀 상자는 왼쪽·위로 1px 넓혀 양쪽 눈금선 자리까지 덮는다(엑셀처럼 채우기가 눈금선을 가린다).
// 테두리는 서식별 ::after 층에 두께에 맞춰 눈금선 가운데로 그려, 이웃 셀이 같은 변에 준 테두리와 한 선으로 겹친다.
// 그림은 영역마다 셀 위에 한 층(.sg-pics)을 두고, 셀을 다시 그려도 그 층은 버리지 않고 다시 붙인다.

const HEAD_HEIGHT = 20;
const OVERSCAN = 0.5; // 보이는 범위의 몇 배를 앞뒤로 더 그릴지
const KEEP_BLOCKS = 32;
const MAX_INFLIGHT = 3;
const MAX_SPILL_COLS = 64;
const MAX_COLS = 16384;
const MAX_ROW_HEIGHT = 545; // 엑셀 행 높이 상한(409pt)
// 셀 종류(워커와 같음)
const BLANK = 0;
const NUM = 1;
const STR = 2;
const BOOL = 3;
const ERR = 4;
const PRENUM = 5;
// 가로 정렬 번호(styles.js의 H_CODE와 같음)
const H_GENERAL = 0;
const H_LEFT = 1;
const H_CENTER = 2;
const H_RIGHT = 3;
const H_CONTINUOUS = 6;

const ESCAPE = /[&<>]/;
const ESCAPES = /[&<>]/g;
const escapeHtml = (s) => (ESCAPE.test(s) ? s.replace(ESCAPES, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;')) : s);
// 줄 바꿈 서식이 없는 칸의 줄바꿈 문자는 엑셀처럼 한 줄로 보여 준다.
const shownText = (text, style) => (!style.wrap && text.includes('\n') ? text.replace(/\r?\n/g, ' ') : text);

export function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function upperBound(prefix, value, count) {
  // prefix[i] <= value < prefix[i+1] 인 i
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prefix[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function lowerBoundCols(cols, from, to, value) {
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cols[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const div = (className) => {
  const el = document.createElement('div');
  el.className = className;
  return el;
};

export class SheetGrid {
  constructor(scroller, { fetchBlock, onScroll }) {
    this.scroller = scroller;
    this.fetchBlock = fetchBlock;
    this.onScroll = onScroll;
    this.styleSheet = document.head.appendChild(document.createElement('style')).sheet;
    this.styleMeta = new Map();
    this.frame = 0;
    this.force = false;
    scroller.addEventListener('scroll', () => this.schedule(), { passive: true });
    addEventListener('resize', () => {
      if (!this.meta) return;
      this.layout();
      this.schedule(true);
    });
  }

  /** 서식 CSS를 문서에 더한다. 워커는 처음 쓰이는 서식만 보낸다. 테두리는 셀 위 ::after 층에 그린다. */
  addStyles(styles) {
    const insert = (rule) => {
      try {
        this.styleSheet.insertRule(rule, this.styleSheet.cssRules.length);
      } catch {
        // 잘못된 CSS 값 하나 때문에 표 전체를 멈추지 않는다.
      }
    };
    for (const [key, entry] of Object.entries(styles ?? {})) {
      const xf = Number(key);
      if (this.styleMeta.has(xf)) continue;
      this.styleMeta.set(xf, entry);
      if (entry.css) insert(`.sheet-body .sg-cells .x${xf}{${entry.css}}`);
      if (entry.border) insert(`.sheet-body .sg-cells .x${xf}::after{content:'';${entry.border}}`);
      if (entry.span) insert(`.sheet-body .sg-cells .x${xf}>span{${entry.span}}`);
    }
  }

  setBaseCss(css) {
    if (this.baseCss === css) return;
    this.baseCss = css;
    if (css) this.styleSheet.insertRule(`.sheet-body .sg-cells{${css}}`, this.styleSheet.cssRules.length);
  }

  /** 시트를 바꿔 그린다. 첫 화면이 그려지면 resolve한다. */
  show(sheet, payload) {
    this.sheet = sheet;
    this.meta = payload.meta;
    this.blocks = new Map();
    this.inflight = new Set();
    // 저장된 행 높이는 원본 글꼴 기준이라 대체 글꼴로는 줄바꿈 글이 넘칠 수 있다.
    // 사용자가 높이를 정하지 않은 행은 그려 본 뒤 넘치면 늘린다(LibreOffice도 다시 계산한다).
    this.grown = new Map();
    this.growth = new Map();
    this.customRows = new Set(payload.meta.customRows);
    this.setMedia(payload.media);
    this.setBaseCss(payload.baseCss);
    this.addStyles(payload.styles);
    for (const block of payload.blocks) this.blocks.set(block.start / this.meta.blockRows, block);
    this.indexSparse();
    this.layout();
    this.scroller.scrollTo(0, 0);
    this.render(true);
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  /**
   * 그림 바이트를 주소(blob URL)로 바꾼다. 앞 시트의 주소는 놓아준다.
   * 차트는 놓일 크기를 알아야 그리므로 여기서는 XML만 들고 있다가 buildPictures에서 그린다(chartUrl).
   */
  setMedia(media = []) {
    for (const url of this.mediaUrls ?? []) if (url) URL.revokeObjectURL(url);
    for (const url of this.chartUrls?.values() ?? []) if (url) URL.revokeObjectURL(url);
    this.media = media;
    this.chartUrls = new Map();
    this.mediaUrls = media.map((m) => (m && m.type !== 'chart' ? URL.createObjectURL(new Blob([m.svg ?? m.data], { type: m.type })) : null));
  }

  /** 차트 하나를 처음 놓인 크기로 SVG로 그려 주소를 만든다(그림마다 한 번). 그리기 함수가 없거나 실패하면 null */
  chartUrl(i, p) {
    if (this.chartUrls.has(i)) return this.chartUrls.get(i);
    let url = null;
    const m = this.media[p.media];
    const r = this.pictureRect(p);
    try {
      const svg = this.renderChart && r.w > 0 && r.h > 0 ? this.renderChart(m.xml, m.theme, r.w, r.h) : null;
      if (svg) url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    } catch (error) {
      console.warn('[sheet] chart skipped', error);
    }
    this.chartUrls.set(i, url);
    return url;
  }

  indexSparse() {
    const m = this.meta;
    const toMap = ({ index, value }) => {
      const map = new Map();
      for (let i = 0; i < index.length; i++) map.set(index[i], value[i]);
      return map;
    };
    this.rowStyles = toMap(m.rowStyles);
    this.colStyles = toMap(m.colStyles);
    // 병합: 행 묶음별로 걸치는 병합을 모아 둔다.
    this.merges = [];
    for (let i = 0; i < m.merges.length; i += 4) this.merges.push([m.merges[i], m.merges[i + 1], m.merges[i + 2], m.merges[i + 3]]);
    this.mergeBuckets = new Map();
    for (const merge of this.merges) {
      for (let b = Math.floor(merge[0] / 64); b <= Math.floor(merge[2] / 64); b++) {
        if (!this.mergeBuckets.has(b)) this.mergeBuckets.set(b, []);
        this.mergeBuckets.get(b).push(merge);
      }
    }
  }

  /** 행 위치·열 위치 누적합과 고정 범위를 계산하고 캔버스 뼈대를 만든다. */
  layout() {
    const m = this.meta;
    const vw = this.scroller.clientWidth;
    const vh = this.scroller.clientHeight;
    // 데이터가 적어도 화면을 채울 만큼 빈 칸을 그린다(엑셀처럼). 그림이 놓인 자리까지도 그린다.
    let nRows = Math.min(1_048_576, Math.max(m.rowCount, m.freezeRows + 1, Math.ceil(vh / Math.max(8, m.defaultRowHeight)) + 1));
    let nCols = Math.min(MAX_COLS, Math.max(m.colCount, m.freezeCols + 1, Math.ceil(vw / Math.max(8, m.defaultColWidth)) + 1));
    for (const p of m.pictures) {
      const end = p.to ?? p.from;
      if (!end) continue;
      nRows = Math.min(1_048_576, Math.max(nRows, end[2] + 1));
      nCols = Math.min(MAX_COLS, Math.max(nCols, end[0] + 1));
    }
    let rowTop;
    let colLeft;
    // 크기로 놓인 그림(oneCell·absolute)이 끝보다 길면 행·열을 더해 한 번 더 잰다.
    for (let pass = 0; pass < 2; pass++) {
      ({ rowTop, colLeft } = this.prefixes(nRows, nCols));
      let right = 0;
      let bottom = 0;
      for (const p of m.pictures) {
        const box = this.pictureRect(p, rowTop, colLeft, nRows, nCols);
        right = Math.max(right, box.x + box.w);
        bottom = Math.max(bottom, box.y + box.h);
      }
      const moreRows = bottom > rowTop[nRows] ? Math.ceil((bottom - rowTop[nRows]) / Math.max(8, m.defaultRowHeight)) + 1 : 0;
      const moreCols = right > colLeft[nCols] ? Math.ceil((right - colLeft[nCols]) / Math.max(8, m.defaultColWidth)) + 1 : 0;
      if (!moreRows && !moreCols) break;
      nRows = Math.min(1_048_576, nRows + moreRows);
      nCols = Math.min(MAX_COLS, nCols + moreCols);
      if (pass === 1) ({ rowTop, colLeft } = this.prefixes(nRows, nCols));
    }
    const rowHead = Math.max(32, String(nRows).length * 8 + 12);
    // 휴대폰에서 고정 영역이 화면 대부분을 차지하면 고정을 푼다.
    let fr = Math.min(m.freezeRows, nRows - 1);
    let fc = Math.min(m.freezeCols, nCols - 1);
    if (rowTop[fr] > (vh - HEAD_HEIGHT) * 0.5) fr = 0;
    if (colLeft[fc] > (vw - rowHead) * 0.6) fc = 0;
    // 본문 영역은 고정 경계의 눈금선 자리(첫 본문 칸의 앞쪽 선)부터 시작한다. fw·fh는 고정 영역 크기다.
    this.geo = { nRows, nCols, rowTop, colLeft, rowHead, fr, fc, fw: colLeft[fc] - 1, fh: rowTop[fr] - 1 };
    this.build();
    this.rendered = null;
  }

  /** 시트 좌표 누적합. 시트 좌표는 1부터 시작한다: 0은 A열 왼쪽·1행 위쪽 눈금선 자리라, 첫 칸의 앞쪽 테두리도 보인다. */
  prefixes(nRows, nCols) {
    const m = this.meta;
    const rowTop = new Float64Array(nRows + 1);
    const heights = new Float32Array(nRows).fill(m.defaultRowHeight);
    for (let i = 0; i < m.rowHeights.index.length; i++) if (m.rowHeights.index[i] < nRows) heights[m.rowHeights.index[i]] = m.rowHeights.value[i];
    for (const [r, h] of this.grown) if (r < nRows) heights[r] = h;
    rowTop[0] = 1;
    for (let r = 0; r < nRows; r++) rowTop[r + 1] = rowTop[r] + heights[r];
    const colLeft = new Float64Array(nCols + 1);
    const widths = new Float32Array(nCols).fill(m.defaultColWidth);
    for (let i = 0; i < m.colWidths.index.length; i++) if (m.colWidths.index[i] < nCols) widths[m.colWidths.index[i]] = m.colWidths.value[i];
    colLeft[0] = 1;
    for (let c = 0; c < nCols; c++) colLeft[c + 1] = colLeft[c] + widths[c];
    return { rowTop, colLeft };
  }

  /**
   * 그림의 시트 좌표 상자. 셀 앵커는 그 칸의 왼쪽·위에서 오프셋만큼 떨어진 자리다.
   * 오프셋은 px(xlsx)이거나, frac이면 그 칸 너비·높이에 대한 비율(xls)이다.
   */
  pictureRect(p, rowTop = this.geo.rowTop, colLeft = this.geo.colLeft, nRows = this.geo.nRows, nCols = this.geo.nCols) {
    const along = (edges, n, i, offset) => {
      const k = Math.min(i, n);
      return edges[k] + (p.frac ? offset * (k < n ? edges[k + 1] - edges[k] : 0) : offset);
    };
    const at = (a) => [along(colLeft, nCols, a[0], a[1]), along(rowTop, nRows, a[2], a[3])];
    const [x0, y0] = p.from ? at(p.from) : [1 + (p.pos?.[0] ?? 0), 1 + (p.pos?.[1] ?? 0)];
    const [x1, y1] = p.to ? at(p.to) : [x0 + (p.size?.[0] ?? 0), y0 + (p.size?.[1] ?? 0)];
    const [f0, g0, f1, g1] = p.box;
    const w = x1 - x0;
    const h = y1 - y0;
    return { x: x0 + f0 * w, y: y0 + g0 * h, w: Math.max(0, (f1 - f0) * w), h: Math.max(0, (g1 - g0) * h) };
  }

  /** 영역마다 그림 층을 만든다. 고정 경계에 걸친 그림은 양쪽 층에 하나씩 두고, 영역이 잘라 보인다. */
  buildPictures() {
    this.picLayers = new Map();
    const pictures = this.meta.pictures;
    if (!pictures.length) return;
    const { fw, fh } = this.geo;
    const areas = [
      [this.cellsMain, fw, fh, 'main'],
      [this.cellsLeft, 0, fh, 'left'],
      [this.cellsTop, fw, 0, 'top'],
      [this.cellsCorner, 0, 0, 'corner'],
    ];
    for (const [target, ox, oy, area] of areas) {
      if (!target) continue;
      const layer = div('sg-pics');
      const items = [];
      pictures.forEach((p, i) => {
        const url = this.media[p.media]?.type === 'chart' ? this.chartUrl(i, p) : this.mediaUrls[p.media];
        if (!url) return;
        const el = div('sg-pic');
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.draggable = false;
        el.appendChild(img);
        if (p.rot || p.flipH || p.flipV) el.style.transform = `rotate(${p.rot}deg) scale(${p.flipH ? -1 : 1},${p.flipV ? -1 : 1})`;
        layer.appendChild(el);
        items.push({ el, img, p: pictures[i] });
      });
      target.appendChild(layer);
      this.picLayers.set(target, { layer, items, ox, oy, area });
    }
    this.placePictures();
  }

  /** 행이 늘면 그림 자리도 다시 잡는다. 그 영역에 걸치지 않는 그림은 숨긴다. */
  placePictures() {
    const { rowTop, colLeft, fr, fc } = this.geo;
    const fx = colLeft[fc];
    const fy = rowTop[fr];
    for (const { items, ox, oy, area } of this.picLayers?.values() ?? []) {
      for (const { el, img, p } of items) {
        const r = this.pictureRect(p);
        const inX = area === 'main' || area === 'top' ? r.x + r.w > fx : r.x < fx;
        const inY = area === 'main' || area === 'left' ? r.y + r.h > fy : r.y < fy;
        el.hidden = !(inX && inY && r.w > 0 && r.h > 0);
        if (el.hidden) continue;
        el.style.left = `${r.x - ox}px`;
        el.style.top = `${r.y - oy}px`;
        el.style.width = `${r.w}px`;
        el.style.height = `${r.h}px`;
        if (p.crop) {
          // srcRect: 원본에서 잘라 낸 비율(왼·위·오른·아래). 남은 부분이 상자를 채우게 원본을 키워 옮긴다.
          const [l, t, rr, b] = p.crop;
          const iw = r.w / Math.max(0.01, 1 - l - rr);
          const ih = r.h / Math.max(0.01, 1 - t - b);
          Object.assign(img.style, { width: `${iw}px`, height: `${ih}px`, left: `${-l * iw}px`, top: `${-t * ih}px` });
        }
      }
    }
  }

  build() {
    const { nRows, nCols, rowTop, colLeft, rowHead, fr, fc, fw, fh } = this.geo;
    const totalW = colLeft[nCols];
    const totalH = rowTop[nRows];
    const canvas = div('sg-canvas');
    canvas.style.width = `${rowHead + totalW}px`;
    canvas.style.height = `${HEAD_HEIGHT + totalH}px`;
    const band = (className, height, top) => {
      const el = div(`sg-band ${className}`);
      el.style.height = `${height}px`;
      if (top !== undefined) el.style.top = `${top}px`;
      canvas.appendChild(el);
      return el;
    };
    const slice = (parent, className, width, left) => {
      const el = div(className);
      el.style.width = `${width}px`;
      if (left !== undefined) el.style.left = `${left}px`;
      parent.appendChild(el);
      return el;
    };
    const head = band('sg-head', HEAD_HEIGHT, 0);
    this.corner = slice(head, 'sg-corner', rowHead, 0);
    this.headLeft = fc ? slice(head, 'sg-colhead sg-fz', fw, rowHead) : null;
    this.headMain = slice(head, 'sg-colhead', totalW - fw);
    if (fr) {
      this.bandTop = band('sg-top', fh, HEAD_HEIGHT);
      this.rowheadTop = slice(this.bandTop, 'sg-rowhead', rowHead, 0);
      this.cellsCorner = fc ? slice(this.bandTop, 'sg-cells sg-fz', fw, rowHead) : null;
      this.cellsTop = slice(this.bandTop, 'sg-cells', totalW - fw);
    } else {
      this.bandTop = this.rowheadTop = this.cellsCorner = this.cellsTop = null;
    }
    this.bandMain = band('sg-main', totalH - fh);
    this.rowheadMain = slice(this.bandMain, 'sg-rowhead', rowHead, 0);
    this.cellsLeft = fc ? slice(this.bandMain, 'sg-cells sg-fz', fw, rowHead) : null;
    this.cellsMain = slice(this.bandMain, 'sg-cells', totalW - fw);
    this.canvas = canvas;
    this.scroller.replaceChildren(canvas);
    this.buildPictures();
  }

  /** 넘친 줄바꿈 칸에 맞춰 행을 늘리고, 화면 위쪽에서 늘어난 만큼 스크롤을 옮겨 보던 자리를 지킨다. */
  applyGrowth() {
    const g = this.geo;
    const { rowTop, nRows } = g;
    const topRow = upperBound(rowTop, g.fh + this.scroller.scrollTop, nRows + 1);
    const changes = [];
    for (const [r, need] of this.growth) {
      const height = rowTop[r + 1] - rowTop[r];
      if (need > height) changes.push([r, need - height]);
    }
    this.growth.clear();
    if (!changes.length) return false;
    changes.sort((a, b) => a[0] - b[0]);
    let above = 0;
    for (const [r, delta] of changes) {
      this.grown.set(r, rowTop[r + 1] - rowTop[r] + delta);
      if (r >= g.fr && r < topRow) above += delta;
    }
    let acc = 0;
    for (let i = changes[0][0] + 1, k = 0; i <= nRows; i++) {
      while (k < changes.length && changes[k][0] < i) acc += changes[k++][1];
      rowTop[i] += acc;
    }
    g.fh = rowTop[g.fr] - 1;
    if (this.bandTop) this.bandTop.style.height = `${g.fh}px`;
    this.bandMain.style.height = `${rowTop[nRows] - g.fh}px`;
    this.canvas.style.height = `${HEAD_HEIGHT + rowTop[nRows]}px`;
    if (above) this.scroller.scrollTop += above;
    this.placePictures();
    return true;
  }

  schedule(force = false) {
    if (force) this.force = true;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const f = this.force;
      this.force = false;
      if (this.meta) this.render(f);
      this.onScroll?.();
    });
  }

  /** 지금 보이는 본문 범위(행·열 번호) */
  visibleRange() {
    const { rowTop, colLeft, nRows, nCols, rowHead, fr, fc, fw, fh } = this.geo;
    const sc = this.scroller;
    const mainW = Math.max(1, sc.clientWidth - rowHead - fw);
    const mainH = Math.max(1, sc.clientHeight - HEAD_HEIGHT - fh);
    const x0 = fw + sc.scrollLeft;
    const y0 = fh + sc.scrollTop;
    return {
      r0: Math.max(fr, upperBound(rowTop, y0, nRows + 1)),
      r1: Math.min(nRows - 1, upperBound(rowTop, y0 + mainH, nRows + 1)),
      c0: Math.max(fc, upperBound(colLeft, x0, nCols + 1)),
      c1: Math.min(nCols - 1, upperBound(colLeft, x0 + mainW, nCols + 1)),
    };
  }

  /** 검색 결과로 옮겨 간다: 그 칸이 본문 가운데에 오게 스크롤하고 테두리로 표시한다. */
  reveal(row, col) {
    this.found = { r: row, c: col };
    const { rowTop, colLeft, rowHead, fr, fc, fw, fh } = this.geo;
    const sc = this.scroller;
    const mainW = Math.max(1, sc.clientWidth - rowHead - fw);
    const mainH = Math.max(1, sc.clientHeight - HEAD_HEIGHT - fh);
    if (row >= fr) sc.scrollTop = Math.max(0, (rowTop[row] + rowTop[row + 1]) / 2 - fh - mainH / 2);
    if (col >= fc) sc.scrollLeft = Math.max(0, (colLeft[col] + colLeft[col + 1]) / 2 - fw - mainW / 2);
    this.render(true);
  }

  clearFound() {
    if (!this.found) return;
    this.found = null;
    this.render(true);
  }

  /** 맨 위에 보이는 행 번호(0부터) */
  topRow() {
    return this.visibleRange().r0;
  }

  render(force = false, depth = 0) {
    const g = this.geo;
    const v = this.visibleRange();
    const w = this.rendered;
    if (!force && w && v.r0 >= w.r0 && v.r1 <= w.r1 && v.c0 >= w.c0 && v.c1 <= w.c1) return;
    const padR = Math.max(8, Math.ceil((v.r1 - v.r0 + 1) * OVERSCAN));
    const padC = Math.max(2, Math.ceil((v.c1 - v.c0 + 1) * OVERSCAN));
    const win = {
      r0: Math.max(g.fr, v.r0 - padR),
      r1: Math.min(g.nRows - 1, v.r1 + padR),
      c0: Math.max(g.fc, v.c0 - padC),
      c1: Math.min(g.nCols - 1, v.c1 + padC),
    };
    this.rendered = win;
    this.request(win);
    const { fr, fc, fw, fh } = g;
    this.paint(this.cellsMain, win.r0, win.r1, win.c0, win.c1, fw, fh);
    this.headMain.innerHTML = this.colHeads(win.c0, win.c1, fw);
    this.rowheadMain.innerHTML = this.rowHeads(win.r0, win.r1, fh);
    if (fc) {
      this.paint(this.cellsLeft, win.r0, win.r1, 0, fc - 1, 0, fh);
      this.headLeft.innerHTML = this.colHeads(0, fc - 1, 0);
    }
    if (fr) {
      this.paint(this.cellsTop, 0, fr - 1, win.c0, win.c1, fw, 0);
      this.rowheadTop.innerHTML = this.rowHeads(0, fr - 1, 0);
      if (fc) this.paint(this.cellsCorner, 0, fr - 1, 0, fc - 1, 0, 0);
    }
    // 넘친 줄바꿈 칸이 있으면 행을 늘려 다시 그린다(늘리기만 하므로 몇 번 안에 멈춘다).
    if (this.growth.size && this.applyGrowth() && depth < 3) {
      this.rendered = null;
      this.render(true, depth + 1);
    }
  }

  // ---- 데이터 ----------------------------------------------------------------
  request(win) {
    const m = this.meta;
    const B = m.blockRows;
    const last = Math.ceil(m.rowCount / B) - 1;
    if (last < 0) return;
    const wanted = new Set();
    for (let b = Math.floor(win.r0 / B); b <= Math.min(last, Math.floor(win.r1 / B)); b++) wanted.add(b);
    if (this.geo.fr) for (let b = 0; b <= Math.min(last, Math.floor((this.geo.fr - 1) / B)); b++) wanted.add(b);
    for (const merge of this.mergesIn(win.r0, win.r1, 0, this.geo.nCols - 1)) if (merge[0] < m.rowCount) wanted.add(Math.floor(merge[0] / B));
    // 스크롤 방향으로 한 묶음 더
    const next = Math.floor(win.r1 / B) + 1;
    if (next <= last) wanted.add(next);
    for (const b of wanted) {
      if (this.blocks.has(b) || this.inflight.has(b)) continue;
      if (this.inflight.size >= MAX_INFLIGHT) break;
      this.inflight.add(b);
      const sheet = this.sheet;
      this.fetchBlock(sheet, b)
        .then((reply) => {
          if (sheet !== this.sheet) return;
          this.inflight.delete(b);
          if (reply.error) return;
          this.addStyles(reply.styles);
          this.blocks.set(b, reply.block);
          this.evict();
          this.schedule(true);
        })
        .catch(() => this.inflight.delete(b));
    }
  }

  evict() {
    if (this.blocks.size <= KEEP_BLOCKS) return;
    const B = this.meta.blockRows;
    const center = this.rendered ? (this.rendered.r0 + this.rendered.r1) / 2 / B : 0;
    const keepTop = this.geo.fr ? Math.floor((this.geo.fr - 1) / B) : -1;
    const order = [...this.blocks.keys()].filter((b) => b > keepTop).sort((a, b) => Math.abs(b - center) - Math.abs(a - center));
    for (const b of order.slice(0, this.blocks.size - KEEP_BLOCKS)) this.blocks.delete(b);
  }

  /** r행의 셀 구간. 묶음이 아직 없으면 null */
  rowData(r) {
    const block = this.blocks.get(Math.floor(r / this.meta.blockRows));
    if (!block) return null;
    const k = r - block.start;
    if (k < 0 || k >= block.count) return null;
    return { block, from: block.offsets[k], to: block.offsets[k + 1] };
  }

  cellAt(r, c) {
    const row = this.rowData(r);
    if (!row) return null;
    const i = lowerBoundCols(row.block.cols, row.from, row.to, c);
    return i < row.to && row.block.cols[i] === c ? { block: row.block, i } : null;
  }

  mergesIn(r0, r1, c0, c1) {
    if (!this.merges.length) return [];
    const out = new Set();
    for (let b = Math.floor(r0 / 64); b <= Math.floor(r1 / 64); b++) {
      for (const merge of this.mergeBuckets.get(b) ?? []) {
        if (merge[0] <= r1 && merge[2] >= r0 && merge[1] <= c1 && merge[3] >= c0) out.add(merge);
      }
    }
    return [...out];
  }

  style(xf) {
    return this.styleMeta.get(xf) ?? { css: '', h: 0, wrap: false, fill: false, paint: false };
  }

  // ---- 그리기 ----------------------------------------------------------------
  colHeads(c0, c1, ox) {
    const { colLeft } = this.geo;
    let html = '';
    for (let c = c0; c <= c1; c++) {
      const w = colLeft[c + 1] - colLeft[c];
      if (w > 0) html += `<div class="sg-hc" style="left:${colLeft[c] - ox}px;width:${w}px">${columnName(c)}</div>`;
    }
    return html;
  }

  rowHeads(r0, r1, oy) {
    const { rowTop } = this.geo;
    let html = '';
    for (let r = r0; r <= r1; r++) {
      const h = rowTop[r + 1] - rowTop[r];
      if (h > 0) html += `<div class="sg-hr" style="top:${rowTop[r] - oy}px;height:${h}px">${r + 1}</div>`;
    }
    return html;
  }

  /** 한 영역(r0~r1행, c0~c1열)을 그린다. ox·oy는 그 영역 원점의 시트 좌표. */
  paint(target, r0, r1, c0, c1, ox, oy) {
    const { rowTop, colLeft } = this.geo;
    const merges = this.mergesIn(r0, r1, c0, c1);
    const covered = new Set();
    for (const [mr1, mc1, mr2, mc2] of merges) {
      for (let r = Math.max(mr1, r0); r <= Math.min(mr2, r1); r++) {
        for (let c = Math.max(mc1, c0); c <= Math.min(mc2, c1); c++) covered.add(r * MAX_COLS + c);
      }
    }
    let html = '';
    if (this.meta.showGrid) html += this.gridLines(r0, r1, c0, c1, ox, oy);
    const colStyles = this.colStyles.size ? this.colStylesIn(c0, c1) : null;
    for (let r = r0; r <= r1; r++) {
      const h = rowTop[r + 1] - rowTop[r];
      if (h <= 0) continue;
      const row = this.rowData(r);
      const rowStyle = this.rowStyles.get(r);
      const present = rowStyle !== undefined || colStyles ? new Set() : null;
      if (row) {
        const { block, from, to } = row;
        let i = lowerBoundCols(block.cols, from, to, c0);
        if (i > from) i--; // 왼쪽 밖 셀의 글자가 넘쳐 들어올 수 있다
        for (; i < to; i++) {
          const c = block.cols[i];
          if (c > c1) {
            // 오른쪽 밖 셀의 글자가 왼쪽으로 넘쳐 들어올 수 있다(오른쪽·가운데 정렬)
            if (block.kinds[i] === BLANK) continue;
            html += this.cell(r, c, block, i, from, to, ox, oy, merges, covered, c0, c1);
            break;
          }
          present?.add(c);
          html += this.cell(r, c, block, i, from, to, ox, oy, merges, covered, c0, c1);
        }
      }
      // 행·열 기본 서식만 있는 빈 칸(채우기·테두리)
      if (present) {
        for (let c = c0; c <= c1; c++) {
          if (present.has(c) || covered.has(r * MAX_COLS + c)) continue;
          const xf = rowStyle ?? colStyles[c - c0];
          if (xf === undefined || !this.style(xf).paint) continue;
          const w = colLeft[c + 1] - colLeft[c];
          if (w > 0) html += `<div class="c x${xf}" style="left:${colLeft[c] - ox - 1}px;top:${rowTop[r] - oy - 1}px;width:${w + 1}px;height:${h + 1}px"></div>`;
        }
      }
    }
    for (const merge of merges) html += this.mergedCell(merge, ox, oy);
    target.innerHTML = html;
    const pics = this.picLayers?.get(target);
    if (pics) target.appendChild(pics.layer);
    this.fitText(target);
    this.measureWrap(target);
  }

  colStylesIn(c0, c1) {
    const out = new Array(c1 - c0 + 1);
    for (let c = c0; c <= c1; c++) out[c - c0] = this.colStyles.get(c);
    return out;
  }

  gridLines(r0, r1, c0, c1, ox, oy) {
    const { rowTop, colLeft } = this.geo;
    const top = rowTop[r0] - oy;
    const height = rowTop[r1 + 1] - rowTop[r0];
    const left = colLeft[c0] - ox;
    const width = colLeft[c1 + 1] - colLeft[c0];
    // 각 칸의 오른쪽·아래 선과, 영역 첫 칸의 왼쪽·위 선(앞 칸의 선 자리)
    let html = `<i class="gv" style="left:${colLeft[c0] - 1 - ox}px;top:${top - 1}px;height:${height + 1}px"></i>`;
    html += `<i class="gh" style="top:${rowTop[r0] - 1 - oy}px;left:${left - 1}px;width:${width + 1}px"></i>`;
    for (let c = c0; c <= c1; c++) {
      if (colLeft[c + 1] > colLeft[c]) html += `<i class="gv" style="left:${colLeft[c + 1] - 1 - ox}px;top:${top - 1}px;height:${height + 1}px"></i>`;
    }
    for (let r = r0; r <= r1; r++) {
      if (rowTop[r + 1] > rowTop[r]) html += `<i class="gh" style="top:${rowTop[r + 1] - 1 - oy}px;left:${left - 1}px;width:${width + 1}px"></i>`;
    }
    return html;
  }

  cell(r, c, block, i, from, to, ox, oy, merges, covered, c0, c1) {
    if (covered.has(r * MAX_COLS + c)) return '';
    const { rowTop, colLeft } = this.geo;
    const w = colLeft[c + 1] - colLeft[c];
    const h = rowTop[r + 1] - rowTop[r];
    if (w <= 0 || h <= 0) return '';
    const xf = block.xfs[i];
    const kind = block.kinds[i];
    const text = block.texts[i];
    const st = this.style(xf);
    if (kind === BLANK && !st.paint) return '';
    let cls = `c x${xf}`;
    if (this.found?.r === r && this.found.c === c) cls += ' sg-found';
    let span = '';
    let attrs = '';
    if (text) {
      const numeric = kind === NUM || kind === PRENUM;
      const align = st.h !== H_GENERAL ? st.h : numeric ? H_RIGHT : kind === BOOL || kind === ERR ? H_CENTER : H_LEFT;
      if (st.h === H_GENERAL && align !== H_LEFT) cls += align === H_RIGHT ? ' ar' : ' ac';
      if (numeric || st.shrink) cls += ' fit';
      let left = 0;
      let right = 0;
      if (kind === STR && !st.wrap) {
        if (align === H_LEFT || align === H_CENTER || align === H_CONTINUOUS) right = this.spillRight(r, c, block, i, to, merges, align === H_CONTINUOUS);
        if (align === H_RIGHT || align === H_CENTER) left = this.spillLeft(r, c, block, i, from, merges);
        if (align === H_CENTER) left = right = Math.min(left, right);
      }
      if (left || right) cls += ' sp';
      const color = block.colors?.[i];
      const css = (left || right ? `margin-left:${-left}px;margin-right:${-right}px;` : '') + (color ? `color:${color}` : '');
      span = `<span${css ? ` style="${css}"` : ''}>${escapeHtml(shownText(text, st))}</span>`;
      // 줄바꿈 칸은 그린 뒤 넘치는지 재서, 높이를 정하지 않은 행이면 늘린다.
      if (st.wrap && !this.customRows.has(r)) attrs = ` data-w="1" data-r="${r}"`;
    } else if (c < c0 || c > c1) return '';
    return `<div class="${cls}"${attrs} style="left:${colLeft[c] - ox - 1}px;top:${rowTop[r] - oy - 1}px;width:${w + 1}px;height:${h + 1}px">${span}</div>`;
  }

  /** 줄바꿈 칸의 글이 행보다 길면 그 행에 필요한 높이를 모은다(applyGrowth가 반영). */
  measureWrap(target) {
    const { rowTop } = this.geo;
    for (const cell of target.querySelectorAll('[data-w]')) {
      const span = cell.firstElementChild;
      if (!span) continue;
      const r = Number(cell.dataset.r);
      const need = Math.min(MAX_ROW_HEIGHT, Math.ceil(span.scrollHeight) + 1);
      if (need > rowTop[r + 1] - rowTop[r] && need > (this.growth.get(r) ?? 0)) this.growth.set(r, need);
    }
  }

  /** 오른쪽 빈 칸으로 넘칠 수 있는 너비. 다음 값 있는 칸이나 병합 영역에서 멈춘다. */
  spillRight(r, c, block, i, to, merges, continuous) {
    const { colLeft, nCols } = this.geo;
    let end = Math.min(nCols, c + 1 + MAX_SPILL_COLS);
    if (continuous) {
      // 선택 영역의 가운데: 같은 정렬을 가진 바로 옆 빈 칸들까지
      let next = c + 1;
      for (let j = i + 1; j < to && block.cols[j] === next && block.kinds[j] === BLANK && this.style(block.xfs[j]).h === H_CONTINUOUS; j++) next++;
      end = Math.min(end, next);
    } else {
      for (let j = i + 1; j < to; j++) {
        if (block.kinds[j] !== BLANK) {
          end = Math.min(end, block.cols[j]);
          break;
        }
      }
    }
    for (const [mr1, mc1, mr2] of merges) if (mr1 <= r && mr2 >= r && mc1 > c && mc1 < end) end = mc1;
    return end > c + 1 ? colLeft[end] - colLeft[c + 1] : 0;
  }

  spillLeft(r, c, block, i, from, merges) {
    const { colLeft } = this.geo;
    let start = Math.max(0, c - MAX_SPILL_COLS);
    for (let j = i - 1; j >= from; j--) {
      if (block.kinds[j] !== BLANK) {
        start = Math.max(start, block.cols[j] + 1);
        break;
      }
    }
    for (const [mr1, , mr2, mc2] of merges) if (mr1 <= r && mr2 >= r && mc2 < c && mc2 >= start) start = mc2 + 1;
    return start < c ? colLeft[c] - colLeft[start] : 0;
  }

  mergedCell([r1, c1, r2, c2], ox, oy) {
    const { rowTop, colLeft } = this.geo;
    const w = colLeft[c2 + 1] - colLeft[c1];
    const h = rowTop[r2 + 1] - rowTop[r1];
    if (w <= 0 || h <= 0) return '';
    const at = this.cellAt(r1, c1);
    const xf = at ? at.block.xfs[at.i] : this.rowStyles.get(r1) ?? this.colStyles.get(c1) ?? 0;
    const st = this.style(xf);
    let cls = `c m x${xf}`;
    if (this.found?.r === r1 && this.found.c === c1) cls += ' sg-found';
    if (!st.fill) cls += ' mw';
    let span = '';
    const text = at?.block.texts[at.i];
    if (text) {
      const kind = at.block.kinds[at.i];
      const numeric = kind === NUM || kind === PRENUM;
      if (st.h === H_GENERAL && (numeric || kind === BOOL || kind === ERR)) cls += numeric ? ' ar' : ' ac';
      if (numeric || st.shrink) cls += ' fit';
      const color = at.block.colors?.[at.i];
      span = `<span${color ? ` style="color:${color}"` : ''}>${escapeHtml(shownText(text, st))}</span>`;
    }
    return `<div class="${cls}" style="left:${colLeft[c1] - ox - 1}px;top:${rowTop[r1] - oy - 1}px;width:${w + 1}px;height:${h + 1}px">${span}</div>`;
  }

  /**
   * 칸보다 긴 숫자는 앞자리가 잘려 다른 값으로 읽히지 않게 글자를 줄인다('셀에 맞춤' 서식도 같다).
   * 대체 글꼴이 원본 글꼴보다 넓어 엑셀에서는 들어가던 숫자가 넘치는 경우가 많다.
   */
  fitText(target) {
    const cells = target.getElementsByClassName('fit');
    const fixes = [];
    for (const cell of cells) {
      const span = cell.firstElementChild;
      if (span && span.scrollWidth > span.clientWidth + 1) fixes.push([span, span.clientWidth / span.scrollWidth]);
    }
    for (const [span, ratio] of fixes) span.style.fontSize = `${Math.max(0.5, Math.floor(ratio * 100) / 100)}em`;
  }
}
