import { BinaryReader } from '../core/binary.js';
import { alignEven } from '../core/utils.js';
import { decodeGrpprl } from './sprm.js';
import { decodeGrpprl6 } from './sprm6.js';
import type {
  DecodedProperty,
  FibRgFcLcb,
  ResolvedStyle,
  StyleBase,
  StyleCollection,
  StyleDefinition,
} from '../types.js';

const REPEATABLE_TABLE_PROPERTIES = new Set([
  'insertCells',
  'deleteCells',
  'columnWidth',
  'merge',
  'split',
  'textFlow',
  'vertMerge',
  'vertAlign',
  'setShading',
  'defaultShading',
  'setBorder',
  'cellPadding',
  'cellSpacing',
  'cellWidth',
  'fitText',
  'cellNoWrap',
]);

// doc-viewer: 글자 토글 속성. 값 0x80은 '기준(스타일) 값 그대로', 0x81은 '기준 값의 반대'다([MS-DOC] ToggleOperand).
const TOGGLE_CHAR_PROPERTIES = new Set([
  'bold', 'italic', 'strike', 'outline', 'shadow', 'smallCaps', 'caps', 'hidden',
  'emboss', 'imprint', 'doubleStrike', 'boldBi', 'italicBi',
]);

function toggleBase(value: unknown): boolean {
  return value === 0x81 ? true : value === 0x80 ? false : Boolean(value);
}

function mergePropertyArrays(...arrays: Array<DecodedProperty[] | undefined | null>): DecodedProperty[] {
  const map = new Map<string, DecodedProperty>();
  let sequence = 0;
  for (const array of arrays) {
    for (const prop of array || []) {
      const repeatable = prop.kind === 'table' && REPEATABLE_TABLE_PROPERTIES.has(prop.name);
      const key = repeatable ? `${prop.kind}:${prop.name}:${sequence++}` : `${prop.kind}:${prop.name}`;
      if (prop.kind === 'char' && TOGGLE_CHAR_PROPERTIES.has(prop.name) && (prop.value === 0x80 || prop.value === 0x81)) {
        const previous = map.get(key);
        if (previous) {
          const base = toggleBase(previous.value);
          map.set(key, { ...prop, value: prop.value === 0x80 ? base : !base });
          continue;
        }
      }
      map.set(key, prop);
    }
  }
  return Array.from(map.values());
}

function splitPropertiesByKind(properties: DecodedProperty[]): { para: DecodedProperty[]; char: DecodedProperty[]; table: DecodedProperty[] } {
  const out = { para: [] as DecodedProperty[], char: [] as DecodedProperty[], table: [] as DecodedProperty[] };
  for (const prop of properties || []) {
    if (prop.kind === 'para') out.para.push(prop);
    else if (prop.kind === 'char') out.char.push(prop);
    else if (prop.kind === 'table') out.table.push(prop);
  }
  return out;
}

function parseXstz(bytes: Uint8Array, offset: number): { value: string; nextOffset: number } {
  const reader = new BinaryReader(bytes);
  const cch = reader.u16(offset);
  const charsOffset = offset + 2;
  const byteLength = cch * 2;
  const text = reader.utf16le(charsOffset, byteLength);
  const end = charsOffset + byteLength + 2;
  return { value: text.replace(/\u0000+$/, ''), nextOffset: end };
}

function parseStdfBase(bytes: Uint8Array, offset: number): StyleBase {
  const reader = new BinaryReader(bytes);
  const w1 = reader.u16(offset);
  const w2 = reader.u16(offset + 2);
  const w3 = reader.u16(offset + 4);
  return {
    sti: w1 & 0x0fff,
    flags1: w1 >> 12,
    stk: w2 & 0x000f,
    istdBase: (w2 >> 4) & 0x0fff,
    cupx: w3 & 0x000f,
    istdNext: (w3 >> 4) & 0x0fff,
    bchUpe: reader.u16(offset + 6),
    grfstd: reader.u16(offset + 8),
  };
}

// doc-viewer: Word 6/95 스타일의 grpprl은 1바이트 sprm이다. version으로 해석기를 고른다.
type GrpprlDecoder = (bytes: Uint8Array, start: number, end: number) => DecodedProperty[];

function grpprlDecoder(version: number): GrpprlDecoder {
  if (version === 6) return (bytes, start, end) => decodeGrpprl6(bytes, start, end, { version: 6 });
  return decodeGrpprl;
}

