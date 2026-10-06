// xls(BIFF8 = Excel 97~2003, BIFF5 = Excel 95) 읽기. 레코드를 직접 훑어 셀 값과 서식을 압축 저장소에 담는다.
// SheetJS는 셀마다 객체를 만들어 큰 파일에서 메모리를 많이 쓰고, 글꼴·테두리·정렬 같은 서식은 버린다.
// SheetJS CE는 코드페이지 표가 없어 BIFF5의 한국어(949)·일본어(932) 글자가 깨지므로 BIFF5도 여기서 읽는다.
// 시트는 BOUNDSHEET의 위치로 바로 찾아가 필요한 시트만 읽는다.
// BIFF4 이하, 암호화, CFB가 아닌 파일(HTML·XML로 된 .xls)은 null을 돌려 SheetJS 경로로 넘긴다.
import { isCfb, readCfbStream } from './cfb.js';
import { BLANK, BOOL, BookContext, ERR, NUM, STR, SheetBuilder, SheetModel } from './sheet-store.js';
import {
  BIFF_BORDERS, BIFF_HALIGN, BIFF_PATTERNS, BIFF_VALIGN, DEFAULT_PALETTE, StyleTable,
  defaultColWidthPx, maxDigitWidth, paletteColor, patternFill, widthToPx,
} from './styles.js';

const RT = {
  BOF: 0x0809, EOF: 0x000a, CONTINUE: 0x003c, FILEPASS: 0x002f, CODEPAGE: 0x0042, DATEMODE: 0x0022, FONT: 0x0031, FORMAT: 0x041e,
  XF: 0x00e0, XFEXT: 0x087d, PALETTE: 0x0092, BOUNDSHEET: 0x0085, SST: 0x00fc, WINDOW1: 0x003d,
  DIMENSIONS: 0x0200, DEFAULTROWHEIGHT: 0x0225, DEFCOLWIDTH: 0x0055, COLINFO: 0x007d, ROW: 0x0208,
  NUMBER: 0x0203, RK: 0x027e, MULRK: 0x00bd, LABELSST: 0x00fd, LABEL: 0x0204, RSTRING: 0x00d6, BOOLERR: 0x0205,
  FORMULA: 0x0006, STRING: 0x0207, BLANK: 0x0201, MULBLANK: 0x00be, MERGEDCELLS: 0x00e5, WINDOW2: 0x023e, PANE: 0x0041,
};
const ERRORS = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A', 0x2b: '#GETTING_DATA' };

const utf16 = new TextDecoder('utf-16le');
const rkView = new DataView(new ArrayBuffer(8));

// BIFF5 문자열의 코드페이지 → TextDecoder 이름. 모르는 것은 서유럽(1252)으로 읽는다.
const CODEPAGES = {
  874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1250: 'windows-1250', 1251: 'windows-1251',
  1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257',
  1258: 'windows-1258', 10000: 'macintosh', 0x8000: 'macintosh', 0x8001: 'windows-1252',
};
function ansiDecoder(codepage) {
  try {
    return new TextDecoder(CODEPAGES[codepage] ?? 'windows-1252');
  } catch {
    return new TextDecoder('windows-1252');
  }
}

function latin1(bytes, start, length) {
  let out = '';
  for (let i = 0; i < length; i += 4096) out += String.fromCharCode.apply(null, bytes.subarray(start + i, start + Math.min(length, i + 4096)));
  return out;
}

function rk(value) {
  let n;
  if (value & 2) n = value >> 2;
  else {
    rkView.setInt32(0, 0, true);
    rkView.setInt32(4, value & ~3, true);
    n = rkView.getFloat64(0, true);
  }
  return value & 1 ? n / 100 : n;
}

/** CONTINUE로 이어지는 레코드를 하나의 흐름으로 읽는다. 글자 배열이 끊기면 다음 조각 첫 바이트가 새 플래그다. */
class Segments {
  constructor(bytes, ranges) {
    this.bytes = bytes;
    this.ranges = ranges;
    this.i = 0;
    [this.pos, this.end] = ranges[0];
  }

  next() {
    if (this.i + 1 >= this.ranges.length) return false;
    this.i++;
    [this.pos, this.end] = this.ranges[this.i];
    return true;
  }

  u8() {
    while (this.pos >= this.end) if (!this.next()) throw new Error('XLS record overrun');
    return this.bytes[this.pos++];
  }

