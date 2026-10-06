// 엑셀 셀 서식(글꼴·채우기·테두리·정렬)을 CSS로 바꾼다. xls와 xlsx 읽기가 함께 쓴다.
//
// 서식 하나(xf)의 모양:
//   { numFmt, font: { name, size(pt), bold, italic, underline, strike, color, script },
//     fill: '#rrggbb' | null,
//     border: { l, r, t, b: { style, color } | null },
//     align: { h, v, wrap, indent, rotate } }
// h: general | left | center | right | fill | justify | centerContinuous | distributed
// v: top | center | bottom | justify | distributed

// Excel 97-2003 기본 색상표(0~63). 64·65는 시스템 글자색·배경색이다.
export const DEFAULT_PALETTE = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

// 테마 파일이 없을 때 쓰는 Office 2007 기본 테마 색(dk1, lt1, dk2, lt2, accent1~6, hlink, folHlink)
export const DEFAULT_THEME = ['000000', 'FFFFFF', '1F497D', 'EEECE1', '4F81BD', 'C0504D', '9BBB59', '8064A2', '4BACC6', 'F79646', '0000FF', '800080'];

/** 색상표 번호 → '#rrggbb'. 64(글자 자동)·0x7FFF는 null(기본 검정), 65(배경 자동)는 흰색. */
export function paletteColor(index, palette = DEFAULT_PALETTE) {
  if (index == null || index === 64 || index === 0x7fff || index === 0x51) return null;
  if (index === 65 || index === 0x50) return '#ffffff';
  const hex = palette[index] ?? DEFAULT_PALETTE[index];
  return hex ? `#${hex.toLowerCase()}` : null;
}

/** 엑셀 tint: HSL 밝기를 어둡게(음수) 또는 밝게(양수) 바꾼다. */
export function applyTint(hex, tint) {
  if (!tint || !hex) return hex;
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) / 255;
  let g = ((n >> 8) & 255) / 255;
  let b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) r = g = b = l;
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }
  const to = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** 무늬 채우기는 무늬 밀도만큼 전경·배경색을 섞은 단색으로 그린다. */
const PATTERN_DENSITY = {
  solid: 1, darkGray: 0.75, mediumGray: 0.5, lightGray: 0.25, gray125: 0.125, gray0625: 0.0625,
  darkHorizontal: 0.5, darkVertical: 0.5, darkDown: 0.5, darkUp: 0.5, darkGrid: 0.5, darkTrellis: 0.75,
  lightHorizontal: 0.25, lightVertical: 0.25, lightDown: 0.25, lightUp: 0.25, lightGrid: 0.25, lightTrellis: 0.25,
};
// xls 무늬 번호(fls) → 이름
export const BIFF_PATTERNS = [
  'none', 'solid', 'mediumGray', 'darkGray', 'lightGray', 'darkHorizontal', 'darkVertical', 'darkDown', 'darkUp',
  'darkGrid', 'darkTrellis', 'lightHorizontal', 'lightVertical', 'lightDown', 'lightUp', 'lightGrid', 'lightTrellis', 'gray125', 'gray0625',
];

export function patternFill(pattern, fg, bg) {
  const density = PATTERN_DENSITY[pattern];
  if (!density) return null;
  const front = fg ?? '#000000';
  if (density === 1) return front;
  return mix(front, bg ?? '#ffffff', density);
}

