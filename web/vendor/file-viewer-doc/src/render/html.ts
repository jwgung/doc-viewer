import { escapeHtml, slugify, twipsToPx } from '../core/utils.js';
import { HIGHLIGHT_COLORS } from '../msdoc/constants.js';
import { formatListNumber } from '../msdoc/lists.js';
import { cssTextAlign, cssUnderline, cssVerticalAlign } from '../msdoc/properties.js';
import { textFontRuns } from './fonts.js';
import { isSymbolFont, mapSymbolText } from './symbols.js';
import type {
  AttachmentAsset,
  AttachmentsBlock,
  BorderSpec,
  CharState,
  CssStyleObject,
  ImageAsset,
  InlineNode,
  MsDocBlock,
  MsDocPageRenderer,
  MsDocParseResult,
  MsDocRenderOptions,
  MsDocRenderResult,
  MsDocRenderedPage,
  NoteInfo,
  ParagraphBlock,
  SectionInfo,
  ShapeBlock,
  TableBlock,
  TableCellBlock,
  ShadingSpec,
  TextInlineNode,
} from '../types.js';

const COLOR_INDEX_MAP: Record<number, string> = {
  1: '#000000',
  2: '#0000ff',
  3: '#00ffff',
  4: '#00ff00',
  5: '#ff00ff',
  6: '#ff0000',
  7: '#ffff00',
  8: '#ffffff',
  9: '#000080',
  10: '#008080',
  11: '#008000',
  12: '#800080',
  13: '#800000',
  14: '#808000',
  15: '#808080',
  16: '#c0c0c0',
};

type ExternalLinkPolicy = NonNullable<MsDocRenderOptions['externalLinkPolicy']>;
type ExternalResourcePolicy = NonNullable<MsDocRenderOptions['externalResourcePolicy']>;

interface RenderContext {
  reviewMode: NonNullable<MsDocRenderOptions['reviewMode']>;
  externalLinkPolicy: ExternalLinkPolicy;
  externalResourcePolicy: ExternalResourcePolicy;
  /** doc-viewer: 쪽 번호 필드에 채울 값과, 이 쪽에서 만난 각주 참조 */
  pageLabel?: string;
  pageCount?: number;
  noteRefs?: string[];
  /** 각주 본문 안의 번호는 본문 참조로 되돌아가는 링크로 그린다 */
  inNote?: boolean;
}

function styleObjectToCss(style: CssStyleObject): string {
  return Object.entries(style)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}:${escapeHtml(value)}`)
    .join(';');
}

function quoteCssString(value: unknown): string {
  const escaped = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/[\n\r\f]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  return `'${escaped}'`;
}

/**
 * Normalizes a document-provided hyperlink before it reaches generated HTML.
 * Internal bookmarks always remain available. External navigation is opt-in
 * and is still restricted to browser-safe schemes and relative paths.
 */
export function sanitizeMsDocLinkHref(
  href: string | undefined | null,
  policy: ExternalLinkPolicy = 'block',
): string | null {
  const value = String(href ?? '')
    .replace(/[\u0000-\u0020\u007f-\u009f]/g, '')
    .trim();
  if (!value) return null;
  if (value.startsWith('#')) return value;
  if (policy !== 'allow') return null;
  if (/^(?:https?:|mailto:|tel:)/i.test(value)) return value;
  if (value.startsWith('//') || value.includes('\\')) return null;
  if (/^(?:\/|\.\/|\.\.\/)/.test(value) && !value.startsWith('//')) {
    return value;
  }
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) return value;
  return null;
}

function renderLink(content: string, href: string | null): string {
  if (!href) return content;
  const escapedHref = escapeHtml(href);
  if (href.startsWith('#')) return `<a class="msdoc-link" href="${escapedHref}">${content}</a>`;
  return `<a class="msdoc-link" href="${escapedHref}" target="_blank" rel="noreferrer noopener">${content}</a>`;
}

function borderToCss(border: BorderSpec | undefined | null): string | null {
  if (!border || border.nil) return null;
  const borderType = border.borderType as number | undefined;
  if (!borderType) return null;
  const lineWidth = Math.max(2, border.lineWidth || 0);
  const widthPoints = borderType >= 0x40 ? lineWidth : lineWidth / 8;
  const width = Math.max(1, Math.round(widthPoints * (96 / 72)));
  const style = borderType === 3
    ? 'double'
    : borderType === 6
      ? 'dotted'
      : [7, 8, 9].includes(borderType)
        ? 'dashed'
        : 'solid';
  const colorIndex = border.color as number | undefined;
  const color = border.colorRef != null
    ? colorRefToCss(border.colorRef)
    : COLOR_INDEX_MAP[colorIndex || 1] || '#000000';
  return `${width}px ${style} ${color}`;
}

function colorRefToCss(colorRef: number | undefined): string {
  if (colorRef == null || (colorRef >>> 24) === 0xff) return '#000000';
  const red = colorRef & 0xff;
  const green = (colorRef >>> 8) & 0xff;
  const blue = (colorRef >>> 16) & 0xff;
  return `#${[red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

const SHADING_PERCENT: Record<number, number> = {
  2: 5, 3: 10, 4: 20, 5: 25, 6: 30, 7: 40,
  8: 50, 9: 60, 10: 70, 11: 75, 12: 80, 13: 90,
};

