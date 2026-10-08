// doc-viewer: Word 6.0/95(그리고 Word 2.0)의 속성 변경 묶음(grpprl) 해석.
// Word 97 이후와 달리 sprm 번호가 1바이트이고 피연산자 길이를 번호마다 표로 정한다.
// 길이 표는 LibreOffice(sw/source/filter/ww8/ww8scan.cxx의 GetWW6SprmSearcher·GetWW2SprmSearcher)와 같게 맞췄다.
// 해석 결과는 Word 97 경로(sprm.ts)와 같은 이름의 속성으로 돌려줘서 이후 단계(스타일 병합·상태 변환·렌더링)를 같이 쓴다.
import type { BorderSpec, DecodedProperty, PropertyKind, ShadingSpec, TDefTableOperand } from '../types.js';

type OperandKind = 'fix' | 'var' | 'var2';

// [피연산자 길이, 종류]. var: 첫 바이트가 길이(cb), 전체 = 1 + cb + 길이. var2: 첫 2바이트가 길이+1.
const WORD6_SPRMS: Record<number, [number, OperandKind]> = {
  0: [0, 'fix'],
  2: [2, 'fix'], 3: [3, 'var'], 4: [1, 'fix'], 5: [1, 'fix'], 6: [1, 'fix'], 7: [1, 'fix'], 8: [1, 'fix'],
  9: [1, 'fix'], 10: [1, 'fix'], 11: [1, 'fix'], 12: [0, 'var'], 13: [1, 'fix'], 14: [1, 'fix'], 15: [0, 'var'],
  16: [2, 'fix'], 17: [2, 'fix'], 18: [2, 'fix'], 19: [2, 'fix'], 20: [4, 'fix'], 21: [2, 'fix'], 22: [2, 'fix'],
  23: [0, 'var'], 24: [1, 'fix'], 25: [1, 'fix'], 26: [2, 'fix'], 27: [2, 'fix'], 28: [2, 'fix'], 29: [1, 'fix'],
  30: [2, 'fix'], 31: [2, 'fix'], 32: [2, 'fix'], 33: [2, 'fix'], 34: [2, 'fix'], 35: [2, 'fix'], 36: [2, 'fix'],
  37: [1, 'fix'], 38: [2, 'fix'], 39: [2, 'fix'], 40: [2, 'fix'], 41: [2, 'fix'], 42: [2, 'fix'], 43: [2, 'fix'],
  44: [1, 'fix'], 45: [2, 'fix'], 46: [2, 'fix'], 47: [2, 'fix'], 48: [2, 'fix'], 49: [2, 'fix'], 50: [1, 'fix'],
  51: [1, 'fix'], 52: [0, 'fix'], 64: [0, 'var'],
  65: [1, 'fix'], 66: [1, 'fix'], 67: [1, 'fix'], 68: [0, 'var'], 69: [2, 'fix'], 70: [4, 'fix'], 71: [1, 'fix'],
  72: [2, 'fix'], 73: [3, 'fix'], 74: [0, 'var'], 75: [1, 'fix'], 77: [0, 'var'], 79: [0, 'var'], 80: [2, 'fix'],
  81: [0, 'var'], 82: [0, 'var'], 83: [0, 'fix'], 85: [1, 'fix'], 86: [1, 'fix'], 87: [1, 'fix'], 88: [1, 'fix'],
  89: [1, 'fix'], 90: [1, 'fix'], 91: [1, 'fix'], 92: [1, 'fix'], 93: [2, 'fix'], 94: [1, 'fix'], 95: [3, 'fix'],
  96: [2, 'fix'], 97: [2, 'fix'], 98: [1, 'fix'], 99: [2, 'fix'], 100: [1, 'fix'], 101: [2, 'fix'], 102: [1, 'fix'],
  103: [0, 'var'], 104: [1, 'fix'], 105: [0, 'var'], 106: [0, 'var'], 107: [2, 'fix'], 108: [0, 'var'],
  109: [2, 'fix'], 110: [2, 'fix'], 111: [0, 'var'], 112: [0, 'var'], 113: [0, 'var'], 114: [0, 'var'],
  115: [0, 'var'], 116: [0, 'var'], 117: [1, 'fix'], 118: [1, 'fix'], 119: [1, 'fix'], 120: [12, 'var'],
  121: [2, 'fix'], 122: [2, 'fix'], 123: [2, 'fix'], 124: [2, 'fix'],
  131: [1, 'fix'], 132: [1, 'fix'], 133: [0, 'var'], 136: [3, 'fix'], 137: [3, 'fix'], 138: [1, 'fix'],
  139: [1, 'fix'], 140: [2, 'fix'], 141: [2, 'fix'], 142: [1, 'fix'], 143: [1, 'fix'], 144: [2, 'fix'],
  145: [2, 'fix'], 146: [1, 'fix'], 147: [1, 'fix'], 148: [2, 'fix'], 149: [2, 'fix'], 150: [1, 'fix'],
  151: [1, 'fix'], 152: [1, 'fix'], 153: [1, 'fix'], 154: [2, 'fix'], 155: [2, 'fix'], 156: [2, 'fix'],
  157: [2, 'fix'], 158: [1, 'fix'], 159: [1, 'fix'], 160: [2, 'fix'], 161: [2, 'fix'], 162: [1, 'fix'],
  163: [0, 'fix'], 164: [2, 'fix'], 165: [2, 'fix'], 166: [2, 'fix'], 167: [2, 'fix'], 168: [2, 'fix'],
  169: [2, 'fix'], 170: [2, 'fix'], 171: [2, 'fix'], 179: [0, 'var'], 181: [0, 'var'],
  182: [2, 'fix'], 183: [2, 'fix'], 184: [2, 'fix'], 185: [1, 'fix'], 186: [1, 'fix'], 187: [12, 'fix'],
  188: [0, 'var2'], 189: [2, 'fix'], 190: [0, 'var2'], 191: [1, 'var'], 192: [4, 'fix'], 193: [5, 'fix'],
  194: [4, 'fix'], 195: [2, 'fix'], 196: [4, 'fix'], 197: [2, 'fix'], 198: [2, 'fix'], 199: [5, 'fix'],
  200: [4, 'fix'], 207: [0, 'var'],
};

