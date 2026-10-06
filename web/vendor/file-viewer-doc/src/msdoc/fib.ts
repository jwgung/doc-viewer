import { BinaryReader } from '../core/binary.js';
import type { FibBase, FibFcLcbPair, FibRgFcLcb, FibRgLw, ParsedFib } from '../types.js';

const FIB_FC_LCB_NAMES = [
  'StshfOrig', 'Stshf', 'PlcffndRef', 'PlcffndTxt', 'PlcfandRef', 'PlcfandTxt',
  'PlcfSed', 'PlcPad', 'PlcfPhe', 'SttbfGlsy', 'PlcfGlsy', 'PlcfHdd', 'PlcfBteChpx',
  'PlcfBtePapx', 'PlcfSea', 'SttbfFfn', 'PlcfFldMom', 'PlcfFldHdr', 'PlcfFldFtn',
  'PlcfFldAtn', 'PlcfFldMcr', 'SttbfBkmk', 'PlcfBkf', 'PlcfBkl', 'Cmds', 'Unused1',
  'SttbfMcr', 'PrDrvr', 'PrEnvPort', 'PrEnvLand', 'Wss', 'Dop', 'SttbfAssoc', 'Clx',
  'PlcfPgdFtn', 'AutosaveSource', 'GrpXstAtnOwners', 'SttbfAtnBkmk', 'Unused2',
  'Unused3', 'PlcSpaMom', 'PlcSpaHdr', 'PlcfAtnBkf', 'PlcfAtnBkl', 'Pms',
  'FormFldSttbs', 'PlcfendRef', 'PlcfendTxt', 'PlcfFldEdn', 'Unused4', 'DggInfo',
  'SttbfRMark', 'SttbfCaption', 'SttbfAutoCaption', 'PlcfWkb', 'PlcfSpl',
  'PlcftxbxTxt', 'PlcfFldTxbx', 'PlcfHdrtxbxTxt', 'PlcffldHdrTxbx', 'StwUser',
  'SttbTtmbd', 'CookieData', 'PgdMotherOldOld', 'BkdMotherOldOld', 'PgdFtnOldOld',
  'BkdFtnOldOld', 'PgdEdnOldOld', 'BkdEdnOldOld', 'SttbfIntlFld', 'RouteSlip',
  'SttbSavedBy', 'SttbFnm', 'PlfLst', 'PlfLfo', 'PlcfTxbxBkd', 'PlcfTxbxHdrBkd',
  'DocUndoWord9', 'RgbUse', 'Usp', 'Uskf', 'PlcupcRgbUse', 'PlcupcUsp', 'SttbGlsyStyle',
  'Plgosl', 'Plcocx', 'PlcfBteLvc', 'dwLowDateTime', 'dwHighDateTime', 'PlcfLvcPre10',
  'PlcfAsumy', 'PlcfGram', 'SttbListNames', 'SttbfUssr',
] as const;

// doc-viewer: Word 6.0/95(nFib 101~105)와 Word 2.0(wIdent 0xA5DB)의 FIB는 크기가 고정된 구조다.
// 앞 38개 fc/lcb 쌍의 순서는 Word 97과 같고(0x58부터), 그 뒤는 버전마다 위치가 정해져 있다.
// 위치는 LibreOffice의 WW8Fib(sw/source/filter/ww8/ww8scan.cxx)와 실제 파일로 확인했다.
const LEGACY_PAIR_COUNT = 38;
const WORD6_EXTRA_PAIRS: Array<[number, string]> = [
  [0x192, 'PlcfdoaMom'], [0x19a, 'PlcfdoaHdr'], [0x1a2, 'PlcSpaMom'], [0x1aa, 'PlcSpaHdr'],
  [0x1b2, 'PlcfAtnBkf'], [0x1ba, 'PlcfAtnBkl'], [0x1c2, 'Pms'], [0x1ca, 'FormFldSttbs'],
  [0x1d2, 'PlcfendRef'], [0x1da, 'PlcfendTxt'], [0x1e2, 'PlcfFldEdn'], [0x1ea, 'PlcfpgdEdn'],
  [0x1f2, 'DggInfo'], [0x1fa, 'SttbfRMark'], [0x202, 'SttbfCaption'], [0x20a, 'SttbfAutoCaption'],
  [0x212, 'PlcfWkb'], [0x21a, 'PlcfSpl'], [0x222, 'PlcftxbxTxt'], [0x22a, 'PlcfFldTxbx'],
  [0x232, 'PlcfHdrtxbxTxt'], [0x23a, 'PlcffldHdrTxbx'], [0x242, 'StwUser'], [0x24a, 'SttbTtmbd'],
];

