// 시트의 셀을 셀마다 객체로 만들지 않고 열 단위 TypedArray에 담는다(셀당 17바이트).
// SheetJS 셀 객체는 셀당 수백 바이트라 28MB xls(194만 셀)를 통째로 읽으면 1GB 가까이 쓴다.
// 표시 문자열은 화면이 그 행 묶음을 요청할 때 만든다(SheetJS의 cell.w와 같은 SSF 서식 함수를 쓴다).
import { SSF } from 'xlsx';

export const BLANK = 0; // 서식만 있는 빈 셀
export const NUM = 1; // 숫자·날짜: 값을 서식 문자열로 표시
export const STR = 2; // 문자열: strings[val]
export const BOOL = 3;
export const ERR = 4; // 오류: strings[val]
export const PRENUM = 5; // 이미 서식이 적용된 숫자 문자열(SheetJS 대체 경로): strings[val]

export const BLOCK_ROWS = 64;
// 셀이 이보다 많으면 뒤쪽 행은 읽지 않는다(휴대폰 메모리 보호, 약 140MB).
export const MAX_CELLS = 8_000_000;
const MAX_ROWS = 1_048_576;
const MAX_COLS = 16_384;

/**
 * 통합 문서 공통 정보: 문자열 표, 서식 번호 → 표시 형식, 1904 날짜 체계.
 * numFmt(xf)는 null(일반) 또는 SSF가 받는 형식 문자열·번호를 돌려준다.
 */
export class BookContext {
  constructor({ strings = [], numFmt = () => null, date1904 = false } = {}) {
    this.strings = strings;
    this.numFmt = numFmt;
    this.date1904 = date1904;
  }

  addString(text) {
    this.strings.push(text);
    return this.strings.length - 1;
  }

  /** 빈 문자열(수식 결과가 "")은 한 칸을 함께 쓴다. */
  emptyString() {
    this.empty ??= this.addString('');
    return this.empty;
  }

  formatNumber(value, xf) {
    const fmt = this.numFmt(xf);
    try {
      if (fmt == null || fmt === 0 || fmt === 'General') return (value | 0) === value ? String(value) : SSF.format('General', value);
      return SSF.format(fmt, value, { date1904: this.date1904 });
    } catch {
      return String(value);
    }
  }

  formatText(text, xf) {
    const fmt = this.numFmt(xf);
    if (fmt == null || fmt === 0 || fmt === 49 || fmt === '@' || fmt === 'General') return text;
    try {
      return SSF.format(fmt, text);
    } catch {
      return text;
    }
  }
}

/** 읽기 중에 셀을 받아 쌓는다. 셀은 대개 행 순서로 오지만 아니어도 finish()에서 정렬한다. */
export class SheetBuilder {
  constructor({ paints = () => false } = {}) {
    this.paints = paints; // 빈 셀이라도 채우기·테두리가 있어 그려야 하는 서식인지
    this.n = 0;
    this.allocate(4096);
    this.sorted = true;
    this.lastKey = -1;
    this.maxRow = -1;
    this.maxCol = -1;
    this.truncatedRow = -1; // MAX_CELLS에 걸려 읽기를 멈춘 행
    this.totalRows = 0;
    this.colWidths = new Map(); // 열 → px (0이면 숨김)
    this.rowHeights = new Map(); // 행 → px (0이면 숨김)
    this.rowStyles = new Map(); // 행 → 빈 칸 기본 서식(xf)
    this.colStyles = new Map(); // 열 → 빈 칸 기본 서식(xf)
    this.merges = [];
    this.freezeRows = 0;
    this.freezeCols = 0;
    this.showGrid = true;
    this.showZeros = true;
    this.defaultRowHeight = 20;
    this.defaultColWidth = 64;
  }

  allocate(cap) {
    const grow = (Type, old) => {
      const next = new Type(cap);
      if (old) next.set(old.subarray(0, this.n));
      return next;
    };
    this.rowA = grow(Int32Array, this.rowA);
    this.colA = grow(Uint16Array, this.colA);
    this.xfA = grow(Uint16Array, this.xfA);
    this.kindA = grow(Uint8Array, this.kindA);
    this.valA = grow(Float64Array, this.valA);
    this.cap = cap;
  }