function mix(a, b, ratio) {
  const x = parseInt(a.slice(1), 16);
  const y = parseInt(b.slice(1), 16);
  const ch = (shift) => Math.round(((x >> shift) & 255) * ratio + ((y >> shift) & 255) * (1 - ratio));
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

// xls 테두리 번호 → 이름
export const BIFF_BORDERS = [
  null, 'thin', 'medium', 'dashed', 'dotted', 'thick', 'double', 'hair',
  'mediumDashed', 'dashDot', 'mediumDashDot', 'dashDotDot', 'mediumDashDotDot', 'slantDashDot',
];
const BORDER_CSS = {
  thin: '1px solid', medium: '2px solid', thick: '3px solid', double: '3px double', hair: '1px dotted',
  dashed: '1px dashed', dotted: '1px dotted', dashDot: '1px dashed', dashDotDot: '1px dotted',
  mediumDashed: '2px dashed', mediumDashDot: '2px dashed', mediumDashDotDot: '2px dotted', slantDashDot: '2px dashed',
};

// xls 가로·세로 정렬 번호 → 이름
export const BIFF_HALIGN = ['general', 'left', 'center', 'right', 'fill', 'justify', 'centerContinuous', 'distributed'];
export const BIFF_VALIGN = ['top', 'center', 'bottom', 'justify', 'distributed'];

// 화면이 셀 배치에 쓰는 가로 정렬 번호(rendering 쪽과 맞춘다)
export const H_CODE = { general: 0, left: 1, center: 2, right: 3, fill: 4, justify: 5, centerContinuous: 6, distributed: 7 };

const SERIF = /serif|times|roman|batang|바탕|명조|myeongjo|궁서|gungsuh|mincho|ming|song|georgia|cambria|garamond|palatino|century|bookman|明|宋|楷/i;
const MONO = /courier|consolas|mono/i;

export function fontFamily(name) {
  const generic = MONO.test(name) ? 'monospace' : SERIF.test(name) && !/sans/i.test(name) ? 'serif' : 'sans-serif';
  const clean = String(name ?? '').replace(/["\\;{}<>]/g, '').trim();
  return clean ? `"${clean}",${generic}` : generic;
}

const ptToPx = (pt) => Math.round(((pt * 96) / 72) * 100) / 100;

const BORDER_WIDTH = {
  thin: 1, hair: 1, dashed: 1, dotted: 1, dashDot: 1, dashDotDot: 1,
  medium: 2, mediumDashed: 2, mediumDashDot: 2, mediumDashDotDot: 2, slantDashDot: 2, thick: 3, double: 3,
};
// 굵은 선은 엑셀처럼 눈금선을 가운데에 두고 그린다. 그래야 이웃 셀이 같은 변에 준 테두리와 정확히 겹친다.
const before = (w) => (w > 1 ? (w - 1) >> 1 : 0);
const after = (w) => (w > 1 ? w - 1 - before(w) : 0);

/**
 * 테두리 CSS. 셀 상자(양쪽 눈금선 포함) 위에 겹치는 ::after 층에 그려 채우기와 글자보다 위에 오게 하고,
 * 두께에 따라 상자 밖으로 조금 넓혀 선 가운데가 눈금선에 오게 한다. 테두리가 없으면 빈 문자열.
 */
export function borderCss(border = {}) {
  const sides = [['l', 'left'], ['r', 'right'], ['t', 'top'], ['b', 'bottom']];
  const width = {};
  const out = [];
  for (const [side, prop] of sides) {
    const b = border[side];
    width[side] = b && BORDER_CSS[b.style] ? BORDER_WIDTH[b.style] : 0;
    if (width[side]) out.push(`border-${prop}:${BORDER_CSS[b.style]} ${b.color ?? '#000'}`);
  }
  if (!out.length) return '';
  out.push(`left:${-before(width.l)}px`, `top:${-before(width.t)}px`, `right:${-after(width.r)}px`, `bottom:${-after(width.b)}px`);
  return out.join(';');
}

/** xf → 셀 CSS 선언 문자열(테두리 제외). base는 통합 문서 기본 글꼴(셀 기본값)이다. */
export function xfToCss(xf, base) {
  const out = [];
  const font = xf.font ?? base;
  if (font) {
    if (font.name && font.name !== base?.name) out.push(`font-family:${fontFamily(font.name)}`);
    if (font.size && font.size !== base?.size) out.push(`font-size:${ptToPx(font.size)}px`);
    if (font.bold) out.push('font-weight:700');
    if (font.italic) out.push('font-style:italic');
    const deco = [];
    if (font.underline) deco.push('underline');
    if (font.strike) deco.push('line-through');
    if (deco.length) out.push(`text-decoration:${deco.join(' ')}${font.underline === 'double' ? ' double' : ''}`);
    if (font.color) out.push(`color:${font.color}`);
  }
  if (xf.fill) out.push(`background-color:${xf.fill}`);
  const align = xf.align ?? {};
  if (align.v === 'top' || align.v === 'justify' || align.v === 'distributed') out.push('align-items:flex-start');
  else if (align.v === 'center') out.push('align-items:center');
  const h = align.h ?? 'general';
  if (h === 'left' || h === 'fill') out.push('text-align:left');
  else if (h === 'center' || h === 'centerContinuous') out.push('text-align:center');
  else if (h === 'right') out.push('text-align:right');
  else if (h === 'justify' || h === 'distributed') out.push('text-align:justify');
  if (align.wrap || h === 'justify' || h === 'distributed' || align.v === 'justify' || align.v === 'distributed') {
    out.push('white-space:pre-wrap', 'overflow-wrap:anywhere');
  }
  if (align.indent > 0) {
    const pad = 3 + align.indent * 9;
    out.push(h === 'right' ? `padding-right:${pad}px` : `padding-left:${pad}px`);
  }
  if (align.rotate === 255) out.push('writing-mode:vertical-rl', 'text-orientation:upright');
  return out.join(';');
}

/** 화면 쪽 배치에 필요한 서식 요약: 가로 정렬, 줄 바꿈, 채우기 여부, 빈 칸이어도 그릴지(채우기·테두리). */
export function xfMeta(xf) {
  const align = xf.align ?? {};
  const border = xf.border ?? {};
  const h = H_CODE[align.h] ?? 0;
  return {
    h,
    wrap: Boolean(align.wrap) || h === 5 || h === 7 || align.v === 'justify' || align.v === 'distributed' || align.rotate === 255,
    fill: Boolean(xf.fill),
    paint: Boolean(xf.fill) || Boolean(border.l || border.r || border.t || border.b),
  };
}

/** 셀 서식 표: xf 번호별 CSS를 한 번만 만들고, 화면에 아직 보내지 않은 것만 골라 준다. */
export class StyleTable {
  constructor(xfs, base) {
    this.xfs = xfs; // 배열(번호 → xf) 또는 (번호) => xf 함수
    this.base = base;
    this.cache = new Map();
    this.sent = new Set();
  }

  get(index) {
    return typeof this.xfs === 'function' ? this.xfs(index) : this.xfs[index];
  }

  entry(index) {
    let e = this.cache.get(index);
    if (!e) {
      const xf = this.get(index);
      e = xf ? { css: xfToCss(xf, this.base), border: borderCss(xf.border), ...xfMeta(xf) } : { css: '', border: '', h: 0, wrap: false, fill: false, paint: false };
      this.cache.set(index, e);
    }
    return e;
  }

  paints(index) {
    return this.entry(index).paint;
  }

  /** 아직 보내지 않은 서식만 { 번호: { css, border, h, wrap, paint } }로 돌려준다. */
  take(indexes) {
    const out = {};
    for (const i of indexes) {
      if (this.sent.has(i)) continue;
      this.sent.add(i);
      out[i] = this.entry(i);
    }
    return out;
  }

  /** 기본 글꼴 CSS(표 전체에 적용) */
  baseCss() {
    const f = this.base;
    if (!f) return '';
    return [`font-family:${fontFamily(f.name)}`, `font-size:${ptToPx(f.size || 11)}px`, f.color ? `color:${f.color}` : ''].filter(Boolean).join(';');
  }
}

/** 문자 수 단위 열 너비 → px. MDW는 기본 글꼴의 숫자 폭(px)이다(맑은 고딕 11pt는 8, Calibri 11·Arial 10은 7). */
export function widthToPx(width, mdw) {
  return Math.trunc(((256 * width + Math.trunc(128 / mdw)) / 256) * mdw);
}

/**
 * 기본 글꼴의 숫자 폭(MDW, px). 엑셀 열 너비의 단위다.
 * 원본 글꼴이 기기에 없으면 대체 글꼴로 그려지므로, 그 대체 글꼴로 실제 숫자 폭을 재야 글자와 열 너비가 맞는다
 * (LibreOffice도 대체 글꼴 기준으로 계산한다). 잴 수 없는 환경(Node)에서는 글꼴 크기로 어림한다.
 */
export function maxDigitWidth(font) {
  const px = ((font?.size || 11) * 96) / 72;
  try {
    const ctx = new OffscreenCanvas(1, 1).getContext('2d');
    ctx.font = `${px}px ${fontFamily(font?.name ?? '')}`;
    let max = 0;
    for (let d = 0; d <= 9; d++) max = Math.max(max, ctx.measureText(String(d)).width);
    if (max > 0) return Math.max(4, Math.round(max));
  } catch {
    // OffscreenCanvas가 없는 환경
  }
  const ratio = /맑은|malgun/i.test(font?.name ?? '') ? 0.55 : 0.5;
  return Math.max(5, Math.round(px * ratio));
}

/** 기본 열 너비(문자 수, 여백 제외) → px. 엑셀은 8px 단위로 올린다. */
export function defaultColWidthPx(chars, mdw) {
  return Math.ceil((chars * mdw + 5) / 8) * 8;
}