  u16() {
    return this.u8() | (this.u8() << 8);
  }

  u32() {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }

  skip(n) {
    while (n > 0) {
      while (this.pos >= this.end) if (!this.next()) return;
      const k = Math.min(n, this.end - this.pos);
      this.pos += k;
      n -= k;
    }
  }

  chars(count, high) {
    let out = '';
    while (count > 0) {
      if (this.pos >= this.end) {
        if (!this.next()) break;
        high = this.bytes[this.pos++] & 1;
        continue;
      }
      const avail = high ? (this.end - this.pos) >> 1 : this.end - this.pos;
      const k = Math.min(count, avail);
      if (k <= 0) {
        this.pos = this.end;
        continue;
      }
      out += high ? utf16.decode(this.bytes.subarray(this.pos, this.pos + k * 2)) : latin1(this.bytes, this.pos, k);
      this.pos += high ? k * 2 : k;
      count -= k;
    }
    return out;
  }

  /** XLUnicodeRichExtendedString(SST 항목·LABEL·STRING 공통). cchBytes는 글자 수 필드 크기(1 또는 2). */
  string(cchBytes = 2) {
    const cch = cchBytes === 1 ? this.u8() : this.u16();
    const flags = this.u8();
    const runs = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.u32() : 0;
    const text = this.chars(cch, flags & 1);
    if (runs) this.skip(runs * 4);
    if (ext) this.skip(ext);
    return text;
  }
}