  add(row, col, kind, val, xf) {
    if (row < 0 || col < 0 || row >= MAX_ROWS || col >= MAX_COLS) return;
    if (this.truncatedRow >= 0 && row >= this.truncatedRow) return;
    if (this.n >= MAX_CELLS) {
      // 행 중간에서 자르지 않도록 다음 행부터 버린다.
      if (row > this.rowA[this.n - 1]) {
        this.truncatedRow = row;
        return;
      }
      if (this.n >= MAX_CELLS + MAX_COLS) return;
    }
    if (kind === BLANK && !this.paints(xf)) return;
    if (this.n === this.cap) this.allocate(this.cap * 2);
    const i = this.n++;
    this.rowA[i] = row;
    this.colA[i] = col;
    this.kindA[i] = kind;
    this.valA[i] = val;
    this.xfA[i] = xf > 0xffff ? 0 : xf;
    const key = row * MAX_COLS + col;
    if (key <= this.lastKey) this.sorted = false;
    this.lastKey = key;
    if (row > this.maxRow) this.maxRow = row;
    if (col > this.maxCol) this.maxCol = col;
  }

  /** 같은 칸에 값을 덮어쓴다(수식 결과 문자열이 뒤따르는 xls STRING 레코드 등). 마지막 셀만 본다. */
  replaceLast(row, col, kind, val) {
    const i = this.n - 1;
    if (i >= 0 && this.rowA[i] === row && this.colA[i] === col) {
      this.kindA[i] = kind;
      this.valA[i] = val;
      return true;
    }
    return false;
  }

  finish(name, context) {
    const n = this.n;
    let { rowA, colA, xfA, kindA, valA } = this;
    this.rowA = this.colA = this.xfA = this.kindA = this.valA = null;
    if (!this.sorted) {
      // (행, 열) 순으로 다시 놓는다. 같은 칸은 나중에 온 것이 뒤에 오게 한다.
      const keys = new Float64Array(n);
      for (let i = 0; i < n; i++) keys[i] = rowA[i] * MAX_COLS + colA[i] + i / (n + 1);
      const order = new Uint32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      order.sort((a, b) => keys[a] - keys[b]);
      const permute = (Type, src) => {
        const out = new Type(n);
        for (let k = 0; k < n; k++) out[k] = src[order[k]];
        return out;
      };
      rowA = permute(Int32Array, rowA);
      colA = permute(Uint16Array, colA);
      xfA = permute(Uint16Array, xfA);
      kindA = permute(Uint8Array, kindA);
      valA = permute(Float64Array, valA);
    }
    // 같은 칸 중복 제거(나중 값 우선), 제자리에서
    let m = 0;
    for (let k = 0; k < n; k++) {
      if (m > 0 && rowA[m - 1] === rowA[k] && colA[m - 1] === colA[k]) m--;
      if (m !== k) {
        rowA[m] = rowA[k];
        colA[m] = colA[k];
        xfA[m] = xfA[k];
        kindA[m] = kindA[k];
        valA[m] = valA[k];
      }
      m++;
    }

    let maxRow = this.maxRow;
    let maxCol = this.maxCol;
    for (const merge of this.merges) {
      maxRow = Math.max(maxRow, merge[2]);
      maxCol = Math.max(maxCol, merge[3]);
    }
    const rowCount = Math.min(MAX_ROWS, maxRow + 1);
    const colCount = Math.min(MAX_COLS, maxCol + 1);
    const rowStart = new Int32Array(rowCount + 1);
    for (let i = 0; i < m; i++) rowStart[rowA[i] + 1]++;
    for (let r = 0; r < rowCount; r++) rowStart[r + 1] += rowStart[r];
    return new SheetModel({
      name,
      context,
      cells: { colA: fit(colA, m), xfA: fit(xfA, m), kindA: fit(kindA, m), valA: fit(valA, m) },
      rowStart,
      rowCount,
      colCount,
      cellCount: m,
      truncatedRow: this.truncatedRow,
      totalRows: Math.max(this.totalRows, rowCount),
      geometry: {
        colWidths: this.colWidths,
        rowHeights: this.rowHeights,
        rowStyles: this.rowStyles,
        colStyles: this.colStyles,
        merges: this.merges,
        freezeRows: this.freezeRows,
        freezeCols: this.freezeCols,
        showGrid: this.showGrid,
        defaultRowHeight: this.defaultRowHeight,
        defaultColWidth: this.defaultColWidth,
      },
      showZeros: this.showZeros,
    });
  }
}

