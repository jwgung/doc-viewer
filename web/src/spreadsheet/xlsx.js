// xlsx 읽기. 시트 XML·공유 문자열·styles.xml·테마를 직접 읽어 셀 값과 서식을 압축 저장소에 담는다.
// SheetJS CE는 글꼴·테두리·정렬 같은 서식을 버리고 셀마다 객체를 만들기 때문이다.
// 시트 XML은 압축을 풀면서 조각으로 처리해, 큰 시트도 XML 전체를 한 번에 메모리에 올리지 않는다.
// 시트는 탭을 열 때 읽는다. xlsb처럼 다른 구조면 null을 돌려 SheetJS 경로로 넘긴다.
import { SSF } from 'xlsx';
import { BLANK, BOOL, BookContext, ERR, NUM, STR, SheetBuilder, SheetModel } from './sheet-store.js';
import {
  DEFAULT_PALETTE, DEFAULT_THEME, StyleTable, applyTint, defaultColWidthPx, maxDigitWidth, paletteColor, patternFill, widthToPx,
} from './styles.js';
import { toMedia } from './media.js';
import { isZip, openZip } from './zip.js';

// SheetJS가 표에 없는 기본 서식 번호에 쓰는 형식(SSFImplicit)과 같게 맞춘다.
const IMPLICIT_FORMATS = {
  5: '"$"#,##0_);\\("$"#,##0\\)', 6: '"$"#,##0_);[Red]\\("$"#,##0\\)', 7: '"$"#,##0.00_);\\("$"#,##0.00\\)', 8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  23: 'General', 24: 'General', 25: 'General', 26: 'General', 27: 'm/d/yy', 28: 'm/d/yy', 29: 'm/d/yy', 30: 'm/d/yy', 31: 'm/d/yy',
  32: 'h:mm:ss', 33: 'h:mm:ss', 34: 'h:mm:ss', 35: 'h:mm:ss', 36: 'm/d/yy',
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)', 42: '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)', 44: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)',
  50: 'm/d/yy', 51: 'm/d/yy', 52: 'm/d/yy', 53: 'm/d/yy', 54: 'm/d/yy', 55: 'm/d/yy', 56: 'm/d/yy', 57: 'm/d/yy', 58: 'm/d/yy',
  59: '0', 60: '0.00', 61: '#,##0', 62: '#,##0.00', 63: '"$"#,##0_);\\("$"#,##0\\)', 64: '"$"#,##0_);[Red]\\("$"#,##0\\)',
  65: '"$"#,##0.00_);\\("$"#,##0.00\\)', 66: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)', 67: '0%', 68: '0.00%', 69: '# ?/?', 70: '# ??/??',
  71: 'm/d/yy', 72: 'm/d/yy', 73: 'd-mmm-yy', 74: 'd-mmm', 75: 'mmm-yy', 76: 'h:mm', 77: 'h:mm:ss', 78: 'm/d/yy h:mm', 79: 'mm:ss', 80: '[h]:mm:ss', 81: 'mmss.0',
};

const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
function attrs(text) {
  const out = {};
  if (!text) return out;
  for (const m of text.matchAll(ATTR)) {
    const name = m[1];
    const colon = name.indexOf(':');
    out[colon >= 0 && !name.startsWith('xmlns') ? name.slice(colon + 1) : name] = m[2] ?? m[3];
  }
  return out;
}