export function readXls(bytes) {
  if (!isCfb(bytes)) return null;
  const stream = readCfbStream(bytes, ['Workbook', 'Book']);
  if (!stream) return null;
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const len = stream.length;
  if (len < 8 || dv.getUint16(0, true) !== RT.BOF || dv.getUint16(6, true) !== 0x0005) return null; // 전역 부분 BOF가 아니면 넘긴다
  const version = dv.getUint16(4, true);
  const biff = version === 0x0600 ? 8 : version === 0x0500 ? 5 : 0;
  if (!biff) return null;

  const fonts = [];
  const formats = new Map();
  const xfs = [];
  const sheets = [];
  const palette = DEFAULT_PALETTE.slice();
  let strings = [];
  let date1904 = false;
  let active = 0;
  let ansi = ansiDecoder(1252);
  // 글자 수(1·2바이트) 뒤에 오는 문자열. BIFF8은 유니코드 문자열, BIFF5는 코드페이지 8비트 문자열이다.
  const text = (start, end, cchBytes) => {
    if (biff === 8) return new Segments(stream, [[start, end]]).string(cchBytes);
    const cch = cchBytes === 1 ? stream[start] : dv.getUint16(start, true);
    const from = start + cchBytes;
    return ansi.decode(stream.subarray(from, Math.min(end, from + cch)));
  };

  // 전역 부분: 첫 EOF까지
  let pos = 0;
  while (pos + 4 <= len) {
    const type = dv.getUint16(pos, true);
    const size = dv.getUint16(pos + 2, true);
    const body = pos + 4;
    pos = body + size;
    if (pos > len) break;
    switch (type) {
      case RT.FILEPASS:
        return null; // 암호화: SheetJS가 처리(또는 암호 오류)하게 넘긴다
      case RT.CODEPAGE:
        if (biff === 5) ansi = ansiDecoder(dv.getUint16(body, true));
        break;
      case RT.DATEMODE:
        date1904 = dv.getUint16(body, true) === 1;
        break;
      case RT.FONT: {
        const grbit = dv.getUint16(body + 2, true);
        const uls = stream[body + 10];
        fonts.push({
          size: dv.getUint16(body, true) / 20,
          italic: Boolean(grbit & 0x02),
          strike: Boolean(grbit & 0x08),
          colorIndex: dv.getUint16(body + 4, true),
          bold: dv.getUint16(body + 6, true) >= 600,
          script: dv.getUint16(body + 8, true),
          underline: uls === 2 || uls === 0x22 ? 'double' : uls ? 'single' : null,
          name: text(body + 14, body + size, 1),
        });
        break;
      }
      case RT.FORMAT:
        formats.set(dv.getUint16(body, true), text(body + 2, body + size, biff === 8 ? 2 : 1));
        break;
      case RT.XF:
        if (biff === 8 && size >= 20) xfs.push(parseXf(dv, body));
        else if (biff === 5 && size >= 16) xfs.push(parseXf5(dv, body));
        break;
      case RT.XFEXT:
        parseXfExt(dv, body, size, xfs);
        break;
      case RT.PALETTE: {
        const count = dv.getUint16(body, true);
        for (let i = 0; i < count && 8 + i < 64; i++) {
          const at = body + 2 + i * 4;
          palette[8 + i] = ((stream[at] << 16) | (stream[at + 1] << 8) | stream[at + 2]).toString(16).padStart(6, '0');
        }
        break;
      }
      case RT.BOUNDSHEET:
        sheets.push({ offset: dv.getUint32(body, true), hidden: (stream[body + 4] & 3) !== 0, dt: stream[body + 5], name: text(body + 6, body + size, 1) });
        break;
      case RT.WINDOW1:
        if (size >= 12) active = dv.getUint16(body + 10, true);
        break;
      case RT.SST: {
        if (biff !== 8) break;
        const ranges = [[body + 8, body + size]];
        while (pos + 4 <= len && dv.getUint16(pos, true) === RT.CONTINUE) {
          const s = dv.getUint16(pos + 2, true);
          ranges.push([pos + 4, pos + 4 + s]);
          pos += 4 + s;
        }
        const count = Math.min(dv.getUint32(body + 4, true), len);
        strings = new Array(count);
        const seg = new Segments(stream, ranges);
        let i = 0;
        try {
          for (; i < count; i++) strings[i] = seg.string(2);
        } catch {
          strings.length = i; // 잘린 SST: 읽은 데까지만 쓴다
        }
        break;
      }
      default:
        break;
    }
    if (type === RT.EOF) break;
  }

  // 서식 → 화면 모양
  const font = (ifnt) => fonts[ifnt < 4 ? ifnt : ifnt - 1] ?? fonts[0];
  const color = (icv) => paletteColor(icv, palette);
  const baseFont = fonts[0] ? { name: fonts[0].name, size: fonts[0].size, color: null } : { name: 'Arial', size: 10, color: null };
  const resolved = new Map();
  const resolve = (index) => {
    let out = resolved.get(index);
    if (out !== undefined) return out;
    const x = xfs[index];
    if (!x) {
      resolved.set(index, null);
      return null;
    }
    const f = font(x.ifnt);
    const border = {};
    for (const side of ['l', 'r', 't', 'b']) {
      const style = BIFF_BORDERS[x.border[side]];
      if (style) border[side] = { style, color: x.ext?.[side] ?? color(x.borderColor[side]) ?? '#000000' };
    }
    const fg = x.ext?.fg ?? color(x.icvFore);
    const bg = x.ext?.bg ?? color(x.icvBack);
    out = {
      font: f
        ? { name: f.name, size: f.size, bold: f.bold, italic: f.italic, underline: f.underline, strike: f.strike, color: x.ext?.font ?? color(f.colorIndex) }
        : null,
      fill: patternFill(BIFF_PATTERNS[x.fls] ?? 'none', fg, bg),
      border,
      align: { h: BIFF_HALIGN[x.alc] ?? 'general', v: BIFF_VALIGN[x.alcV] ?? 'bottom', wrap: x.wrap, indent: x.indent, rotate: x.rotate, shrink: x.shrink },
    };
    resolved.set(index, out);
    return out;
  };
  const styles = new StyleTable(resolve, baseFont);
  const numFmt = (xf) => {
    const id = xfs[xf]?.ifmt ?? 0;
    if (id === 0) return null;
    return formats.get(id) ?? id;
  };
  const context = new BookContext({ strings, numFmt, date1904 });
  const mdw = maxDigitWidth(baseFont);

  const list = sheets.filter((s) => s.dt !== 6); // VB 모듈 시트는 엑셀도 보여주지 않는다
  if (!list.length) return null;
  const activeSheet = sheets[active] && sheets[active].dt !== 6 ? list.indexOf(sheets[active]) : 0;
  // BOUNDSHEET 위치가 BOF를 가리키지 않는 손상 파일은 전역 부분 뒤의 하위 스트림을 순서대로 짝짓는다.
  let substreams = null;
  const offsetOf = (s) => {
    if (s.offset + 4 <= len && dv.getUint16(s.offset, true) === RT.BOF) return s.offset;
    substreams ??= scanSubstreams(dv, pos, len);
    return substreams[sheets.indexOf(s)] ?? -1;
  };
  return {
    reader: 'xls',
    sheets: list.map((s) => ({ name: s.name, hidden: s.hidden, kind: s.dt === 2 ? 'chart' : s.dt === 1 ? 'macro' : 'sheet' })),
    active: Math.max(0, activeSheet),
    styles,
    load: (index) => {
      const s = list[index];
      if (!s || s.dt === 2) return SheetModel.placeholder(s?.name ?? '', 'chart');
      const offset = offsetOf(s);
      if (offset < 0) return SheetModel.placeholder(s.name, 'sheet');
      return readSheet(stream, dv, { ...s, offset }, { biff, text, context, styles, mdw });
    },
  };
}