/** wIdent·nFib로 파일 형식 세대를 고른다. 8 = Word 97 이상, 6 = Word 6.0/95, 2 = Word 2.0/1.x */
export function detectWordVersion(wIdent: number, nFib: number): 2 | 6 | 8 {
  if (wIdent === 0xa5db || wIdent === 0xa59b || wIdent === 0xa59c) return 2;
  if (wIdent === 0xa5dc || (wIdent >= 0xa697 && wIdent <= 0xa699)) return nFib >= 106 && wIdent === 0xa5dc ? 8 : 6;
  if (nFib >= 101 && nFib <= 105) return 6;
  return 8;
}

/** Word 6.0/95·Word 2.0 FIB를 Word 97 FIB와 같은 이름의 필드로 읽는다. */
export function parseLegacyFib(wordBytes: Uint8Array, version: 2 | 6): ParsedFib {
  const reader = new BinaryReader(wordBytes);
  const base = parseFibBase(reader);
  const pairSize = version === 2 ? 6 : 8;
  const fields: FibRgFcLcb = { _pairs: [] };
  const pairs: FibFcLcbPair[] = [];
  for (let i = 0; i < LEGACY_PAIR_COUNT; i += 1) {
    const at = 0x58 + i * pairSize;
    if (!reader.ensure(at, pairSize)) break;
    const fc = reader.u32(at);
    const lcb = version === 2 ? reader.u16(at + 4) : reader.u32(at + 4);
    const name = FIB_FC_LCB_NAMES[i] || `Field${i}`;
    fields[`fc${name}`] = fc;
    fields[`lcb${name}`] = lcb;
    pairs.push({ name, fc, lcb, index: i });
  }
  if (version === 6) {
    for (const [at, name] of WORD6_EXTRA_PAIRS) {
      if (!reader.ensure(at, 8)) break;
      const fc = reader.u32(at);
      const lcb = reader.u32(at + 4);
      fields[`fc${name}`] = fc;
      fields[`lcb${name}`] = lcb;
      pairs.push({ name, fc, lcb, index: pairs.length });
    }
  }
  fields._pairs = pairs;
  const pnBase = version === 2 ? 0x58 + LEGACY_PAIR_COUNT * 6 + 2 : 0x18a;
  const lw = (at: number) => reader.i32(at);
  const fibRgLw: FibRgLw = {
    raw: [],
    cbMac: lw(0x20),
    ccpText: lw(0x34),
    ccpFtn: lw(0x38),
    ccpHdd: lw(0x3c),
    ccpMcr: lw(0x40),
    ccpAtn: lw(0x44),
    ccpEdn: lw(0x48),
    ccpTxbx: lw(0x4c),
    ccpHdrTxbx: lw(0x50),
  };
  return {
    base,
    csw: 0,
    cslw: 0,
    cbRgFcLcb: pairs.length,
    cswNew: 0,
    nFibNew: 0,
    fibRgWBytes: new Uint8Array(0),
    fibRgLwBytes: new Uint8Array(0),
    fibRgFcLcbBytes: new Uint8Array(0),
    fibRgCswNewBytes: new Uint8Array(0),
    fibRgLw,
    fibRgFcLcb: fields,
    version,
    fcMin: reader.i32(24),
    fcMac: reader.i32(28),
    chse: reader.u16(20),
    pnChpFirst: reader.u16(pnBase),
    pnPapFirst: reader.u16(pnBase + 2),
    cpnBteChp: reader.u16(pnBase + 4),
    cpnBtePap: reader.u16(pnBase + 6),
  };
}

