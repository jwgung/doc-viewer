import type { Effects, Fill, Stroke } from '../types';
import { inflateSync, unzlibSync } from 'fflate';
import { ESCHER, Rec, records, utf16 } from './records';

/**
 * [MS-ODRAW] OfficeArt（Escher）形状属性解析。
 * 属性表 OfficeArtFOPT 是一串 6 字节条目：u16(id|flags) + u32(value)，
 * 复杂属性（fComplex）的实际数据按顺序追加在属性数组之后。
 */

export interface EscherProps {
  simple: Map<number, number>;
  complex: Map<number, { start: number; len: number }>;
}

export function parseOpt(dv: DataView, rec: Rec): EscherProps {
  const simple = new Map<number, number>();
  const complex = new Map<number, { start: number; len: number }>();
  const count = rec.instance;
  let off = rec.start;
  const arrayEnd = rec.start + Math.min(count * 6, rec.len);
  const pending: { id: number; len: number }[] = [];

  for (let i = 0; i < count && off + 6 <= rec.start + rec.len; i++, off += 6) {
    const raw = dv.getUint16(off, true);
    const id = raw & 0x3fff;
    const isComplex = (raw & 0x8000) !== 0;
    const value = dv.getUint32(off + 2, true);
    if (isComplex) pending.push({ id, len: value });
    else simple.set(id, value);
  }

  let dataOff = arrayEnd;
  const end = rec.start + rec.len;
  for (const p of pending) {
    let len = p.len;
    // [doc-viewer] 배열 속성(IMsoArray)은 길이 값에 6바이트 머리(개수·예약·원소 크기)를 빼고 적은 파일이 많다.
    // 원소 수 × 원소 크기가 길이와 정확히 같으면 머리만큼 더한다(Apache POI EscherArrayProperty와 같은 규칙).
    // 이것을 놓치면 뒤따르는 복합 속성 위치가 6바이트씩 밀려 자유형 도형이 깨진 조각으로 그려진다.
    if (ARRAY_PROPS.has(p.id) && len > 0 && dataOff + 6 <= end) {
      const n = dv.getUint16(dataOff, true);
      if (n * arrayElementSize(dv.getInt16(dataOff + 4, true)) === len) len += 6;
    }
    if (dataOff + len > end) break;
    complex.set(p.id, { start: dataOff, len });
    dataOff += len;
  }
  return { simple, complex };
}

/**
 * [doc-viewer] 마스터 도형(hspMaster)의 속성을 아직 없는 것만 물려받는다.
 * 불리언 묶음 속성(id 끝 6비트가 0x3F)은 위 16비트가 '이 비트를 정했음' 표시라 비트마다 합친다.
 * 슬라이드의 자리표시자는 글 상자 세로 정렬·여백·채우기를 대개 마스터 자리표시자에서 물려받는다.
 */
export function inheritProps(own: EscherProps, master: EscherProps): void {
  for (const [id, value] of master.simple) {
    // 도형마다 고유한 것(글 id·그림·이름·마스터 참조)은 물려받지 않는다
    if (NOT_INHERITED.has(id)) continue;
    const mine = own.simple.get(id);
    if (mine === undefined) {
      own.simple.set(id, value);
    } else if ((id & 0x3f) === 0x3f) {
      const ownUse = mine >>> 16;
      const masterUse = value >>> 16;
      const val = (mine & ownUse) | (value & masterUse & ~ownUse);
      own.simple.set(id, (((ownUse | masterUse) << 16) | (val & 0xffff)) >>> 0);
    }
  }
  for (const [id, data] of master.complex) if (!own.complex.has(id) && !NOT_INHERITED.has(id)) own.complex.set(id, data);
}

const NOT_INHERITED = new Set([128, 260, 261, 262, 769, 896, 897]);