// Word 2.0의 번호 체계는 또 다르다(문자 속성이 53번부터). 본문과 기본 서식에 필요한 것만 이름을 붙인다.
const WORD2_SPRMS: Record<number, [number, OperandKind]> = {
  0: [0, 'fix'], 2: [1, 'fix'], 3: [0, 'var'], 4: [1, 'fix'], 5: [1, 'fix'], 6: [1, 'fix'], 7: [1, 'fix'],
  8: [1, 'fix'], 9: [1, 'fix'], 10: [1, 'fix'], 11: [1, 'fix'], 12: [1, 'fix'], 13: [1, 'fix'], 14: [1, 'fix'],
  15: [0, 'var'], 16: [2, 'fix'], 17: [2, 'fix'], 18: [2, 'fix'], 19: [2, 'fix'], 20: [2, 'fix'], 21: [2, 'fix'],
  22: [2, 'fix'], 23: [0, 'var'], 24: [1, 'fix'], 25: [1, 'fix'], 26: [2, 'fix'], 27: [2, 'fix'], 28: [2, 'fix'],
  29: [1, 'fix'], 30: [2, 'fix'], 31: [2, 'fix'], 32: [2, 'fix'], 33: [2, 'fix'], 34: [2, 'fix'], 35: [2, 'fix'],
  36: [2, 'fix'], 37: [1, 'fix'], 38: [2, 'fix'], 39: [2, 'fix'], 40: [2, 'fix'], 41: [2, 'fix'], 42: [2, 'fix'],
  43: [2, 'fix'], 44: [1, 'fix'], 45: [2, 'fix'], 46: [2, 'fix'], 47: [2, 'fix'], 48: [2, 'fix'], 49: [2, 'fix'],
  50: [1, 'fix'], 51: [1, 'fix'], 52: [0, 'fix'], 53: [1, 'fix'], 54: [1, 'fix'], 55: [1, 'fix'], 57: [0, 'var'],
  58: [0, 'fix'], 60: [1, 'fix'], 61: [1, 'fix'], 62: [1, 'fix'], 63: [1, 'fix'], 64: [1, 'fix'], 65: [1, 'fix'],
  66: [1, 'fix'], 67: [1, 'fix'], 68: [2, 'fix'], 69: [1, 'fix'], 70: [3, 'fix'], 71: [2, 'fix'], 72: [2, 'fix'],
  73: [1, 'fix'], 74: [1, 'fix'], 75: [1, 'fix'], 76: [1, 'fix'], 77: [1, 'fix'], 78: [0, 'var'], 80: [1, 'fix'],
  81: [1, 'fix'], 82: [2, 'fix'], 83: [2, 'fix'], 84: [1, 'fix'], 85: [1, 'fix'], 86: [1, 'fix'], 87: [1, 'fix'],
  94: [1, 'fix'], 95: [12, 'var'], 96: [2, 'fix'], 97: [2, 'fix'], 98: [2, 'fix'], 99: [2, 'fix'],
  112: [1, 'fix'], 114: [1, 'fix'], 115: [2, 'fix'], 116: [2, 'fix'], 117: [1, 'fix'], 118: [1, 'fix'],
  119: [2, 'fix'], 120: [2, 'fix'], 121: [1, 'fix'], 122: [1, 'fix'], 123: [2, 'fix'], 124: [2, 'fix'],
  125: [1, 'fix'], 126: [1, 'fix'], 127: [1, 'fix'], 128: [1, 'fix'], 129: [2, 'fix'], 130: [2, 'fix'],
  131: [2, 'fix'], 132: [2, 'fix'], 133: [1, 'fix'], 134: [1, 'fix'], 135: [2, 'fix'], 136: [2, 'fix'],
  137: [1, 'fix'], 138: [1, 'fix'], 139: [2, 'fix'], 140: [2, 'fix'], 141: [2, 'fix'], 142: [2, 'fix'],
  143: [2, 'fix'], 144: [2, 'fix'], 145: [2, 'fix'], 146: [2, 'fix'], 147: [2, 'fix'], 148: [2, 'fix'],
  149: [1, 'fix'], 152: [0, 'var2'], 153: [2, 'fix'], 154: [0, 'var2'], 155: [1, 'var'], 157: [5, 'fix'],
  158: [4, 'fix'], 159: [2, 'fix'], 160: [4, 'fix'], 161: [2, 'fix'], 162: [2, 'fix'], 163: [5, 'fix'],
  164: [4, 'fix'],
};