const ENTITIES = { quot: '"', apos: "'", gt: '>', lt: '<', amp: '&' };
const ENTITY = /&(?:(quot|apos|gt|lt|amp)|#x([\da-fA-F]+)|#(\d+));/gi;
const XESCAPE = /_x([\da-fA-F]{4})_/g;
function unescapeXml(text) {
  if (!text) return '';
  const cdata = text.indexOf('<![CDATA[');
  if (cdata >= 0) {
    const end = text.indexOf(']]>', cdata);
    return unescapeXml(text.slice(0, cdata)) + text.slice(cdata + 9, end < 0 ? undefined : end) + (end < 0 ? '' : unescapeXml(text.slice(end + 3)));
  }
  let out = text;
  if (out.indexOf('&') >= 0) {
    out = out.replace(ENTITY, (all, name, hex, dec) => {
      if (name) return ENTITIES[name.toLowerCase()];
      const code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : all;
    });
  }
  if (out.indexOf('_x') >= 0) out = out.replace(XESCAPE, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return out.indexOf('\r') >= 0 ? out.replace(/\r\n/g, '\n') : out;
}

const T_TAG = /<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g;
const PHONETIC = /<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g;
/** 공유 문자열 항목(<si>)이나 인라인 문자열(<is>)의 글자. 서식 조각을 이어 붙이고 후리가나는 뺀다. */
function richText(inner) {
  const body = inner.indexOf('rPh') >= 0 ? inner.replace(PHONETIC, '') : inner;
  let out = '';
  for (const m of body.matchAll(T_TAG)) out += m[1] ?? '';
  return unescapeXml(out);
}

function element(xml, name) {
  const m = new RegExp(`<(?:\\w+:)?${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${name}>)`).exec(xml);
  return m ? { attrs: attrs(m[1]), body: m[2] ?? '' } : null;
}

function elements(xml, name) {
  if (!xml) return [];
  const re = new RegExp(`<(?:\\w+:)?${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${name}>)`, 'g');
  return [...xml.matchAll(re)].map((m) => ({ attrs: attrs(m[1]), body: m[2] ?? '' }));
}

function emptyTag(xml, name) {
  const m = new RegExp(`<(?:\\w+:)?${name}\\b([^>]*?)/?>`).exec(xml);
  return m ? attrs(m[1]) : null;
}

const truthy = (v) => v === '1' || v === 'true';

// 경로: 관계(rels) 대상은 원본 파트 폴더 기준 상대 경로다.
function resolvePath(base, target) {
  if (!target) return null;
  const parts = (target.startsWith('/') ? target.slice(1) : `${base}${target}`).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}
const dirOf = (path) => path.slice(0, path.lastIndexOf('/') + 1);
const relsOf = (path) => `${dirOf(path)}_rels/${path.slice(path.lastIndexOf('/') + 1)}.rels`;

async function readRels(zip, path) {
  const xml = await zip.text(relsOf(path));
  const base = dirOf(path);
  return elements(xml ?? '', 'Relationship').map(({ attrs: a }) => ({
    id: a.Id,
    type: a.Type ?? '',
    target: a.TargetMode === 'External' ? null : resolvePath(base, a.Target),
  }));
}

/** 셀 주소(A1)의 열·행(0부터). 문자열을 만들지 않고 글자 코드로 읽는다. */
function decodeRef(s, from, to, out) {
  let col = 0;
  let row = 0;
  let i = from;
  for (; i < to; i++) {
    const c = s.charCodeAt(i) | 32;
    if (c < 97 || c > 122) break;
    col = col * 26 + (c - 96);
  }
  for (; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c === 36) continue; // $
    if (c < 48 || c > 57) break;
    row = row * 10 + (c - 48);
  }
  out.col = col - 1;
  out.row = row - 1;
}

function decodeRange(ref) {
  const [a, b = a] = ref.split(':');
  const s = {};
  const e = {};
  decodeRef(a, 0, a.length, s);
  decodeRef(b, 0, b.length, e);
  return [s.row, s.col, e.row, e.col];
}

function parseTheme(xml) {
  const names = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  return names.map((name, i) => {
    const block = xml && element(xml, name);
    if (!block) return DEFAULT_THEME[i];
    const m = /srgbClr\b[^>]*?\bval="([0-9A-Fa-f]{6})"/.exec(block.body) || /sysClr\b[^>]*?\blastClr="([0-9A-Fa-f]{6})"/.exec(block.body);
    return m ? m[1] : DEFAULT_THEME[i];
  });
}

function parseStyles(xml, theme) {
  const palette = DEFAULT_PALETTE.slice();
  const indexed = element(xml, 'indexedColors');
  if (indexed) elements(indexed.body, 'rgbColor').forEach((c, i) => c.attrs.rgb && (palette[i] = c.attrs.rgb.slice(-6)));
  const THEME_ORDER = [1, 0, 3, 2];
  const color = (a) => {
    if (!a) return null;
    let hex = null;
    if (a.rgb && /^[0-9A-Fa-f]{6,8}$/.test(a.rgb)) hex = `#${a.rgb.slice(-6).toLowerCase()}`;
    else if (a.theme != null) {
      const t = Number(a.theme);
      const v = theme[t < 4 ? THEME_ORDER[t] : t];
      hex = v ? `#${v.toLowerCase()}` : null;
    } else if (a.indexed != null) hex = paletteColor(Number(a.indexed), palette);
    return hex && a.tint ? applyTint(hex, Number(a.tint)) : hex;
  };
  const numFmts = new Map(elements(element(xml, 'numFmts')?.body, 'numFmt').map((n) => [Number(n.attrs.numFmtId), unescapeXml(n.attrs.formatCode ?? '')]));
  const fonts = elements(element(xml, 'fonts')?.body, 'font').map(({ body }) => {
    const flag = (name) => {
      const a = emptyTag(body, name);
      return a ? !(a.val === '0' || a.val === 'false') : false;
    };
    const u = emptyTag(body, 'u');
    return {
      name: emptyTag(body, 'name')?.val ?? emptyTag(body, 'rFont')?.val ?? 'Calibri',
      size: Number(emptyTag(body, 'sz')?.val) || 11,
      bold: flag('b'),
      italic: flag('i'),
      strike: flag('strike'),
      underline: u ? (/double/.test(u.val ?? '') ? 'double' : u.val === 'none' ? null : 'single') : null,
      color: color(emptyTag(body, 'color')),
    };
  });
  const fills = elements(element(xml, 'fills')?.body, 'fill').map(({ body }) => {
    const pattern = element(body, 'patternFill');
    if (pattern) {
      const type = pattern.attrs.patternType ?? 'none';
      return patternFill(type, color(emptyTag(pattern.body, 'fgColor')), color(emptyTag(pattern.body, 'bgColor')));
    }
    const stops = elements(element(body, 'gradientFill')?.body, 'stop').map((s) => color(emptyTag(s.body, 'color'))).filter(Boolean);
    return stops[0] ?? null;
  });
  const borders = elements(element(xml, 'borders')?.body, 'border').map(({ body }) => {
    const out = {};
    for (const [key, names] of [['l', ['left', 'start']], ['r', ['right', 'end']], ['t', ['top']], ['b', ['bottom']]]) {
      for (const name of names) {
        const side = element(body, name);
        if (side?.attrs.style && side.attrs.style !== 'none') {
          out[key] = { style: side.attrs.style, color: color(emptyTag(side.body, 'color')) ?? '#000000' };
          break;
        }
      }
    }
    return out;
  });
  const xfs = elements(element(xml, 'cellXfs')?.body, 'xf').map(({ attrs: a, body }) => {
    const al = emptyTag(body, 'alignment') ?? {};
    return {
      numFmtId: Number(a.numFmtId) || 0,
      font: fonts[Number(a.fontId) || 0] ?? null,
      fill: fills[Number(a.fillId) || 0] ?? null,
      border: borders[Number(a.borderId) || 0] ?? {},
      align: {
        h: al.horizontal ?? 'general',
        v: al.vertical ?? 'bottom',
        wrap: truthy(al.wrapText),
        indent: Number(al.indent) || 0,
        rotate: Number(al.textRotation) || 0,
        shrink: truthy(al.shrinkToFit),
      },
    };
  });
  return { xfs, numFmts, fonts };
}

export async function readXlsx(bytes) {
  if (!isZip(bytes)) return null;
  const zip = openZip(bytes);
  const rootRels = await readRels(zip, '');
  let bookPath = rootRels.find((r) => /\/officeDocument$/.test(r.type))?.target ?? 'xl/workbook.xml';
  if (!zip.has(bookPath)) bookPath = 'xl/workbook.xml';
  const bookXml = await zip.text(bookPath);
  if (bookXml == null) return null; // xlsb 등
  const rels = await readRels(zip, bookPath);
  const relOf = (pattern) => rels.find((r) => pattern.test(r.type))?.target;

  const themeXml = await zip.text(relOf(/\/theme$/) ?? 'xl/theme/theme1.xml');
  const theme = parseTheme(themeXml);
  const stylesXml = (await zip.text(relOf(/\/styles$/) ?? 'xl/styles.xml')) ?? '';
  const { xfs, numFmts, fonts } = parseStyles(stylesXml, theme);
  const strings = await readSharedStrings(zip, relOf(/\/sharedStrings$/) ?? 'xl/sharedStrings.xml');

  const bookPr = emptyTag(bookXml, 'workbookPr') ?? {};
  const date1904 = truthy(bookPr.date1904);
  const table = SSF.get_table();
  const numFmt = (xf) => {
    const id = xfs[xf]?.numFmtId ?? 0;
    if (id === 0) return null;
    return numFmts.get(id) ?? table[id] ?? IMPLICIT_FORMATS[id] ?? null;
  };
  const context = new BookContext({ strings, numFmt, date1904 });
  const baseFont = fonts[0] ? { name: fonts[0].name, size: fonts[0].size, color: fonts[0].color } : { name: 'Calibri', size: 11, color: null };
  const styles = new StyleTable(xfs, baseFont);
  const mdw = maxDigitWidth(baseFont);

  const relById = new Map(rels.map((r) => [r.id, r]));
  const printNames = readPrintNames(bookXml);
  const sheets = elements(element(bookXml, 'sheets')?.body, 'sheet').map(({ attrs: a }, index) => {
    const rel = relById.get(a.id);
    const type = rel?.type ?? '';
    return {
      name: unescapeXml(a.name ?? ''),
      hidden: a.state === 'hidden' || a.state === 'veryHidden',
      kind: /chartsheet$/i.test(type) ? 'chart' : /macrosheet$/i.test(type) ? 'macro' : /dialogsheet$/i.test(type) ? 'dialog' : 'sheet',
      path: rel?.target ?? null,
      printNames: printNames.get(index) ?? null,
    };
  });
  if (!sheets.length) return null;
  const activeTab = Number(emptyTag(bookXml, 'workbookView')?.activeTab) || 0;
  return {
    reader: 'xlsx',
    sheets: sheets.map(({ name, hidden, kind }) => ({ name, hidden, kind })),
    active: activeTab < sheets.length ? activeTab : 0,
    styles,
    load: async (index, { drawing = true } = {}) => {
      const s = sheets[index];
      if (!s || !s.path || !zip.has(s.path) || (s.kind !== 'sheet' && s.kind !== 'chart')) return SheetModel.placeholder(s?.name ?? '', s?.kind === 'sheet' ? 'sheet' : 'chart');
      // 차트 시트는 표가 없고 그리기 파트에 차트 하나가 있다.
      const model = s.kind === 'chart' ? SheetModel.placeholder(s.name, 'chart') : await readSheet(zip, s, context, styles, mdw, baseFont);
      if (s.kind === 'chart') model.geometry.showGrid = false;
      if (!drawing) return model;
      try {
        // 차트가 다른 시트 값을 가리키면 그 시트를 따로 읽는다(같은 시트면 방금 읽은 것). 이 시트의 차트들이 같은 시트를
        // 가리키면 한 번만 읽고, 다 채우면 버린다.
        const referenced = new Map();
        model.drawing = await readDrawing(zip, s.path, themeXml, (name) => {
          if (name === s.name && s.kind === 'sheet') return model;
          if (!referenced.has(name)) {
            const ref = sheets.find((x) => x.name === name && x.kind === 'sheet' && x.path && zip.has(x.path));
            referenced.set(name, ref ? readSheet(zip, ref, context, styles, mdw, baseFont).catch(() => null) : null);
          }
          return referenced.get(name);
        });
      } catch (error) {
        console.warn('[sheet] pictures skipped', error); // 그림을 못 읽어도 표는 보인다.
      }
      return model;
    },
  };
}

async function readSharedStrings(zip, path) {
  const strings = [];
  let buf = '';
  const SI = /<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g;
  const flush = (text) => {
    for (const m of text.matchAll(SI)) strings.push(m[1] ? richText(m[1]) : '');
  };
  await zip.stream(path, (chunk) => {
    buf += chunk;
    const cut = lastClose(buf, 'si');
    if (cut > 0) {
      flush(buf.slice(0, cut));
      buf = buf.slice(cut);
    }
  });
  flush(buf);
  return strings;
}

/** 버퍼 안 마지막 </tag>(접두어 허용) 바로 뒤 위치. 없으면 -1. */
function lastClose(buf, tag) {
  const needle = `${tag}>`;
  let i = buf.lastIndexOf(needle);
  while (i > 0) {
    let j = i - 1;
    if (buf.charCodeAt(j) === 58) while (j > 0 && buf.charCodeAt(j) !== 47 && buf.charCodeAt(j) !== 60) j--; // 접두어:
    if (buf.charCodeAt(j) === 47 && buf.charCodeAt(j - 1) === 60) return i + needle.length;
    i = buf.lastIndexOf(needle, i - 1);
  }
  return -1;
}

async function readSheet(zip, sheet, context, styles, mdw, baseFont) {
  const builder = new SheetBuilder({ paints: (xf) => styles.paints(xf) });
  builder.defaultRowHeight = Math.round((baseFont.size || 11) * (96 / 72) * 1.364);
  builder.defaultColWidth = defaultColWidthPx(8, mdw);
  const state = { row: -1, col: -1, ref: { row: 0, col: 0 } };
  let buf = '';
  let phase = 0; // 0: sheetData 앞, 1: sheetData 안, 2: 뒤
  let prefix = '';
  let tail = '';
  const tags = {};
  const onChunk = (chunk) => {
    buf += chunk;
    if (phase === 0) {
      const m = /<([\w.-]+:)?sheetData\b/.exec(buf);
      if (!m) return;
      const root = /<([\w.-]+:)?worksheet\b/.exec(buf);
      prefix = root?.[1] ?? m[1] ?? '';
      Object.assign(tags, { row: `<${prefix}row`, rowEnd: `</${prefix}row>`, c: `<${prefix}c`, cEnd: `</${prefix}c>`, v: `<${prefix}v`, vEnd: `</${prefix}v>`, is: `<${prefix}is`, isEnd: `</${prefix}is>`, dataEnd: `</${prefix}sheetData>` });
      readHead(buf.slice(0, m.index), builder, mdw);
      buf = buf.slice(m.index);
      phase = 1;
    }
    if (phase === 1) {
      const end = buf.indexOf(tags.dataEnd);
      if (end >= 0) {
        readRows(buf.slice(0, end), tags, state, builder, context);
        tail = buf.slice(end);
        buf = '';
        phase = 2;
        return;
      }
      const cut = buf.lastIndexOf(tags.rowEnd);
      if (cut >= 0) {
        readRows(buf.slice(0, cut + tags.rowEnd.length), tags, state, builder, context);
        buf = buf.slice(cut + tags.rowEnd.length);
      }
    } else if (phase === 2) {
      tail += buf;
      buf = '';
    }
  };
  await zip.stream(sheet.path, onChunk);
  if (phase === 1) readRows(buf, tags, state, builder, context);
  if (phase === 0) readHead(buf, builder, mdw);
  for (const { attrs: a } of elements(element(tail || buf, 'mergeCells')?.body, 'mergeCell')) {
    if (!a.ref) continue;
    const [r1, c1, r2, c2] = decodeRange(a.ref);
    if (r1 >= 0 && c1 >= 0 && r2 >= r1 && c2 >= c1 && (r2 > r1 || c2 > c1)) builder.merges.push([r1, c1, r2, c2]);
  }
  const rest = tail || buf;
  builder.print = readPrint(rest, sheet.printNames, builder.fitToPage);
  const model = builder.finish(sheet.name, context);
  // 시트 배경 그림(<picture>)과 머리글·바닥글 그림(<legacyDrawingHF>, 인쇄에만 보인다)
  const picture = emptyTag(rest, 'picture')?.id;
  const legacyHF = emptyTag(rest, 'legacyDrawingHF')?.id;
  if (picture || legacyHF) {
    const sheetRels = new Map((await readRels(zip, sheet.path)).map((r) => [r.id, r.target]));
    if (picture && sheetRels.get(picture)) model.background = await readMedia(zip, sheetRels.get(picture)).catch(() => null);
    if (legacyHF && sheetRels.get(legacyHF) && model.geometry.print) {
      model.geometry.print.images = await readHeaderImages(zip, sheetRels.get(legacyHF)).catch(() => null);
    }
  }
  return model;
}

// ---- 인쇄 설정 ---------------------------------------------------------------
/** 범위 글(시트!$A$1:$H$40, 시트!$1:$2, 시트!$A:$B)의 행·열. 줄·칸 전체는 해당 쪽을 null로 둔다. */
function refRange(text) {
  const ref = text.slice(text.lastIndexOf('!') + 1).replace(/\$/g, '').trim();
  let m = /^([A-Za-z]{1,3})(\d+)(?::([A-Za-z]{1,3})(\d+))?$/.exec(ref);
  if (m) {
    const [r1, c1, r2, c2] = decodeRange(ref);
    return { rows: [r1, r2], cols: [c1, c2] };
  }
  m = /^(\d+):(\d+)$/.exec(ref);
  if (m) return { rows: [Number(m[1]) - 1, Number(m[2]) - 1], cols: null };
  m = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/.exec(ref);
  if (m) {
    const [, c1, , c2] = decodeRange(`${m[1]}1:${m[2]}1`);
    return { rows: null, cols: [c1, c2] };
  }
  return null;
}

/** 통합 문서의 정의된 이름 중 인쇄 영역·인쇄 제목: 시트 번호 → { area: [r1,c1,r2,c2], titleRows, titleCols } */
function readPrintNames(bookXml) {
  const out = new Map();
  for (const { attrs: a, body } of elements(element(bookXml, 'definedNames')?.body, 'definedName')) {
    const sheet = Number(a.localSheetId);
    if (!Number.isInteger(sheet) || (a.name !== '_xlnm.Print_Area' && a.name !== '_xlnm.Print_Titles')) continue;
    const entry = out.get(sheet) ?? {};
    // 여러 범위는 쉼표로 잇는다(시트 이름 안 쉼표는 따옴표 안이다)
    const parts = unescapeXml(body).match(/(?:'[^']*(?:''[^']*)*'|[^,])+/g) ?? [];
    for (const part of parts) {
      const range = refRange(part);
      if (!range) continue;
      if (a.name === '_xlnm.Print_Area') {
        entry.area ??= [range.rows?.[0] ?? 0, range.cols?.[0] ?? 0, range.rows?.[1] ?? 1_048_575, range.cols?.[1] ?? 16_383];
      } else if (range.rows && !range.cols) entry.titleRows = range.rows;
      else if (range.cols && !range.rows) entry.titleCols = range.cols;
    }
    out.set(sheet, entry);
  }
  return out;
}

/** 시트 XML 뒤쪽의 인쇄 설정(여백·용지 방향·배율·쪽 나누기·머리글·바닥글). 단위는 인치(여백), 배율은 1 = 100% */
function readPrint(xml, names, fitToPage) {
  const margins = emptyTag(xml, 'pageMargins') ?? {};
  const setup = emptyTag(xml, 'pageSetup') ?? {};
  const options = emptyTag(xml, 'printOptions') ?? {};
  const hf = element(xml, 'headerFooter');
  const breaks = (name) => elements(element(xml, name)?.body, 'brk').map((b) => Number(b.attrs.id)).filter((v) => v > 0);
  const inch = (v, dflt) => (Number.isFinite(Number(v)) && v != null ? Number(v) : dflt);
  const scale = Number(setup.scale);
  return {
    area: names?.area ?? null,
    titleRows: names?.titleRows ?? null,
    titleCols: names?.titleCols ?? null,
    landscape: setup.orientation === 'landscape',
    scale: scale >= 10 && scale <= 400 ? scale / 100 : 1,
    fit: fitToPage ? { w: Number(setup.fitToWidth ?? 1) || 0, h: Number(setup.fitToHeight ?? 1) || 0 } : null,
    margins: {
      l: inch(margins.left, 0.7), r: inch(margins.right, 0.7), t: inch(margins.top, 0.75), b: inch(margins.bottom, 0.75),
      header: inch(margins.header, 0.3), footer: inch(margins.footer, 0.3),
    },
    center: { h: truthy(options.horizontalCentered), v: truthy(options.verticalCentered) },
    grid: truthy(options.gridLines),
    rowBreaks: breaks('rowBreaks'),
    colBreaks: breaks('colBreaks'),
    header: hf ? unescapeXml(element(hf.body, 'oddHeader')?.body ?? '') : '',
    footer: hf ? unescapeXml(element(hf.body, 'oddFooter')?.body ?? '') : '',
  };
}

/** 머리글·바닥글 그림(VML): 자리(LH·CH·RH·LF·CF·RF) → { type, data, w, h(px) } */
async function readHeaderImages(zip, vmlPath) {
  const vml = await zip.text(vmlPath);
  if (!vml) return null;
  const rels = new Map((await readRels(zip, vmlPath)).map((r) => [r.id, r.target]));
  const out = {};
  for (const [, head, body] of vml.matchAll(/<v:shape\b([^>]*)>([\s\S]*?)<\/v:shape>/g)) {
    const a = attrs(head);
    const place = /^[LCR][HF]$/.test(a.id ?? '') ? a.id : null;
    const relid = /o:relid="([^"]+)"/.exec(body)?.[1];
    if (!place || !relid || !rels.get(relid)) continue;
    const pt = (name) => Number(new RegExp(`${name}:\\s*([\\d.]+)pt`).exec(a.style ?? '')?.[1]) || 0;
    const media = await readMedia(zip, rels.get(relid)).catch(() => null);
    if (media) out[place] = { ...media, w: (pt('width') * 96) / 72, h: (pt('height') * 96) / 72 };
  }
  return out;
}