export function parseFib(wordBytes: Uint8Array): ParsedFib {
  const reader = new BinaryReader(wordBytes);
  const base = parseFibBase(reader);
  const version = detectWordVersion(base.wIdent, base.nFib);
  if (version !== 8) return parseLegacyFib(wordBytes, version);
  let offset = 32;

  const csw = reader.u16(offset); offset += 2;
  const fibRgWBytes = reader.slice(offset, csw * 2); offset += csw * 2;
  const cslw = reader.u16(offset); offset += 2;
  const fibRgLwBytes = reader.slice(offset, cslw * 4); offset += cslw * 4;
  const cbRgFcLcb = reader.u16(offset); offset += 2;
  const fibRgFcLcbBytes = reader.slice(offset, cbRgFcLcb * 8); offset += cbRgFcLcb * 8;
  const cswNew = reader.ensure(offset, 2) ? reader.u16(offset) : 0;
  if (reader.ensure(offset, 2)) offset += 2;
  const fibRgCswNewBytes = cswNew ? reader.slice(offset, cswNew * 2) : new Uint8Array(0);

  const fibRgLw = parseFibRgLw(fibRgLwBytes);
  const fibRgFcLcb = parseFibRgFcLcb(fibRgFcLcbBytes, cbRgFcLcb);
  const nFibNew = cswNew ? new BinaryReader(fibRgCswNewBytes).u16(0) : 0;

  return {
    base,
    csw,
    cslw,
    cbRgFcLcb,
    cswNew,
    nFibNew,
    fibRgWBytes,
    fibRgLwBytes,
    fibRgFcLcbBytes,
    fibRgCswNewBytes,
    fibRgLw,
    fibRgFcLcb,
    version: 8,
    fcMin: reader.i32(24),
    fcMac: reader.i32(28),
    chse: reader.u16(20),
  };
}

export function parseFibBase(reader: BinaryReader): FibBase {
  const wIdent = reader.u16(0);
  const nFib = reader.u16(2);
  const lid = reader.u16(6);
  const pnNext = reader.u16(8);
  const flags = reader.u16(10);
  const envFlags = reader.u16(18);
  return {
    wIdent,
    nFib,
    lid,
    pnNext,
    flags,
    envFlags,
    fDot: Boolean(flags & 0x0001),
    fGlsy: Boolean(flags & 0x0002),
    fComplex: Boolean(flags & 0x0004),
    fHasPic: Boolean(flags & 0x0008),
    cQuickSaves: (flags >> 4) & 0x0f,
    fEncrypted: Boolean(flags & 0x0100),
    fWhichTblStm: flags & 0x0200 ? 1 : 0,
    fReadOnlyRecommended: Boolean(flags & 0x0400),
    fWriteReservation: Boolean(flags & 0x0800),
    fExtChar: Boolean(flags & 0x1000),
    fLoadOverride: Boolean(flags & 0x2000),
    fFarEast: Boolean(flags & 0x4000),
    fObfuscated: Boolean(flags & 0x8000),
    nFibBack: reader.u16(12),
    lKey: reader.u32(14),
    envr: reader.u8(18),
    fMac: Boolean(envFlags & 0x0001),
    fEmptySpecial: Boolean(envFlags & 0x0002),
    fLoadOverridePage: Boolean(envFlags & 0x0004),
  };
}

function parseFibRgLw(bytes: Uint8Array): FibRgLw {
  const reader = new BinaryReader(bytes);
  const dwords: number[] = [];
  for (let i = 0; i + 4 <= bytes.length; i += 4) dwords.push(reader.i32(i));
  return {
    raw: dwords,
    cbMac: dwords[0] ?? 0,
    ccpText: dwords[3] ?? 0,
    ccpFtn: dwords[4] ?? 0,
    ccpHdd: dwords[5] ?? 0,
    ccpMcr: dwords[6] ?? 0,
    ccpAtn: dwords[7] ?? 0,
    ccpEdn: dwords[8] ?? 0,
    ccpTxbx: dwords[9] ?? 0,
    ccpHdrTxbx: dwords[10] ?? 0,
  };
}

function parseFibRgFcLcb(bytes: Uint8Array, count: number): FibRgFcLcb {
  const reader = new BinaryReader(bytes);
  const fields: FibRgFcLcb = { _pairs: [] };
  const pairs: FibFcLcbPair[] = [];
  for (let i = 0; i < count && i * 8 + 8 <= bytes.length; i += 1) {
    const fc = reader.u32(i * 8);
    const lcb = reader.u32(i * 8 + 4);
    const name = FIB_FC_LCB_NAMES[i] || `Field${i}`;
    fields[`fc${name}`] = fc;
    fields[`lcb${name}`] = lcb;
    pairs.push({ name, fc, lcb, index: i });
  }
  fields._pairs = pairs;
  return fields;
}
