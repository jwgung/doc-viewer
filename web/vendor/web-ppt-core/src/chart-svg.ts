/**
 * [doc-viewer] 엑셀 시트 차트: chart XML(xl/charts/chartN.xml) → 독립 SVG 문자열.
 * xlsx 차트는 pptx 차트와 같은 DrawingML이라 슬라이드의 차트 해석(parseChart)과 SVG 그리기를 그대로 쓴다.
 * 시트에는 슬라이드 마스터가 없으므로 색 이름 매핑(clrMap)은 엑셀 기본값(bg1→lt1, tx1→dk1 …)을 쓴다.
 */
import { parseChart } from './chart';
import { renderSlideToSvg } from './render/svg';
import type { Presentation, Slide } from './types';
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
