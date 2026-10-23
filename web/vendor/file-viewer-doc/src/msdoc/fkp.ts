import { BinaryReader } from '../core/binary.js';
import { decodeGrpprl, SprmCodes } from './sprm.js';
import { decodeGrpprl6 } from './sprm6.js';
import { fcToCp } from './clx.js';
import type { DecodedProperty, ParsedClx, ParsedFib } from '../types.js';

interface PlcBte {
  aFC: number[];
  pages: number[];
}

interface ChpxFkp {
  crun: number;
  rgfc: number[];
  rgb: number[];
  chpxOffsets: number[];
}

interface PapxFkp {
  cpara: number;
  rgfc: number[];
  bOffsets: number[];
  papxOffsets: number[];
}

export interface ChpxRun {
  cpStart: number;
  cpEnd: number;
  fcStart: number;
  fcEnd: number;
  properties: DecodedProperty[];
}

export interface PapxRun extends ChpxRun {
  styleId: number;
  rawOffset: number;
}

/**
 * doc-viewer: 파일 형식 세대마다 다른 FKP 구조.
 * - Word 97 이상: BTE의 PN 4바이트, PAPX FKP의 BX 13바이트, PAPX 길이 = 2*cb-1(cb=0이면 다음 바이트*2)
 * - Word 6/95: PN 2바이트, BX 7바이트, PAPX 길이 = 2*cw
 * - Word 2: PN 2바이트, BX 1바이트, PAPX = cw, 스타일(1바이트), PHE(6바이트), grpprl. CHPX는 grpprl이 아니라 CHP 차분 구조다.
 */
export interface FkpFormat {
  version: 2 | 6 | 8;
  farEast?: boolean;
}

const WORD97_FORMAT: FkpFormat = { version: 8 };

function formatOf(fib: ParsedFib): FkpFormat {
  return { version: fib.version ?? 8, farEast: fib.base.wIdent >= 0xa697 && fib.base.wIdent <= 0xa699 };
}

function u32(bytes: Uint8Array, offset = 0): number {
  if (offset + 4 > bytes.length) return 0;
  return ((bytes[offset] ?? 0)
    | ((bytes[offset + 1] ?? 0) << 8)
    | ((bytes[offset + 2] ?? 0) << 16)
    | (((bytes[offset + 3] ?? 0) << 24) >>> 0)) >>> 0;
}

function readPlcBte(
  tableBytes: Uint8Array,
  fc: number | undefined,
  lcb: number | undefined,
  pnSize: 2 | 4,
  pnFirst = 0,
  cpnBte = 0,
): PlcBte {
  const empty = { aFC: [], pages: [] };
  let aFC: number[] = [];
  let pages: number[] = [];
  if (fc != null && lcb != null && lcb > 0 && fc < tableBytes.length) {
    const available = Math.min(lcb, tableBytes.length - fc);
    const bytes = tableBytes.subarray(fc, fc + available);
    const reader = new BinaryReader(bytes);
    const count = Math.floor((available - 4) / (4 + pnSize));
    if (count > 0) {
      for (let i = 0; i <= count; i += 1) aFC.push(reader.u32(i * 4) >>> 0);
      const pnOffset = (count + 1) * 4;
      for (let i = 0; i < count; i += 1) {
        pages.push(pnSize === 2 ? reader.u16(pnOffset + i * 2) : reader.u32(pnOffset + i * 4) & 0x3fffff);
      }
    }
  }
  // Word 6/95와 WordPad가 저장한 파일은 BTE 표가 실제 FKP 페이지 수(cpnBte)보다 짧을 수 있다.
  // 그때는 pnFirst부터 이어지는 페이지가 FKP다(LibreOffice WW8PLCF::GeneratePLCF와 같은 처리).
  if (cpnBte > pages.length && pnFirst > 0) {
    aFC = [];
    pages = Array.from({ length: cpnBte }, (_, index) => pnFirst + index);
  }
  return pages.length ? { aFC, pages } : empty;
}

