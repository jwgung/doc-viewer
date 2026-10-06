// SheetJS로 읽는 대체 경로: CSV, BIFF5 이하 xls, HTML·XML로 된 .xls, xlsb, 직접 읽기에 실패한 파일.
// 읽은 뒤에는 셀 객체를 압축 저장소로 옮기고 SheetJS 통합 문서는 버린다. 표시 문자열은 cell.w를 그대로 쓴다.
import * as XLSX from 'xlsx';
import { decodeText } from '../text.js';
import { BLANK, BOOL, BookContext, ERR, PRENUM, STR, SheetBuilder } from './sheet-store.js';
import { StyleTable } from './styles.js';

const NUMBER_TEXT = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/g;
const MULTILINE_XF = 1; // CSV 안 여러 줄 값: 줄을 지켜 보여 준다
const LINE_PX = 18;
const MAX_LINES = 8;
const textWidth = (line) => line.length + (line.match(WIDE)?.length ?? 0);

// HTML·XML로 된 .xls(은행·관공서의 "엑셀 내려받기"): SheetJS에 바이트를 주면 EUC-KR 한글이 깨진다.
// 문서가 밝힌 문자셋(meta charset, XML encoding)으로 직접 풀어 문자열로 넘긴다. HTML·XML이 아니면 null.
const CHARSET_ALIASES = { cp949: 'euc-kr', ms949: 'euc-kr', uhc: 'euc-kr', 'x-windows-949': 'euc-kr', ksc5601: 'euc-kr' };
export function markupText(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 4096));
  if (!/^\s*</.test(head) || !/<(?:html|table|\?xml|workbook|meta|head|body|!doctype)\b/i.test(head)) return null;
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.-]+)/i.exec(head) ?? /<\?xml[^>]+encoding\s*=\s*["']([\w:.-]+)/i.exec(head);
  const label = m ? CHARSET_ALIASES[m[1].toLowerCase()] ?? m[1].toLowerCase() : null;
  if (label && label !== 'utf-8' && label !== 'utf8') {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // 모르는 문자셋 이름이면 아래에서 추정한다.
    }
  }
  return decodeText(bytes); // UTF-8로 읽히지 않으면 EUC-KR
}

export function readWithSheetJs(bytes, fmt) {
  const csv = fmt === 'csv';
  const markup = csv ? null : markupText(bytes);
  const workbook = csv
    ? XLSX.read(decodeText(bytes), { type: 'string', raw: true, dense: true })
    : markup != null
      ? XLSX.read(markup, { type: 'string', raw: true, dense: true, cellDates: true, cellStyles: true })
      : XLSX.read(bytes, { type: 'array', dense: true, cellDates: true, cellStyles: true, cellFormula: false, cellHTML: false });
  const context = new BookContext();
  // 시트를 하나도 못 찾은 손상 파일은 빈 시트 하나로 연다.
  const names = workbook.SheetNames.length ? workbook.SheetNames : ['Sheet1'];
  const props = workbook.Workbook?.Sheets ?? [];
  // 텍스트 원본(CSV·HTML 표)은 열 너비가 없어 글자 수로 정하고, 숫자 모양 글은 오른쪽에 붙인다.
  const models = names.map((name) => toModel(workbook.Sheets?.[name], name, context, csv || markup != null));
  return {
    reader: 'sheetjs',
    sheets: names.map((name, i) => ({ name, hidden: Boolean(props[i]?.Hidden), kind: workbook.Sheets[name]?.['!type'] === 'chart' ? 'chart' : 'sheet' })),
    active: Number(workbook.Workbook?.Views?.[0]?.activeTab) || 0,
    styles: new StyleTable([{}, { align: { wrap: true } }], null),
    load: (index) => models[index],
  };
}

function toModel(sheet, name, context, textual) {
  const builder = new SheetBuilder();
  builder.defaultRowHeight = 20;
  builder.defaultColWidth = 64;
  const data = sheet?.['!data'] ?? [];
  const widths = textual ? [] : null;
  // 여러 열에 걸친 병합 칸의 글은 한 열의 너비를 정하는 데 쓰지 않는다.
  const spanning = new Set((sheet?.['!merges'] ?? []).filter((m) => m.e.c > m.s.c).map((m) => m.s.r * 16384 + m.s.c));
  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell || cell.t === 'z') continue;
      const text = cell.w ?? (cell.v instanceof Date ? cell.v.toISOString() : String(cell.v ?? ''));
      const lines = textual && text.includes('\n') ? text.split(/\r?\n/) : null;
      const xf = lines ? MULTILINE_XF : 0;
      if (cell.t === 'b') builder.add(r, c, BOOL, cell.v ? 1 : 0, 0);
      else if (cell.t === 'e') builder.add(r, c, ERR, context.addString(text), 0);
      else if (cell.t === 'n' || cell.t === 'd' || (textual && NUMBER_TEXT.test(text))) builder.add(r, c, PRENUM, context.addString(text), 0);
      else builder.add(r, c, text === '' ? BLANK : STR, text === '' ? 0 : context.addString(text), xf);
      // CSV·HTML 표에는 열 너비·행 높이가 없어 앞쪽 행의 글자 수와 줄 수로 정한다.
      if (widths && r < 2000 && !spanning.has(r * 16384 + c)) {
        const w = Math.max(...(lines ?? [text]).map(textWidth));
        if (w > (widths[c] ?? 0)) widths[c] = w;
      }
      if (lines) builder.rowHeights.set(r, Math.max(builder.rowHeights.get(r) ?? 0, Math.min(MAX_LINES, lines.length) * LINE_PX + 2));
    }
  }
  if (widths) widths.forEach((w, c) => builder.colWidths.set(c, Math.min(400, Math.max(48, Math.round(w * 7.5 + 12)))));
  for (const [c, col] of (sheet?.['!cols'] ?? []).entries()) {
    if (!col) continue;
    if (col.hidden) builder.colWidths.set(c, 0);
    else if (col.wpx) builder.colWidths.set(c, Math.round(col.wpx));
  }
  for (const [r, row] of (sheet?.['!rows'] ?? []).entries()) {
    if (!row) continue;
    if (row.hidden) builder.rowHeights.set(r, 0);
    else if (row.hpx) builder.rowHeights.set(r, Math.round(row.hpx));
  }
  for (const m of sheet?.['!merges'] ?? []) builder.merges.push([m.s.r, m.s.c, m.e.r, m.e.c]);
  return builder.finish(name, context);
}