/** 전역 부분 뒤에 이어지는 최상위 BOF(시트 시작) 위치들 */
function scanSubstreams(dv, from, len) {
  const out = [];
  let depth = 0;
  for (let pos = from; pos + 4 <= len; ) {
    const type = dv.getUint16(pos, true);
    const size = dv.getUint16(pos + 2, true);
    if (type === RT.BOF) {
      if (depth === 0) out.push(pos);
      depth++;
    } else if (type === RT.EOF) depth = Math.max(0, depth - 1);
    pos += 4 + size;
  }
  return out;
}

function parseXf(dv, at) {
  const align = dv.getUint8(at + 6);
  const indent = dv.getUint8(at + 8);
  const lines = dv.getUint16(at + 10, true);
  const colors1 = dv.getUint16(at + 12, true);
  const colors2 = dv.getUint32(at + 14, true);
  const fill = dv.getUint16(at + 18, true);
  return {
    ifnt: dv.getUint16(at, true),
    ifmt: dv.getUint16(at + 2, true),
    alc: align & 7,
    wrap: Boolean(align & 8),
    alcV: (align >> 4) & 7,
    rotate: dv.getUint8(at + 7),
    indent: indent & 15,
    shrink: Boolean(indent & 0x10),
    border: { l: lines & 15, r: (lines >> 4) & 15, t: (lines >> 8) & 15, b: (lines >> 12) & 15 },
    borderColor: { l: colors1 & 0x7f, r: (colors1 >> 7) & 0x7f, t: colors2 & 0x7f, b: (colors2 >> 7) & 0x7f },
    fls: (colors2 >>> 26) & 0x3f,
    icvFore: fill & 0x7f,
    icvBack: (fill >> 7) & 0x7f,
    ext: null,
  };
}

// BIFF5 XF(16바이트): 테두리는 3비트 선 종류, 들여쓰기 없음, 글자 방향 2비트(1 = 세로 쌓기)
function parseXf5(dv, at) {
  const align = dv.getUint8(at + 6);
  const orient = dv.getUint8(at + 7) & 3;
  const fill = dv.getUint32(at + 8, true);
  const lines = dv.getUint32(at + 12, true);
  return {
    ifnt: dv.getUint16(at, true),
    ifmt: dv.getUint16(at + 2, true),
    alc: align & 7,
    wrap: Boolean(align & 8),
    alcV: (align >> 4) & 7,
    rotate: orient === 1 ? 255 : orient === 2 ? 90 : orient === 3 ? 180 : 0,
    indent: 0,
    shrink: false,
    border: { l: (lines >> 3) & 7, r: (lines >> 6) & 7, t: lines & 7, b: (fill >>> 22) & 7 },
    borderColor: { l: (lines >>> 16) & 0x7f, r: (lines >>> 23) & 0x7f, t: (lines >>> 9) & 0x7f, b: (fill >>> 25) & 0x7f },
    fls: (fill >>> 16) & 0x3f,
    icvFore: fill & 0x7f,
    icvBack: (fill >>> 7) & 0x7f,
    ext: null,
  };
}

// XFEXT(엑셀 2007 이후가 함께 저장하는 실제 RGB 색). 테마 색은 색상표 근사값을 그대로 둔다.
function parseXfExt(dv, at, size, xfs) {
  if (size < 20) return;
  const ixfe = dv.getUint16(at + 14, true);
  const count = dv.getUint16(at + 18, true);
  const xf = xfs[ixfe];
  if (!xf) return;
  let p = at + 20;
  const end = at + size;
  const names = { 4: 'fg', 5: 'bg', 7: 't', 8: 'b', 9: 'l', 10: 'r', 13: 'font' };
  for (let i = 0; i < count && p + 4 <= end; i++) {
    const type = dv.getUint16(p, true);
    const cb = dv.getUint16(p + 2, true);
    if (cb < 4) break;
    const name = names[type];
    if (name && cb >= 20 && dv.getUint16(p + 4, true) === 2) {
      const rgb = (dv.getUint8(p + 8) << 16) | (dv.getUint8(p + 9) << 8) | dv.getUint8(p + 10);
      xf.ext ??= {};
      xf.ext[name] = `#${rgb.toString(16).padStart(6, '0')}`;
    }
    p += cb;
  }
}