/** [doc-viewer] 배열(IMsoArray) 꼴 복합 속성: 꼭짓점·구간·조절 손잡이·안내선·글상자 영역·연결점, 그라데이션 색, 점선, 감싸기 다각형, 표 행 */
const ARRAY_PROPS = new Set([325, 326, 337, 338, 341, 342, 343, 407, 463, 899, 928]);

/** [doc-viewer] IMsoArray 원소 크기. 0xFFF0(−16)은 8바이트 원소를 아래 4바이트만 적은 꼴이라 4바이트 */
export function arrayElementSize(raw: number): number {
  if (raw === -16) return 4;
  return raw < 0 ? (-raw) >> 2 : raw;
}

/** OfficeArt 属性 id（仅列出用到的） */
export const P = {
  rotation: 4,
  tableProperties: 927,
  tableRowProperties: 928,
  lTxid: 128,
  dxTextLeft: 129,
  dyTextTop: 130,
  dxTextRight: 131,
  dyTextBottom: 132,
  /** [doc-viewer] 글 줄바꿈: 2 = 줄바꿈 없음 */
  wrapText: 133,
  anchorText: 135,
  /** [doc-viewer] 이 도형이 속성을 물려받는 마스터 도형의 shape id */
  hspMaster: 769,
  txflTextFlow: 136,
  pib: 260,
  pibName: 261,
  geoLeft: 320,
  geoTop: 321,
  geoRight: 322,
  geoBottom: 323,
  shapePath: 324,
  pVertices: 325,
  pSegmentInfo: 326,
  adjustValue: 327,
  adjust2Value: 328,
  adjust3Value: 329,
  adjust4Value: 330,
  fillType: 384,
  fillColor: 385,
  fillOpacity: 386,
  fillBackColor: 387,
  /** [doc-viewer] 그라데이션 관련: 끝색 불투명도, 각도(16.16 고정소수 도), 초점(-100~100), 가운데 사각형 위치 */
  fillBackOpacity: 388,
  fillBlip: 390,
  fillAngle: 395,
  fillFocus: 396,
  fillToRight: 399,
  fillToBottom: 400,
  fillStyleBooleans: 447,
  lineColor: 448,
  lineOpacity: 449,
  /** [doc-viewer] fSysIndex 0xF6(선 배경색)이 가리키는 값 */
  lineBackColor: 450,
  lineWidth: 459,
  lineDashing: 462,
  lineStartArrow: 464,
  lineEndArrow: 465,
  lineStyleBooleans: 511,
  shadowType: 512,
  shadowColor: 513,
  shadowOpacity: 516,
  shadowOffsetX: 517,
  shadowOffsetY: 518,
  shadowStyleBooleans: 575,
  groupShapeBooleans: 959,
} as const;

/** 属性值是 32 位有符号量时的还原（属性表统一按无符号读出） */
const signed = (v: number): number => (v > 0x7fffffff ? v - 0x100000000 : v);

/** PPT 配色方案：8 个 RGB */
export type Scheme = string[];

/**
 * [doc-viewer] fSysIndex 색이 가리키는 같은 도형의 다른 색(0xF0 채우기색 … 0xF7)의 원시 값.
 * 없으면 undefined를 돌려주고 기본값(채우기 흰색·선 검정)을 쓴다.
 */
export type ColorRef = (source: number) => number | undefined;

/** [doc-viewer] 도형 속성표로 fSysIndex 참조를 푼다(LibreOffice MSO_CLR_ToColor와 같은 대응) */
export function propColorRef(props: EscherProps): ColorRef {
  const s = props.simple;
  return (source) => {
    switch (source) {
      case 0xf0: case 0xf4: case 0xf7: case 0xff: return s.get(P.fillColor) ?? 0xffffff;
      case 0xf1: return (s.get(P.lineStyleBooleans) ?? 0) & 0x8 ? s.get(P.lineColor) ?? 0 : s.get(P.fillColor) ?? 0xffffff;
      case 0xf2: return s.get(P.lineColor) ?? 0;
      case 0xf3: return s.get(P.shadowColor) ?? 0x808080;
      case 0xf5: return s.get(P.fillBackColor) ?? 0xffffff;
      case 0xf6: return s.get(P.lineBackColor) ?? 0xffffff;
      default: return undefined;
    }
  };
}