function mixHexColors(foreground: string, background: string, percent: number): string {
  const channel = (color: string, offset: number) => Number.parseInt(color.slice(offset, offset + 2), 16);
  const ratio = Math.max(0, Math.min(100, percent)) / 100;
  const values = [1, 3, 5].map(offset => Math.round(
    channel(foreground, offset) * ratio + channel(background, offset) * (1 - ratio)
  ));
  return `#${values.map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

function shadingToCss(shading: ShadingSpec | undefined): CssStyleObject {
  if (!shading || shading.nil || shading.auto || shading.pattern === 0) return {};
  const foreground = shading.foregroundColorRef != null
    ? colorRefToCss(shading.foregroundColorRef)
    : COLOR_INDEX_MAP[shading.foregroundColorIndex || 1] || '#000000';
  const background = shading.backgroundColorRef != null
    ? colorRefToCss(shading.backgroundColorRef)
    : COLOR_INDEX_MAP[shading.backgroundColorIndex || 8] || '#ffffff';
  if (shading.pattern === 1) return { 'background-color': foreground };
  if (SHADING_PERCENT[shading.pattern] != null) {
    return { 'background-color': mixHexColors(foreground, background, SHADING_PERCENT[shading.pattern]!) };
  }
  const stripe = shading.pattern === 14 || shading.pattern === 20
    ? `repeating-linear-gradient(0deg,${foreground} 0 1px,transparent 1px 4px)`
    : shading.pattern === 15 || shading.pattern === 21
      ? `repeating-linear-gradient(90deg,${foreground} 0 1px,transparent 1px 4px)`
      : shading.pattern === 16 || shading.pattern === 22
        ? `repeating-linear-gradient(45deg,${foreground} 0 1px,transparent 1px 5px)`
        : shading.pattern === 17 || shading.pattern === 23
          ? `repeating-linear-gradient(-45deg,${foreground} 0 1px,transparent 1px 5px)`
          : null;
  return stripe
    ? { 'background-color': background, 'background-image': stripe }
    : { 'background-color': background };
}

function paragraphStyleToCss(paraState: ParagraphBlock['paraState']): CssStyleObject {
  const style: CssStyleObject = {
    'text-align': cssTextAlign(paraState.alignment),
  };
  const marginTop = twipsToPx(paraState.spacingBefore);
  const marginBottom = twipsToPx(paraState.spacingAfter);
  const marginLeft = twipsToPx(paraState.leftIndent);
  const marginRight = twipsToPx(paraState.rightIndent);
  const textIndent = twipsToPx(paraState.firstLineIndent);
  if (marginTop) style['margin-top'] = `${marginTop}px`;
  if (marginBottom) style['margin-bottom'] = `${marginBottom}px`;
  if (marginLeft) style['margin-left'] = `${marginLeft}px`;
  if (marginRight) style['margin-right'] = `${marginRight}px`;
  if (textIndent) style['text-indent'] = `${textIndent}px`;
  if (paraState.lineSpacing) {
    if (paraState.lineSpacingRule === 'exact' || paraState.lineSpacingRule === 'atLeast') {
      style['line-height'] = `${twipsToPx(Math.abs(paraState.lineSpacing))}px`;
    } else {
      const multiple = Math.abs(paraState.lineSpacing) / 240;
      // A font's single line includes its metrics and leading, not just a 1em box.
      style['line-height'] = multiple === 1 ? 'normal' : String(multiple);
    }
  }
  if (paraState.keepLines) style['break-inside'] = 'avoid';
  if (paraState.keepNext) style['break-after'] = 'avoid';
  if (paraState.pageBreakBefore) style['break-before'] = 'page';
  if (paraState.rtlPara) style.direction = 'rtl';

  const top = borderToCss(paraState.borders?.top);
  const right = borderToCss(paraState.borders?.right);
  const bottom = borderToCss(paraState.borders?.bottom);
  const left = borderToCss(paraState.borders?.left);
  if (top) style['border-top'] = top;
  if (right) style['border-inline-end'] = right;
  if (bottom) style['border-bottom'] = bottom;
  if (left) style['border-inline-start'] = left;
  return style;
}

function buildUnderlineStyle(underline: number): CssStyleObject {
  const wordStyle = cssUnderline(underline);
  if (!underline || wordStyle === 'none') return {};
  const css: CssStyleObject = { 'text-decoration-line': 'underline' };
  if (wordStyle === 'double' || wordStyle === 'wavy-double') css['text-decoration-style'] = 'double';
  else if (wordStyle.includes('dot') || wordStyle === 'dotted-heavy') css['text-decoration-style'] = 'dotted';
  else if (wordStyle.includes('dash')) css['text-decoration-style'] = 'dashed';
  else if (wordStyle.includes('wave') || wordStyle.includes('wavy')) css['text-decoration-style'] = 'wavy';
  else css['text-decoration-style'] = 'solid';
  return css;
}

function inlineStyleToCss(styleState: CharState): CssStyleObject {
  const style: CssStyleObject = {};
  if (styleState.bold || styleState.boldBi) style['font-weight'] = '700';
  if (styleState.italic || styleState.italicBi) style['font-style'] = 'italic';
  if (styleState.strike || styleState.doubleStrike) style['text-decoration-line'] = `${style['text-decoration-line'] ? `${style['text-decoration-line']} ` : ''}line-through`;
  Object.assign(style, buildUnderlineStyle(styleState.underline));
  if (styleState.fontSizeHalfPoints) style['font-size'] = `${styleState.fontSizeHalfPoints / 2}pt`;
  // doc-viewer: 기호 글꼴은 휴대폰에 없으므로 글꼴을 지정하지 않고 글자를 유니코드로 바꿔 그린다(renderTextNode).
  if (styleState.fontFamily && !isSymbolFont(styleState.fontFamily)) style['font-family'] = `${quoteCssString(styleState.fontFamily)},sans-serif`;
  if (styleState.colorIndex && COLOR_INDEX_MAP[styleState.colorIndex]) style.color = COLOR_INDEX_MAP[styleState.colorIndex];
  const highlightIndex = typeof styleState.highlight === 'number' ? styleState.highlight : styleState.highlight?.index;
  if (highlightIndex && HIGHLIGHT_COLORS[highlightIndex as keyof typeof HIGHLIGHT_COLORS]) {
    style['background-color'] = HIGHLIGHT_COLORS[highlightIndex as keyof typeof HIGHLIGHT_COLORS];
  }
  if (styleState.smallCaps) style['font-variant-caps'] = 'small-caps';
  if (styleState.caps) style['text-transform'] = 'uppercase';
  if (styleState.scale && styleState.scale !== 100) {
    style.display = 'inline-block';
    style.transform = `scaleX(${styleState.scale / 100})`;
    style['transform-origin'] = 'left center';
  }
  if (styleState.positionHalfPoints > 0) style['vertical-align'] = 'super';
  if (styleState.positionHalfPoints < 0) style['vertical-align'] = 'sub';
  // doc-viewer: 위첨자·아래첨자(sprmCIss). Word처럼 글자를 줄여 그린다.
  if (styleState.iss === 1 || styleState.iss === 2) {
    style['vertical-align'] = styleState.iss === 1 ? 'super' : 'sub';
    style['font-size'] = styleState.fontSizeHalfPoints ? `${(styleState.fontSizeHalfPoints / 2) * 0.66}pt` : '66%';
    style['line-height'] = '0';
  }
  if (styleState.outline) style['text-shadow'] = '0 0 0.02em currentColor';
  if (styleState.shadow || styleState.emboss || styleState.imprint) {
    style['text-shadow'] = style['text-shadow'] ? `${style['text-shadow']}, 0.06em 0.06em 0.08em rgba(0,0,0,.25)` : '0.06em 0.06em 0.08em rgba(0,0,0,.25)';
  }
  if (styleState.rtl) style.direction = 'rtl';
  return style;
}

function renderTextNode(node: TextInlineNode, context: RenderContext): string {
  if (context.reviewMode === 'final' && node.style.revisionDeleted) return '';
  if (context.reviewMode === 'original' && node.style.revisionInserted) return '';
  const content = textFontRuns(mapSymbolText(node.text, node.style.fontFamily), node.style).map(run => {
    const text = escapeHtml(run.text);
    if (!run.fontFamily || run.fontFamily === node.style.fontFamily || isSymbolFont(run.fontFamily)) return text;
    const font = styleObjectToCss({ 'font-family': `${quoteCssString(run.fontFamily)},sans-serif` });
    return `<span style="${font}">${text}</span>`;
  }).join('');
  const inlineStyle = inlineStyleToCss(node.style);
  inlineStyle['white-space'] = 'break-spaces';
  const revision = context.reviewMode === 'all'
    ? node.style.revisionDeleted ? 'delete' : node.style.revisionInserted ? 'insert' : null
    : null;
  if (revision) {
    inlineStyle.color = '#c62828';
    inlineStyle['text-decoration-line'] = revision === 'delete' ? 'line-through' : 'underline';
  }
  const style = styleObjectToCss(inlineStyle);
  const tag = revision === 'delete' ? 'del' : revision === 'insert' ? 'ins' : 'span';
  const change = revision ? ` data-msdoc-change="${revision}"` : '';
  const inner = `<${tag}${change}${style ? ` style="${style}"` : ''}>${content}</${tag}>`;
  return renderLink(inner, sanitizeMsDocLinkHref(node.href, context.externalLinkPolicy));
}

function inlineImageDisplaySizePx(asset: ImageAsset): { widthPx?: number; heightPx?: number } {
  const widthPx = twipsToPx(asset.meta?.displayWidthTwips);
  const heightPx = twipsToPx(asset.meta?.displayHeightTwips);
  return {
    widthPx: widthPx && widthPx > 0 ? widthPx : undefined,
    heightPx: heightPx && heightPx > 0 ? heightPx : undefined,
  };
}

function applyInlineImageDisplaySize(style: CssStyleObject, asset: ImageAsset): void {
  const { widthPx, heightPx } = inlineImageDisplaySizePx(asset);
  if (!widthPx && !heightPx) return;
  if (widthPx) style.width = `${widthPx}px`;
  if (heightPx) style.height = `${heightPx}px`;
}

const SAFE_RASTER_IMAGE_DATA_URL =
  /^data:image\/(?:avif|bmp|gif|jpeg|png|webp|x-icon);base64,[a-z\d+/=]+$/i;

function decodeBase64Text(value: string): string | null {
  try {
    const bufferCtor = (globalThis as {
      Buffer?: { from(value: string, encoding: string): { toString(encoding: string): string } };
    }).Buffer;
    if (bufferCtor) return bufferCtor.from(value, 'base64').toString('utf8');
    if (typeof atob !== 'function') return null;
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function isSafeSvgImageDataUrl(value: string): boolean {
  const match = /^data:image\/svg\+xml;base64,([a-z\d+/=]+)$/i.exec(value);
  if (!match || match[1].length > 8 * 1024 * 1024) return false;
  const svg = decodeBase64Text(match[1]);
  if (!svg || !/^\s*<svg(?:\s|>)/i.test(svg)) return false;
  if (/<\/?(?:script|style|foreignObject|iframe|object|embed|form|link)\b/i.test(svg)) return false;
  if (/<!\s*(?:doctype|entity)\b/i.test(svg) || /\son[a-z\d_-]+\s*=/i.test(svg)) return false;
  if (svg.includes('\\') || svg.includes('/*') || /@import\b/i.test(svg)) return false;
  if (/url\s*\(\s*(?!["']?#[A-Za-z0-9_.:-]+["']?\s*\))/i.test(svg)) return false;
  for (const resource of svg.matchAll(/\s(?:href|xlink:href|src)\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    const target = String(resource[2] || '').replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
    if (!/^#[A-Za-z0-9_.:-]+$/.test(target) && !SAFE_RASTER_IMAGE_DATA_URL.test(target)) return false;
  }
  return true;
}

function sanitizeImageSource(
  src: string | undefined | null,
  policy: ExternalResourcePolicy,
  allowGeneratedVector = false,
): string | null {
  const value = String(src || '').replace(/[\u0000-\u0020\u007f-\u009f]/g, '').trim();
  if (!value) return null;
  if (SAFE_RASTER_IMAGE_DATA_URL.test(value)) return value;
  if (allowGeneratedVector && isSafeSvgImageDataUrl(value)) return value;
  if (/^blob:/i.test(value)) return value;
  if (policy !== 'allow') return null;
  if (/^https?:/i.test(value)) return value;
  if (value.startsWith('//') || value.startsWith('\\')) return null;
  if (!/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('\\')) return value;
  return null;
}

function sanitizeDownloadHref(href: string | undefined | null): string | null {
  const value = String(href ?? '').trim();
  if (!value) return null;
  const dataUrl = /^data:([^;,]+);base64,([a-z\d+/=\s]+)$/i.exec(value);
  if (!dataUrl) return null;
  const mimeType = dataUrl[1].trim().toLowerCase();
  if (/^(?:text\/(?:html|javascript)|application\/(?:javascript|xhtml\+xml|xml)|image\/svg\+xml)$/.test(mimeType)) {
    return null;
  }
  if (mimeType.endsWith('+xml')) return null;
  return value;
}

function sanitizeAssetHref(href: string | undefined | null, context: RenderContext): string | null {
  const downloadHref = sanitizeDownloadHref(href);
  if (downloadHref) return downloadHref;
  const value = sanitizeMsDocLinkHref(href, context.externalLinkPolicy);
  if (value && !value.startsWith('#')) return value;
  return null;
}

function renderImageNode(node: Extract<InlineNode, { type: 'image' }>, context: RenderContext): string {
  const allowGeneratedVector = node.asset.meta?.vectorConverted === true;
  const src = sanitizeImageSource(
    node.asset.sourceUrl,
    context.externalResourcePolicy,
    allowGeneratedVector,
  ) || sanitizeImageSource(
    node.asset.dataUrl,
    context.externalResourcePolicy,
    allowGeneratedVector,
  );
  const baseStyle = inlineStyleToCss(node.style);
  const displaySize = inlineImageDisplaySizePx(node.asset);
  if (displaySize.widthPx || displaySize.heightPx) {
    applyInlineImageDisplaySize(baseStyle, node.asset);
    baseStyle['max-width'] = 'none';
    if (!displaySize.heightPx) baseStyle.height = 'auto';
  } else {
    baseStyle['max-width'] = '100%';
    baseStyle.height = 'auto';
  }

  if (!src || node.asset.displayable === false) {
    const fallbackHref = sanitizeAssetHref(node.asset.dataUrl, context) || sanitizeAssetHref(node.asset.sourceUrl, context);
    // doc-viewer: 풀지 못한 그림은 MIME 이름(application/octet-stream 등) 대신 그림 표시만 남긴다.
    const label = escapeHtml(String(node.asset.meta?.linkedPath || ''));
    const inner = fallbackHref
      ? `<a class="msdoc-attachment msdoc-image-fallback" href="${escapeHtml(fallbackHref)}" target="_blank" rel="noreferrer noopener">🖼 ${label}</a>`
      : `<span class="msdoc-image-fallback">🖼 ${label}</span>`;
    return renderLink(inner, sanitizeMsDocLinkHref(node.href, context.externalLinkPolicy));
  }

  const img = `<img class="msdoc-image" src="${escapeHtml(src)}" alt="" style="${styleObjectToCss(baseStyle)}">`;
  return renderLink(img, sanitizeMsDocLinkHref(node.href, context.externalLinkPolicy));
}

function renderAttachmentNode(node: Extract<InlineNode, { type: 'attachment' }>, context: RenderContext): string {
  const label = escapeHtml(node.asset.name || 'embedded-file');
  const downloadHref = sanitizeDownloadHref(node.asset.dataUrl);
  const inner = downloadHref
    ? `<a class="msdoc-attachment" href="${escapeHtml(downloadHref)}" download="${label}">📎 ${label}</a>`
    : `<span class="msdoc-attachment">📎 ${label}</span>`;
  const href = sanitizeMsDocLinkHref(node.href, context.externalLinkPolicy);
  return href ? `<span class="msdoc-inline-group">${inner}${renderLink('↗', href)}</span>` : inner;
}

function renderInlineNodes(nodes: InlineNode[], context: RenderContext): string {
  return nodes.map((node) => {
    if (hiddenRevision(node.style, context)) return '';
    if (node.type === 'text') return renderTextNode(node, context);
    if (node.type === 'image') return renderImageNode(node, context);
    if (node.type === 'attachment') return renderAttachmentNode(node, context);
    if (node.type === 'lineBreak') return '<br>';
    // doc-viewer: 쪽 나누기는 renderMsDoc이 쪽을 나눌 때 쓰고, 표·글상자 안에서는 그리지 않는다.
    if (node.type === 'pageBreak') return '';
    if (node.type === 'noteRef') {
      const label = escapeHtml(node.label);
      const style = styleObjectToCss({ ...inlineStyleToCss({ ...node.style, iss: 0, positionHalfPoints: 0 }), 'vertical-align': undefined });
      if (context.inNote) {
        return `<a class="msdoc-note-label" href="#${escapeHtml(node.noteId)}-ref"${style ? ` style="${style}"` : ''}>${label}</a>`;
      }
      context.noteRefs?.push(node.noteId);
      return `<sup class="msdoc-note-ref" id="${escapeHtml(node.noteId)}-ref"><a href="#${escapeHtml(node.noteId)}">${label}</a></sup>`;
    }
    if (node.type === 'field') {
      const value = node.field === 'page'
        ? context.pageLabel ?? node.text
        : context.pageCount != null ? String(context.pageCount) : node.text;
      // doc-viewer: 앱이 자동 쪽 나눔으로 쪽을 다시 나누면 쪽 번호를 바꿔 넣을 수 있게 필드 자리를 표시한다.
      return `<span class="msdoc-field" data-field="${node.field}">${renderTextNode({ type: 'text', text: value, style: node.style, href: node.href }, context)}</span>`;
    }
    return '';
  }).join('');
}

function hiddenRevision(
  revision: ParagraphBlock['paragraphMark'],
  context: RenderContext,
): boolean {
  return !!((context.reviewMode === 'final' && revision?.revisionDeleted)
    || (context.reviewMode === 'original' && revision?.revisionInserted));
}

function reviewParagraphs(paragraphs: ParagraphBlock[], context: RenderContext): ParagraphBlock[] {
  const result: ParagraphBlock[] = [];
  for (const paragraph of paragraphs) {
    const previous = result[result.length - 1];
    if (previous && previous.storyKind === paragraph.storyKind
      && hiddenRevision(previous.paragraphMark, context)) {
      // The surviving paragraph mark owns the merged paragraph's formatting.
      result[result.length - 1] = {
        ...paragraph,
        inlines: [...previous.inlines, ...paragraph.inlines],
        text: previous.text + paragraph.text,
      };
    } else {
      result.push(paragraph);
    }
  }
  return result;
}

// doc-viewer: 번호·글머리 기호. 내어쓰기(첫 줄 음수 들여쓰기) 폭만큼 자리를 잡아 Word처럼 본문과 줄을 맞춘다.
function renderListLabel(block: ParagraphBlock): string {
  const label = block.listLabel;
  if (!label?.text) return '';
  const labelStyle = label.style ? inlineStyleToCss(label.style) : {};
  const text = mapSymbolText(label.text, label.style?.fontFamily, true);
  const hanging = -(twipsToPx(block.paraState.firstLineIndent) || 0);
  if (label.follow === 'tab' && hanging > 0) {
    labelStyle.display = 'inline-block';
    labelStyle['min-width'] = `${hanging}px`;
    labelStyle['text-indent'] = '0';
  }
  const follow = label.follow === 'space' ? ' ' : label.follow === 'tab' && hanging <= 0 ? '\u2003' : '';
  const css = styleObjectToCss(labelStyle);
  return `<span class="msdoc-list-label"${css ? ` style="${css}"` : ''}>${escapeHtml(text + follow)}</span>`;
}

/**
 * doc-viewer: 머리말·꼬리말의 '왼쪽\t가운데\t오른쪽' 줄. Word 기본 머리말 스타일은 가운데·오른쪽 탭이 있어
 * 탭으로 세 칸을 나눈다. 탭 위치 대신 칸 수로 자리를 정한다(앞 칸이 비면 가운데·오른쪽으로 민다).
 */
function splitTabColumns(nodes: InlineNode[]): InlineNode[][] | null {
  const columns: InlineNode[][] = [[]];
  for (const node of nodes) {
    if (node.type !== 'text' || !node.text.includes('\t')) {
      columns[columns.length - 1]!.push(node);
      continue;
    }
    const parts = node.text.split('\t');
    parts.forEach((part, index) => {
      if (index > 0) columns.push([]);
      if (part) columns[columns.length - 1]!.push({ ...node, text: part });
    });
  }
  return columns.length > 1 ? columns : null;
}

function renderTabColumns(block: ParagraphBlock, context: RenderContext, tag: string, style: string): string | null {
  if (block.listLabel) return null;
  const columns = splitTabColumns(block.inlines || []);
  if (!columns || columns.length > 4) return null;
  const isEmpty = (nodes: InlineNode[]) => nodes.every((node) => node.type === 'text' && !node.text.trim());
  let left: InlineNode[] = [];
  let center: InlineNode[] = [];
  let right: InlineNode[] = [];
  if (columns.length === 2) {
    if (isEmpty(columns[0]!)) center = columns[1]!;
    else [left, right] = [columns[0]!, columns[1]!];
  } else {
    left = columns[0]!;
    center = columns.slice(1, -1).flat();
    right = columns[columns.length - 1]!;
  }
  const cell = (nodes: InlineNode[], align: string) => `<span class="msdoc-tab-${align}">${renderInlineNodes(nodes, context)}</span>`;
  return `<${tag} class="msdoc-paragraph msdoc-tab-columns"${style ? ` style="${style}"` : ''}>${cell(left, 'left')}${cell(center, 'center')}${cell(right, 'right')}</${tag}>`;
}

function renderParagraphBlock(block: ParagraphBlock, context: RenderContext, options: { inline?: boolean; tabColumns?: boolean } = {}): string {
  const tag = options.inline ? 'div' : 'p';
  const style = styleObjectToCss(paragraphStyleToCss(block.paraState));
  if (options.tabColumns) {
    const columns = renderTabColumns(block, context, tag, style);
    if (columns) return columns;
  }
  const anchors = block.anchors?.length ? renderShapeRun(block.anchors, context) : '';
  const body = renderListLabel(block) + renderInlineNodes(block.inlines || [], context);
  const empty = body || '<br>';
  const classNames = ['msdoc-paragraph'];
  if (block.paraState.lineSpacingRule === 'atLeast') classNames.push('msdoc-line-at-least');
  if (block.styleName) classNames.push(`msdoc-style-${slugify(block.styleName)}`);
  return `${anchors}<${tag} class="${classNames.join(' ')}"${style ? ` style="${style}"` : ''}>${empty}</${tag}>`;
}

/** doc-viewer: 떠 있는 글상자·그림. 원래 위치 대신 고정 문단 자리에 블록으로 그린다. */
function renderShapeBlock(shape: ShapeBlock, context: RenderContext): string {
  const style: CssStyleObject = {};
  const widthPx = twipsToPx(shape.widthTwips);
  if (shape.kind === 'picture' && shape.image) {
    const allowVector = shape.image.meta?.vectorConverted === true;
    const src = sanitizeImageSource(shape.image.sourceUrl, context.externalResourcePolicy, allowVector)
      || sanitizeImageSource(shape.image.dataUrl, context.externalResourcePolicy, allowVector);
    if (!src) return '';
    const imageStyle = styleObjectToCss({ width: widthPx ? `${Math.round(widthPx)}px` : undefined, 'max-width': '100%', height: 'auto' });
    return `<div class="msdoc-shape msdoc-shape-picture"><img class="msdoc-image" src="${escapeHtml(src)}" alt="" style="${imageStyle}"></div>`;
  }
  if (widthPx) style.width = `${Math.round(widthPx)}px`;
  if (shape.fillColor) style['background-color'] = shape.fillColor;
  if (shape.lineColor) style.border = `${shape.lineWidthPx || 1}px solid ${shape.lineColor}`;
  const inner = renderBlockList(shape.blocks, context, { inline: true });
  if (!inner) return '';
  const css = styleObjectToCss(style);
  return `<div class="msdoc-shape msdoc-shape-textbox"${css ? ` style="${css}"` : ''}>${inner}</div>`;
}

/**
 * doc-viewer: 이어진 도형들. 세로 위치가 비슷한 것끼리 한 줄(flex, 줄바꿈 허용)에 놓아
 * 넓은 화면에서는 원본처럼 나란히, 좁은 화면에서는 아래로 이어지게 한다.
 */
function renderShapeRun(shapes: ShapeBlock[], context: RenderContext): string {
  const rows: ShapeBlock[][] = [];
  let current: ShapeBlock[] = [];
  let rowTop = 0;
  for (const shape of shapes) {
    const top = shape.topTwips ?? 0;
    if (current.length && Math.abs(top - rowTop) > 360) {
      rows.push(current);
      current = [];
    }
    if (!current.length) rowTop = top;
    current.push(shape);
  }
  if (current.length) rows.push(current);
  return rows.map((row) => {
    const html = row.map((shape) => renderShapeBlock(shape, context)).join('');
    return row.length > 1 ? `<div class="msdoc-shape-row">${html}</div>` : html;
  }).join('');
}

/** doc-viewer: 블록 목록(머리말·각주·글상자 안)을 그린다. 쪽 나누기는 무시한다. */
function renderBlockList(blocks: MsDocBlock[], context: RenderContext, options: { inline?: boolean; tabColumns?: boolean } = {}): string {
  const parts: string[] = [];
  let paragraphs: ParagraphBlock[] = [];
  let shapes: ShapeBlock[] = [];
  const flush = () => {
    parts.push(...reviewParagraphs(paragraphs, context).map((block) => renderParagraphBlock(block, context, options)));
    paragraphs = [];
  };
  const flushShapes = () => {
    if (shapes.length) parts.push(renderShapeRun(shapes, context));
    shapes = [];
  };
  for (const block of blocks) {
    if (block.type === 'shape') {
      flush();
      shapes.push(block);
      continue;
    }
    flushShapes();
    if (block.type === 'paragraph') {
      paragraphs.push(block);
      continue;
    }
    flush();
    if (block.type === 'table') parts.push(renderTableBlock(block, context));
    if (block.type === 'attachments') parts.push(renderAttachmentsBlock(block));
  }
  flushShapes();
  flush();
  return parts.join('');
}

function cellStyle(cell: TableCellBlock): CssStyleObject {
  const style: CssStyleObject = {};
  const widthTwips = (cell.meta?.rightBoundary != null && cell.meta?.leftBoundary != null)
    ? cell.meta.rightBoundary - cell.meta.leftBoundary
    : cell.meta?.width;
  const widthPx = twipsToPx(widthTwips);
  if (widthPx) style.width = `${widthPx}px`;
  if (cell.meta?.noWrap) style['white-space'] = 'nowrap';
  if (cell.meta?.fitText) style['text-align'] = 'justify';
  if (cell.meta?.vertAlign != null) style['vertical-align'] = cssVerticalAlign(cell.meta.vertAlign);
  const borders = cell.meta?.borders || {};
  const borderAll = borderToCss(borders.all);
  const borderForSide = (side: string) => Object.prototype.hasOwnProperty.call(borders, side)
    ? borderToCss(borders[side])
    : borderAll;
  const top = borderForSide('top');
  const right = borderForSide('right');
  const bottom = borderForSide('bottom');
  const left = borderForSide('left');
  if (top) style['border-top'] = top;
  if (right) style['border-inline-end'] = right;
  if (bottom) style['border-bottom'] = bottom;
  if (left) style['border-inline-start'] = left;
  const padding = cell.meta?.paddingTwips;
  if (padding?.top != null) style['padding-top'] = `${twipsToPx(padding.top)}px`;
  if (padding?.right != null) style['padding-inline-end'] = `${twipsToPx(padding.right)}px`;
  if (padding?.bottom != null) style['padding-bottom'] = `${twipsToPx(padding.bottom)}px`;
  if (padding?.left != null) style['padding-inline-start'] = `${twipsToPx(padding.left)}px`;
  Object.assign(style, shadingToCss(cell.meta?.shading));
  return style;
}

function tableStyle(block: TableBlock): CssStyleObject {
  const style: CssStyleObject = {};
  const widthPx = twipsToPx(block.gridWidthTwips || block.state?.tableWidth?.wWidth);
  if (widthPx) style.width = `${widthPx}px`;
  else style.width = '100%';
  const marginLeft = twipsToPx(block.state?.leftIndent);
  if (marginLeft) style['margin-inline-start'] = `${marginLeft}px`;
  if (block.state?.rtl) style.direction = 'rtl';
  const spacing = block.rows.flatMap(row => row.cells).reduce((maximum, cell) => {
    const value = cell.meta?.spacingTwips;
    if (!value) return maximum;
    return {
      horizontal: Math.max(maximum.horizontal, value.left || 0, value.right || 0),
      vertical: Math.max(maximum.vertical, value.top || 0, value.bottom || 0),
    };
  }, { horizontal: 0, vertical: 0 });
  if (spacing.horizontal || spacing.vertical) {
    style['border-collapse'] = 'separate';
    style['border-spacing'] = `${twipsToPx(spacing.horizontal)}px ${twipsToPx(spacing.vertical)}px`;
  } else {
    style['border-collapse'] = 'collapse';
  }
  style['table-layout'] = 'fixed';
  return style;
}

function renderTableBlock(block: TableBlock, context: RenderContext): string {
  const rows = block.rows.map((row) => {
    const rowHeight = row.state?.rowHeight ? twipsToPx(Math.abs(row.state.rowHeight)) : null;
    const rowStyle = rowHeight ? ` style="height:${rowHeight}px"` : '';
    const cells = row.cells
      .filter((cell) => !cell.hidden)
      .map((cell) => {
        const attrs: string[] = [];
        if ((cell.colspan ?? 1) > 1) attrs.push(` colspan="${cell.colspan}"`);
        if ((cell.rowspan ?? 1) > 1) attrs.push(` rowspan="${cell.rowspan}"`);
        const style = styleObjectToCss(cellStyle(cell));
        const body = reviewParagraphs(cell.paragraphs, context)
          .map((paragraph) => renderParagraphBlock(paragraph, context, { inline: true })).join('');
        return `<td class="msdoc-cell"${attrs.join('')}${style ? ` style="${style}"` : ''}>${body || '<div class="msdoc-paragraph"><br></div>'}</td>`;
      })
      .join('');
    return `<tr class="msdoc-row"${rowStyle}>${cells}</tr>`;
  }).join('');

  return `<table class="msdoc-table msdoc-table-depth-${block.depth}" style="${styleObjectToCss(tableStyle(block))}"><tbody>${rows}</tbody></table>`;
}

function renderAttachmentsBlock(block: AttachmentsBlock): string {
  const items = block.items.map((item: AttachmentAsset) => {
    const label = escapeHtml(item.name || 'embedded-file');
    const downloadHref = sanitizeDownloadHref(item.dataUrl);
    const content = downloadHref
      ? `<a class="msdoc-attachment" href="${escapeHtml(downloadHref)}" download="${label}">📎 ${label}</a>`
      : `<span class="msdoc-attachment">📎 ${label}</span>`;
    return `<li>${content}</li>`;
  }).join('');
  return `<section class="msdoc-attachments"><div class="msdoc-attachments-title">Embedded attachments</div><ul>${items}</ul></section>`;
}

export function defaultMsDocCss(): string {
  // doc-viewer: 쪽(머리말·꼬리말·각주)·번호·글상자 모양을 더했다. 쪽 카드 모양은 앱이 정한다.
  return `
.msdoc-root{box-sizing:border-box;max-width:100%;padding:24px;background:#fff;color:#111;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.msdoc-root *{box-sizing:border-box}
.msdoc-paragraph{margin:0 0 8px;white-space:normal;word-break:break-word;overflow-wrap:anywhere}
.msdoc-line-at-least span,.msdoc-line-at-least ins,.msdoc-line-at-least del{line-height:normal}
.msdoc-paragraph:last-child{margin-bottom:0}
.msdoc-table{margin:12px 0;border-collapse:collapse;border-spacing:0;max-width:100%}
.msdoc-cell{padding:6px 8px;vertical-align:top;word-break:break-word;overflow-wrap:anywhere}
.msdoc-link{color:#1a73e8;text-decoration:none}
.msdoc-link:hover{text-decoration:underline}
.msdoc-image{display:inline-block;vertical-align:middle}
.msdoc-image-fallback{display:inline-flex;align-items:center;gap:6px}
.msdoc-attachment{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;color:#0969da;text-decoration:none}
.msdoc-attachments{margin-top:20px;padding-top:12px;border-top:1px solid #e5e7eb}
.msdoc-attachments-title{font-weight:600;margin-bottom:8px}
.msdoc-page-break{display:block;height:0;border-top:1px dashed #cbd5e1;margin:16px 0}
.msdoc-header{margin:0 0 16px;padding-bottom:6px;border-bottom:1px solid #e5e7eb;color:#444;font-size:0.92em}
.msdoc-footer{margin:16px 0 0;padding-top:6px;border-top:1px solid #e5e7eb;color:#444;font-size:0.92em}
.msdoc-header .msdoc-paragraph,.msdoc-footer .msdoc-paragraph{margin-bottom:2px}
.msdoc-notes{margin-top:20px;font-size:0.9em}
.msdoc-notes::before{content:"";display:block;width:33%;margin-bottom:6px;border-top:1px solid #6b7280}
.msdoc-note{display:flex;gap:6px;align-items:baseline}
.msdoc-note>.msdoc-note-body{flex:1;min-width:0}
.msdoc-note-label,.msdoc-note-ref a{color:inherit;text-decoration:none}
.msdoc-note-ref{font-size:0.75em;line-height:0}
.msdoc-note-label{vertical-align:super;font-size:0.75em}
.msdoc-list-label{white-space:pre}
.msdoc-shape{max-width:100%;margin:8px 0;overflow-wrap:anywhere}
.msdoc-shape-textbox{padding:6px 8px}
.msdoc-shape-picture img{max-width:100%;height:auto}
.msdoc-shape-row{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:flex-start;margin:8px 0}
.msdoc-shape-row>.msdoc-shape{margin:0}
.msdoc-tab-columns{display:flex;gap:12px;align-items:baseline}
.msdoc-tab-columns>span{flex:1 1 0;min-width:0}
.msdoc-tab-center{text-align:center}
.msdoc-tab-right{text-align:right}
`;
}

interface PageDraft {
  sectionIndex: number;
  firstOfSection: boolean;
  blocks: MsDocBlock[];
}

function blockSection(block: MsDocBlock): number | undefined {
  if (block.type === 'paragraph' || block.type === 'table') return block.sectionIndex;
  return undefined;
}

function hasVisibleContent(page: PageDraft): boolean {
  return page.blocks.some((block) => block.type !== 'paragraph' || block.inlines.length > 0 || Boolean(block.listLabel) || Boolean(block.anchors?.length));
}

/**
 * doc-viewer: 명시적 쪽 나누기(0x0C, 문단 앞 쪽 나눔)와 새 쪽에서 시작하는 구역 나누기로 쪽을 나눈다.
 * 글자 흐름에 따른 자동 쪽 나눔은 하지 않는다(화면 폭에 맞춰 줄이 다시 흐르기 때문).
 */
function paginate(blocks: MsDocBlock[], sections: SectionInfo[]): PageDraft[] {
  const pages: PageDraft[] = [];
  let current: PageDraft = { sectionIndex: 0, firstOfSection: true, blocks: [] };
  let currentSection = blockSection(blocks.find((block) => blockSection(block) != null) ?? blocks[0]!) ?? 0;
  current.sectionIndex = currentSection;
  const startNewPage = (sectionIndex: number, firstOfSection: boolean) => {
    if (hasVisibleContent(current)) pages.push(current);
    else if (current.blocks.length && pages.length) pages[pages.length - 1]!.blocks.push(...current.blocks);
    else if (current.blocks.length) {
      current = { sectionIndex, firstOfSection, blocks: current.blocks };
      return;
    }
    current = { sectionIndex, firstOfSection, blocks: [] };
  };
  for (const block of blocks) {
    const sectionIndex = blockSection(block);
    if (sectionIndex != null && sectionIndex !== currentSection) {
      const section = sections[sectionIndex];
      currentSection = sectionIndex;
      if (!section || section.breakType >= 2) startNewPage(sectionIndex, true);
    }
    if (block.type !== 'paragraph') {
      current.blocks.push(block);
      continue;
    }
    if (block.paraState.pageBreakBefore && hasVisibleContent(current)) startNewPage(currentSection, false);
    // 문단 안의 쪽 나누기 문자에서 문단을 둘로 나눈다.
    let fragment: InlineNode[] = [];
    let first = true;
    for (const node of block.inlines) {
      if (node.type !== 'pageBreak') {
        fragment.push(node);
        continue;
      }
      if (fragment.length || !first) current.blocks.push({ ...block, inlines: fragment, listLabel: first ? block.listLabel : undefined, anchors: first ? block.anchors : undefined });
      else if (first && block.anchors?.length) current.blocks.push({ ...block, inlines: [], listLabel: undefined });
      startNewPage(currentSection, false);
      fragment = [];
      first = false;
    }
    if (first) current.blocks.push(block);
    else if (fragment.length) current.blocks.push({ ...block, inlines: fragment, listLabel: undefined, anchors: undefined });
  }
  if (current.blocks.length || !pages.length) pages.push(current);
  return pages;
}

function pageLabels(pages: PageDraft[], sections: SectionInfo[]): string[] {
  const labels: string[] = [];
  let number = 0;
  pages.forEach((page) => {
    const section = sections[page.sectionIndex];
    if (page.firstOfSection && section?.pageNumberRestart) number = (section.pageNumberStart ?? 1) - 1;
    number += 1;
    labels.push(formatListNumber(number, section?.pageNumberFormat ?? 0) || String(number));
  });
  return labels;
}

function renderNotes(notes: NoteInfo[], context: RenderContext, title = ''): string {
  if (!notes.length) return '';
  const items = notes.map((note) => {
    const body = renderBlockList(note.blocks, { ...context, inNote: true, noteRefs: [] }, { inline: true });
    return `<div class="msdoc-note" id="${escapeHtml(note.id)}">${body.includes('msdoc-note-label') ? '' : `<a class="msdoc-note-label" href="#${escapeHtml(note.id)}-ref">${escapeHtml(note.label)}</a>`}<div class="msdoc-note-body">${body}</div></div>`;
  }).join('');
  return `<section class="msdoc-notes"${title ? ` aria-label="${escapeHtml(title)}"` : ''}>${items}</section>`;
}

/**
 * Converts the parsed AST into HTML and a companion CSS string.
 * Keeping rendering separate from parsing makes it easier for downstream apps
 * to customize styles or consume the AST directly.
 */
export function renderMsDoc(parsed: MsDocParseResult, options: MsDocRenderOptions = {}): MsDocRenderResult {
  const renderer = createMsDocRenderer(parsed, options);
  const pages = Array.from({ length: renderer.count }, () => renderer.next()!);
  const html = pages.map((page) => `<section class="msdoc-page">${page.html}</section>`).join('');
  return {
    pages,
    sectionHeaders: renderer.sectionHeaders,
    html,
    css: renderer.css,
    warnings: parsed.warnings || [],
    meta: parsed.meta,
    assets: parsed.assets || [],
    parsed,
  };
}

/**
 * doc-viewer: 쪽(쪽 나누기·구역 나누기 단위)을 하나씩 그린다. 큰 문서는 전체 HTML을 만드는 데 오래 걸려, 앱은 앞쪽부터
 * 받아 첫 쪽을 먼저 보인다. 각주는 처음 참조한 쪽에 붙으므로 next()로 앞에서부터 차례로만 그린다.
 */
export function createMsDocRenderer(parsed: MsDocParseResult, options: MsDocRenderOptions = {}): MsDocPageRenderer {
  const css = options.css ?? defaultMsDocCss();
  const baseContext: RenderContext = {
    reviewMode: options.reviewMode ?? 'all',
    externalLinkPolicy: options.externalLinkPolicy ?? 'block',
    externalResourcePolicy: options.externalResourcePolicy ?? 'block',
  };
  // doc-viewer: 쪽을 나눈 뒤 쪽마다 머리말 + 본문 + 그 쪽 각주 + 꼬리말을 그린다. 미주는 마지막 쪽에 둔다.
  const sections: SectionInfo[] = parsed.sections?.length
    ? parsed.sections
    : [{ index: 0, cpStart: 0, cpEnd: 0, breakType: 2, titlePage: false, headers: {}, footers: {} }];
  const drafts = parsed.blocks.length ? paginate(parsed.blocks, sections) : [{ sectionIndex: 0, firstOfSection: true, blocks: [] }];
  const labels = pageLabels(drafts, sections);
  const footnotes = new Map((parsed.notes?.footnotes ?? []).map((note) => [note.id, note]));
  const placedFootnotes = new Set<string>();
  const inSection = new Map<number, number>(); // 구역마다 지금까지 그린 쪽 수
  let index = 0;
  const next = (): MsDocRenderedPage | null => {
    if (index >= drafts.length) return null;
    const draft = drafts[index]!;
    const context: RenderContext = { ...baseContext, pageLabel: labels[index], pageCount: drafts.length, noteRefs: [] };
    const section = sections[draft.sectionIndex] ?? sections[0]!;
    const pageNumberInSection = (inSection.get(draft.sectionIndex) ?? 0) + 1;
    inSection.set(draft.sectionIndex, pageNumberInSection);
    const pick = (map: SectionInfo['headers']) => {
      if (section.titlePage && draft.firstOfSection) return map.first;
      if (map.even && pageNumberInSection % 2 === 0) return map.even;
      return map.default;
    };
    const header = pick(section.headers);
    const footer = pick(section.footers);
    const body = renderBlockList(draft.blocks, context);
    const pageNotes = (context.noteRefs ?? [])
      .filter((id) => !placedFootnotes.has(id) && footnotes.has(id))
      .map((id) => {
        placedFootnotes.add(id);
        return footnotes.get(id)!;
      });
    const isLast = index === drafts.length - 1;
    if (isLast) {
      for (const note of footnotes.values()) {
        if (!placedFootnotes.has(note.id)) pageNotes.push(note);
      }
    }
    const notesHtml = renderNotes(pageNotes, context)
      + (isLast ? renderNotes(parsed.notes?.endnotes ?? [], context, 'endnotes') : '');
    const headerHtml = header?.length ? `<header class="msdoc-header">${renderBlockList(header, context, { tabColumns: true })}</header>` : '';
    const footerHtml = footer?.length ? `<footer class="msdoc-footer">${renderBlockList(footer, context, { tabColumns: true })}</footer>` : '';
    index += 1;
    return {
      html: headerHtml + body + notesHtml + footerHtml,
      sectionIndex: draft.sectionIndex,
      firstOfSection: draft.firstOfSection,
      bodyHtml: body + notesHtml,
      headerHtml,
      footerHtml,
    };
  };
  // doc-viewer: 앱이 자동 쪽 나눔으로 쪽을 더 나누면 나눈 쪽마다 머리말·꼬리말(첫 쪽·기본·짝수 쪽)을 고를 수 있게 구역마다 함께 낸다.
  const variants = (map: SectionInfo['headers'], tag: 'header' | 'footer') => {
    const context: RenderContext = { ...baseContext, noteRefs: [] };
    const result: Partial<Record<'first' | 'default' | 'even', string>> = {};
    for (const key of ['first', 'default', 'even'] as const) {
      const blocks = map[key];
      if (blocks?.length) result[key] = `<${tag} class="msdoc-${tag}">${renderBlockList(blocks, context, { tabColumns: true })}</${tag}>`;
    }
    return result;
  };
  const sectionHeaders = sections.map((section) => ({
    titlePage: section.titlePage,
    header: variants(section.headers, 'header'),
    footer: variants(section.footers, 'footer'),
  }));
  return { css, sectionHeaders, count: drafts.length, next };
}