function readChpxFkp(wordBytes: Uint8Array, pn: number): ChpxFkp | null {
  const offset = pn * 512;
  const page = wordBytes.subarray(offset, offset + 512);
  if (page.length < 512) return null;
  const reader = new BinaryReader(page);
  const crun = reader.u8(511);
  if (!crun || crun > 0x65) return null;
  const rgfc: number[] = [];
  for (let i = 0; i <= crun; i += 1) rgfc.push(reader.u32(i * 4) >>> 0);
  const rgb: number[] = [];
  const chpxOffsets: number[] = [];
  const rgbStart = (crun + 1) * 4;
  for (let i = 0; i < crun; i += 1) {
    const b = reader.u8(rgbStart + i);
    rgb.push(b);
    chpxOffsets.push(b ? offset + b * 2 : 0);
  }
  return { crun, rgfc, rgb, chpxOffsets };
}

function readPapxFkp(wordBytes: Uint8Array, pn: number, bxSize: number): PapxFkp | null {
  const offset = pn * 512;
  const page = wordBytes.subarray(offset, offset + 512);
  if (page.length < 512) return null;
  const reader = new BinaryReader(page);
  const cpara = reader.u8(511);
  if (!cpara || cpara > Math.floor(507 / (4 + bxSize))) return null;
  const rgfc: number[] = [];
  for (let i = 0; i <= cpara; i += 1) rgfc.push(reader.u32(i * 4) >>> 0);
  const bxStart = (cpara + 1) * 4;
  const bOffsets: number[] = [];
  const papxOffsets: number[] = [];
  for (let i = 0; i < cpara; i += 1) {
    const bOffset = reader.u8(bxStart + i * bxSize);
    bOffsets.push(bOffset);
    papxOffsets.push(bOffset ? offset + bOffset * 2 : 0);
  }
  return { cpara, rgfc, bOffsets, papxOffsets };
}

export function readChpxRuns(wordBytes: Uint8Array, tableBytes: Uint8Array, fib: ParsedFib, clx: ParsedClx): ChpxRun[] {
  const format = formatOf(fib);
  const fcPlcfBteChpx = fib.fibRgFcLcb.fcPlcfBteChpx as number | undefined;
  const lcbPlcfBteChpx = fib.fibRgFcLcb.lcbPlcfBteChpx as number | undefined;
  const plc = readPlcBte(
    tableBytes, fcPlcfBteChpx, lcbPlcfBteChpx, format.version === 8 ? 4 : 2,
    fib.pnChpFirst || 0, fib.cpnBteChp || 0,
  );
  const runs: ChpxRun[] = [];
  // doc-viewer: 바이트가 같은 CHPX는 한 번만 풀어 그 배열을 함께 쓴다(큰 문서는 같은 서식이 수만 번 나온다). 푼 결과는 바이트와
  // 문서 형식(이 문서 안에서 하나)에만 달려 있고, 쓰는 쪽은 읽기만 한다. 같은 배열이어야 parser.ts가 글자 상태도 다시 쓴다.
  const shared = new Map<string, DecodedProperty[]>();
  const noProperties: DecodedProperty[] = [];
  for (const pn of plc.pages) {
    const fkp = readChpxFkp(wordBytes, pn);
    if (!fkp) continue;
    for (let i = 0; i < fkp.crun; i += 1) {
      const fcStart = fkp.rgfc[i] ?? 0;
      const fcEnd = fkp.rgfc[i + 1] ?? fcStart;
      const cpStart = fcToCp(clx, fcStart);
      const cpEnd = fcToCp(clx, fcEnd);
      if (cpStart == null || cpEnd == null || cpEnd <= cpStart) continue;
      const offset = fkp.chpxOffsets[i];
      let properties = noProperties;
      if (offset) {
        const cb = offset >= 0 && offset < wordBytes.length ? (wordBytes[offset] ?? 0) : 0;
        const key = String.fromCharCode(...wordBytes.subarray(offset, Math.min(wordBytes.length, offset + 1 + cb)));
        properties = shared.get(key) ?? readChpxProperties(wordBytes, offset, format);
        shared.set(key, properties);
      }
      runs.push({ cpStart, cpEnd, fcStart, fcEnd, properties });
    }
  }
  runs.sort((a, b) => a.cpStart - b.cpStart || a.cpEnd - b.cpEnd);
  return runs;
}