function readHead(head, builder, mdw) {
  const view = element(head, 'sheetView');
  if (view) {
    if (view.attrs.showGridLines === '0' || view.attrs.showGridLines === 'false') builder.showGrid = false;
    if (view.attrs.showZeros === '0' || view.attrs.showZeros === 'false') builder.showZeros = false;
    const pane = emptyTag(view.body, 'pane');
    if (pane && (pane.state === 'frozen' || pane.state === 'frozenSplit')) {
      builder.freezeCols = Math.max(0, Math.round(Number(pane.xSplit) || 0));
      builder.freezeRows = Math.max(0, Math.round(Number(pane.ySplit) || 0));
    }
  }
  if (truthy(emptyTag(head, 'pageSetUpPr')?.fitToPage)) builder.fitToPage = true;
  const format = emptyTag(head, 'sheetFormatPr');
  if (format) {
    if (Number(format.defaultRowHeight) > 0) builder.defaultRowHeight = Math.round((Number(format.defaultRowHeight) * 4) / 3);
    if (Number(format.defaultColWidth) > 0) builder.defaultColWidth = widthToPx(Number(format.defaultColWidth), mdw);
    else if (Number(format.baseColWidth) > 0) builder.defaultColWidth = defaultColWidthPx(Number(format.baseColWidth), mdw);
  }
  const dimension = emptyTag(head, 'dimension');
  if (dimension?.ref) builder.totalRows = decodeRange(dimension.ref)[2] + 1;
  for (const { attrs: a } of elements(element(head, 'cols')?.body, 'col')) {
    const min = Math.max(1, Number(a.min) || 1);
    const max = Math.min(16384, Number(a.max) || min);
    const hidden = truthy(a.hidden);
    const width = Number(a.width);
    const px = hidden ? 0 : width >= 0 && a.width != null ? widthToPx(width, mdw) : null;
    const style = Number(a.style) || 0;
    const paints = style > 0 && builder.paints(style);
    for (let c = min - 1; c < max; c++) {
      if (px != null) builder.colWidths.set(c, px);
      if (paints) builder.colStyles.set(c, style);
    }
  }
}