// Word 2.0 번호 → 같은 뜻의 Word 6 번호(해석 함수를 같이 쓰려고).
const WORD2_TO_WORD6: Record<number, number> = {
  2: 2, 5: 5, 7: 7, 8: 8, 9: 9, 16: 16, 17: 17, 18: 18, 19: 19, 21: 21, 22: 22, 24: 24, 25: 25,
  53: 65, 54: 66, 55: 67, 58: 83, 60: 85, 61: 86, 62: 87, 63: 88, 64: 89, 65: 90, 66: 91, 67: 92, 68: 93,
  69: 94, 71: 96, 72: 97, 73: 98, 117: 142, 118: 143, 122: 147, 125: 150, 128: 153, 131: 156, 132: 157, 136: 161,
  139: 164, 140: 165, 141: 166, 142: 167, 143: 168, 144: 169,
  146: 182, 147: 183, 148: 184, 153: 189,
};

function u16(bytes: Uint8Array, offset = 0): number {
  if (offset + 2 > bytes.length) return 0;
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function i16(bytes: Uint8Array, offset = 0): number {
  const value = u16(bytes, offset);
  return value > 0x7fff ? value - 0x10000 : value;
}

function u32(bytes: Uint8Array, offset = 0): number {
  if (offset + 4 > bytes.length) return 0;
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)
    | (((bytes[offset + 3] ?? 0) << 24) >>> 0)) >>> 0;
}

/** Word 6 BRC(2바이트): dxpLineWidth:3, brcType:2, fShadow:1, ico:5, dxpSpace:5 */
export function parseBrc6(bytes: Uint8Array, offset = 0): BorderSpec | null {
  if (offset + 2 > bytes.length) return null;
  const raw = u16(bytes, offset);
  if (raw === 0) return {};
  if (raw === 0xffff) return { raw, nil: true };
  const width = raw & 0x7;
  const type = (raw >> 3) & 0x3;
  // dxpLineWidth 6·7은 점선·파선이다. 두께는 0.75pt 단위라 Word 97의 1/8pt 단위로 바꾼다.
  const borderType = width === 6 ? 6 : width === 7 ? 7 : type === 3 ? 3 : type ? 1 : 0;
  return {
    raw,
    borderType,
    lineWidth: (width >= 6 ? 1 : width || 1) * 6 * (type === 2 ? 2 : 1),
    color: (raw >> 6) & 0x1f,
    space: (raw >> 11) & 0x1f,
    shadow: Boolean(raw & 0x20),
  };
}