function parseLpUpxPapx(bytes: Uint8Array, offset: number, decode: GrpprlDecoder = decodeGrpprl): { cbUpx: number; styleId: number; properties: DecodedProperty[]; nextOffset: number } {
  const reader = new BinaryReader(bytes);
  const cbUpx = reader.u16(offset);
  const start = offset + 2;
  const end = start + cbUpx;
  const papx = bytes.subarray(start, Math.min(end, bytes.length));
  let styleId = 0;
  let properties: DecodedProperty[] = [];
  if (papx.length >= 2) {
    styleId = papx[0] | ((papx[1] ?? 0) << 8);
    properties = decode(papx, 2, papx.length);
  }
  return { cbUpx, styleId, properties, nextOffset: alignEven(end) };
}

function parseLpUpxChpx(bytes: Uint8Array, offset: number, decode: GrpprlDecoder = decodeGrpprl): { cbUpx: number; properties: DecodedProperty[]; nextOffset: number } {
  const reader = new BinaryReader(bytes);
  const cbUpx = reader.u16(offset);
  const start = offset + 2;
  const end = start + cbUpx;
  const chpx = bytes.subarray(start, Math.min(end, bytes.length));
  const properties = decode(chpx, 0, chpx.length);
  return { cbUpx, properties, nextOffset: alignEven(end) };
}

/** Word 6/95 스타일 이름: 길이 1바이트 + 8비트 글자 + 0 */
function parseLegacyStyleName(bytes: Uint8Array, offset: number, decodeName: (raw: Uint8Array) => string): { value: string; nextOffset: number } {
  const cch = bytes[offset] ?? 0;
  const raw = bytes.subarray(offset + 1, Math.min(bytes.length, offset + 1 + cch));
  // 이름 뒤 0 종료 바이트를 건너뛰고, UPX는 STD 시작에서 짝수 위치에 온다.
  return { value: decodeName(raw).replace(/\u0000+$/, ''), nextOffset: alignEven(offset + 1 + cch + 1) };
}

function parseLpUpxTapx(bytes: Uint8Array, offset: number): { cbUpx: number; properties: DecodedProperty[]; nextOffset: number } {
  const reader = new BinaryReader(bytes);
  const cbUpx = reader.u16(offset);
  const start = offset + 2;
  const end = start + cbUpx;
  const tapx = bytes.subarray(start, Math.min(end, bytes.length));
  const properties = decodeGrpprl(tapx, 0, tapx.length);
  return { cbUpx, properties, nextOffset: alignEven(end) };
}

function parseStyleStd(
  stdBytes: Uint8Array,
  cbSTDBaseInFile: number,
  istd: number,
  version = 8,
  decodeName: (raw: Uint8Array) => string = (raw) => new TextDecoder('windows-1252').decode(raw),
): StyleDefinition {
  if (!stdBytes.length) {
    return {
      istd,
      empty: true,
      name: '',
      stdfBase: { istdBase: 0x0fff, istdNext: 0, stk: 1, cupx: 0 },
      paraProps: [],
      charProps: [],
      tableProps: [],
    };
  }
  const legacy = version !== 8;
  const baseSize = legacy
    ? Math.max(8, Math.min(cbSTDBaseInFile || 8, stdBytes.length))
    : Math.max(10, Math.min(cbSTDBaseInFile || 10, stdBytes.length));
  const stdfBase = parseStdfBase(stdBytes, 0);
  let offset = baseSize;
  const nameInfo = legacy ? parseLegacyStyleName(stdBytes, offset, decodeName) : parseXstz(stdBytes, offset);
  offset = nameInfo.nextOffset;
  const decode = grpprlDecoder(version);

  let paraProps: DecodedProperty[] = [];
  let charProps: DecodedProperty[] = [];
  let tableProps: DecodedProperty[] = [];

  try {
    if (stdfBase.stk === 1) {
      if (stdfBase.cupx >= 1 && offset + 2 <= stdBytes.length) {
        const papx = parseLpUpxPapx(stdBytes, offset, decode);
        paraProps = papx.properties;
        offset = papx.nextOffset;
      }
      if (stdfBase.cupx >= 2 && offset + 2 <= stdBytes.length) {
        const chpx = parseLpUpxChpx(stdBytes, offset, decode);
        charProps = chpx.properties;
      }
    } else if (stdfBase.stk === 2) {
      if (offset + 2 <= stdBytes.length) {
        const chpx = parseLpUpxChpx(stdBytes, offset, decode);
        charProps = chpx.properties;
      }
    } else if (stdfBase.stk === 3) {
      if (stdfBase.cupx >= 1 && offset + 2 <= stdBytes.length) {
        const tapx = parseLpUpxTapx(stdBytes, offset);
        tableProps = tapx.properties;
        offset = tapx.nextOffset;
      }
      if (stdfBase.cupx >= 2 && offset + 2 <= stdBytes.length) {
        const papx = parseLpUpxPapx(stdBytes, offset);
        paraProps = papx.properties;
        offset = papx.nextOffset;
      }
      if (stdfBase.cupx >= 3 && offset + 2 <= stdBytes.length) {
        const chpx = parseLpUpxChpx(stdBytes, offset);
        charProps = chpx.properties;
      }
    }
  } catch {
    // keep best-effort partial decoding
  }

  return {
    istd,
    name: nameInfo.value,
    stdfBase,
    paraProps,
    charProps,
    tableProps,
    empty: false,
  };
}