const ROW_ATTR = /\s(r|ht|hidden|s|customFormat|customHeight)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** <row>와 <c>를 훑는다. 셀 속성(r·s·t)은 문자열을 만들지 않고 글자 코드로 읽는다. */
function readRows(xml, tags, state, builder, context) {
  let i = 0;
  const ref = state.ref;
  for (;;) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (xml.startsWith(tags.c, lt) && isDelimiter(xml.charCodeAt(lt + tags.c.length))) {
      let gt = xml.indexOf('>', lt);
      if (gt < 0) break;
      const selfClose = xml.charCodeAt(gt - 1) === 47;
      // 속성: r, s, t
      let hasRef = false;
      let xf = 0;
      let type = 0; // 0 n, 1 s, 2 str, 3 inlineStr, 4 b, 5 e, 6 d
      let a = lt + tags.c.length;
      const attrEnd = selfClose ? gt - 1 : gt;
      while (a < attrEnd) {
        let ch = xml.charCodeAt(a);
        if (ch <= 32) {
          a++;
          continue;
        }
        const nameStart = a;
        while (a < attrEnd && (ch = xml.charCodeAt(a)) !== 61 && ch > 32) a++;
        const nameLength = a - nameStart;
        const first = xml.charCodeAt(nameStart);
        while (a < attrEnd && (ch = xml.charCodeAt(a)) !== 34 && ch !== 39) a++;
        const quote = ch;
        const valueStart = ++a;
        while (a < attrEnd && xml.charCodeAt(a) !== quote) a++;
        const valueEnd = a++;
        if (nameLength !== 1) continue;
        if (first === 114) {
          decodeRef(xml, valueStart, valueEnd, ref);
          hasRef = ref.col >= 0 && ref.row >= 0;
        } else if (first === 115) {
          xf = 0;
          for (let k = valueStart; k < valueEnd; k++) xf = xf * 10 + (xml.charCodeAt(k) - 48);
        } else if (first === 116) {
          const t0 = xml.charCodeAt(valueStart);
          const len = valueEnd - valueStart;
          type = t0 === 115 ? (len === 1 ? 1 : 2) : t0 === 105 ? 3 : t0 === 98 ? 4 : t0 === 101 ? 5 : t0 === 100 ? 6 : 0;
        }
      }
      if (hasRef) {
        state.col = ref.col;
        if (ref.row !== state.row && ref.row >= 0) state.row = ref.row;
      } else state.col++;
      const row = state.row;
      const col = state.col;
      if (selfClose) {
        if (xf > 0) builder.add(row, col, BLANK, 0, xf);
        i = gt + 1;
        continue;
      }
      const end = xml.indexOf(tags.cEnd, gt);
      if (end < 0) break;
      let value = null;
      const v0 = xml.indexOf(tags.v, gt);
      if (v0 >= 0 && v0 < end && isDelimiter(xml.charCodeAt(v0 + tags.v.length))) {
        const vs = xml.indexOf('>', v0) + 1;
        if (xml.charCodeAt(vs - 2) !== 47) {
          const ve = xml.indexOf(tags.vEnd, vs);
          value = xml.slice(vs, ve < 0 || ve > end ? end : ve);
        } else value = '';
      }
      if (type === 3) {
        const s0 = xml.indexOf(tags.is, gt);
        if (s0 >= 0 && s0 < end) {
          const ss = xml.indexOf('>', s0) + 1;
          const se = xml.indexOf(tags.isEnd, ss);
          builder.add(row, col, STR, context.addString(richText(xml.slice(ss, se < 0 || se > end ? end : se))), xf);
        } else if (value != null) builder.add(row, col, STR, context.addString(unescapeXml(value)), xf);
        else builder.add(row, col, BLANK, 0, xf);
      } else if (value == null || (value === '' && type !== 2)) {
        builder.add(row, col, BLANK, 0, xf);
      } else if (type === 0) {
        const num = Number(value);
        if (Number.isNaN(num)) builder.add(row, col, STR, context.addString(unescapeXml(value)), xf);
        else builder.add(row, col, NUM, num, xf);
      } else if (type === 1) {
        const index = Number(value);
        if (index >= 0 && index < context.strings.length) builder.add(row, col, STR, index, xf);
      } else if (type === 2) builder.add(row, col, STR, value === '' ? context.emptyString() : context.addString(unescapeXml(value)), xf);
      else if (type === 4) builder.add(row, col, BOOL, value === '1' || value === 'true' ? 1 : 0, xf);
      else if (type === 5) builder.add(row, col, ERR, context.addString(unescapeXml(value)), xf);
      else if (type === 6) {
        const time = Date.parse(value);
        if (Number.isNaN(time)) builder.add(row, col, STR, context.addString(value), xf);
        else builder.add(row, col, NUM, time / 86_400_000 + 25_569 - (context.date1904 ? 1462 : 0), xf);
      }
      i = end + tags.cEnd.length;
    } else if (xml.startsWith(tags.row, lt) && isDelimiter(xml.charCodeAt(lt + tags.row.length))) {
      const gt = xml.indexOf('>', lt);
      if (gt < 0) break;
      const head = xml.slice(lt + tags.row.length, gt);
      let r = null;
      let height = null;
      let hidden = false;
      let style = 0;
      let customFormat = false;
      let customHeight = false;
      for (const m of head.matchAll(ROW_ATTR)) {
        const v = m[2] ?? m[3];
        if (m[1] === 'r') r = Number(v) - 1;
        else if (m[1] === 'ht') height = Number(v);
        else if (m[1] === 'hidden') hidden = truthy(v);
        else if (m[1] === 's') style = Number(v) || 0;
        else if (m[1] === 'customFormat') customFormat = truthy(v);
        else if (m[1] === 'customHeight') customHeight = truthy(v);
      }
      state.row = r != null && r >= 0 ? r : state.row + 1;
      state.col = -1;
      if (hidden) builder.rowHeights.set(state.row, 0);
      else if (height > 0) builder.rowHeights.set(state.row, Math.round((height * 4) / 3));
      if (customHeight) builder.customRows.add(state.row);
      if (customFormat && style > 0 && builder.paints(style)) builder.rowStyles.set(state.row, style);
      i = gt + 1;
    } else {
      i = lt + 1;
    }
  }
}