function parseShd6(bytes: Uint8Array, offset = 0): ShadingSpec | null {
  if (offset + 2 > bytes.length) return null;
  const raw = u16(bytes, offset);
  const pattern = (raw >>> 10) & 0x3f;
  return {
    foregroundColorIndex: raw & 0x1f,
    backgroundColorIndex: (raw >>> 5) & 0x1f,
    pattern,
    auto: pattern === 0,
    nil: raw === 0xffff,
    legacy: true,
  };
}

/** Word 6 sprmTDefTable: cb(2) itcMac(1) rgdxaCenter[itcMac+1](2) rgtc[itcMac](TC 10바이트) */
function parseTDefTable6(bytes: Uint8Array): TDefTableOperand | null {
  if (bytes.length < 3) return null;
  const numberOfColumns = bytes[2] ?? 0;
  let offset = 3;
  const rgdxaCenter: number[] = [];
  for (let i = 0; i < numberOfColumns + 1 && offset + 2 <= bytes.length; i += 1) {
    rgdxaCenter.push(i16(bytes, offset));
    offset += 2;
  }
  const cells: TDefTableOperand['cells'] = [];
  for (let i = 0; i < numberOfColumns && offset + 10 <= bytes.length; i += 1) {
    const rgf = u16(bytes, offset);
    cells.push({
      tcgrf: { horzMerge: rgf & 0x1 ? 2 : rgf & 0x2 ? 1 : 0 },
      wWidth: (rgdxaCenter[i + 1] ?? 0) - (rgdxaCenter[i] ?? 0),
      borders: {
        top: parseBrc6(bytes, offset + 2) || {},
        left: parseBrc6(bytes, offset + 4) || {},
        bottom: parseBrc6(bytes, offset + 6) || {},
        right: parseBrc6(bytes, offset + 8) || {},
      },
    });
    offset += 10;
  }
  return { cb: u16(bytes, 0), numberOfColumns, rgdxaCenter, cells } as TDefTableOperand;
}

function meta<T>(kind: PropertyKind, name: string, value: T, raw: number, bytes: Uint8Array): DecodedProperty<T> {
  return { kind, name, value, raw, operandBytes: bytes };
}

