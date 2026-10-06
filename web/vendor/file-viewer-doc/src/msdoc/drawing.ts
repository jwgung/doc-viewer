// doc-viewer: 떠 있는 도형(글상자·그림)을 본문 고정 위치와 이어 준다(Word 97 이상).
//
// - PlcSpaMom/PlcSpaHdr: 본문·머리말 문서에서 도형이 고정된 CP(0x08 문자)와 FSPA(도형 번호 spid, 크기, 배치)
//   [MS-DOC] 2.8.? PlcfSpa, 2.9.? FSPA
// - OfficeArtContent(fcDggInfo): 도형 트리. 묶음 도형의 자식 spid → 최상위 spid, 그림 번호(pib), 채우기·선,
//   글상자 번호(lTxid) [MS-DOC] 2.11.? OfficeArtContent, [MS-ODRAW]
// - PlcftxbxTxt/PlcfHdrtxbxTxt: 글상자 이야기(story)의 CP 구간과 FTXBXS(lid = 글상자를 담은 도형 spid)
import { BinaryReader } from '../core/binary.js';
import { extractBlipRecordAsset, extractFbseImageAsset } from './objects.js';
import type { FibRgFcLcb, ImageAsset, MsDocParseOptions } from '../types.js';

export interface Fspa {
  cp: number;
  spid: number;
  xaLeft: number;
  yaTop: number;
  xaRight: number;
  yaBottom: number;
  wrap: number;
  belowText: boolean;
}

export interface ShapeProps {
  spid: number;
  shapeType: number;
  topSpid: number;
  pib?: number;
  txid?: number;
  fillColor?: number;
  filled?: boolean;
  lineColor?: number;
  line?: boolean;
  lineWidthEmu?: number;
  hidden?: boolean;
}

export interface TextboxRange {
  index: number;
  cpStart: number;
  cpEnd: number;
  spid: number;
  reusable: boolean;
}

export interface DrawingInfo {
  shapes: Map<number, ShapeProps>;
  /** 최상위 spid → 그 아래(자기 포함) 도형 spid 목록 */
  members: Map<number, number[]>;
  blips: Array<{ offset: number; recLen: number; delayOffset: number } | null>;
  dggBytes: Uint8Array;
}

function readPlc(tableBytes: Uint8Array, fc: number | undefined, lcb: number | undefined, structSize: number): { cps: number[]; data: Uint8Array; count: number } | null {
  if (fc == null || !lcb || lcb < 4 || fc + lcb > tableBytes.length) return null;
  const count = Math.floor((lcb - 4) / (4 + structSize));
  if (count <= 0) return null;
  const reader = new BinaryReader(tableBytes.subarray(fc, fc + lcb));
  const cps: number[] = [];
  for (let i = 0; i <= count; i += 1) cps.push(reader.i32(i * 4));
  return { cps, data: tableBytes.subarray(fc + (count + 1) * 4, fc + lcb), count };
}

export function readFspas(tableBytes: Uint8Array, fibRgFcLcb: FibRgFcLcb, header = false): Fspa[] {
  const plc = readPlc(
    tableBytes,
    fibRgFcLcb[header ? 'fcPlcSpaHdr' : 'fcPlcSpaMom'] as number | undefined,
    fibRgFcLcb[header ? 'lcbPlcSpaHdr' : 'lcbPlcSpaMom'] as number | undefined,
    26,
  );
  if (!plc) return [];
  const reader = new BinaryReader(plc.data);
  const out: Fspa[] = [];
  for (let i = 0; i < plc.count; i += 1) {
    const at = i * 26;
    const flags = reader.u16(at + 20);
    out.push({
      cp: plc.cps[i] ?? 0,
      spid: reader.u32(at),
      xaLeft: reader.i32(at + 4),
      yaTop: reader.i32(at + 8),
      xaRight: reader.i32(at + 12),
      yaBottom: reader.i32(at + 16),
      wrap: (flags >> 5) & 0x0f,
      belowText: Boolean(flags & 0x4000),
    });
  }
  return out;
}