/** [doc-viewer] Windows 시스템 색(fSysIndex 0x00~0x18) 기본값 */
const SYS_COLORS: Record<number, number> = {
  0: 0xc8c8c8, 1: 0x000000, 2: 0x99b4d1, 3: 0xbfcddb, 4: 0xf0f0f0, 5: 0xffffff, 6: 0x646464, 7: 0x000000,
  8: 0x000000, 9: 0x000000, 10: 0xb4b4b4, 11: 0xf4f7fc, 12: 0xababab, 13: 0x0078d7, 14: 0xffffff, 15: 0xf0f0f0,
  16: 0xa0a0a0, 17: 0x6d6d6d, 18: 0x000000, 19: 0x434e54, 20: 0xffffff, 21: 0x696969, 22: 0xe3e3e3, 23: 0x000000,
  24: 0xffffe1,
};

const schemeRgb = (scheme: Scheme, idx: number): [number, number, number] | null => {
  const hex = scheme[idx];
  if (!hex) return null;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
};

/**
 * [doc-viewer] OfficeArtCOLORREF([MS-ODRAW] 2.2.2) → RGB. 규칙은 LibreOffice MSO_CLR_ToColor를 따른다.
 * - fSchemeIndex(0x08) 또는 fPaletteIndex(0x01)만 켜짐: 색 구성표 색
 * - fSysIndex(0x10): 시스템 색이나 같은 도형의 다른 색(0xF0~0xF7)에 어둡게·밝게 같은 연산을 건 색.
 *   원본은 이것을 RGB로 읽어 그라데이션 끝색이 엉뚱한 자주색으로 나왔다.
 */
function colorRgb(value: number, scheme: Scheme, ref: ColorRef | undefined, fallback: number): [number, number, number] {
  let v = value >>> 0;
  if (v >>> 25 === 0x7f) v &= 0xffffff; // 0xFE/0xFF 머리: 글자 색의 RGB 표기
  const upper = v >>> 24;
  if (upper & 0x19) {
    if (upper & 0x08 || !(upper & 0x10)) {
      return schemeRgb(scheme, upper & 0x08 ? v & 0xffff : upper) ?? [(fallback >> 16) & 0xff, (fallback >> 8) & 0xff, fallback & 0xff];
    }
    const param = (v >>> 16) & 0xff;
    const fn = (v >>> 8) & 0x0f;
    const extra = (v >>> 8) & 0xf0;
    const index = v & 0xff;
    let rgb: [number, number, number];
    if (index >= 0xf0) {
      const raw = ref?.(index);
      // 가리킨 색도 fSysIndex면 되돌이 고리가 될 수 있어 기본값으로 둔다(LibreOffice와 같다)
      const src = raw !== undefined && !(raw & 0x10000000) ? raw : index === 0xf2 ? 0 : 0xffffff;
      rgb = colorRgb(src, scheme, undefined, index === 0xf2 ? 0 : 0xffffff);
    } else {
      const sys = SYS_COLORS[index] ?? 0;
      rgb = [(sys >> 16) & 0xff, (sys >> 8) & 0xff, sys & 0xff];
    }
    if (extra & 0x80) {
      const y = Math.round(rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114);
      rgb = [y, y, y];
    }
    const clamp = (n: number): number => Math.max(0, Math.min(255, n));
    if (fn === 1) rgb = rgb.map((c) => (param * c) >> 8) as [number, number, number];
    else if (fn === 2) rgb = rgb.map((c) => (((0xff - param) * 0xff) + param * c) >> 8) as [number, number, number];
    else if (fn === 3) rgb = rgb.map((c) => clamp(c + param)) as [number, number, number];
    else if (fn === 4) rgb = rgb.map((c) => clamp(c - param)) as [number, number, number];
    else if (fn === 5) rgb = rgb.map((c) => clamp(param - c)) as [number, number, number];
    else if (fn === 6) rgb = rgb.map((c) => (c < param ? 0 : 0xff)) as [number, number, number];
    if (extra & 0x40) rgb = rgb.map((c) => c ^ 0x80) as [number, number, number];
    if (extra & 0x20) rgb = rgb.map((c) => 0xff - c) as [number, number, number];
    return rgb;
  }
  if (upper & 0x04 && (v & 0xfffff8) === 0) {
    // PowerPoint는 0x04xxxxxx 꼴을 구성표 색으로 쓴다(LibreOffice 주석)
    const hit = schemeRgb(scheme, upper);
    if (hit) return hit;
  }
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
}