/** Word 6 sprm 하나를 Word 97 경로와 같은 이름의 속성으로 바꾼다. 쓰지 않는 sprm은 null. */
function decodeSprm6(sprm: number, bytes: Uint8Array, version: 2 | 6): DecodedProperty | null {
  const b = bytes[0] ?? 0;
  const bool = Boolean(b);
  switch (sprm) {
    case 2: return meta('para', 'styleId', version === 2 ? b : u16(bytes), sprm, bytes);
    case 5: return meta('para', 'alignment', b, sprm, bytes);
    case 7: return meta('para', 'keepLines', bool, sprm, bytes);
    case 8: return meta('para', 'keepNext', bool, sprm, bytes);
    case 9: return meta('para', 'pageBreakBefore', bool, sprm, bytes);
    case 12: return meta('para', 'anld', bytes.subarray(1), sprm, bytes);
    case 13: return meta('para', 'anmLevel', b, sprm, bytes);
    case 16: return meta('para', 'rightIndent', i16(bytes), sprm, bytes);
    case 17: return meta('para', 'leftIndent', i16(bytes), sprm, bytes);
    case 19: return meta('para', 'firstLineIndent', i16(bytes), sprm, bytes);
    case 20: return meta('para', 'lineSpacing', i16(bytes), sprm, version === 2 ? new Uint8Array([bytes[0] ?? 0, bytes[1] ?? 0, 1, 0]) : bytes);
    case 21: return meta('para', 'spacingBefore', i16(bytes), sprm, bytes);
    case 22: return meta('para', 'spacingAfter', i16(bytes), sprm, bytes);
    case 24: return meta('para', 'inTable', bool, sprm, bytes);
    case 25: return meta('para', 'tableRowEnd', bool, sprm, bytes);
    case 26: return meta('para', 'frameLeft', i16(bytes), sprm, bytes);
    case 27: return meta('para', 'frameTop', i16(bytes), sprm, bytes);
    case 28: return meta('para', 'frameWidth', i16(bytes), sprm, bytes);
    case 29: return meta('para', 'framePosition', b, sprm, bytes);
    case 37: return meta('para', 'frameWrap', b, sprm, bytes);
    case 38: return meta('para', 'borderTop', parseBrc6(bytes), sprm, bytes);
    case 39: return meta('para', 'borderLeft', parseBrc6(bytes), sprm, bytes);
    case 40: return meta('para', 'borderBottom', parseBrc6(bytes), sprm, bytes);
    case 41: return meta('para', 'borderRight', parseBrc6(bytes), sprm, bytes);
    case 42: return meta('para', 'borderBetween', parseBrc6(bytes), sprm, bytes);
    case 45: return meta('para', 'frameHeight', i16(bytes), sprm, bytes);
    case 47: return meta('para', 'shading', bytes.slice(), sprm, bytes);
    case 51: return meta('para', 'widowControl', bool, sprm, bytes);
    case 65: return meta('char', 'revisionDeleted', bool, sprm, bytes);
    case 66: return meta('char', 'revisionInserted', bool, sprm, bytes);
    case 67: return meta('char', 'fieldVanish', bool, sprm, bytes);
    // sprmCPicLocation: 길이 바이트 뒤 4바이트가 Data(Word 6은 WordDocument) 스트림의 그림 위치다.
    case 68: return meta('char', 'pictureOffset', u32(bytes, 1), sprm, bytes);
    case 71: return meta('char', 'data', bool, sprm, bytes);
    case 73: return meta('char', 'chse', { diff: bool, charset: u16(bytes, 1) }, sprm, bytes);
    case 74: return meta('char', 'symbol', { font: u16(bytes, 1), charCode: bytes[3] ?? 0 }, sprm, bytes);
    case 75: return meta('char', 'ole2', bool, sprm, bytes);
    case 80: return meta('char', 'charStyleId', u16(bytes), sprm, bytes);
    case 83: return meta('char', 'plain', true, sprm, bytes);
    case 85: return meta('char', 'bold', b, sprm, bytes);
    case 86: return meta('char', 'italic', b, sprm, bytes);
    case 87: return meta('char', 'strike', b, sprm, bytes);
    case 88: return meta('char', 'outline', b, sprm, bytes);
    case 89: return meta('char', 'shadow', b, sprm, bytes);
    case 90: return meta('char', 'smallCaps', b, sprm, bytes);
    case 91: return meta('char', 'caps', b, sprm, bytes);
    case 92: return meta('char', 'hidden', b, sprm, bytes);
    case 93: return meta('char', 'fontFamilyId', u16(bytes), sprm, bytes);
    case 94: return meta('char', 'underline', b, sprm, bytes);
    case 95: return meta('char', 'sizePos', { hps: bytes[0] ?? 0, hpsPos: bytes[2] ?? 0 }, sprm, bytes);
    case 96: return meta('char', 'spacing', i16(bytes), sprm, bytes);
    case 97: return meta('char', 'lid', u16(bytes), sprm, bytes);
    case 98: return meta('char', 'colorIndex', b & 0x1f, sprm, bytes);
    case 99: return meta('char', 'fontSizeHalfPoints', version === 2 ? b : u16(bytes), sprm, bytes);
    case 101: return meta('char', 'positionHalfPoints', version === 2 ? (b > 127 ? b - 256 : b) : i16(bytes), sprm, bytes);
    case 104: return meta('char', 'iss', b, sprm, bytes);
    case 111: case 112: case 113:
      // Word 95 동아시아판(wIdent 0xA697~0xA699)은 111~113을 글꼴 번호(2바이트)로 쓴다.
      return bytes.length >= 2
        ? meta('char', sprm === 112 ? 'fontFamilyEastAsiaId' : sprm === 113 ? 'fontFamilyBiId' : 'fontFamilyId', u16(bytes), sprm, bytes)
        : null;
    case 117: return meta('char', 'special', bool, sprm, bytes);
    case 118: return meta('char', 'object', bool, sprm, bytes);
    case 131: return meta('section', 'cnsPgn', b, sprm, bytes);
    case 142: return meta('section', 'breakType', b, sprm, bytes);
    case 143: return meta('section', 'titlePage', bool, sprm, bytes);
    case 144: return meta('section', 'columns', u16(bytes) + 1, sprm, bytes);
    case 147: return meta('section', 'pageNumberFormat', b, sprm, bytes);
    case 150: return meta('section', 'pageNumberRestart', bool, sprm, bytes);
    case 153: return meta('section', 'headerFlags', b, sprm, bytes);
    case 156: return meta('section', 'headerTop', u16(bytes), sprm, bytes);
    case 157: return meta('section', 'footerBottom', u16(bytes), sprm, bytes);
    case 161: return meta('section', 'pageNumberStart', u16(bytes), sprm, bytes);
    case 162: return meta('section', 'orientation', b, sprm, bytes);
    case 164: return meta('section', 'pageWidth', u16(bytes), sprm, bytes);
    case 165: return meta('section', 'pageHeight', u16(bytes), sprm, bytes);
    case 166: return meta('section', 'marginLeft', u16(bytes), sprm, bytes);
    case 167: return meta('section', 'marginRight', u16(bytes), sprm, bytes);
    case 168: return meta('section', 'marginTop', i16(bytes), sprm, bytes);
    case 169: return meta('section', 'marginBottom', i16(bytes), sprm, bytes);
    case 182: return meta('table', 'alignment', u16(bytes), sprm, bytes);
    case 183: return meta('table', 'leftIndent', i16(bytes), sprm, bytes);
    case 184: return meta('table', 'gapHalf', u16(bytes), sprm, bytes);
    case 185: return meta('table', 'cantSplit', bool, sprm, bytes);
    case 186: return meta('table', 'header', bool, sprm, bytes);
    case 187: {
      const borders: Record<string, BorderSpec> = {};
      ['top', 'left', 'bottom', 'right', 'horizontalInside', 'verticalInside'].forEach((name, index) => {
        const border = parseBrc6(bytes, index * 2);
        if (border) borders[name] = border;
      });
      return meta('table', 'tableBorders', borders, sprm, bytes);
    }
    case 189: return meta('table', 'rowHeight', i16(bytes), sprm, bytes);
    case 188:
    case 190: return meta('table', 'defTable', parseTDefTable6(bytes), sprm, bytes);
    case 197: return meta('table', 'merge', { first: bytes[0] ?? 0, lim: bytes[1] ?? 0 }, sprm, bytes);
    case 198: return meta('table', 'split', { first: bytes[0] ?? 0, lim: bytes[1] ?? 0 }, sprm, bytes);
    case 200: return meta('table', 'setShading', {
      range: { first: bytes[0] ?? 0, lim: bytes[1] ?? 0 },
      shading: parseShd6(bytes, 2),
    }, sprm, bytes);
    default: return null;
  }
}