export function readPapxRuns(wordBytes: Uint8Array, tableBytes: Uint8Array, fib: ParsedFib, clx: ParsedClx, dataBytes?: Uint8Array): PapxRun[] {
  const format = formatOf(fib);
  const fcPlcfBtePapx = fib.fibRgFcLcb.fcPlcfBtePapx as number | undefined;
  const lcbPlcfBtePapx = fib.fibRgFcLcb.lcbPlcfBtePapx as number | undefined;
  const plc = readPlcBte(
    tableBytes, fcPlcfBtePapx, lcbPlcfBtePapx, format.version === 8 ? 4 : 2,
    fib.pnPapFirst || 0, fib.cpnBtePap || 0,
  );
  const bxSize = format.version === 8 ? 13 : format.version === 6 ? 7 : 1;
  const runs: PapxRun[] = [];
  for (const pn of plc.pages) {
    const fkp = readPapxFkp(wordBytes, pn, bxSize);
    if (!fkp) continue;
    for (let i = 0; i < fkp.cpara; i += 1) {
      const fcStart = fkp.rgfc[i] ?? 0;
      const fcEnd = fkp.rgfc[i + 1] ?? fcStart;
      const cpStart = fcToCp(clx, fcStart);
      const cpEnd = fcToCp(clx, fcEnd);
      if (cpStart == null || cpEnd == null || cpEnd < cpStart) continue;
      const papx = fkp.papxOffsets[i]
        ? readPapxProperties(wordBytes, fkp.papxOffsets[i], dataBytes, format)
        : { styleId: 0, properties: [] };
      runs.push({ cpStart, cpEnd, fcStart, fcEnd, styleId: papx.styleId, properties: papx.properties, rawOffset: fkp.papxOffsets[i] ?? 0 });
    }
  }
  runs.sort((a, b) => a.cpStart - b.cpStart || a.cpEnd - b.cpEnd);
  return runs;
}

/** Word 2 CHPX(CHP 차분 구조)를 Word 6 경로와 같은 이름의 속성으로 바꾼다(LibreOffice ReadWord2Chpx와 같은 배치). */
function decodeWord2Chpx(bytes: Uint8Array): DecodedProperty[] {
  const out: DecodedProperty[] = [];
  const push = (name: string, value: unknown) => out.push({ kind: 'char', name, value, operandBytes: bytes });
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  const b2 = bytes[2] ?? 0;
  if (b0 & 0x01) push('bold', 1);
  if (b0 & 0x02) push('italic', 1);
  if (b0 & 0x04) push('revisionDeleted', true);
  if (b0 & 0x08) push('outline', 1);
  if (b0 & 0x20) push('smallCaps', 1);
  if (b0 & 0x40) push('caps', 1);
  if (b0 & 0x80) push('hidden', 1);
  if (b1 & 0x01) push('revisionInserted', true);
  if (b1 & 0x02) push('special', true);
  if (b1 & 0x04) push('strike', 1);
  if (b1 & 0x08) push('object', true);
  if (bytes.length >= 6 && (b2 & 0x02)) push('fontFamilyId', (bytes[4] ?? 0) | ((bytes[5] ?? 0) << 8));
  if (bytes.length >= 8 && (b2 & 0x04)) push('fontSizeHalfPoints', (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8));
  if (bytes.length >= 10 && (b2 & 0x01)) push('colorIndex', (bytes[9] ?? 0) & 0x1f);
  if (bytes.length >= 10 && (b2 & 0x08)) push('underline', ((bytes[9] ?? 0) >> 5) & 0x7);
  if (bytes.length >= 11 && (b2 & 0x10)) {
    const pos = bytes[10] ?? 0;
    push('positionHalfPoints', pos > 127 ? pos - 256 : pos);
  }
  if (bytes.length >= 14 && (b2 & 0x40)) push('lid', (bytes[12] ?? 0) | ((bytes[13] ?? 0) << 8));
  return out;
}