function isDelimiter(c) {
  return c === 32 || c === 62 || c === 47 || c === 9 || c === 10 || c === 13 || Number.isNaN(c);
}

// ---- 그림 ----------------------------------------------------------------
// 시트에 딸린 그리기 파트(xl/drawings/drawingN.xml)에서 그림(pic), 차트(graphicFrame → chartN.xml), 도형·글상자(sp·cxnSp)를
// 읽는다. 차트와 도형은 XML째 넘기고 화면이 자리 크기에 맞춰 SVG로 그린다(web-ppt 차트·도형 렌더러).
// 위치는 셀 기준(열·행 + EMU 오프셋)으로 넘기고, 화면이 그린 행 높이·열 너비로 픽셀 자리를 정한다.
const EMU_PER_PX = 9525;
const ITEM = /<(?:\w+:)?(pic|graphicFrame)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?\1>/g;
const ANCHOR = /<(?:\w+:)?(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?\1>/g;
const FALLBACK = /<(?:\w+:)?Fallback\b[\s\S]*?<\/(?:\w+:)?Fallback>/g;
const MAX_PICTURES = 2000;

function cellAnchor(xml) {
  if (!xml) return null;
  const n = (name) => Number(element(xml, name)?.body) || 0;
  return [n('col'), n('colOff') / EMU_PER_PX, n('row'), n('rowOff') / EMU_PER_PX];
}

function xfrmOf(xml) {
  const x = element(xml, 'xfrm');
  if (!x) return null;
  const off = emptyTag(x.body, 'off') ?? {};
  const ext = emptyTag(x.body, 'ext') ?? {};
  const chOff = emptyTag(x.body, 'chOff');
  const chExt = emptyTag(x.body, 'chExt');
  return {
    x: Number(off.x) || 0, y: Number(off.y) || 0, cx: Number(ext.cx) || 0, cy: Number(ext.cy) || 0,
    chX: Number(chOff?.x) || 0, chY: Number(chOff?.y) || 0, chCx: Number(chExt?.cx) || 0, chCy: Number(chExt?.cy) || 0,
    rot: (Number(x.attrs.rot) || 0) / 60000, flipH: truthy(x.attrs.flipH), flipV: truthy(x.attrs.flipV),
  };
}

/** 앵커 안 그룹(grpSp)들의 범위와 좌표계. 바깥 그룹이 앞에 온다. */
function groupRanges(body) {
  const out = [];
  const stack = [];
  for (const m of body.matchAll(/<(\/?)(?:\w+:)?grpSp\b[^>]*>/g)) {
    if (!m[1]) stack.push(m.index);
    else if (stack.length) {
      const start = stack.pop();
      out.push({ start, end: m.index, xf: xfrmOf(element(body.slice(start, m.index), 'grpSpPr')?.body ?? '') });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * { pictures: [{ from, to, pos, size, box, media, crop, rot, flipH, flipV }], media } 또는 null.
 * media 항목: { type, data } | { type, svg }(그림) | { type: 'chart', xml, theme }(차트)
 */
async function readDrawing(zip, sheetPath, themeXml, sheetByName) {
  const drawingPath = (await readRels(zip, sheetPath)).find((r) => /\/drawing$/.test(r.type))?.target;
  if (!drawingPath) return null;
  const xml = await zip.text(drawingPath);
  if (!xml) return null;
  const rels = new Map((await readRels(zip, drawingPath)).map((r) => [r.id, r]));
  const pictures = [];
  const mediaIndex = new Map(); // 파트 경로 → { index, chart }
  for (const [, kind, raw] of xml.matchAll(ANCHOR)) {
    const body = raw.indexOf('Fallback') >= 0 ? raw.replace(FALLBACK, '') : raw;
    const from = kind === 'absoluteAnchor' ? null : cellAnchor(element(body, 'from')?.body);
    const to = kind === 'twoCellAnchor' ? cellAnchor(element(body, 'to')?.body) : null;
    const ext = kind === 'twoCellAnchor' ? null : emptyTag(body, 'ext');
    const pos = kind === 'absoluteAnchor' ? emptyTag(body, 'pos') : null;
    const size = ext ? [Number(ext.cx) / EMU_PER_PX || 0, Number(ext.cy) / EMU_PER_PX || 0] : null;
    // 그룹 안 항목은 그룹의 자식 좌표계(chOff·chExt)로 앵커 상자 안 비율 자리를 구한다.
    // 그룹 안의 그룹은 안쪽 좌표계부터 바깥 그룹의 자식 좌표계로 차례로 옮긴다.
    const groups = /<(?:\w+:)?grpSp\b/.test(body) ? groupRanges(body) : [];
    // 도형·글상자·선(sp·cxnSp, 그룹 안 것 포함): 앵커 하나를 통째로 넘겨 화면에서 SVG로 그린다(슬라이드 도형 렌더러).
    // 그림과 차트는 아래에서 따로 그리므로 뺀다.
    if (/<(?:\w+:)?(?:sp|cxnSp)\b/.test(body) && pictures.length < MAX_PICTURES) {
      const key = `#shapes${mediaIndex.size}`;
      const entry = { index: mediaIndex.size, shapes: `<anchor>${body.replace(ITEM, '')}</anchor>` };
      mediaIndex.set(key, entry);
      pictures.push({
        from, to, size,
        pos: pos ? [Number(pos.x) / EMU_PER_PX || 0, Number(pos.y) / EMU_PER_PX || 0] : null,
        box: [0, 0, 1, 1], media: entry.index, crop: null, rot: 0, flipH: false, flipV: false, shapes: true,
      });
    }
    for (const match of body.matchAll(ITEM)) {
      const [, tag, item] = match;
      if (pictures.length >= MAX_PICTURES) break;
      const nv = emptyTag(item, 'cNvPr');
      if (nv && truthy(nv.hidden)) continue;
      let target;
      let chart = false;
      let chartEx = false;
      if (tag === 'pic') {
        const blip = emptyTag(item, 'blip');
        target = blip?.embed && rels.get(blip.embed)?.target;
      } else {
        const ref = emptyTag(item, 'chart');
        const rel = ref?.id && rels.get(ref.id);
        // chartEx(엑셀 2016 이후 새 차트: 폭포·트리맵 등)는 다른 형식이라 chartex.js가 따로 그린다.
        chartEx = Boolean(rel && /chartEx$/i.test(rel.type));
        target = rel && (chartEx || /\/chart$/.test(rel.type)) ? rel.target : null;
        chart = true;
      }
      if (!target) continue;
      const xf = xfrmOf(tag === 'pic' ? element(item, 'spPr')?.body ?? '' : item);
      let box = [0, 0, 1, 1];
      const chain = groups.filter((g) => g.start < match.index && match.index < g.end);
      const group = chain[0]?.xf;
      if (group && xf && group.chCx > 0 && group.chCy > 0) {
        let { x, y, cx, cy } = xf;
        for (const { xf: g } of chain.slice(1).reverse()) {
          if (!g || !(g.chCx > 0) || !(g.chCy > 0)) continue;
          const sx = g.cx / g.chCx;
          const sy = g.cy / g.chCy;
          x = g.x + (x - g.chX) * sx;
          y = g.y + (y - g.chY) * sy;
          cx *= sx;
          cy *= sy;
        }
        const fx = (v) => (v - group.chX) / group.chCx;
        const fy = (v) => (v - group.chY) / group.chCy;
        box = [fx(x), fy(y), fx(x + cx), fy(y + cy)];
      }
      const src = tag === 'pic' && emptyTag(item, 'srcRect');
      const crop = src ? ['l', 't', 'r', 'b'].map((k) => (Number(src[k]) || 0) / 100000) : null;
      let entry = mediaIndex.get(target);
      if (!entry) {
        entry = { index: mediaIndex.size, chart, chartEx };
        mediaIndex.set(target, entry);
      }
      pictures.push({
        from, to, size,
        pos: pos ? [Number(pos.x) / EMU_PER_PX || 0, Number(pos.y) / EMU_PER_PX || 0] : null,
        box, media: entry.index,
        crop: crop?.some((v) => v !== 0) ? crop : null,
        rot: chart ? 0 : xf?.rot ?? 0, flipH: !chart && (xf?.flipH ?? false), flipV: !chart && (xf?.flipV ?? false),
      });
    }
  }
  if (!pictures.length) return null;
  // 하나를 못 읽어도 나머지는 보인다.
  const media = await Promise.all(
    [...mediaIndex].map(([path, { chart, chartEx, shapes }]) => {
      if (shapes) return { type: 'shapes', xml: shapes, theme: themeXml };
      if (chartEx) return zip.text(path).then((text) => (text ? { type: 'chartex', xml: text, theme: themeXml } : null)).catch(() => null);
      return (chart ? readChart(zip, path, themeXml, sheetByName) : readMedia(zip, path)).catch(() => null);
    }),
  );
  return { pictures: pictures.filter((p) => media[p.media]), media };
}

async function readChart(zip, path, themeXml, sheetByName) {
  const text = await zip.text(path);
  return text ? { type: 'chart', xml: await fillChartCache(text, sheetByName), theme: themeXml } : null;
}

// 값 캐시(numCache·strCache)가 없는 계열 참조(POI 등 프로그램이 만든 파일). 엑셀은 열 때 셀에서 다시 읽는다.
const BARE_REF = /<((?:\w+:)?)(numRef|strRef)>\s*<\1f>([^<]*)<\/\1f>\s*<\/\1\2>/g;
const SHEET_REF = /^(?:'((?:[^']|'')+)'|([^'!]+))!(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?$/;
const MAX_CACHE_POINTS = 10000;

/** 캐시 없는 참조를 시트 값으로 채운다. 한 범위(시트!A1:B2)만 읽고, 여러 범위·이름 정의는 그대로 둔다. */
async function fillChartCache(xml, sheetByName) {
  if (!sheetByName || !/<(?:\w+:)?(?:numRef|strRef)>\s*<(?:\w+:)?f>[^<]*<\/(?:\w+:)?f>\s*<\/(?:\w+:)?(?:numRef|strRef)>/.test(xml)) return xml;
  const sheetsRead = new Map(); // 이 차트 안에서 같은 시트를 한 번만 기다린다(읽기 자체는 sheetByName이 나눠 쓴다)
  const escape = (t) => t.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
  const replacements = [];
  for (const m of xml.matchAll(BARE_REF)) {
    const [all, prefix, kind, formula] = m;
    const ref = SHEET_REF.exec(unescapeXml(formula).trim());
    if (!ref) continue;
    const name = ref[1]?.replace(/''/g, "'") ?? ref[2];
    if (!sheetsRead.has(name)) sheetsRead.set(name, Promise.resolve(sheetByName(name)).catch(() => null));
    const model = await sheetsRead.get(name);
    if (!model) continue;
    const [r1, c1, r2, c2] = decodeRange(ref[4] ? `${ref[3]}:${ref[4]}` : ref[3]);
    const count = (r2 - r1 + 1) * (c2 - c1 + 1);
    if (!(count > 0) || count > MAX_CACHE_POINTS) continue;
    let pts = '';
    let i = 0;
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++, i++) {
        const v = model.cellValue(r, c);
        if (!v) continue;
        if (kind === 'numRef') {
          if (Number.isFinite(v.num)) pts += `<${prefix}pt idx="${i}"><${prefix}v>${v.num}</${prefix}v></${prefix}pt>`;
        } else if (v.text) pts += `<${prefix}pt idx="${i}"><${prefix}v>${escape(v.text)}</${prefix}v></${prefix}pt>`;
      }
    }
    const cache = kind === 'numRef' ? 'numCache' : 'strCache';
    const head = kind === 'numRef' ? `<${prefix}formatCode>General</${prefix}formatCode>` : '';
    // 바꿀 글은 함수로 넘긴다: 칸 글자에 든 $', $& 같은 것이 치환 패턴으로 해석되지 않게.
    const filled = `</${prefix}f><${prefix}${cache}>${head}<${prefix}ptCount val="${count}"/>${pts}</${prefix}${cache}>`;
    replacements.push([m.index, all.length, all.replace(`</${prefix}f>`, () => filled)]);
  }
  let out = xml;
  for (const [at, length, text] of replacements.reverse()) out = out.slice(0, at) + text + out.slice(at + length);
  return out;
}

async function readMedia(zip, path) {
  return toMedia(await zip.binary(path), { svgFile: /\.svg$/i.test(path) });
}