// 남는 용량이 크면 딱 맞는 크기로 복사해 원래 배열을 놓아준다.
const fit = (array, length) => (array.length - length > 1024 ? array.slice(0, length) : array.subarray(0, length));

export class SheetModel {
  constructor({ name, context, cells, rowStart, rowCount, colCount, cellCount, truncatedRow, totalRows, geometry, showZeros, kind = 'sheet' }) {
    Object.assign(this, { name, context, cells, rowStart, rowCount, colCount, cellCount, truncatedRow, totalRows, geometry, showZeros, kind });
  }

  static placeholder(name, kind) {
    return new SheetModel({
      name,
      context: new BookContext(),
      cells: { colA: new Uint16Array(0), xfA: new Uint16Array(0), kindA: new Uint8Array(0), valA: new Float64Array(0) },
      rowStart: new Int32Array(1),
      rowCount: 0,
      colCount: 0,
      cellCount: 0,
      truncatedRow: -1,
      totalRows: 0,
      geometry: { colWidths: new Map(), rowHeights: new Map(), rowStyles: new Map(), colStyles: new Map(), merges: [], freezeRows: 0, freezeCols: 0, showGrid: true, defaultRowHeight: 20, defaultColWidth: 64 },
      showZeros: true,
      kind,
    });
  }

  /** 화면이 배치에 쓰는 정보(행 높이·열 너비·병합·틀 고정). 셀 내용은 들어 있지 않다. */
  meta() {
    const g = this.geometry;
    const colCount = this.colCount;
    const sparse = (map, limit) => {
      const keys = [...map.keys()].filter((k) => k < limit).sort((a, b) => a - b);
      return { index: Int32Array.from(keys), value: Float32Array.from(keys.map((k) => map.get(k))) };
    };
    const merges = new Int32Array(g.merges.length * 4);
    g.merges.forEach((m, i) => merges.set(m, i * 4));
    return {
      name: this.name,
      kind: this.kind,
      rowCount: this.rowCount,
      colCount,
      totalRows: this.totalRows,
      truncatedRow: this.truncatedRow,
      defaultRowHeight: g.defaultRowHeight,
      defaultColWidth: g.defaultColWidth,
      colWidths: sparse(g.colWidths, MAX_COLS),
      rowHeights: sparse(g.rowHeights, MAX_ROWS),
      rowStyles: sparse(g.rowStyles, MAX_ROWS),
      colStyles: sparse(g.colStyles, MAX_COLS),
      merges,
      freezeRows: g.freezeRows,
      freezeCols: g.freezeCols,
      showGrid: g.showGrid,
      blockRows: BLOCK_ROWS,
    };
  }

  /** 행 묶음 하나의 셀(열·서식·종류·표시 문자열). 행마다 offsets로 구간을 나눈다. */
  block(index) {
    const start = index * BLOCK_ROWS;
    const end = Math.min(this.rowCount, start + BLOCK_ROWS);
    const count = Math.max(0, end - start);
    const offsets = new Int32Array(count + 1);
    if (count === 0) return { start, count, offsets, cols: new Uint16Array(0), xfs: new Uint16Array(0), kinds: new Uint8Array(0), texts: [] };
    const i0 = this.rowStart[start];
    const i1 = this.rowStart[end];
    for (let r = 0; r <= count; r++) offsets[r] = this.rowStart[start + r] - i0;
    const { colA, xfA, kindA, valA } = this.cells;
    const texts = new Array(i1 - i0);
    const ctx = this.context;
    for (let i = i0; i < i1; i++) {
      const kind = kindA[i];
      const val = valA[i];
      let text = '';
      if (kind === NUM) text = val === 0 && !this.showZeros ? '' : ctx.formatNumber(val, xfA[i]);
      else if (kind === STR) text = ctx.formatText(ctx.strings[val] ?? '', xfA[i]);
      else if (kind === BOOL) text = val ? 'TRUE' : 'FALSE';
      else if (kind === ERR || kind === PRENUM) text = ctx.strings[val] ?? '';
      texts[i - i0] = text;
    }
    return { start, count, offsets, cols: colA.slice(i0, i1), xfs: xfA.slice(i0, i1), kinds: kindA.slice(i0, i1), texts };
  }

  /** 행 묶음에서 쓰인 서식 번호(중복 없음) */
  usedXfs(block) {
    const set = new Set();
    for (const xf of block.xfs) set.add(xf);
    return set;
  }
}