export function readChpxProperties(
  wordBytes: Uint8Array,
  offset: number | null | undefined,
  format: FkpFormat = WORD97_FORMAT,
): DecodedProperty[] {
  if (offset == null || offset < 0 || offset >= wordBytes.length) return [];
  const cb = wordBytes[offset] ?? 0;
  if (!cb) return [];
  const start = offset + 1;
  const end = Math.min(wordBytes.length, start + cb);
  if (format.version === 2) return decodeWord2Chpx(wordBytes.subarray(start, end));
  if (format.version === 6) return decodeGrpprl6(wordBytes, start, end, { version: 6, farEast: format.farEast });
  return decodeGrpprl(wordBytes, start, end);
}

function readHugePapxProperties(dataBytes: Uint8Array, offset: number): DecodedProperty[] {
  if (offset < 0 || offset + 2 > dataBytes.length) return [];
  const cb = (dataBytes[offset] ?? 0) | ((dataBytes[offset + 1] ?? 0) << 8);
  if (!cb || offset + 2 + cb > dataBytes.length) return [];
  return decodeGrpprl(dataBytes, offset + 2, offset + 2 + cb);
}

function expandHugePapxProperties(properties: DecodedProperty[], dataBytes?: Uint8Array): DecodedProperty[] {
  if (!dataBytes?.length) return properties;
  const expanded: DecodedProperty[] = [];
  for (const property of properties) {
    if (property.raw !== SprmCodes.sprmPHugePapx) {
      expanded.push(property);
      continue;
    }
    const operandBytes = property.operandBytes || (property.value instanceof Uint8Array ? property.value : null);
    if (!operandBytes || operandBytes.length < 4) {
      expanded.push(property);
      continue;
    }
    const hugeOffset = u32(operandBytes);
    const hugeProperties = readHugePapxProperties(dataBytes, hugeOffset);
    expanded.push(...(hugeProperties.length ? hugeProperties : [property]));
  }
  return expanded;
}

export function readPapxProperties(
  wordBytes: Uint8Array,
  offset: number | null | undefined,
  dataBytes?: Uint8Array,
  format: FkpFormat = WORD97_FORMAT,
): { styleId: number; properties: DecodedProperty[] } {
  if (offset == null || offset < 0 || offset >= wordBytes.length) return { styleId: 0, properties: [] };
  const reader = new BinaryReader(wordBytes);
  const cb = reader.u8(offset);
  if (format.version !== 8) {
    // Word 6/95: cw(1) + istd(2) + grpprl, 길이 = 2*cw. Word 2: cw(1) + stc(1) + PHE(6) + grpprl.
    const size = cb * 2;
    const bodyStart = offset + 1;
    if (format.version === 2) {
      if (size < 1) return { styleId: 0, properties: [] };
      const styleId = reader.u8(bodyStart);
      const propsStart = bodyStart + 7;
      const propsEnd = Math.min(wordBytes.length, bodyStart + size);
      return { styleId, properties: propsEnd > propsStart ? decodeGrpprl6(wordBytes, propsStart, propsEnd, { version: 2 }) : [] };
    }
    if (size < 2) return { styleId: 0, properties: [] };
    const styleId = reader.u16(bodyStart);
    const propsEnd = Math.min(wordBytes.length, bodyStart + size);
    return { styleId, properties: decodeGrpprl6(wordBytes, bodyStart + 2, propsEnd, { version: 6, farEast: format.farEast }) };
  }
  if (cb === 0 && !reader.ensure(offset + 1, 1)) return { styleId: 0, properties: [] };

  let bodyStart: number;
  let bodySize: number;
  if (cb === 0) {
    bodySize = reader.u8(offset + 1) * 2;
    bodyStart = offset + 2;
  } else {
    // PapxInFkp.cb counts 2-byte words; the payload occupies (2 * cb) - 1 bytes.
    bodySize = cb * 2 - 1;
    bodyStart = offset + 1;
  }
  if (bodySize < 2 || !reader.ensure(bodyStart, Math.max(2, bodySize))) {
    return { styleId: 0, properties: [] };
  }

  const styleId = reader.u16(bodyStart);
  const propsStart = bodyStart + 2;
  const propsEnd = Math.min(wordBytes.length, bodyStart + bodySize);
  const properties = expandHugePapxProperties(decodeGrpprl(wordBytes, propsStart, propsEnd), dataBytes);
  return { styleId, properties };
}