export function readTextboxRanges(tableBytes: Uint8Array, fibRgFcLcb: FibRgFcLcb, storyStart: number, storyLength: number, header = false): TextboxRange[] {
  const plc = readPlc(
    tableBytes,
    fibRgFcLcb[header ? 'fcPlcfHdrtxbxTxt' : 'fcPlcftxbxTxt'] as number | undefined,
    fibRgFcLcb[header ? 'lcbPlcfHdrtxbxTxt' : 'lcbPlcftxbxTxt'] as number | undefined,
    22,
  );
  if (!plc) return [];
  const reader = new BinaryReader(plc.data);
  const out: TextboxRange[] = [];
  for (let i = 0; i < plc.count; i += 1) {
    const at = i * 22;
    const start = Math.max(0, plc.cps[i] ?? 0);
    const end = Math.min(storyLength, Math.max(start, plc.cps[i + 1] ?? start));
    out.push({
      index: i,
      cpStart: storyStart + start,
      cpEnd: storyStart + end,
      reusable: reader.u16(at + 8) !== 0,
      spid: reader.u32(at + 14),
    });
  }
  return out;
}

interface RecordHeader {
  recVer: number;
  recInstance: number;
  recType: number;
  recLen: number;
}

function header(bytes: Uint8Array, offset: number): RecordHeader | null {
  if (offset + 8 > bytes.length) return null;
  const verInst = (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
  const recType = (bytes[offset + 2] ?? 0) | ((bytes[offset + 3] ?? 0) << 8);
  const recLen = new BinaryReader(bytes).u32(offset + 4);
  if (recType < 0xf000 || offset + 8 + recLen > bytes.length) return null;
  return { recVer: verInst & 0xf, recInstance: verInst >> 4, recType, recLen };
}

function readFopt(bytes: Uint8Array, offset: number, h: RecordHeader, shape: ShapeProps): void {
  const reader = new BinaryReader(bytes);
  const count = h.recInstance;
  for (let i = 0; i < count; i += 1) {
    const at = offset + 8 + i * 6;
    if (at + 6 > offset + 8 + h.recLen) break;
    const opid = reader.u16(at);
    const value = reader.u32(at + 2);
    const pid = opid & 0x3fff;
    switch (pid) {
      case 0x0080: shape.txid = value; break;
      case 0x0104: shape.pib = value; break;
      case 0x0181: shape.fillColor = value; break;
      case 0x01bf:
        // 채우기 불 속성: fFilled(bit4)는 fUsefFilled(bit20)가 켜졌을 때만 뜻이 있다.
        if (value & (1 << 20)) shape.filled = Boolean(value & (1 << 4));
        break;
      case 0x01c0: shape.lineColor = value; break;
      case 0x01cb: shape.lineWidthEmu = value; break;
      case 0x01ff:
        if (value & (1 << 19)) shape.line = Boolean(value & (1 << 3));
        break;
      case 0x03bf:
        if (value & (1 << 17)) shape.hidden = Boolean(value & (1 << 1));
        break;
      default: break;
    }
  }
}

function readSpContainer(bytes: Uint8Array, start: number, end: number, topSpid: number | null): ShapeProps | null {
  let cursor = start;
  const shape: ShapeProps = { spid: 0, shapeType: 0, topSpid: topSpid ?? 0 };
  while (cursor + 8 <= end) {
    const h = header(bytes, cursor);
    if (!h) break;
    if (h.recType === 0xf00a && h.recLen >= 8) {
      shape.spid = new BinaryReader(bytes).u32(cursor + 8);
      shape.shapeType = h.recInstance;
    } else if (h.recType === 0xf00b || h.recType === 0xf121 || h.recType === 0xf122) {
      readFopt(bytes, cursor, h, shape);
    } else if (h.recType === 0xf00d && h.recLen >= 4 && shape.txid == null) {
      shape.txid = new BinaryReader(bytes).u32(cursor + 8);
    }
    cursor += 8 + h.recLen;
  }
  if (!shape.spid) return null;
  if (topSpid == null) shape.topSpid = shape.spid;
  return shape;
}

function walkGroup(bytes: Uint8Array, start: number, end: number, topSpid: number | null, out: DrawingInfo, depth: number): void {
  let cursor = start;
  let groupSpid = topSpid;
  let first = true;
  while (cursor + 8 <= end && depth < 32) {
    const h = header(bytes, cursor);
    if (!h) break;
    const bodyStart = cursor + 8;
    const bodyEnd = bodyStart + h.recLen;
    if (h.recType === 0xf004) {
      const shape = readSpContainer(bytes, bodyStart, bodyEnd, groupSpid);
      // 묶음(SpgrContainer)의 첫 SpContainer는 묶음 자신이다. 최상위 묶음이면 그 spid가 FSPA의 spid다.
      if (shape) {
        if (first && depth > 0 && groupSpid == null) {
          groupSpid = shape.spid;
          shape.topSpid = shape.spid;
        }
        out.shapes.set(shape.spid, shape);
        const top = shape.topSpid || shape.spid;
        const list = out.members.get(top) ?? [];
        list.push(shape.spid);
        out.members.set(top, list);
      }
    } else if (h.recType === 0xf003) {
      // 최상위(루트) 묶음 안의 묶음은 그 자체가 FSPA에 걸리는 도형이다.
      walkGroup(bytes, bodyStart, bodyEnd, depth === 0 ? null : groupSpid, out, depth + 1);
    }
    first = false;
    cursor = bodyEnd;
  }
}

/** OfficeArtContent에서 본문(dgglbl 0) 또는 머리말(1) 그림판의 도형 정보를 읽는다. */
export function readDrawing(tableBytes: Uint8Array, fibRgFcLcb: FibRgFcLcb, headerDrawing = false): DrawingInfo | null {
  const fc = fibRgFcLcb.fcDggInfo as number | undefined;
  const lcb = fibRgFcLcb.lcbDggInfo as number | undefined;
  if (fc == null || !lcb || fc + lcb > tableBytes.length) return null;
  const bytes = tableBytes.subarray(fc, fc + lcb);
  const info: DrawingInfo = { shapes: new Map(), members: new Map(), blips: [], dggBytes: bytes };
  const dgg = header(bytes, 0);
  if (!dgg || dgg.recType !== 0xf000) return null;
  // BStore: FBSE 목록(그림 번호 pib는 1부터)
  let cursor = 8;
  const dggEnd = 8 + dgg.recLen;
  while (cursor + 8 <= dggEnd) {
    const h = header(bytes, cursor);
    if (!h) break;
    if (h.recType === 0xf001) {
      let inner = cursor + 8;
      const innerEnd = inner + h.recLen;
      while (inner + 8 <= innerEnd) {
        const fh = header(bytes, inner);
        if (!fh) break;
        if (fh.recType === 0xf007) {
          info.blips.push({ offset: inner, recLen: fh.recLen, delayOffset: new BinaryReader(bytes).u32(inner + 8 + 28) });
        } else {
          info.blips.push(null);
        }
        inner += 8 + fh.recLen;
      }
    }
    cursor += 8 + h.recLen;
  }
  // 그림판 목록: dgglbl(1바이트) + OfficeArtDgContainer
  cursor = dggEnd;
  while (cursor + 9 <= bytes.length) {
    const label = bytes[cursor] ?? 0;
    const h = header(bytes, cursor + 1);
    if (!h || h.recType !== 0xf002) break;
    const bodyStart = cursor + 9;
    const bodyEnd = bodyStart + h.recLen;
    if ((label === 1) === headerDrawing) {
      let inner = bodyStart;
      while (inner + 8 <= bodyEnd) {
        const ih = header(bytes, inner);
        if (!ih) break;
        if (ih.recType === 0xf003) walkGroup(bytes, inner + 8, inner + 8 + ih.recLen, null, info, 0);
        inner += 8 + ih.recLen;
      }
    }
    cursor = bodyEnd;
  }
  return info;
}

/** pib(1부터)에 해당하는 그림을 꺼낸다. BLIP이 FBSE 안에 없으면 WordDocument 스트림의 foDelay 위치에 있다. */
export function extractShapeImage(
  drawing: DrawingInfo,
  pib: number,
  wordBytes: Uint8Array,
  options: MsDocParseOptions = {},
): ImageAsset | null {
  const blip = drawing.blips[pib - 1];
  if (!blip) return null;
  const embedded = extractFbseImageAsset(drawing.dggBytes, blip.offset);
  if (embedded && embedded.displayable !== false) return embedded;
  if (blip.delayOffset > 0 && blip.delayOffset < wordBytes.length) {
    const delayed = extractBlipRecordAsset(wordBytes, blip.delayOffset, options);
    if (delayed) return delayed;
  }
  return embedded;
}

export function colorRefToHex(value: number | undefined): string | undefined {
  if (value == null) return undefined;
  // 상위 바이트가 0이 아니면 팔레트·시스템 색 참조라 정확한 색을 알 수 없다.
  if ((value >>> 24) & 0xff) return undefined;
  const r = value & 0xff;
  const g = (value >>> 8) & 0xff;
  const b = (value >>> 16) & 0xff;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