function readSheet(stream, dv, sheet, { biff, text: readText, context, styles, mdw }) {
  const len = stream.length;
  // LABEL·STRING 문자열: BIFF8은 CONTINUE까지 이어 읽고, BIFF5는 코드페이지 8비트 문자열이다.
  const recordText = (start, end) => {
    if (biff !== 8) return readText(start, end, 2);
    const ranges = [[start, end]];
    pos = collectContinue(dv, pos, len, ranges);
    return new Segments(stream, ranges).string(2);
  };
  const builder = new SheetBuilder({ paints: (xf) => styles.paints(xf) });
  builder.defaultRowHeight = 17;
  builder.defaultColWidth = defaultColWidthPx(8, mdw);
  let pos = sheet.offset;
  let depth = 0;
  let frozen = false;
  let pending = null; // 수식 결과 문자열을 기다리는 칸
  while (pos + 4 <= len) {
    const type = dv.getUint16(pos, true);
    const size = dv.getUint16(pos + 2, true);
    const body = pos + 4;
    pos = body + size;
    if (pos > len) break;
    if (type === RT.BOF) {
      depth++;
      continue;
    }
    if (type === RT.EOF) {
      if (--depth <= 0) break;
      continue;
    }
    if (depth !== 1) continue; // 시트 안에 든 차트 등
    switch (type) {
      case RT.NUMBER:
        builder.add(dv.getUint16(body, true), dv.getUint16(body + 2, true), NUM, dv.getFloat64(body + 6, true), dv.getUint16(body + 4, true));
        break;
      case RT.RK:
        builder.add(dv.getUint16(body, true), dv.getUint16(body + 2, true), NUM, rk(dv.getInt32(body + 6, true)), dv.getUint16(body + 4, true));
        break;
      case RT.MULRK: {
        const row = dv.getUint16(body, true);
        const first = dv.getUint16(body + 2, true);
        const n = (size - 6) / 6;
        for (let i = 0; i < n; i++) {
          const at = body + 4 + i * 6;
          builder.add(row, first + i, NUM, rk(dv.getInt32(at + 2, true)), dv.getUint16(at, true));
        }
        break;
      }
      case RT.LABELSST: {
        const isst = dv.getUint32(body + 6, true);
        if (isst < context.strings.length) builder.add(dv.getUint16(body, true), dv.getUint16(body + 2, true), STR, isst, dv.getUint16(body + 4, true));
        break;
      }
      case RT.LABEL:
      case RT.RSTRING: {
        const text = recordText(body + 6, body + size);
        builder.add(dv.getUint16(body, true), dv.getUint16(body + 2, true), STR, context.addString(text), dv.getUint16(body + 4, true));
        break;
      }
      case RT.BOOLERR: {
        const value = stream[body + 6];
        const isError = stream[body + 7];
        const row = dv.getUint16(body, true);
        const col = dv.getUint16(body + 2, true);
        const xf = dv.getUint16(body + 4, true);
        if (isError) builder.add(row, col, ERR, context.addString(ERRORS[value] ?? '#ERR!'), xf);
        else builder.add(row, col, BOOL, value ? 1 : 0, xf);
        break;
      }
      case RT.FORMULA: {
        const row = dv.getUint16(body, true);
        const col = dv.getUint16(body + 2, true);
        const xf = dv.getUint16(body + 4, true);
        pending = null;
        if (dv.getUint16(body + 12, true) === 0xffff) {
          const kind = stream[body + 6];
          if (kind === 0) {
            pending = { row, col };
            builder.add(row, col, STR, context.emptyString(), xf); // STRING 레코드가 오면 바꾼다
          } else if (kind === 1) builder.add(row, col, BOOL, stream[body + 8] ? 1 : 0, xf);
          else if (kind === 2) builder.add(row, col, ERR, context.addString(ERRORS[stream[body + 8]] ?? '#ERR!'), xf);
          else builder.add(row, col, STR, context.emptyString(), xf);
        } else {
          builder.add(row, col, NUM, dv.getFloat64(body + 6, true), xf);
        }
        break;
      }
      case RT.STRING: {
        const text = recordText(body, body + size);
        if (pending) {
          builder.replaceLast(pending.row, pending.col, STR, context.addString(text));
          pending = null;
        }
        break;
      }
      case RT.BLANK:
        builder.add(dv.getUint16(body, true), dv.getUint16(body + 2, true), BLANK, 0, dv.getUint16(body + 4, true));
        break;
      case RT.MULBLANK: {
        const row = dv.getUint16(body, true);
        const first = dv.getUint16(body + 2, true);
        const n = (size - 6) / 2;
        for (let i = 0; i < n; i++) builder.add(row, first + i, BLANK, 0, dv.getUint16(body + 4 + i * 2, true));
        break;
      }
      case RT.ROW: {
        const row = dv.getUint16(body, true);
        const height = dv.getUint16(body + 6, true) & 0x7fff;
        const flags = dv.getUint16(body + 12, true);
        if (flags & 0x20) builder.rowHeights.set(row, 0);
        else if (height > 0) builder.rowHeights.set(row, Math.round(height / 15));
        if (flags & 0x40) builder.customRows.add(row);
        if (flags & 0x80) {
          const xf = dv.getUint16(body + 14, true) & 0x0fff;
          if (styles.paints(xf)) builder.rowStyles.set(row, xf);
        }
        break;
      }
      case RT.COLINFO: {
        const first = dv.getUint16(body, true);
        const last = Math.min(255, dv.getUint16(body + 2, true));
        const width = dv.getUint16(body + 4, true);
        const xf = dv.getUint16(body + 6, true);
        const hidden = dv.getUint16(body + 8, true) & 1;
        const px = hidden ? 0 : widthToPx(width / 256, mdw);
        const paints = styles.paints(xf);
        for (let c = first; c <= last; c++) {
          builder.colWidths.set(c, px);
          if (paints) builder.colStyles.set(c, xf);
        }
        break;
      }
      case RT.DEFAULTROWHEIGHT: {
        const height = dv.getUint16(body + 2, true);
        if (height > 0) builder.defaultRowHeight = Math.round(height / 15);
        break;
      }
      case RT.DEFCOLWIDTH:
        builder.defaultColWidth = defaultColWidthPx(dv.getUint16(body, true), mdw);
        break;
      case RT.MERGEDCELLS: {
        const n = dv.getUint16(body, true);
        for (let i = 0; i < n && body + 2 + i * 8 + 8 <= body + size; i++) {
          const at = body + 2 + i * 8;
          const r1 = dv.getUint16(at, true);
          const r2 = dv.getUint16(at + 2, true);
          const c1 = dv.getUint16(at + 4, true);
          const c2 = dv.getUint16(at + 6, true);
          if (r2 >= r1 && c2 >= c1 && (r2 > r1 || c2 > c1)) builder.merges.push([r1, c1, r2, c2]);
        }
        break;
      }
      case RT.WINDOW2: {
        const flags = dv.getUint16(body, true);
        builder.showGrid = Boolean(flags & 0x02);
        builder.showZeros = Boolean(flags & 0x10);
        frozen = Boolean(flags & 0x08);
        break;
      }
      case RT.PANE:
        if (frozen) {
          builder.freezeCols = dv.getUint16(body, true);
          builder.freezeRows = dv.getUint16(body + 2, true);
        }
        break;
      case RT.DIMENSIONS:
        builder.totalRows = biff === 8 ? dv.getUint32(body + 4, true) : dv.getUint16(body + 2, true);
        break;
      default:
        break;
    }
    if (type !== RT.FORMULA && type !== RT.STRING && pending && isCellRecord(type)) pending = null;
  }
  return builder.finish(sheet.name, context);
}

function collectContinue(dv, pos, len, ranges) {
  while (pos + 4 <= len && dv.getUint16(pos, true) === RT.CONTINUE) {
    const s = dv.getUint16(pos + 2, true);
    ranges.push([pos + 4, pos + 4 + s]);
    pos += 4 + s;
  }
  return pos;
}

function isCellRecord(type) {
  return type === RT.NUMBER || type === RT.RK || type === RT.MULRK || type === RT.LABELSST || type === RT.LABEL || type === RT.BOOLERR || type === RT.BLANK || type === RT.MULBLANK;
}