export interface Sprm6Options {
  version: 2 | 6;
  /** Word 95 동아시아판(wIdent 0xA697~0xA699): 111~113이 2바이트 고정 길이 */
  farEast?: boolean;
}

/** Word 6/95·Word 2 grpprl을 해석한다. 길이를 모르는 sprm을 만나면 거기서 멈춘다. */
export function decodeGrpprl6(
  buffer: Uint8Array,
  startOffset: number,
  endOffset: number,
  options: Sprm6Options = { version: 6 },
): DecodedProperty[] {
  const table = options.version === 2 ? WORD2_SPRMS : WORD6_SPRMS;
  const properties: DecodedProperty[] = [];
  let offset = startOffset;
  const end = Math.min(endOffset, buffer.length);
  while (offset + 1 <= end) {
    const sprm = buffer[offset] ?? 0;
    offset += 1;
    let info = table[sprm] ?? [0, 'var' as OperandKind];
    if (options.farEast && options.version === 6 && sprm >= 111 && sprm <= 113) info = [2, 'fix'];
    const [len, kind] = info;
    let operandLength: number;
    if (kind === 'fix') operandLength = len;
    else if (kind === 'var') {
      if (sprm === 23 && options.version === 6 && (buffer[offset] ?? 0) === 255) {
        // sprmPChgTabs의 특수형: 삭제 탭 수와 추가 탭 수로 길이가 정해진다.
        const del = buffer[offset + 1] ?? 0;
        const ins = buffer[offset + 2 + 4 * del] ?? 0;
        operandLength = 2 + 4 * del + 3 * ins;
      } else {
        operandLength = 1 + (buffer[offset] ?? 0) + len;
      }
    } else {
      const count = u16(buffer, offset);
      operandLength = 2 + Math.max(0, count - 1) + len;
    }
    if (offset + operandLength > end) break;
    const bytes = buffer.subarray(offset, offset + operandLength);
    offset += operandLength;
    const effective = options.version === 2 ? WORD2_TO_WORD6[sprm] : sprm;
    if (effective == null) continue;
    const decoded = decodeSprm6(effective, bytes, options.version);
    if (decoded) properties.push(decoded);
  }
  return properties;
}