export function parseStyles(
  tableBytes: Uint8Array,
  fibRgFcLcb: FibRgFcLcb,
  version = 8,
  decodeName?: (raw: Uint8Array) => string,
): StyleCollection {
  // doc-viewer: Word 2의 스타일 시트는 구조가 전혀 달라 읽지 않는다(기본 서식으로 그린다).
  if (version === 2) {
    return { styles: new Map(), header: null, resolveStyle(istd: number | null | undefined): ResolvedStyle { return resolveStyle(new Map(), istd); } };
  }
  const fcStshf = fibRgFcLcb.fcStshf as number | undefined;
  const lcbStshf = fibRgFcLcb.lcbStshf as number | undefined;
  if (fcStshf == null || lcbStshf == null || lcbStshf <= 0) {
    return { styles: new Map(), header: null, resolveStyle(istd: number | null | undefined): ResolvedStyle { return resolveStyle(new Map(), istd); } };
  }
  const bytes = tableBytes.subarray(fcStshf, fcStshf + lcbStshf);
  const reader = new BinaryReader(bytes);
  const cbStshi = reader.u16(0);
  const stshiOffset = 2;
  const cstd = reader.u16(stshiOffset + 0);
  const cbSTDBaseInFile = reader.u16(stshiOffset + 2);
  const fontAt = (offset: number) => cbStshi >= offset + 2 && bytes.length >= stshiOffset + offset + 2
    ? reader.i16(stshiOffset + offset) : -1;
  const ftcAsci = fontAt(12);
  const ftcFE = fontAt(14);
  const ftcOther = fontAt(16);
  const header = { cbStshi, cstd, cbSTDBaseInFile, ftcAsci, ftcFE, ftcOther };

  let offset = 2 + cbStshi;
  const styles = new Map<number, StyleDefinition>();
  for (let istd = 0; istd < cstd && offset + 2 <= bytes.length; istd += 1) {
    const cbStd = reader.u16(offset);
    const stdStart = offset + 2;
    const stdEnd = stdStart + cbStd;
    if (cbStd === 0) {
      styles.set(istd, {
        istd,
        empty: true,
        name: '',
        stdfBase: { istdBase: 0x0fff, istdNext: 0, stk: 1, cupx: 0 },
        paraProps: [],
        charProps: [],
        tableProps: [],
      });
      offset = alignEven(stdEnd);
      continue;
    }
    const stdBytes = bytes.subarray(stdStart, Math.min(stdEnd, bytes.length));
    const style = parseStyleStd(stdBytes, cbSTDBaseInFile, istd, version, decodeName);
    styles.set(istd, style);
    offset = alignEven(stdEnd);
  }

  return {
    header,
    styles,
    resolveStyle(istd: number | null | undefined): ResolvedStyle {
      return resolveStyle(styles, istd);
    },
  };
}

export function resolveStyle(styleMap: Map<number, StyleDefinition>, istd: number | null | undefined, seen = new Set<number>()): ResolvedStyle {
  if (istd == null || istd === 0x0fff || seen.has(istd)) {
    return { paraProps: [], charProps: [], tableProps: [], styleIds: [] };
  }
  const style = styleMap.get(istd);
  if (!style || style.empty) return { paraProps: [], charProps: [], tableProps: [], styleIds: [] };
  seen.add(istd);
  const baseResolved = resolveStyle(styleMap, style.stdfBase?.istdBase, seen);
  return {
    styleIds: [...baseResolved.styleIds, istd],
    paraProps: mergePropertyArrays(baseResolved.paraProps, style.paraProps),
    charProps: mergePropertyArrays(baseResolved.charProps, style.charProps),
    tableProps: mergePropertyArrays(baseResolved.tableProps, style.tableProps),
  };
}

export { mergePropertyArrays, splitPropertiesByKind };