/** Escher 颜色值 → CSS。0x0BBGGRR，高位字节标明取色方式 */
export function escherColor(value: number, scheme: Scheme, alpha = 1, ref?: ColorRef): string {
  const [r, g, b] = colorRgb(value, scheme, ref, 0);
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${Math.round(alpha * 1000) / 1000})`;
}

const bit = (v: number | undefined, mask: number): boolean | null => {
  if (v === undefined) return null;
  // 高 16 位是「该位是否被显式设置」，低 16 位是取值
  if ((v & (mask << 16)) === 0) return null;
  return (v & mask) !== 0;
};

export function shapeFill(props: EscherProps, scheme: Scheme, blipUrl: (idx: number) => string | null): Fill | null {
  const filled = bit(props.simple.get(P.fillStyleBooleans), 0x10);
  if (filled === false) return { type: 'none' };
  const type = props.simple.get(P.fillType) ?? 0;
  const opacity = (props.simple.get(P.fillOpacity) ?? 65536) / 65536;
  const ref = propColorRef(props);

  if (type === 3 || type === 2) {
    const idx = props.simple.get(P.fillBlip) ?? props.simple.get(P.pib);
    const src = idx !== undefined ? blipUrl(idx) : null;
    if (src) return { type: 'image', src, alpha: opacity < 1 ? opacity : undefined };
  }
  if (type >= 4 && type <= 8) {
    const c1 = props.simple.get(P.fillColor);
    const c2 = props.simple.get(P.fillBackColor);
    if (c1 !== undefined || c2 !== undefined) return gradientFill(props, type, scheme, opacity, ref);
  }
  const color = props.simple.get(P.fillColor);
  if (color === undefined) return filled === true ? { type: 'solid', color: escherColor(0xffffff, scheme) } : null;
  return { type: 'solid', color: escherColor(color, scheme, opacity, ref) };
}

/**
 * [doc-viewer] 그라데이션 채우기(fillType 4~8). 방향·색 순서는 LibreOffice(ImportGradientColor)와 같게 정한다.
 * - fillAngle은 16.16 고정소수 도. LibreOffice 각도 θ(0 = 위→아래, 반시계)는 fillAngle과 같고,
 *   이 스키마 각도(0 = 왼쪽→오른쪽, 시계 방향)로는 90 − fillAngle이다.
 * - 각도 ≥ 0, 초점 0, 음수 초점, 축 대칭(초점 40~60), 사각형형(5·6)마다 두 색을 맞바꾼다.
 * 원본은 각도·초점을 무시하고 늘 위→아래로 그려 배경 그라데이션 방향이 틀렸다.
 */
function gradientFill(props: EscherProps, type: number, scheme: Scheme, opacity: number, ref: ColorRef): Fill {
  const angle = signed(props.simple.get(P.fillAngle) ?? 0) / 65536;
  let swap = angle >= 0;
  let focus = signed(props.simple.get(P.fillFocus) ?? 0);
  if (!focus) swap = !swap;
  else if (focus < 0) {
    focus = -focus;
    swap = !swap;
  }
  let style: 'linear' | 'axial' | 'rect' = 'linear';
  if (focus > 40 && focus < 60) {
    style = 'axial';
    swap = !swap;
  }
  if (type === 5 || type === 6) {
    style = 'rect';
    swap = !swap;
  }
  const backOpacity = (props.simple.get(P.fillBackOpacity) ?? 65536) / 65536;
  let c1 = escherColor(props.simple.get(P.fillColor) ?? 0xffffff, scheme, opacity, ref);
  let c2 = escherColor(props.simple.get(P.fillBackColor) ?? 0xffffff, scheme, backOpacity, ref);
  if (swap) [c1, c2] = [c2, c1];
  // LibreOffice 그라데이션: 시작색(c2)이 위(사각형형은 바깥), 끝색(c1)이 아래(가운데)
  if (style === 'rect') return { type: 'gradient', angle: 0, radial: true, stops: [{ pos: 0, color: c1 }, { pos: 1, color: c2 }] };
  const dir = (((90 - angle) % 360) + 360) % 360;
  if (style === 'axial') {
    return { type: 'gradient', angle: dir, stops: [{ pos: 0, color: c2 }, { pos: 0.5, color: c1 }, { pos: 1, color: c2 }] };
  }
  return { type: 'gradient', angle: dir, stops: [{ pos: 0, color: c2 }, { pos: 1, color: c1 }] };
}

const DASH_MAP: Record<number, number[]> = {
  1: [4, 3], 2: [1, 3], 3: [4, 3, 1, 3], 4: [4, 3, 1, 3, 1, 3],
  5: [8, 3], 6: [8, 3, 1, 3], 7: [8, 3, 1, 3, 1, 3], 8: [1, 1], 9: [3, 3], 10: [3, 3, 1, 3],
};

const ARROW_MAP: Record<number, 'triangle' | 'stealth' | 'diamond' | 'oval' | 'arrow'> = {
  1: 'triangle', 2: 'stealth', 3: 'diamond', 4: 'oval', 5: 'arrow',
};

export function shapeStroke(props: EscherProps, scheme: Scheme): Stroke | null {
  const hasLine = bit(props.simple.get(P.lineStyleBooleans), 0x08);
  if (hasLine === false) return null;
  const color = props.simple.get(P.lineColor);
  if (color === undefined && hasLine !== true) return null;
  const widthEmu = props.simple.get(P.lineWidth) ?? 9525;
  const width = widthEmu / 9525;
  const dashId = props.simple.get(P.lineDashing);
  const opacity = (props.simple.get(P.lineOpacity) ?? 65536) / 65536;
  const start = props.simple.get(P.lineStartArrow);
  const end = props.simple.get(P.lineEndArrow);
  return {
    color: escherColor(color ?? 0x000000, scheme, opacity, propColorRef(props)),
    width,
    dash: dashId ? (DASH_MAP[dashId] ?? [4, 3]).map((m) => m * Math.max(width, 1)) : null,
    head: start && ARROW_MAP[start] ? { type: ARROW_MAP[start], w: 3, h: 3 } : undefined,
    tail: end && ARROW_MAP[end] ? { type: ARROW_MAP[end], w: 3, h: 3 } : undefined,
  };
}

/**
 * 阴影。Escher 只存偏移 / 颜色 / 不透明度，**没有模糊半径**，
 * 因此这里给一个温和的固定模糊，避免渲染成硬邦邦的复制层。
 * 发光与柔化边缘在二进制格式里没有对应属性，不做推测。
 */
export function shapeShadow(props: EscherProps, scheme: Scheme): Effects['shadow'] | undefined {
  if (bit(props.simple.get(P.shadowStyleBooleans), 0x2) !== true) return undefined;
  // 默认偏移取 MSO 的 2pt，与 PowerPoint 新建形状时的阴影一致
  const dx = signed(props.simple.get(P.shadowOffsetX) ?? 25400) / 9525;
  const dy = signed(props.simple.get(P.shadowOffsetY) ?? 25400) / 9525;
  const alpha = Math.max(0, Math.min(1, (props.simple.get(P.shadowOpacity) ?? 65536) / 65536));
  const color = props.simple.get(P.shadowColor) ?? 0x808080;
  // 偏移与不透明度都为 0 时形同没有阴影，别塞一个看不见的滤镜进去
  if (alpha <= 0 || (dx === 0 && dy === 0)) return undefined;
  return { dx, dy, blur: 4, color: escherColor(color, scheme, alpha, propColorRef(props)) };
}

/**
 * MSO 形状类型（MSOSPT 枚举）→ 本项目预设几何名。
 * 编号严格按 [MS-ODRAW] 2.4.24，任何偏移都会让形状张冠李戴。
 */
export const MSO_SHAPE: Record<number, string> = {
  1: 'rect', 2: 'roundRect', 3: 'ellipse', 4: 'diamond', 5: 'triangle', 6: 'rtTriangle',
  7: 'parallelogram', 8: 'trapezoid', 9: 'hexagon', 10: 'octagon', 11: 'plus', 12: 'star5',
  13: 'rightArrow', 14: 'rightArrow', 15: 'homePlate', 16: 'cube', 17: 'wedgeRoundRectCallout',
  18: 'star8', 19: 'arc', 20: 'line', 21: 'plaque', 22: 'can', 23: 'donut',
  // 24-31 为文本形状，统一按矩形文本框处理
  24: 'rect', 25: 'octagon', 26: 'hexagon', 27: 'rect', 28: 'wave', 29: 'donut', 30: 'rect', 31: 'donut',
  32: 'straightConnector1', 33: 'bentConnector2', 34: 'bentConnector3', 35: 'bentConnector4',
  36: 'bentConnector5', 37: 'curvedConnector2', 38: 'curvedConnector3', 39: 'curvedConnector4',
  40: 'curvedConnector5',
  41: 'callout1', 42: 'callout2', 43: 'callout2',
  44: 'callout1', 45: 'callout2', 46: 'callout2',
  47: 'borderCallout1', 48: 'borderCallout2', 49: 'borderCallout2',
  50: 'borderCallout1', 51: 'borderCallout2', 52: 'borderCallout2',
  53: 'ribbon', 54: 'ribbon2', 55: 'chevron', 56: 'pentagon', 57: 'noSmoking',
  58: 'star8', 59: 'star16', 60: 'star32',
  61: 'wedgeRectCallout', 62: 'wedgeRoundRectCallout', 63: 'wedgeEllipseCallout',
  64: 'wave', 65: 'foldedCorner',
  66: 'leftArrow', 67: 'downArrow', 68: 'upArrow', 69: 'leftRightArrow', 70: 'upDownArrow',
  71: 'irregularSeal1', 72: 'irregularSeal2', 73: 'lightningBolt', 74: 'heart',
  75: 'rect', // pictureFrame：按图片处理，几何退化为矩形
  76: 'quadArrow',
  77: 'leftArrowCallout', 78: 'rightArrowCallout', 79: 'upArrowCallout', 80: 'downArrowCallout',
  81: 'leftRightArrowCallout', 82: 'upArrowCallout', 83: 'quadArrow',
  84: 'bevel', 85: 'leftBracket', 86: 'rightBracket', 87: 'leftBrace', 88: 'rightBrace',
  89: 'leftRightUpArrow', 90: 'bentArrow', 91: 'bentArrow', 92: 'star24',
  93: 'stripedRightArrow', 94: 'notchedRightArrow', 95: 'blockArc', 96: 'smileyFace',
  97: 'verticalScroll', 98: 'horizontalScroll', 99: 'circularArrow', 100: 'circularArrow',
  101: 'uturnArrow', 102: 'curvedRightArrow', 103: 'curvedLeftArrow', 104: 'curvedUpArrow',
  105: 'curvedDownArrow', 106: 'cloudCallout', 107: 'ribbon', 108: 'ribbon2',
  109: 'flowChartProcess', 110: 'flowChartDecision', 111: 'flowChartInputOutput',
  112: 'flowChartPredefinedProcess', 113: 'flowChartInternalStorage', 114: 'flowChartDocument',
  115: 'flowChartMultidocument', 116: 'flowChartTerminator', 117: 'flowChartPreparation',
  118: 'flowChartManualInput', 119: 'flowChartManualOperation', 120: 'flowChartConnector',
  121: 'flowChartPunchedCard', 122: 'flowChartPunchedTape', 123: 'flowChartSummingJunction',
  124: 'flowChartOr', 125: 'flowChartCollate', 126: 'flowChartSort', 127: 'flowChartExtract',
  128: 'flowChartMerge', 129: 'flowChartOnlineStorage', 130: 'flowChartOnlineStorage',
  131: 'flowChartMagneticTape', 132: 'flowChartMagneticDisk', 133: 'flowChartMagneticDrum',
  134: 'flowChartDisplay', 135: 'flowChartDelay',
  176: 'flowChartAlternateProcess', 177: 'flowChartOffpageConnector',
  178: 'callout1', 179: 'callout1', 180: 'borderCallout1', 181: 'borderCallout1',
  182: 'leftRightUpArrow', 183: 'sun', 184: 'moon', 185: 'bracketPair', 186: 'bracePair',
  187: 'star4', 188: 'doubleWave',
  189: 'actionButtonBlank', 190: 'actionButtonHome', 191: 'actionButtonHelp',
  192: 'actionButtonInformation', 193: 'actionButtonForwardNext', 194: 'actionButtonBackPrevious',
  195: 'actionButtonEnd', 196: 'actionButtonBeginning', 197: 'actionButtonReturn',
  198: 'actionButtonDocument', 199: 'actionButtonSound', 200: 'actionButtonMovie',
  202: 'rect', // textBox
};

/** pictureFrame 的形状类型编号 */
export const MSO_PICTURE_FRAME = 75;

/**
 * 从 Pictures 流按顺序抽取 BLIP 图片。
 *
 * BLIP 结构：记录头 → 1~2 个 16 字节 UID（instance 为奇数时是两个）→ 文件头 → 图像数据。
 * 光栅图的文件头只有 1 字节 tag；图元文件（EMF/WMF/PICT）的文件头有 34 字节，
 * 其中 m_fCompression 标明数据是否经 DEFLATE 压缩——PPT 里图元文件默认压缩，
 * 不解压直接交给解码器只会得到一堆乱码。
 */
export function extractBlips(pictures: Uint8Array): { mime: string; data: Uint8Array }[] {
  const out: { mime: string; data: Uint8Array }[] = [];
  if (!pictures.length) return out;
  const dv = new DataView(pictures.buffer, pictures.byteOffset, pictures.byteLength);

  const RASTER: Record<number, string> = {
    0xf01d: 'image/jpeg', 0xf01e: 'image/png', 0xf01f: 'image/bmp', 0xf029: 'image/tiff',
    0xf02a: 'image/jpeg',
  };
  const METAFILE: Record<number, string> = {
    0xf01a: 'image/emf', 0xf01b: 'image/wmf', 0xf01c: 'image/pict',
  };

  for (const rec of records(dv, 0, pictures.length)) {
    const isMeta = rec.type in METAFILE;
    const mime = isMeta ? METAFILE[rec.type] : RASTER[rec.type];
    if (!mime) continue;

    // instance 为奇数表示带两个 UID
    let off = rec.start + ((rec.instance & 1) === 1 ? 32 : 16);
    const end = rec.start + rec.len;
    if (off >= end) continue;

    if (!isMeta) {
      out.push({ mime, data: pictures.subarray(off + 1, end) });
      continue;
    }

    if (off + 34 > end) continue;
    const uncompressedSize = dv.getUint32(off, true);
    const compression = dv.getUint8(off + 32);
    const body = pictures.subarray(off + 34, end);
    // 0 = DEFLATE，254 = 未压缩
    if (compression === 0) {
      try {
        const raw = unzlibSync(body, uncompressedSize ? { out: new Uint8Array(uncompressedSize) } : undefined);
        out.push({ mime, data: raw });
      } catch {
        try {
          out.push({ mime, data: inflateSync(body) });
        } catch {
          // 解压失败就跳过这张图，不影响其余内容
        }
      }
    } else {
      out.push({ mime, data: body });
    }
  }
  return out;
}

/** ClientAnchor：4 个 int16，顺序为 top,left,bottom(右),right —— 与 POI 的读法一致 */
export function readAnchor(dv: DataView, rec: Rec): { x: number; y: number; w: number; h: number } | null {
  if (rec.len < 8) return null;
  const y1 = dv.getInt16(rec.start, true);
  const x1 = dv.getInt16(rec.start + 2, true);
  const x2 = dv.getInt16(rec.start + 4, true);
  const y2 = dv.getInt16(rec.start + 6, true);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** ChildAnchor：4 个 int32（组内坐标系） */
export function readChildAnchor(dv: DataView, rec: Rec): { x: number; y: number; w: number; h: number } | null {
  if (rec.len < 16) return null;
  const x1 = dv.getInt32(rec.start, true);
  const y1 = dv.getInt32(rec.start + 4, true);
  const x2 = dv.getInt32(rec.start + 8, true);
  const y2 = dv.getInt32(rec.start + 12, true);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Spgr 记录：组的子坐标系矩形 */
export function readSpgr(dv: DataView, rec: Rec): { x: number; y: number; w: number; h: number } | null {
  if (rec.len < 16) return null;
  const x1 = dv.getInt32(rec.start, true);
  const y1 = dv.getInt32(rec.start + 4, true);
  const x2 = dv.getInt32(rec.start + 8, true);
  const y2 = dv.getInt32(rec.start + 12, true);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Sp 记录：shape id + flags；shape 类型在 instance 里 */
export function readSp(dv: DataView, rec: Rec): { id: number; flags: number } {
  return { id: dv.getUint32(rec.start, true), flags: dv.getUint32(rec.start + 4, true) };
}

export const SP_FLAG = {
  GROUP: 0x1, CHILD: 0x2, PATRIARCH: 0x4, DELETED: 0x8,
  OLE: 0x10, HAVEMASTER: 0x20, FLIPH: 0x40, FLIPV: 0x80,
  CONNECTOR: 0x100, HAVEANCHOR: 0x200, BACKGROUND: 0x400, HAVESPT: 0x800,
};

/** 复杂属性里的 Unicode 字符串（如 pibName） */
export function complexString(dv: DataView, props: EscherProps, id: number): string | null {
  const c = props.complex.get(id);
  return c ? utf16(dv, c.start, c.len).replace(/\0+$/, '') : null;
}

export { ESCHER };

/** 表格行高数组（复杂属性 928）：头部 u16 count/countMax/entrySize，其后为 int32 行高 */
export function tableRowHeights(dv: DataView, props: EscherProps): number[] {
  const c = props.complex.get(P.tableRowProperties);
  if (!c || c.len < 6) return [];
  const count = dv.getUint16(c.start, true);
  const entry = dv.getInt16(c.start + 4, true);
  const size = entry > 0 ? entry : 4;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const off = c.start + 6 + i * size;
    if (off + 4 > c.start + c.len) break;
    out.push(dv.getInt32(off, true));
  }
  return out;
}

/** 该组是否是一个表格 */
export function isTableGroup(props: EscherProps): boolean {
  return props.simple.has(P.tableProperties) || props.complex.has(P.tableRowProperties);
}
