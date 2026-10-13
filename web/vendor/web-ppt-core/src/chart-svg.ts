/**
 * [doc-viewer] 엑셀 시트 차트: chart XML(xl/charts/chartN.xml) → 독립 SVG 문자열.
 * xlsx 차트는 pptx 차트와 같은 DrawingML이라 슬라이드의 차트 해석(parseChart)과 SVG 그리기를 그대로 쓴다.
 * 시트에는 슬라이드 마스터가 없으므로 색 이름 매핑(clrMap)은 엑셀 기본값(bg1→lt1, tx1→dk1 …)을 쓴다.
 */
import { parseChart } from './chart';
import { parseSheetShapes } from './pptx/parser';
import { renderSlideToSvg } from './render/svg';
import type { GroupElement, Presentation, Slide } from './types';
import { attr, kid, parseXml, walk } from './xml';

const CLR_MAP: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
// 테마가 없을 때(드묾) 오피스 기본 테마
const DEFAULT_THEME: Record<string, string> = {
  dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6', accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5',
  accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47', hlink: '0563C1', folHlink: '954F72',
};

function themeOf(themeXml: string | null): { colors: Record<string, string>; fonts: Parameters<typeof parseChart>[3]['fonts'] } {
  const colors = { ...DEFAULT_THEME };
  const root = themeXml ? parseXml(themeXml) : null;
  const scheme = walk(root, 'themeElements', 'clrScheme');
  for (let c = scheme?.firstElementChild ?? null; c; c = c.nextElementSibling) {
    const clr = c.firstElementChild;
    if (!clr) continue;
    colors[c.localName] = clr.localName === 'srgbClr'
      ? (attr(clr, 'val') ?? '000000')
      : (attr(clr, 'lastClr') ?? (attr(clr, 'val') === 'window' ? 'FFFFFF' : '000000'));
  }
  const fontScheme = walk(root, 'themeElements', 'fontScheme');
  const pick = (name: string) => {
    const f = kid(fontScheme, name);
    return { latin: attr(kid(f, 'latin'), 'typeface') || null, ea: attr(kid(f, 'ea'), 'typeface') || null, cs: attr(kid(f, 'cs'), 'typeface') || null };
  };
  return { colors, fonts: { major: pick('majorFont'), minor: pick('minorFont') } };
}

/** w·h는 화면 px. 차트를 못 읽으면 null */
export function chartToSvg(chartXml: string, themeXml: string | null, w: number, h: number): string | null {
  const W = Math.max(1, w);
  const H = Math.max(1, h);
  const root = parseXml(chartXml);
  if (!root) return null;
  const theme = themeOf(themeXml);
  const elements = parseChart(root, W, H, { ctx: { theme: theme.colors, clrMap: CLR_MAP }, fonts: theme.fonts, rels: {} });
  if (!elements.length) return null;
  const pres: Presentation = { width: W, height: H, slides: [], source: 'pptx' };
  const slide: Slide = { background: { type: 'none' }, elements };
  return renderSlideToSvg(pres, slide, { textMode: 'svg' });
}

/**
 * [doc-viewer] 엑셀 그리기 파트의 도형(앵커 하나 안의 sp·cxnSp·grpSp) → 독립 SVG. 도형들을 감싸는 상자를
 * w×h(화면 px)에 맞춰 늘린다(시트 렌더러가 앵커 자리를 열 너비·행 높이로 잡는다). 선 굵기·화살촉이 상자 밖으로
 * 나가므로 사방에 pad만큼 여백을 둔다(SVG 크기는 w+2pad × h+2pad). 그릴 것이 없으면 null
 */
export function shapesToSvg(anchorXml: string, themeXml: string | null, w: number, h: number, pad = 0): string | null {
  const W = Math.max(0, w);
  const H = Math.max(0, h);
  const root = parseXml(anchorXml);
  if (!root) return null;
  const children = parseSheetShapes(root, themeXml ? parseXml(themeXml) : null);
  if (!children.length) return null;
  const minX = Math.min(...children.map((c) => c.x));
  const minY = Math.min(...children.map((c) => c.y));
  const spanX = Math.max(...children.map((c) => c.x + c.w)) - minX;
  const spanY = Math.max(...children.map((c) => c.y + c.h)) - minY;
  // 가로선·세로선처럼 한쪽 크기가 0이면 그 방향은 늘리지 않고 가운데에 둔다.
  const scaleX = spanX >= 1 ? W / spanX : 1;
  const scaleY = spanY >= 1 ? H / spanY : 1;
  const group: GroupElement = {
    kind: 'group', x: pad, y: pad, w: Math.max(1, W), h: Math.max(1, H), rot: 0, flipH: false, flipV: false,
    childX: spanX >= 1 ? minX : minX - W / 2, childY: spanY >= 1 ? minY : minY - H / 2, scaleX, scaleY,
    children,
  };
  const pres: Presentation = { width: W + 2 * pad, height: H + 2 * pad, slides: [], source: 'pptx' };
  const slide: Slide = { background: { type: 'none' }, elements: [group] };
  return renderSlideToSvg(pres, slide, { textMode: 'svg' });
}
