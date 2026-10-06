import { toUint8Array } from '../core/binary.js';
import { parseCFB } from '../core/cfb.js';
import { cleanTextControlChars, pushWarning, shallowEqual, uniqueId } from '../core/utils.js';
import { parseClx, buildPieceTextCache, getTextByCp, makeSinglePieceClx, splitParagraphRanges } from './clx.js';
import {
  charsetToEncoding,
  decode8BitText,
  FILLER_CHAR,
  isDoubleByteEncoding,
  lidToEncoding,
  looksLikeValidDoubleByte,
} from './codepage.js';
import { DOC_CONTROL } from './constants.js';
import { colorRefToHex, extractShapeImage, readDrawing, readFspas, readTextboxRanges, type DrawingInfo, type TextboxRange } from './drawing.js';
import { parseFib } from './fib.js';
import { readChpxRuns, readPapxRuns, type ChpxRun, type PapxRun } from './fkp.js';
import { parseFonts } from './fonts.js';
import { parseHtmlWordDocumentStream } from './html-word.js';
import { formatListNumber, ListNumberer, parseListTables, type ListTables } from './lists.js';
import { parseNonOleDocument } from './nonole.js';
import { extractObjectPool, extractPictureAsset } from './objects.js';
import {
  applyTableStateToCells,
  charPropsToState,
  getTableDepth,
  paraPropsToState,
  tablePropsToState,
} from './properties.js';
import { parseSections } from './sections.js';
import { mergePropertyArrays, parseStyles, splitPropertiesByKind } from './styles.js';
import { BinaryReader } from '../core/binary.js';
import type {
  AttachmentAsset,
  CharSegment,
  CharState,
  DecodedProperty,
  FieldInstruction,
  FontInfo,
  FontsCollection,
  InlineNode,
  ListLabel,
  MsDocAsset,
  MsDocBlock,
  MsDocParseOptions,
  MsDocParseResult,
  MsDocWarning,
  NoteInfo,
  ObjectPoolInfo,
  ParagraphBlock,
  ParagraphModel,
  ParagraphRange,
  ParsedClx,
  ParsedFib,
  ResolvedStyle,
  SectionInfo,
  ShapeBlock,
  StyleCollection,
  TableBlock,
  TableCellBlock,
  TableRowBlock,
} from '../types.js';

function getOverlappingRuns<T extends { cpStart: number; cpEnd: number }>(
  runs: T[],
  cpStart: number,
  cpEnd: number,
  cursorRef?: { index: number },
): T[] {
  let cursor = cursorRef?.index || 0;
  while (cursor < runs.length && runs[cursor]!.cpEnd <= cpStart) cursor += 1;
  if (cursorRef) cursorRef.index = cursor;
  const list: T[] = [];
  let i = cursor;
  while (i < runs.length && runs[i]!.cpStart < cpEnd) {
    if (runs[i]!.cpEnd > cpStart) list.push(runs[i] as T);
    i += 1;
  }
  return list;
}

/** doc-viewer: cp보다 뒤에서 끝나는 첫 구간의 번호(정렬된 구간 목록에서 이진 탐색). */
function firstRunEndingAfter<T extends { cpStart: number; cpEnd: number }>(runs: T[], cp: number): number {
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid]!.cpEnd <= cp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function normalizeTextStyleName(name: unknown): string {
  return String(name || '').trim();
}

function decodeFieldInstruction(instruction: unknown): FieldInstruction | null {
  const normalized = String(instruction || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const upper = normalized.toUpperCase();
  if (upper.startsWith('HYPERLINK')) {
    const body = normalized.slice(9).trim();
    const quoted = body.match(/"([^"]+)"/);
    const href = quoted?.[1] || body.split(/\s+/)[0] || '';
    return href ? { type: 'hyperlink', href } : null;
  }
  if (upper.startsWith('INCLUDEPICTURE')) {
    const body = normalized.slice('INCLUDEPICTURE'.length).trim();
    const quoted = body.match(/"([^"]+)"/);
    return { type: 'includePicture', target: quoted?.[1] || body.split(/\s+/)[0] || '' };
  }
  if (upper.startsWith('EMBED')) {
    return { type: 'embed', raw: normalized };
  }
  if (upper.startsWith('LINK')) {
    return { type: 'link', raw: normalized };
  }
  // doc-viewer: 쪽 번호 필드는 렌더러가 쪽을 나눈 뒤 번호를 채운다.
  const keyword = upper.split(/[\s\\]/)[0];
  if (keyword === 'PAGE') return { type: 'page' };
  if (keyword === 'NUMPAGES' || keyword === 'SECTIONPAGES') return { type: 'numpages' };
  return { type: 'unknown', raw: normalized };
}

function mergeTextNode(target: InlineNode[], node: Extract<InlineNode, { type: 'text' }>): void {
  if (!node.text) return;
  const last = target[target.length - 1];
  if (last && last.type === 'text' && last.href === node.href && shallowEqual(last.style, node.style)) {
    last.text += node.text;
    return;
  }
  target.push(node);
}

interface FieldFrame {
  instruction: string;
  parsed: FieldInstruction | null;
  readingInstruction: boolean;
  nodes: InlineNode[];
}

function emitInline(targetStack: FieldFrame[], output: InlineNode[], node: InlineNode | null | undefined): void {
  if (!node) return;
  const target = targetStack.length ? targetStack[targetStack.length - 1]!.nodes : output;
  if (node.type === 'text') mergeTextNode(target, node);
  else target.push(node);
}

function getObjectPoolInfo(objectPool: Map<string, ObjectPoolInfo>, pictureOffset: number): ObjectPoolInfo | null {
  const candidates = [
    `_${pictureOffset}`,
    `_${String(pictureOffset)}`,
    `_${pictureOffset.toString(16)}`,
    `_${pictureOffset.toString(16).toUpperCase()}`,
  ];
  for (const key of candidates) {
    if (objectPool.has(key)) return objectPool.get(key) || null;
  }
  return null;
}

function createAssetResolver(
  dataBytes: Uint8Array,
  objectPool: Map<string, ObjectPoolInfo>,
  assets: MsDocAsset[],
  usedAttachmentNames: Set<string>,
  assetCache: Map<number, MsDocAsset | null>,
  options: MsDocParseOptions = {},
): (charState: CharState) => MsDocAsset | null {
  return function resolveAsset(charState: CharState): MsDocAsset | null {
    const pictureOffset = charState?.pictureOffset;
    if (pictureOffset == null) return null;
    if (assetCache.has(pictureOffset)) return assetCache.get(pictureOffset) || null;

    let asset: MsDocAsset | null = null;
    const objectInfo = getObjectPoolInfo(objectPool, pictureOffset);

    if ((charState.ole2 || charState.object || charState.data) && objectInfo?.attachment) {
      asset = objectInfo.attachment;
      usedAttachmentNames.add(objectInfo.entry.name);
    }

    if (!asset && dataBytes?.length) {
      const extracted = extractPictureAsset(dataBytes, pictureOffset, options);
      if (extracted && extracted.mime !== 'application/octet-stream') {
        asset = extracted;
      } else if (!asset && objectInfo?.attachment) {
        asset = objectInfo.attachment;
        usedAttachmentNames.add(objectInfo.entry.name);
      } else if (extracted) {
        asset = extracted;
      }
    }

    if (!asset && objectInfo?.attachment) {
      asset = objectInfo.attachment;
      usedAttachmentNames.add(objectInfo.entry.name);
    }

    if (asset) assets.push(asset);
    assetCache.set(pictureOffset, asset);
    return asset;
  };
}

function normalizePlainTextChar(ch: string): string {
  switch (ch) {
    case DOC_CONTROL.nonBreakingHyphen:
      return '-';
    case DOC_CONTROL.nonRequiredHyphen:
    case DOC_CONTROL.annotationRef:
    case DOC_CONTROL.textBoxPlaceholder:
    case FILLER_CHAR:
    case '\u0002':
    case '\u0003':
    case '\u0004':
      return '';
    default:
      return ch;
  }
}

/** doc-viewer: 화면에 보이는 글자만 남긴다(빈 문단 판정용). CP 정렬이 필요한 곳에는 원문을 그대로 쓴다. */
function visibleParagraphText(text: string): string {
  return text.replace(/[\u0001-\u0008\u000e-\u001f￿]/g, '');
}

type StoryKind = 'main' | 'footnote' | 'header' | 'macro' | 'annotation' | 'endnote' | 'textbox' | 'header-textbox';

interface StoryRange {
  kind: StoryKind;
  cpStart: number;
  cpEnd: number;
}

function getDocumentStoryRanges(fib: ParsedFib, documentLength: number): StoryRange[] {
  const storyLengths: Array<[StoryRange['kind'], number]> = [
    ['main', fib.fibRgLw.ccpText],
    ['footnote', fib.fibRgLw.ccpFtn],
    ['header', fib.fibRgLw.ccpHdd],
    ['macro', fib.fibRgLw.ccpMcr],
    ['annotation', fib.fibRgLw.ccpAtn],
    ['endnote', fib.fibRgLw.ccpEdn],
    ['textbox', fib.fibRgLw.ccpTxbx],
    ['header-textbox', fib.fibRgLw.ccpHdrTxbx],
  ];
  const hasDeclaredStories = storyLengths.some(([, length]) => length > 0);
  if (!hasDeclaredStories) return [{ kind: 'main', cpStart: 0, cpEnd: documentLength }];

  const ranges: StoryRange[] = [];
  let cp = 0;
  for (const [kind, rawLength] of storyLengths) {
    const length = Math.max(0, rawLength || 0);
    const cpStart = Math.min(cp, documentLength);
    cp += length;
    const cpEnd = Math.min(cp, documentLength);
    ranges.push({ kind, cpStart, cpEnd });
  }
  return ranges;
}

type PapxLike = { cpStart: number; cpEnd: number; styleId: number; properties: DecodedProperty[] };

function buildStoryParagraphRanges(
  story: StoryRange,
  documentText: string,
  papxRuns: PapxLike[],
): Array<ParagraphRange & { storyKind: StoryRange['kind'] }> {
  if (story.cpEnd <= story.cpStart) return [];
  const out: Array<ParagraphRange & { storyKind: StoryRange['kind'] }> = [];
  // doc-viewer: PAPX가 덮지 못한 구간(손상·옛 형식)은 문단 표시 문자로 나눠 채운다. 예전에는 그 글자가 사라졌다.
  const fillGap = (start: number, end: number) => {
    if (end <= start) return;
    for (const range of splitParagraphRanges(documentText.slice(start, end))) {
      out.push({
        ...range,
        cpStart: range.cpStart + start,
        cpEnd: range.cpEnd + start,
        styleId: 0,
        properties: [],
        storyKind: story.kind,
      });
    }
  };
  let cursor = story.cpStart;
  for (let i = firstRunEndingAfter(papxRuns, story.cpStart); i < papxRuns.length; i += 1) {
    const run = papxRuns[i]!;
    if (run.cpStart >= story.cpEnd) break;
    const cpStart = Math.max(story.cpStart, run.cpStart);
    const cpEnd = Math.min(story.cpEnd, run.cpEnd);
    if (cpEnd <= cpStart || cpEnd <= cursor) continue;
    fillGap(cursor, cpStart);
    const start = Math.max(cpStart, cursor);
    out.push({
      cpStart: start,
      cpEnd,
      terminator: documentText[cpEnd - 1] || '',
      styleId: run.styleId,
      properties: run.properties,
      storyKind: story.kind,
    });
    cursor = cpEnd;
  }
  fillGap(cursor, story.cpEnd);
  return out;
}

/** doc-viewer: 본문 흐름을 만드는 동안 필요한 정보. 이야기(본문·머리말·각주·글상자)마다 하나씩 만든다. */
interface NoteMark {
  kind: 'footnote' | 'endnote';
  noteId: string;
  label: string;
}

interface StoryContext {
  storyKind: StoryKind;
  styles: StyleCollection;
  fonts: FontsCollection;
  chpxRuns: ChpxRun[];
  chpxCursor: { index: number };
  resolveAsset: (charState: CharState) => MsDocAsset | null;
  marks?: Map<number, NoteMark>;
  sectionBreakCps?: Set<number>;
  sections?: SectionInfo[];
  numberer?: ListNumberer | null;
  listTables?: ListTables | null;
  anchors?: Map<number, ShapeBlock[]>;
  /** Word 6 이하: 기호 글자(sprmCSymbol)의 글꼴 이름을 찾는다 */
  resolveFont: (fontId: number | undefined) => FontInfo | null;
  /** Word 6/95 번호 매기기(ANLD) 카운터 */
  anldCounters?: Map<number, number>;
}

/**
 * doc-viewer: Word 6/95 번호 매기기. 문단의 sprmPAnld(ANLD 52바이트)와 sprmPNLvlAnm(수준)으로 번호를 만든다.
 * ANLD: nfc(1) cxchTextBefore(1) cxchTextAfter(1) 플래그(3) ftc(2) hps(2) iStartAt(2) dxaIndent(2) dxaSpace(2)
 *       fNumber1·fNumberAcross·fRestartHdn·fSpareX(4) rgchAnld(32, 8비트 글자)  — LibreOffice WW8_ANLD와 같은 배치
 * nfc 0xFF(번호 없음)·0x17(글머리 기호)는 앞 글자(대개 Symbol 글꼴의 0xB7)만 쓴다.
 */
function legacyListLabel(paraState: ParagraphModel['paraState'], context: StoryContext): ListLabel | undefined {
  const anld = paraState.anld;
  const level = Number(paraState.anmLevel || 0);
  if (!(anld instanceof Uint8Array) || anld.length < 20 || !level) return undefined;
  const nfc = anld[0] ?? 0;
  const before = Math.min(anld[1] ?? 0, 32);
  const after = Math.min(anld[2] ?? 0, 32 - before);
  const ftc = (anld[6] ?? 0) | ((anld[7] ?? 0) << 8);
  const startAt = (anld[10] ?? 0) | ((anld[11] ?? 0) << 8);
  const font = context.resolveFont(ftc);
  const symbol = /^(symbol|wingdings)/i.test(font?.name || '');
  const chars = (from: number, count: number) => {
    const raw = anld.subarray(20 + from, 20 + from + count);
    if (symbol) return Array.from(raw, (b) => String.fromCharCode(0xf000 + b)).join('');
    return decode8BitText(raw, charsetToEncoding(font?.charset) || 'windows-1252').replaceAll(FILLER_CHAR, '');
  };
  let number = '';
  if (nfc !== 0xff && nfc !== 0x17) {
    const counters = context.anldCounters ?? new Map<number, number>();
    context.anldCounters = counters;
    const value = (counters.get(level) ?? Math.max(1, startAt) - 1) + 1;
    counters.set(level, value);
    for (const key of Array.from(counters.keys())) if (key > level && key <= 9) counters.delete(key);
    number = formatListNumber(value, nfc);
  }
  const text = chars(0, before) + number + chars(before, after);
  if (!text.trim()) return undefined;
  const style = charPropsToState([]);
  if (font?.name) style.fontFamily = font.name;
  return { text, follow: 'tab', style };
}

function buildInlineNodes(segments: CharSegment[], context: StoryContext): InlineNode[] {
  const output: InlineNode[] = [];
  const fieldStack: FieldFrame[] = [];

  for (const segment of segments) {
    if (!segment.text || segment.state.hidden) continue;
    const text = segment.text;
    for (let index = 0; index < text.length; index += 1) {
      const rawCh = text[index]!;
      const cp = segment.cpStart + index;
      // doc-viewer: 각주·미주 참조. 자동 번호(0x02)면 번호를, 사용자 지정 표시면 그 글자를 위첨자로 단다.
      const mark = context.marks?.get(cp);
      if (mark && fieldStack.every((frame) => !frame.readingInstruction)) {
        emitInline(fieldStack, output, {
          type: 'noteRef',
          kind: mark.kind,
          noteId: mark.noteId,
          label: rawCh === '\u0002' ? mark.label : rawCh,
          style: segment.state,
        });
        continue;
      }
      if (rawCh === DOC_CONTROL.pageBreak && context.sectionBreakCps?.has(cp)) continue;
      let ch = normalizePlainTextChar(rawCh);
      // doc-viewer: 기호 삽입(sprmCSymbol)은 본문에 자리표시 문자만 두고 실제 글자와 글꼴을 속성에 둔다.
      let style = segment.state;
      if (segment.state.special && segment.state.symbol && (rawCh === '(' || rawCh === '(')) {
        const symbol = segment.state.symbol as { font?: number; charCode?: number };
        if (symbol.charCode) {
          ch = String.fromCharCode(symbol.charCode < 0x100 ? 0xf000 + symbol.charCode : symbol.charCode);
          const font = context.resolveFont(symbol.font);
          if (font?.name) style = { ...segment.state, fontFamily: font.name };
        }
      }
      if (!ch) continue;

      if (ch === DOC_CONTROL.fieldStart) {
        fieldStack.push({ instruction: '', parsed: null, readingInstruction: true, nodes: [] });
        continue;
      }
      if (ch === DOC_CONTROL.fieldSeparator) {
        const current = fieldStack[fieldStack.length - 1];
        if (current) {
          current.parsed = decodeFieldInstruction(current.instruction);
          current.readingInstruction = false;
        }
        continue;
      }
      if (ch === DOC_CONTROL.fieldEnd) {
        const current = fieldStack.pop();
        if (!current) continue;
        let nodes = current.nodes;
        if (current.readingInstruction) {
          current.parsed = decodeFieldInstruction(current.instruction);
        }
        if (current.parsed?.type === 'hyperlink') {
          const href = current.parsed.href;
          nodes = nodes.map((node) => {
            if (node.type === 'lineBreak' || node.type === 'pageBreak') return node;
            return { ...node, href } as InlineNode;
          });
        }
        if (current.parsed?.type === 'page' || current.parsed?.type === 'numpages') {
          const textNodes = nodes.filter((node): node is Extract<InlineNode, { type: 'text' }> => node.type === 'text');
          emitInline(fieldStack, output, {
            type: 'field',
            field: current.parsed.type,
            text: textNodes.map((node) => node.text).join(''),
            style: textNodes[0]?.style ?? style,
          });
          continue;
        }
        for (const node of nodes) emitInline(fieldStack, output, node);
        continue;
      }

      const currentField = fieldStack[fieldStack.length - 1];
      if (currentField?.readingInstruction) {
        currentField.instruction += ch;
        continue;
      }

      if (ch === DOC_CONTROL.hardLineBreak || ch === '\u000e') {
        emitInline(fieldStack, output, { type: 'lineBreak', style });
        continue;
      }
      if (ch === DOC_CONTROL.pageBreak) {
        emitInline(fieldStack, output, { type: 'pageBreak', style });
        continue;
      }
      if (ch === DOC_CONTROL.picture) {
        const asset = context.resolveAsset(segment.state);
        if (asset?.type === 'image') {
          emitInline(fieldStack, output, { type: 'image', asset, style });
        } else if (asset?.type === 'attachment') {
          emitInline(fieldStack, output, { type: 'attachment', asset, style });
        }
        continue;
      }
      // 그 밖의 제어 문자(0x00~0x1F, 탭 제외)는 그리지 않는다.
      if (ch < ' ' && ch !== '\t') continue;

      emitInline(fieldStack, output, {
        type: 'text',
        text: cleanTextControlChars(ch),
        style,
      });
    }
  }

  while (fieldStack.length) {
    const current = fieldStack.pop()!;
    for (const node of current.nodes) emitInline(fieldStack, output, node);
  }

  return output;
}

function resolveCharacterFonts(
  state: CharState,
  resolveFont: (id: number | undefined) => FontInfo | null,
  defaults: StyleCollection['header'],
): void {
  for (const [id, name, fallback] of [
    ['fontFamilyId', 'fontFamily', defaults?.ftcAsci],
    ['fontFamilyEastAsiaId', 'fontFamilyEastAsia', defaults?.ftcFE],
    ['fontFamilyOtherId', 'fontFamilyOther', defaults?.ftcOther],
    ['fontFamilyBiId', 'fontFamilyBi', undefined],
  ] as const) {
    const index = state[id] ?? fallback;
    const font = resolveFont(index);
    if (font) {
      state[id] = index;
      state[name] = font.name || font.altName || undefined;
    }
  }
}

function buildCharSegments(
  range: ParagraphRange,
  paragraphText: string,
  chpxRuns: ChpxRun[],
  styles: StyleCollection,
  baseCharProps: DecodedProperty[],
  resolveFont: (fontId: number | undefined) => FontInfo | null,
  cursorRef: { index: number },
  forceReadableColors = false,
): CharSegment[] {
  const overlaps = getOverlappingRuns(chpxRuns, range.cpStart, range.cpEnd, cursorRef);
  const boundaries = new Set<number>([range.cpStart, range.cpEnd]);
  for (const run of overlaps) {
    boundaries.add(Math.max(range.cpStart, run.cpStart));
    boundaries.add(Math.min(range.cpEnd, run.cpEnd));
  }
  const points = Array.from(boundaries).sort((a, b) => a - b);
  const segments: CharSegment[] = [];

  for (let i = 0; i < points.length - 1; i += 1) {
    const cpStart = points[i]!;
    const cpEnd = points[i + 1]!;
    if (cpEnd <= cpStart) continue;
    const coveringRun = overlaps.find((run) => run.cpStart <= cpStart && run.cpEnd >= cpEnd);
    const directProps = coveringRun?.properties || [];
    const directState = charPropsToState(directProps);
    const charStyleProps = directState.charStyleId != null ? styles.resolveStyle(directState.charStyleId).charProps : [];
    const finalProps = mergePropertyArrays(baseCharProps, charStyleProps, directProps);
    const state = charPropsToState(finalProps);
    if (forceReadableColors && state.colorIndex === 8) state.colorIndex = 1;
    resolveCharacterFonts(state, resolveFont, styles.header);
    const localStart = cpStart - range.cpStart;
    const localEnd = cpEnd - range.cpStart;
    const text = paragraphText.slice(localStart, localEnd);
    if (!text) continue;
    const last = segments[segments.length - 1];
    if (last && shallowEqual(last.state, state)) {
      last.text += text;
      last.cpEnd = cpEnd;
      continue;
    }
    segments.push({ cpStart, cpEnd, text, state });
  }

  if (!segments.length && paragraphText) {
    const state = charPropsToState(baseCharProps);
    if (forceReadableColors && state.colorIndex === 8) state.colorIndex = 1;
    resolveCharacterFonts(state, resolveFont, styles.header);
    segments.push({ cpStart: range.cpStart, cpEnd: range.cpEnd, text: paragraphText, state });
  }

  return segments;
}

function buildParagraphModel(
  range: ParagraphRange & { storyKind?: StoryRange['kind'] },
  paragraphText: string,
  context: StoryContext,
): ParagraphModel {
  const { styles } = context;
  const directSplit = splitPropertiesByKind(range.properties || []);
  const paraStyleId = range.styleId || (directSplit.para.find((item) => item.name === 'styleId')?.value as number | undefined) || 0;
  const paraStyle: ResolvedStyle = styles.resolveStyle(paraStyleId);
  let paraProps = mergePropertyArrays(paraStyle.paraProps, directSplit.para);
  let paraState = paraPropsToState(paraProps);

  // doc-viewer: 번호 매기기. 목록 수준의 문단 속성(들여쓰기)은 스타일과 직접 서식 사이에 끼운다.
  let listLabel: ListLabel | undefined;
  let listCharProps: DecodedProperty[] | undefined;
  if (context.numberer && paraState.listId) {
    const resolved = context.numberer.label({ ilfo: paraState.listId, ilvl: paraState.listLevel ?? 0 });
    if (resolved) {
      paraProps = mergePropertyArrays(paraStyle.paraProps, resolved.level.paraProps, directSplit.para);
      paraState = paraPropsToState(paraProps);
      listCharProps = resolved.level.charProps;
      listLabel = { text: resolved.text, follow: resolved.level.follow };
    }
  }

  if (!listLabel && paraState.anld) {
    listLabel = legacyListLabel(paraState, context);
  } else if (!paraState.anld && context.anldCounters?.size && !paraState.listId) {
    // 번호 없는 문단이 끼면 Word 6 번호는 새로 센다.
    context.anldCounters.clear();
  }

  const directTableState = tablePropsToState(directSplit.table);
  const tableStyleProps = directTableState.styleId != null ? styles.resolveStyle(directTableState.styleId).tableProps : [];
  const tableProps = mergePropertyArrays(tableStyleProps, directSplit.table);
  const tableState = tablePropsToState(tableProps);

  const baseCharProps = paraStyle.charProps;
  const resolveFont = context.resolveFont;
  const segments = buildCharSegments(
    range,
    paragraphText,
    context.chpxRuns,
    styles,
    baseCharProps,
    resolveFont,
    context.chpxCursor,
    range.storyKind === 'textbox' || range.storyKind === 'header-textbox',
  );
  const inlines = buildInlineNodes(segments, context);
  // The terminator has its own CHPX run and is not part of paragraphText.
  const markSegment = range.terminator === DOC_CONTROL.paragraph
    ? buildCharSegments(
      { ...range, cpStart: range.cpEnd - 1 },
      range.terminator,
      context.chpxRuns,
      styles,
      baseCharProps,
      resolveFont,
      { index: context.chpxCursor.index },
    )[0]
    : undefined;
  const markState = markSegment?.state;

  if (listLabel) {
    // 번호의 글자 모양 = 문단 표시의 글자 모양 + 목록 수준의 글자 속성
    const labelState = charPropsToState(mergePropertyArrays(baseCharProps, listCharProps));
    resolveCharacterFonts(labelState, resolveFont, styles.header);
    if (markState) {
      for (const key of ['fontSizeHalfPoints', 'colorIndex', 'bold', 'italic'] as const) {
        if (!(listCharProps || []).some((prop) => prop.name === key) && markState[key] != null) {
          (labelState as Record<string, unknown>)[key] = markState[key];
        }
      }
    }
    // Word 6 번호(ANLD)는 번호 글꼴(대개 Symbol)을 따로 정한다.
    if (!listCharProps && listLabel.style?.fontFamily) labelState.fontFamily = listLabel.style.fontFamily;
    labelState.underline = 0;
    listLabel.style = labelState;
  }

  return {
    id: uniqueId('para'),
    cpStart: range.cpStart,
    cpEnd: range.cpEnd,
    terminator: range.terminator || '',
    paragraphMark: markState && {
      revisionDeleted: markState.revisionDeleted,
      revisionInserted: markState.revisionInserted,
    },
    storyKind: range.storyKind,
    text: visibleParagraphText(paragraphText),
    rawProperties: range.properties || [],
    styleId: paraStyleId,
    styleName: normalizeTextStyleName(styles.styles.get(paraStyleId)?.name),
    paraProps,
    paraState,
    tableProps,
    tableState,
    segments,
    inlines,
    listLabel,
  };
}

export function finalizeTableGrid(rows: TableRowBlock[]): void {
  for (const row of rows) {
    row.cells.forEach((cell, index) => {
      cell.colIndex = index;
      cell.colspan = 1;
      cell.rowspan = 1;
      cell.hidden = false;
    });
    for (let i = 0; i < row.cells.length; i += 1) {
      const cell = row.cells[i]!;
      const merge = cell.meta?.merge || 0;
      if (merge === 1) {
        continue;
      }
      if (merge > 1) {
        let j = i + 1;
        while (j < row.cells.length && (row.cells[j]!.meta?.merge || 0) === 1) {
          row.cells[j]!.hidden = true;
          cell.colspan = (cell.colspan || 1) + 1;
          j += 1;
        }
        const lastCell = row.cells[j - 1];
        if (cell.meta && lastCell?.meta && lastCell !== cell) {
          cell.meta.rightBoundary = lastCell.meta.rightBoundary;
          if (cell.meta.leftBoundary != null && cell.meta.rightBoundary != null) {
            cell.meta.width = Math.max(0, cell.meta.rightBoundary - cell.meta.leftBoundary);
          }
          const rightBorder = lastCell.meta.borders?.right;
          if (rightBorder) {
            cell.meta.borders = {
              ...(cell.meta.borders || {}),
              right: rightBorder,
            };
          }
        }
      }
    }
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    for (const cell of row.cells) {
      if (cell.hidden) continue;
      const vertMerge = cell.meta?.vertMerge || 0;
      if (vertMerge === 1) {
        continue;
      }
      if (vertMerge > 1) {
        let nextIndex = rowIndex + 1;
        while (nextIndex < rows.length) {
          let canMerge = true;
          for (let col = cell.colIndex || 0; col < (cell.colIndex || 0) + (cell.colspan || 1); col += 1) {
            const nextCell = rows[nextIndex]!.cells[col];
            if (!nextCell || (nextCell.meta?.vertMerge || 0) !== 1) {
              canMerge = false;
              break;
            }
          }
          if (!canMerge) break;
          for (let col = cell.colIndex || 0; col < (cell.colIndex || 0) + (cell.colspan || 1); col += 1) {
            rows[nextIndex]!.cells[col]!.hidden = true;
          }
          cell.rowspan = (cell.rowspan || 1) + 1;
          nextIndex += 1;
        }
        const bottomCell = rows[nextIndex - 1]?.cells[cell.colIndex || 0];
        const bottomBorder = bottomCell?.meta?.borders?.bottom;
        if (cell.meta && bottomCell?.meta && bottomCell !== cell && bottomBorder) {
          cell.meta.borders = {
            ...(cell.meta.borders || {}),
            bottom: bottomBorder,
          };
        }
      }
    }
  }

  // HTML tables need one shared column grid even when Word stores a different
  // TDefTable boundary list per row (usually because cells are merged). Map
  // every visible cell back onto the union of physical boundaries so colspan
  // preserves the original geometry instead of squeezing later row cells.
  const boundaries = Array.from(new Set(rows.flatMap((row) => row.cells.flatMap((cell) => {
    const left = cell.meta?.leftBoundary;
    const right = cell.meta?.rightBoundary;
    return [left, right].filter((value): value is number => value != null);
  })))).sort((left, right) => left - right);
  if (boundaries.length > 1) {
    for (const row of rows) {
      for (const cell of row.cells) {
        if (!cell.meta) continue;
        const leftIndex = boundaries.indexOf(cell.meta.leftBoundary ?? Number.NaN);
        const rightIndex = boundaries.indexOf(cell.meta.rightBoundary ?? Number.NaN);
        if (leftIndex >= 0) cell.colIndex = leftIndex;
        if (!cell.hidden && leftIndex >= 0 && rightIndex > leftIndex) {
          cell.colspan = rightIndex - leftIndex;
        }
      }
    }
  }
}

function resolveTableGridBorders(rows: TableRowBlock[]): void {
  const hasOwnBorder = (borders: Record<string, unknown>, side: string) => (
    Object.prototype.hasOwnProperty.call(borders, side) && (() => {
      const border = borders[side] as { borderType?: number; nil?: boolean } | undefined;
      // An all-zero BRC is an empty cell-level value and still inherits the
      // table edge/inside border. NilBrc is the explicit "no border" value.
      return Boolean(border?.nil || border?.borderType);
    })()
  );
  rows.forEach((row, rowIndex) => {
    row.cells.forEach((cell) => {
      if (cell.hidden || !cell.meta) return;
      const explicit = { ...(cell.meta.borders || {}) };
      const table = row.state.borders || {};
      const startColumn = cell.colIndex || 0;
      const endColumn = startColumn + (cell.colspan || 1);
      const endRow = rowIndex + (cell.rowspan || 1);
      const assignFallback = (side: string, border: typeof table.top) => {
        if (!hasOwnBorder(explicit, side) && border) explicit[side] = border;
      };
      assignFallback('top', rowIndex === 0 ? table.top : table.horizontalInside);
      assignFallback('bottom', endRow >= rows.length ? table.bottom : table.horizontalInside);
      assignFallback('left', startColumn === 0 ? table.left : table.verticalInside);
      assignFallback('right', endColumn >= row.cells.length ? table.right : table.verticalInside);
      cell.meta.borders = explicit;
    });
  });
}

function paragraphToBlock(paragraph: ParagraphModel): ParagraphBlock {
  const block: ParagraphBlock = {
    type: 'paragraph',
    id: paragraph.id,
    styleId: paragraph.styleId,
    styleName: paragraph.styleName,
    paraState: paragraph.paraState,
    inlines: paragraph.inlines,
    text: paragraph.text,
    paragraphMark: paragraph.paragraphMark,
    storyKind: paragraph.storyKind,
  };
  if (paragraph.sectionIndex != null) block.sectionIndex = paragraph.sectionIndex;
  if (paragraph.endsSection) block.endsSection = true;
  if (paragraph.listLabel) block.listLabel = paragraph.listLabel;
  if (paragraph.anchors?.length) block.anchors = paragraph.anchors;
  return block;
}

function tableGridSignature(paragraph: ParagraphModel): string {
  const cells = applyTableStateToCells(paragraph.tableState);
  if (!cells.length) return '';
  const state = paragraph.tableState;
  const border = (side: keyof typeof state.borders) => {
    const value = state.borders?.[side];
    return `${value?.borderType ?? ''}:${value?.lineWidth ?? ''}:${value?.nil ? 1 : 0}`;
  };
  return [
    cells[0]?.leftBoundary ?? '',
    cells[cells.length - 1]?.rightBoundary ?? '',
    state.alignment ?? '',
    state.leftIndent ?? '',
    state.gapHalf ?? '',
    state.rtl ? 1 : 0,
    border('top'),
    border('left'),
    border('bottom'),
    border('right'),
    border('horizontalInside'),
    border('verticalInside'),
  ].join('|');
}

function inheritRowEndTableState(paragraph: ParagraphModel, rowEnd: ParagraphModel): void {
  paragraph.paraState.inTable = true;
  paragraph.paraState.itap = Math.max(rowEnd.paraState.itap || 1, paragraph.paraState.itap || 0);
  paragraph.tableState = rowEnd.tableState;
  paragraph.tableProps = rowEnd.tableProps;
}

export function normalizeRowEndOnlyTables(paragraphs: ParagraphModel[]): void {
  for (let index = 0; index < paragraphs.length; index += 1) {
    const rowEnd = paragraphs[index]!;
    const cellCount = applyTableStateToCells(rowEnd.tableState).length;
    if (!rowEnd.paraState.tableRowEnd || !cellCount) continue;

    rowEnd.paraState.inTable = true;
    rowEnd.paraState.itap = Math.max(1, rowEnd.paraState.itap || 0);

    let remainingCells = cellCount;
    let cursor = index - 1;
    const rowParagraphs: ParagraphModel[] = [];
    for (; cursor >= 0 && remainingCells > 0; cursor -= 1) {
      const paragraph = paragraphs[cursor]!;
      if (paragraph.paraState.tableRowEnd || paragraph.paraState.innerTableRowEnd) break;
      rowParagraphs.push(paragraph);
      if (paragraph.terminator === DOC_CONTROL.cellMark) remainingCells -= 1;
    }

    if (remainingCells > 0) continue;

    // Some Word/WPS producers store all table properties only on the row-end
    // PAPX. Paragraph marks inside a cell then look like ordinary paragraphs.
    // When the immediately preceding row has the same outer grid and table
    // border identity, everything between the two row terminators belongs to
    // the current row, including leading paragraphs in its first cell.
    let previousRowEndIndex = cursor;
    while (
      previousRowEndIndex >= 0
      && !paragraphs[previousRowEndIndex]!.paraState.tableRowEnd
      && !paragraphs[previousRowEndIndex]!.paraState.innerTableRowEnd
      && paragraphs[previousRowEndIndex]!.terminator !== DOC_CONTROL.cellMark
    ) {
      previousRowEndIndex -= 1;
    }
    const previousRowEnd = paragraphs[previousRowEndIndex];
    if (
      previousRowEnd?.paraState.tableRowEnd
      && tableGridSignature(previousRowEnd) === tableGridSignature(rowEnd)
    ) {
      for (let leading = previousRowEndIndex + 1; leading < index; leading += 1) {
        const paragraph = paragraphs[leading]!;
        if (!rowParagraphs.includes(paragraph)) rowParagraphs.push(paragraph);
      }
    }

    rowParagraphs.forEach((paragraph) => inheritRowEndTableState(paragraph, rowEnd));
  }
}

function buildTableBlock(tableParagraphs: ParagraphModel[]): TableBlock {
  const rows: TableRowBlock[] = [];
  let pendingRow: { cells: TableCellBlock[] } = { cells: [] };
  let pendingCellParagraphs: ParagraphModel[] = [];

  for (const paragraph of tableParagraphs) {
    pendingCellParagraphs.push(paragraph);
    if (paragraph.terminator === DOC_CONTROL.cellMark) {
      pendingRow.cells.push({
        id: uniqueId('cell'),
        paragraphs: pendingCellParagraphs.map(paragraphToBlock),
        meta: null,
      });
      pendingCellParagraphs = [];

      if (paragraph.paraState.tableRowEnd || paragraph.paraState.innerTableRowEnd) {
        const cellDefs = applyTableStateToCells(paragraph.tableState);
        while (
          cellDefs.length &&
          pendingRow.cells.length > cellDefs.length &&
          pendingRow.cells[pendingRow.cells.length - 1]!.paragraphs.every((block) => !block.text && !(block.inlines || []).length)
        ) {
          pendingRow.cells.pop();
        }
        pendingRow.cells.forEach((cell, index) => {
          cell.meta = cellDefs[index] || { index };
        });
        const gridWidthTwips = cellDefs.length
          ? ((cellDefs[cellDefs.length - 1]!.rightBoundary || 0) - (cellDefs[0]!.leftBoundary || 0))
          : 0;
        rows.push({
          id: uniqueId('row'),
          cells: pendingRow.cells,
          state: paragraph.tableState,
          gridWidthTwips,
        });
        pendingRow = { cells: [] };
      }
    }
  }

  if (pendingCellParagraphs.length) {
    pendingRow.cells.push({ id: uniqueId('cell'), paragraphs: pendingCellParagraphs.map(paragraphToBlock), meta: null });
  }
  if (pendingRow.cells.length) {
    rows.push({ id: uniqueId('row'), cells: pendingRow.cells, state: tableParagraphs[0]?.tableState || tablePropsToState([]), gridWidthTwips: 0 });
  }

  finalizeTableGrid(rows);
  resolveTableGridBorders(rows);

  const gridWidthTwips = rows.find((row) => row.gridWidthTwips)?.gridWidthTwips || 0;
  const depth = Math.max(...tableParagraphs.map((paragraph) => getTableDepth(paragraph.paraState)), 1);

  const block: TableBlock = {
    type: 'table',
    id: uniqueId('table'),
    depth,
    rows,
    state: rows[0]?.state || tablePropsToState([]),
    gridWidthTwips,
  };
  const sectionIndex = tableParagraphs[0]?.sectionIndex;
  if (sectionIndex != null) block.sectionIndex = sectionIndex;
  return block;
}

function buildBlocks(paragraphs: ParagraphModel[]): MsDocBlock[] {
  const blocks: MsDocBlock[] = [];
  let index = 0;
  while (index < paragraphs.length) {
    const paragraph = paragraphs[index]!;
    const depth = getTableDepth(paragraph.paraState);
    if (depth <= 0) {
      // doc-viewer: 본문 문단에 고정된 도형은 문단 바로 앞에 블록으로 둔다.
      if (paragraph.anchors?.length) blocks.push(...paragraph.anchors);
      if (!paragraph.anchorOnly) blocks.push({ ...paragraphToBlock(paragraph), anchors: undefined });
      index += 1;
      continue;
    }
    const tableParagraphs: ParagraphModel[] = [];
    while (index < paragraphs.length && getTableDepth(paragraphs[index]!.paraState) > 0) {
      tableParagraphs.push(paragraphs[index]!);
      index += 1;
    }
    blocks.push(buildTableBlock(tableParagraphs));
  }
  return blocks;
}

function sectionIndexAt(sections: SectionInfo[], cp: number): number {
  let lo = 0;
  let hi = sections.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sections[mid]!.cpStart <= cp) lo = mid;
    else hi = mid - 1;
  }
  return sections[lo]?.index ?? 0;
}

/** doc-viewer: 한 이야기의 CP 구간을 문단 모델로 만든다. 본문·머리말·각주·글상자가 같이 쓴다. */
function buildRangeParagraphs(
  story: StoryRange,
  documentText: string,
  wordBytes: Uint8Array,
  clx: ParsedClx,
  pieceTexts: string[],
  papxRuns: PapxRun[],
  context: StoryContext,
): ParagraphModel[] {
  const ranges = buildStoryParagraphRanges(story, documentText, papxRuns);
  context.chpxCursor.index = firstRunEndingAfter(context.chpxRuns, story.cpStart);
  const paragraphs: ParagraphModel[] = [];
  for (const range of ranges) {
    const rawParagraphText = getTextByCp(wordBytes, clx, pieceTexts, range.cpStart, range.cpEnd);
    const terminator = range.terminator === DOC_CONTROL.paragraph || range.terminator === DOC_CONTROL.cellMark ? range.terminator : '';
    const rawContent = terminator && rawParagraphText.endsWith(terminator)
      ? rawParagraphText.slice(0, -1)
      : rawParagraphText;
    const anchors: ShapeBlock[] = [];
    if (context.anchors?.size) {
      for (let cp = range.cpStart; cp < range.cpEnd; cp += 1) {
        const found = context.anchors.get(cp);
        if (found) anchors.push(...found);
      }
      // 한 문단에 여러 도형이 고정되면(표지·이력서처럼 글상자로 짠 문서) 위에서 아래, 왼쪽에서 오른쪽 순서로 읽히게 한다.
      if (anchors.length > 1) {
        const row = (shape: ShapeBlock) => Math.round((shape.topTwips ?? 0) / 240);
        anchors.sort((a, b) => row(a) - row(b) || (a.leftTwips ?? 0) - (b.leftTwips ?? 0));
      }
    }
    const visible = visibleParagraphText(rawContent).replace(/[\f]/g, '');
    const isTextBoxStory = range.storyKind === 'textbox' || range.storyKind === 'header-textbox';
    const onlyAnchorChars = rawContent.includes(DOC_CONTROL.textBoxPlaceholder) && !visible.trim();
    if ((onlyAnchorChars || isTextBoxStory) && !visible.trim() && !rawContent.includes(DOC_CONTROL.picture)) {
      if (anchors.length) {
        paragraphs.push({ ...buildParagraphModel({ ...range, terminator }, '', context), anchors, anchorOnly: true });
      }
      continue;
    }
    const model = buildParagraphModel({ ...range, terminator }, rawContent, context);
    if (anchors.length) model.anchors = anchors;
    if (context.sections && story.kind === 'main') {
      model.sectionIndex = sectionIndexAt(context.sections, range.cpStart);
      const last = range.cpEnd - 1;
      if (documentText[last] === DOC_CONTROL.pageBreak && context.sectionBreakCps?.has(last)) model.endsSection = true;
    }
    paragraphs.push(model);
  }
  normalizeRowEndOnlyTables(paragraphs);
  return paragraphs;
}

/** doc-viewer: Word 6/95·Word 2의 8비트 본문을 글자 속성(글꼴 문자 집합·언어)에 맞는 코드 페이지로 푼다. */
function decodeLegacyPieceTexts(
  wordBytes: Uint8Array,
  clx: ParsedClx,
  fib: ParsedFib,
  chpxRuns: ChpxRun[],
  papxRuns: PapxRun[],
  styles: StyleCollection,
  fonts: FontsCollection,
): { pieceTexts: string[]; encodings: Set<string> } {
  const docEncoding = fib.chse === 256 ? 'macintosh' : lidToEncoding(fib.base.lid) || 'windows-1252';
  const japaneseDoc = (fib.base.lid & 0x3ff) === 0x11;
  // 글꼴 표에 2바이트 문자 집합 글꼴이 있으면, 언어가 영어로 저장된 한글 문서도 알아볼 수 있게 후보로 둔다.
  let dbcsHint: string | null = isDoubleByteEncoding(docEncoding) ? docEncoding : null;
  if (!dbcsHint) {
    for (const font of fonts.fonts) {
      const enc = charsetToEncoding(font.charset);
      if (isDoubleByteEncoding(enc) && (enc !== 'shift_jis' || japaneseDoc)) {
        dbcsHint = enc;
        break;
      }
    }
  }
  const encodingFor = (props: DecodedProperty[]): string => {
    let chse: { diff?: boolean; charset?: number } | undefined;
    let fontId: number | undefined;
    let eastAsiaFontId: number | undefined;
    let lid: number | undefined;
    for (const prop of props) {
      if (prop.name === 'chse') chse = prop.value as { diff?: boolean; charset?: number };
      else if (prop.name === 'fontFamilyId') fontId = prop.value as number;
      else if (prop.name === 'fontFamilyEastAsiaId') eastAsiaFontId = prop.value as number;
      else if (prop.name === 'lid') lid = prop.value as number;
    }
    if (chse?.diff) {
      const enc = charsetToEncoding(chse.charset);
      if (enc) return enc;
    }
    const languageJapanese = ((lid ?? fib.base.lid) & 0x3ff) === 0x11;
    const fromFont = (id: number | undefined) => {
      const font = fonts.byIndex(id ?? styles.header?.ftcAsci);
      if (!font) return null;
      if (font.charset === 77) return docEncoding;
      // LibreOffice처럼 Word 6/95의 ANSI(0)는 '알 수 없음'으로 보고 언어로 정한다.
      if (font.charset === 0 || font.charset === 1) return null;
      const enc = charsetToEncoding(font.charset);
      // LibreOffice·StarOffice가 Word 95로 내보낸 파일은 글꼴 문자 집합을 엉뚱하게 932로 적곤 한다(fdo#82904).
      if (enc === 'shift_jis' && !languageJapanese) return null;
      return enc;
    };
    const eastAsia = fromFont(eastAsiaFontId);
    if (eastAsia && isDoubleByteEncoding(eastAsia)) return eastAsia;
    return fromFont(fontId) || lidToEncoding(lid) || docEncoding;
  };

  // 문단 스타일의 글자 속성 위에 글자 런 속성을 얹어 코드 페이지를 고른다.
  const segments: Array<{ cpStart: number; cpEnd: number; encoding: string }> = [];
  const styleCharCache = new Map<number, DecodedProperty[]>();
  const styleChars = (styleId: number) => {
    let value = styleCharCache.get(styleId);
    if (!value) {
      value = styles.resolveStyle(styleId).charProps;
      styleCharCache.set(styleId, value);
    }
    return value;
  };
  let papxIndex = 0;
  for (const run of chpxRuns) {
    while (papxIndex < papxRuns.length && papxRuns[papxIndex]!.cpEnd <= run.cpStart) papxIndex += 1;
    const para = papxRuns[papxIndex];
    const base = para && para.cpStart <= run.cpStart ? styleChars(para.styleId) : styleChars(0);
    segments.push({ cpStart: run.cpStart, cpEnd: run.cpEnd, encoding: encodingFor([...base, ...run.properties]) });
  }
  const fallbackEncoding = encodingFor(styleChars(0));

  const encodings = new Set<string>();
  // 동아시아판 Word 95(fExtChar): CP마다 16비트 값이다. 0x3000 이상이면 (앞 바이트 << 8 | 뒤 바이트)로 저장한
  // 2바이트 문자 코드이고, 그보다 작으면 아래 바이트가 한 바이트 문자다(LibreOffice ReadPlainChars와 같은 처리).
  const cjkEncoding = dbcsHint || 'euc-kr';
  const decodeExtChars = (bytes: Uint8Array, singleByteEncoding: string): string => {
    const out: string[] = [];
    let pending: number[] = [];
    const flush = () => {
      if (!pending.length) return;
      out.push(decode8BitText(Uint8Array.from(pending), singleByteEncoding));
      pending = [];
    };
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const value = (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8);
      if (value >= 0x3000) {
        flush();
        const ch = decode8BitText(Uint8Array.of(value >> 8, value & 0xff), cjkEncoding).replaceAll(FILLER_CHAR, '');
        out.push(ch.length === 1 ? ch : '\ufffd');
        encodings.add(cjkEncoding);
      } else {
        pending.push(value & 0xff);
      }
    }
    flush();
    return out.join('');
  };
  const pieceTexts = clx.pcdt.pieceTable.pieces.map((piece) => {
    if (!piece.compressed) {
      if (fib.base.fExtChar) {
        const parts: string[] = [];
        let cp = piece.cpStart;
        let segIndex = firstRunEndingAfter(segments, cp);
        while (cp < piece.cpEnd) {
          const seg = segments[segIndex];
          let end = piece.cpEnd;
          let encoding = fallbackEncoding;
          if (seg && seg.cpStart <= cp) {
            end = Math.min(piece.cpEnd, seg.cpEnd);
            encoding = seg.encoding;
            segIndex += 1;
          } else if (seg) {
            end = Math.min(piece.cpEnd, seg.cpStart);
          }
          if (end <= cp) end = cp + 1;
          const start = piece.actualByteStart + (cp - piece.cpStart) * 2;
          const sbcs = isDoubleByteEncoding(encoding) ? (lidToEncoding(fib.base.lid) || 'windows-1252') : encoding;
          encodings.add(sbcs);
          let text = decodeExtChars(wordBytes.subarray(start, piece.actualByteStart + (end - piece.cpStart) * 2), isDoubleByteEncoding(sbcs) ? 'windows-1252' : sbcs);
          if (text.length < end - cp) text = text.padEnd(end - cp, FILLER_CHAR);
          parts.push(text);
          cp = end;
        }
        return parts.join('');
      }
      return new TextDecoder('utf-16le').decode(wordBytes.subarray(piece.actualByteStart, piece.actualByteEnd));
    }
    const parts: string[] = [];
    let cp = piece.cpStart;
    let segIndex = firstRunEndingAfter(segments, cp);
    while (cp < piece.cpEnd) {
      const seg = segments[segIndex];
      let end: number;
      let encoding: string;
      if (seg && seg.cpStart <= cp) {
        end = Math.min(piece.cpEnd, seg.cpEnd);
        encoding = seg.encoding;
        segIndex += 1;
      } else {
        end = Math.min(piece.cpEnd, seg ? seg.cpStart : piece.cpEnd);
        encoding = fallbackEncoding;
      }
      if (end <= cp) {
        end = cp + 1;
      }
      const start = piece.actualByteStart + (cp - piece.cpStart);
      const bytes = wordBytes.subarray(start, piece.actualByteStart + (end - piece.cpStart));
      let chosen = encoding;
      if (!isDoubleByteEncoding(chosen) && dbcsHint && bytes.some((b) => b >= 0x80) && looksLikeValidDoubleByte(bytes, dbcsHint)) {
        chosen = dbcsHint;
      }
      encodings.add(chosen);
      let text = decode8BitText(bytes, chosen);
      if (text.length < end - cp) text = text.padEnd(end - cp, FILLER_CHAR);
      parts.push(text);
      cp = end;
    }
    return parts.join('');
  });
  return { pieceTexts, encodings };
}

interface HeaderStoryLayout {
  /** 구역 번호 → 종류별 [시작, 끝) CP(문서 전체 기준) */
  ranges: Array<Partial<Record<'evenHeader' | 'header' | 'evenFooter' | 'footer' | 'firstHeader' | 'firstFooter', [number, number]>>>;
}

const HEADER_KINDS = ['evenHeader', 'header', 'evenFooter', 'footer', 'firstHeader', 'firstFooter'] as const;

function readCpPlc(tableBytes: Uint8Array, fc: number | undefined, lcb: number | undefined, structSize = 0): { cps: number[]; data: Uint8Array } | null {
  if (fc == null || !lcb || lcb < 4 || fc + lcb > tableBytes.length) return null;
  const count = Math.floor((lcb - 4) / (4 + structSize));
  const reader = new BinaryReader(tableBytes.subarray(fc, fc + lcb));
  const cps: number[] = [];
  for (let i = 0; i <= count; i += 1) cps.push(reader.i32(i * 4));
  return { cps, data: tableBytes.subarray(fc + (count + 1) * 4, fc + lcb) };
}

/**
 * doc-viewer: 구역별 머리말·꼬리말 위치. [MS-DOC] 2.8.? Plcfhdd
 * - Word 97: 앞의 6칸은 각주·미주 구분선이고, 구역마다 6칸(짝수 머리말, 홀수 머리말, 짝수 꼬리말, 홀수 꼬리말,
 *   첫 쪽 머리말, 첫 쪽 꼬리말)이 이어진다. 비어 있으면 앞 구역 것을 이어 쓴다.
 * - Word 6/95: 있는 것만 차례로 저장한다. DOP의 grpfIhdt(구분선)와 구역의 sprmSGprfIhdt가 어떤 것이 있는지 알려준다
 *   (LibreOffice WW8PLCF_HdFt와 같은 처리).
 */
function layoutHeaderStories(
  tableBytes: Uint8Array,
  fib: ParsedFib,
  sections: SectionInfo[],
  headerStart: number,
  headerLength: number,
  dopHeaderFlags: number,
): HeaderStoryLayout {
  const layout: HeaderStoryLayout = { ranges: sections.map(() => ({})) };
  const plc = readCpPlc(tableBytes, fib.fibRgFcLcb.fcPlcfHdd as number | undefined, fib.fibRgFcLcb.lcbPlcfHdd as number | undefined);
  if (!plc || headerLength <= 0) return layout;
  const entry = (index: number): [number, number] | null => {
    const start = plc.cps[index];
    const end = plc.cps[index + 1];
    if (start == null || end == null || end <= start || start < 0 || end > headerLength) return null;
    return [headerStart + start, headerStart + end];
  };
  const version = fib.version ?? 8;
  if (version === 8) {
    sections.forEach((section, s) => {
      HEADER_KINDS.forEach((kind, k) => {
        const own = entry(6 + s * 6 + k);
        const previous = s > 0 ? layout.ranges[s - 1]![kind] : undefined;
        const value = own && own[1] - own[0] > 0 ? own : previous;
        if (value) layout.ranges[s]![kind] = value;
      });
    });
    return layout;
  }
  let offset = 0;
  for (let bit = 0x01; bit <= 0x20; bit <<= 1) if (dopHeaderFlags & bit) offset += 1;
  sections.forEach((section, s) => {
    const flags = section.headerFlags ?? 0;
    let index = offset;
    HEADER_KINDS.forEach((kind, k) => {
      const bit = 1 << k;
      if (flags & bit) {
        const own = entry(index);
        if (own) layout.ranges[s]![kind] = own;
        index += 1;
      } else if (s > 0 && layout.ranges[s - 1]![kind]) {
        layout.ranges[s]![kind] = layout.ranges[s - 1]![kind];
      }
    });
    offset = index;
  });
  return layout;
}

interface NoteLayout {
  kind: 'footnote' | 'endnote';
  index: number;
  refCp: number;
  auto: boolean;
  textStart: number;
  textEnd: number;
}

function layoutNotes(
  tableBytes: Uint8Array,
  fib: ParsedFib,
  kind: 'footnote' | 'endnote',
  storyStart: number,
  storyLength: number,
): NoteLayout[] {
  const fcLcb = fib.fibRgFcLcb;
  const refPlc = readCpPlc(
    tableBytes,
    fcLcb[kind === 'footnote' ? 'fcPlcffndRef' : 'fcPlcfendRef'] as number | undefined,
    fcLcb[kind === 'footnote' ? 'lcbPlcffndRef' : 'lcbPlcfendRef'] as number | undefined,
    2,
  );
  const txtPlc = readCpPlc(
    tableBytes,
    fcLcb[kind === 'footnote' ? 'fcPlcffndTxt' : 'fcPlcfendTxt'] as number | undefined,
    fcLcb[kind === 'footnote' ? 'lcbPlcffndTxt' : 'lcbPlcfendTxt'] as number | undefined,
  );
  if (!refPlc || !txtPlc || storyLength <= 0) return [];
  const reader = new BinaryReader(refPlc.data);
  const count = refPlc.cps.length - 1;
  const out: NoteLayout[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = txtPlc.cps[i];
    const end = txtPlc.cps[i + 1];
    if (start == null || end == null || end < start || end > storyLength) continue;
    out.push({
      kind,
      index: i,
      refCp: refPlc.cps[i] ?? 0,
      auto: reader.i16(i * 2) !== 0,
      textStart: storyStart + start,
      textEnd: storyStart + end,
    });
  }
  return out;
}

function readDop(tableBytes: Uint8Array, fib: ParsedFib): { headerFlags: number; footnoteStart: number; footnoteRestart: number; nfcFtn: number; nfcEdn: number; endnoteStart: number; facingPages: boolean } {
  const fc = fib.fibRgFcLcb.fcDop as number | undefined;
  const lcb = fib.fibRgFcLcb.lcbDop as number | undefined;
  const defaults = { headerFlags: 0, footnoteStart: 1, footnoteRestart: 0, nfcFtn: 0, nfcEdn: 2, endnoteStart: 1, facingPages: false };
  if (fc == null || !lcb || lcb < 4 || fc + Math.min(lcb, 0x38) > tableBytes.length) return defaults;
  const reader = new BinaryReader(tableBytes.subarray(fc, fc + lcb));
  const w0 = reader.u16(0);
  const w2 = reader.u16(2);
  const w34 = lcb >= 0x36 ? reader.u16(0x34) : 0;
  const w36 = lcb >= 0x38 ? reader.u16(0x36) : 0;
  return {
    facingPages: Boolean(w0 & 0x0001),
    headerFlags: (w0 >> 8) & 0xff,
    footnoteRestart: w2 & 0x3,
    footnoteStart: (w2 >> 2) || 1,
    endnoteStart: (w34 >> 2) || 1,
    nfcFtn: lcb >= 0x38 ? (w36 >> 2) & 0xf : 0,
    nfcEdn: lcb >= 0x38 ? (w36 >> 6) & 0xf : 2,
  };
}

/**
 * Main MS-DOC entry point.
 * It parses the OLE container, restores text through the piece table, resolves
 * paragraph/character/table properties, and finally produces a normalized AST
 * that the HTML renderer can consume.
 *
 * doc-viewer: Word 6.0/95·Word 2.0과 OLE가 아닌 옛 형식(Mac Word 4/5 등)도 받는다.
 * 구역·머리말·꼬리말·각주·미주·번호 매기기·떠 있는 글상자(고정 위치)를 함께 돌려준다.
 */
export function parseMsDoc(input: ArrayBuffer | Uint8Array | ArrayBufferView, options: MsDocParseOptions = {}): MsDocParseResult {
  const bytes = toUint8Array(input);
  const isCfb = bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  if (!isCfb) {
    // Word 2.0(0xA5DB)은 OLE 없이 파일 전체가 WordDocument 스트림과 같은 구조다.
    const wIdent = bytes.length >= 4 ? (bytes[0]! | (bytes[1]! << 8)) : 0;
    if (wIdent === 0xa5db) {
      try {
        return parseWordDocument(bytes, null, [], options);
      } catch {
        // 구조를 못 읽으면 아래의 글자 복구로 넘어간다.
      }
    }
    const legacy = parseNonOleDocument(bytes);
    if (legacy) return legacy;
    throw new Error('Not a Compound File Binary document');
  }

  const warnings = [] as MsDocParseResult['warnings'];
  const cfb = parseCFB(bytes, options);
  warnings.push(...(cfb.warnings || []));

  const wordBytes = cfb.getStream('/WordDocument');
  if (!wordBytes) throw new Error('Missing WordDocument stream');

  const htmlDocument = parseHtmlWordDocumentStream(wordBytes);
  if (htmlDocument) {
    htmlDocument.warnings.unshift(...(cfb.warnings || []));
    return htmlDocument;
  }
  return parseWordDocument(wordBytes, cfb, warnings, options);
}

function parseWordDocument(
  wordBytes: Uint8Array,
  cfb: ReturnType<typeof parseCFB> | null,
  warnings: MsDocWarning[],
  options: MsDocParseOptions,
): MsDocParseResult {
  const fib = parseFib(wordBytes);
  const version = fib.version ?? 8;
  if (version === 8 && fib.base.wIdent !== 0xA5EC) {
    pushWarning(warnings, `Unexpected FIB identifier: 0x${fib.base.wIdent.toString(16)}`);
  }
  if (fib.base.fEncrypted) {
    throw new Error('Encrypted .doc files are not supported yet');
  }

  // 표 스트림: Word 97은 0Table/1Table, Word 6 이하는 WordDocument 스트림 안에 있다.
  let tableBytes: Uint8Array | null = version === 8
    ? cfb?.getStream(fib.base.fWhichTblStm ? '/1Table' : '/0Table') ?? null
    : wordBytes;
  if (!tableBytes && version === 8 && cfb) {
    // doc-viewer: fWhichTblStm이 가리키는 표 스트림이 없으면 다른 쪽을 써 본다.
    tableBytes = cfb.getStream(fib.base.fWhichTblStm ? '/0Table' : '/1Table');
    if (tableBytes) pushWarning(warnings, 'The table stream named by the FIB is missing; using the other table stream.', { code: 'MSDOC_TABLE_STREAM_SWAPPED' });
  }
  let plainTextOnly = false;
  if (!tableBytes) {
    // doc-viewer: 표 스트림이 아예 없으면 서식 없이 fcMin부터 본문 글자만 읽는다(LibreOffice도 글자는 보여준다).
    pushWarning(warnings, 'Missing table stream; recovered plain text only.', { code: 'MSDOC_PLAIN_TEXT_FALLBACK' });
    tableBytes = new Uint8Array(0);
    plainTextOnly = true;
    fib.fibRgFcLcb = { _pairs: [] };
  }

  const dataBytes = version === 8 ? cfb?.getStream('/Data') || new Uint8Array(0) : wordBytes;
  const lw = fib.fibRgLw;
  const declaredCp = [lw.ccpText, lw.ccpFtn, lw.ccpHdd, lw.ccpMcr, lw.ccpAtn, lw.ccpEdn, lw.ccpTxbx, lw.ccpHdrTxbx]
    .reduce((sum, value) => sum + Math.max(0, value || 0), 0);

  let clx: ParsedClx;
  const lcbClx = fib.fibRgFcLcb.lcbClx as number | undefined;
  try {
    if (plainTextOnly || !lcbClx) throw new Error('no piece table');
    clx = parseClx(tableBytes, fib.fibRgFcLcb, version, version !== 8 && fib.base.fExtChar);
  } catch (error) {
    // Word 6/95의 단순 저장 문서는 조각 표가 없고 fcMin부터 글자가 이어진다.
    const fcMin = fib.fcMin ?? 0;
    const fcMac = fib.fcMac ?? 0;
    const span = Math.max(0, Math.min(wordBytes.length, fcMac) - fcMin);
    if (version === 8) {
      const unicode = declaredCp > 0 ? span >= declaredCp * 2 : span % 2 === 0 && span > 0;
      const count = declaredCp > 0 ? Math.min(declaredCp, unicode ? Math.floor(span / 2) : span) : unicode ? Math.floor(span / 2) : span;
      if (!fcMin || count <= 0) throw error;
      clx = makeSinglePieceClx(fcMin, count, unicode);
      if (!plainTextOnly) pushWarning(warnings, 'The piece table could not be read; recovered text from fcMin.', { code: 'MSDOC_PIECE_TABLE_FALLBACK' });
    } else {
      const extChar = fib.base.fExtChar;
      const available = extChar ? Math.floor(span / 2) : span;
      const count = Math.min(available, declaredCp || available);
      clx = makeSinglePieceClx(fcMin, count, extChar);
    }
  }

  const decodeLegacyName = (raw: Uint8Array, charset?: number) => {
    const enc = charset != null && charset !== 0 && charset !== 1 ? charsetToEncoding(charset) : null;
    return decode8BitText(raw, enc && enc !== 'x-symbol' ? enc : lidToEncoding(fib.base.lid) || 'windows-1252')
      .replaceAll(FILLER_CHAR, '');
  };
  const styles = parseStyles(tableBytes, fib.fibRgFcLcb, version, (raw) => decodeLegacyName(raw));
  const fonts = parseFonts(tableBytes, fib.fibRgFcLcb, version, decodeLegacyName);
  const allChpxRuns = plainTextOnly ? [] : readChpxRuns(wordBytes, tableBytes, fib, clx);
  const allPapxRuns = plainTextOnly ? [] : readPapxRuns(wordBytes, tableBytes, fib, clx, dataBytes);

  let pieceTexts: string[];
  if (version === 8) {
    pieceTexts = buildPieceTextCache(wordBytes, clx);
  } else {
    const decoded = decodeLegacyPieceTexts(wordBytes, clx, fib, allChpxRuns, allPapxRuns, styles, fonts);
    pieceTexts = decoded.pieceTexts;
    const nonLatin = Array.from(decoded.encodings).filter((enc) => enc !== 'windows-1252');
    pushWarning(warnings, `Legacy Word ${version === 2 ? '2.0' : '6.0/95'} document; text decoded as ${Array.from(decoded.encodings).join(', ') || 'windows-1252'}.`, {
      code: 'MSDOC_LEGACY_FORMAT',
      wordVersion: version,
      encodings: nonLatin,
    });
  }
  const documentText = pieceTexts.join('');
  const stories = getDocumentStoryRanges(fib, documentText.length);
  const storyOf = (kind: StoryKind) => stories.find((story) => story.kind === kind);
  const mainStory = storyOf('main') || { kind: 'main' as const, cpStart: 0, cpEnd: documentText.length };

  const chpxRuns = allChpxRuns;
  const papxRuns = allPapxRuns;

  const objectPool = cfb ? extractObjectPool(cfb) : new Map<string, ObjectPoolInfo>();
  const assets: MsDocAsset[] = [];
  const usedAttachmentNames = new Set<string>();
  const assetCache = new Map<number, MsDocAsset | null>();
  const resolveAsset = createAssetResolver(dataBytes, objectPool, assets, usedAttachmentNames, assetCache, options);
  const resolveFont = (fontId: number | undefined) => fonts.byIndex(fontId);

  const sections = plainTextOnly
    ? [{ index: 0, cpStart: 0, cpEnd: mainStory.cpEnd, breakType: 2, titlePage: false, headers: {}, footers: {} } as SectionInfo]
    : parseSections(wordBytes, tableBytes, fib, mainStory.cpEnd);
  const sectionBreakCps = new Set<number>();
  for (const section of sections.slice(0, -1)) {
    const cp = section.cpEnd - 1;
    if (documentText[cp] === DOC_CONTROL.pageBreak) sectionBreakCps.add(cp);
  }
  const dop = readDop(tableBytes, fib);
  const listTables = version === 8 && !plainTextOnly ? safely(() => parseListTables(tableBytes!, fib.fibRgFcLcb), null, warnings, 'lists') : null;

  const makeContext = (storyKind: StoryKind, extra: Partial<StoryContext> = {}): StoryContext => ({
    storyKind,
    styles,
    fonts,
    chpxRuns,
    chpxCursor: { index: 0 },
    resolveAsset,
    resolveFont,
    listTables,
    numberer: listTables ? new ListNumberer(listTables) : null,
    ...extra,
  });
  const buildBlocksFor = (story: StoryRange, context: StoryContext) => buildBlocks(
    buildRangeParagraphs(story, documentText, wordBytes, clx, pieceTexts, papxRuns, context),
  );

  // 각주·미주: 본문 참조 위치와 번호를 먼저 정해 본문을 만들 때 위첨자 번호를 달 수 있게 한다.
  const marks = new Map<number, NoteMark>();
  const noteLayouts: NoteLayout[] = [];
  const footnoteStory = storyOf('footnote');
  const endnoteStory = storyOf('endnote');
  if (!plainTextOnly) {
    if (footnoteStory) noteLayouts.push(...layoutNotes(tableBytes, fib, 'footnote', footnoteStory.cpStart, footnoteStory.cpEnd - footnoteStory.cpStart));
    if (endnoteStory) noteLayouts.push(...layoutNotes(tableBytes, fib, 'endnote', endnoteStory.cpStart, endnoteStory.cpEnd - endnoteStory.cpStart));
  }
  const noteLabels = new Map<NoteLayout, { id: string; label: string }>();
  let footnoteNumber = dop.footnoteStart - 1;
  let endnoteNumber = dop.endnoteStart - 1;
  let lastFootnoteSection = -1;
  for (const note of noteLayouts) {
    let label: string;
    if (note.auto) {
      if (note.kind === 'footnote') {
        const sectionIndex = sectionIndexAt(sections, note.refCp);
        if (dop.footnoteRestart === 1 && sectionIndex !== lastFootnoteSection) footnoteNumber = dop.footnoteStart - 1;
        lastFootnoteSection = sectionIndex;
        footnoteNumber += 1;
        label = formatListNumber(footnoteNumber, dop.nfcFtn);
      } else {
        endnoteNumber += 1;
        label = formatListNumber(endnoteNumber, dop.nfcEdn);
      }
    } else {
      label = visibleParagraphText(documentText.slice(note.refCp, note.refCp + 1)) || '*';
    }
    const id = uniqueId(note.kind === 'footnote' ? 'fn' : 'en');
    noteLabels.set(note, { id, label });
    marks.set(note.refCp, { kind: note.kind, noteId: id, label });
    // 각주 본문 맨 앞의 자동 번호 문자도 같은 번호로 그린다.
    if (documentText[note.textStart] === '\u0002') marks.set(note.textStart, { kind: note.kind, noteId: id, label });
  }

  // 떠 있는 글상자·그림: 고정 CP → 도형 블록
  const anchorWarnings: string[] = [];
  const mainAnchors = new Map<number, ShapeBlock[]>();
  const headerAnchors = new Map<number, ShapeBlock[]>();
  const usedTextboxes = new Set<string>();
  const textboxStory = storyOf('textbox');
  const headerTextboxStory = storyOf('header-textbox');
  const textboxBlocksCache = new Map<string, MsDocBlock[]>();
  const textboxBlocks = (range: TextboxRange, kind: StoryKind) => {
    const key = `${kind}:${range.cpStart}:${range.cpEnd}`;
    let blocks = textboxBlocksCache.get(key);
    if (!blocks) {
      // 글상자 이야기의 마지막 문단 표시는 다음 글상자와의 경계라 그 앞까지만 그린다.
      blocks = buildBlocksFor({ kind, cpStart: range.cpStart, cpEnd: range.cpEnd }, makeContext(kind, { marks }));
      textboxBlocksCache.set(key, blocks);
    }
    usedTextboxes.add(key);
    return blocks;
  };
  if (version === 8 && !plainTextOnly) {
    for (const header of [false, true]) {
      const story = header ? headerTextboxStory : textboxStory;
      const fspas = safely(() => readFspas(tableBytes!, fib.fibRgFcLcb, header), [], warnings, 'shapes');
      if (!fspas.length) continue;
      const drawing = safely(() => readDrawing(tableBytes!, fib.fibRgFcLcb, header), null, warnings, 'drawing');
      const ranges = story && story.cpEnd > story.cpStart
        ? safely(() => readTextboxRanges(tableBytes!, fib.fibRgFcLcb, story.cpStart, story.cpEnd - story.cpStart, header), [], warnings, 'textboxes')
        : [];
      const target = header ? headerAnchors : mainAnchors;
      for (const fspa of fspas) {
        const shape = buildAnchoredShape(fspa, drawing, ranges, (range) => textboxBlocks(range, header ? 'header-textbox' : 'textbox'), wordBytes, options);
        if (!shape) continue;
        // 머리말 그림판(PlcSpaHdr)의 CP는 머리말 문서 시작 기준이다.
        const cp = header ? (storyOf('header')?.cpStart ?? 0) + fspa.cp : fspa.cp;
        const list = target.get(cp) ?? [];
        list.push(shape);
        target.set(cp, list);
      }
    }
  }

  const mainContext = makeContext('main', { marks, sectionBreakCps, sections, anchors: mainAnchors });
  const blocks: MsDocBlock[] = buildBlocksFor(mainStory, mainContext);

  // 고정 위치를 찾지 못한 글상자(Word 6/95, 손상 파일 등)는 예전처럼 본문 뒤에 이어 붙인다.
  const leftoverStories: StoryRange[] = [];
  for (const story of [textboxStory, headerTextboxStory]) {
    if (!story || story.cpEnd <= story.cpStart) continue;
    const header = story.kind === 'header-textbox';
    const ranges = version === 8 && !plainTextOnly
      ? safely(() => readTextboxRanges(tableBytes!, fib.fibRgFcLcb, story.cpStart, story.cpEnd - story.cpStart, header), [], warnings, 'textboxes')
      : [];
    const pieces = ranges.length
      ? ranges.filter((range) => !usedTextboxes.has(`${story.kind}:${range.cpStart}:${range.cpEnd}`)).map((range) => ({ kind: story.kind, cpStart: range.cpStart, cpEnd: range.cpEnd }))
      : [story];
    for (const piece of pieces) {
      const text = visibleParagraphText(documentText.slice(piece.cpStart, piece.cpEnd)).replace(/[\r\u0007]/g, '').trim();
      if (text) leftoverStories.push(piece);
    }
  }
  if (leftoverStories.length) {
    for (const story of leftoverStories) {
      const content = buildBlocksFor(story, makeContext(story.kind, { marks }));
      if (content.length) {
        blocks.push({ type: 'shape', id: uniqueId('shape'), kind: 'textbox', blocks: content });
      }
    }
    pushWarning(
      warnings,
      'Recovered text from a legacy Word text-box story; text-box positioning is unavailable, so the content was linearized after the main story.',
      { code: 'MSDOC_TEXTBOX_STORY_LINEARIZED', storyCount: leftoverStories.length },
    );
  }
  if (anchorWarnings.length) pushWarning(warnings, anchorWarnings.join('; '));

  // 머리말·꼬리말
  const headerStory = storyOf('header');
  if (headerStory && headerStory.cpEnd > headerStory.cpStart && !plainTextOnly) {
    const layout = layoutHeaderStories(tableBytes, fib, sections, headerStory.cpStart, headerStory.cpEnd - headerStory.cpStart, dop.headerFlags);
    const cache = new Map<string, MsDocBlock[]>();
    const blocksForRange = ([start, end]: [number, number]) => {
      const key = `${start}:${end}`;
      let value = cache.get(key);
      if (!value) {
        value = safely(() => buildBlocksFor({ kind: 'header', cpStart: start, cpEnd: end }, makeContext('header', { anchors: headerAnchors, marks })), [], warnings, 'header');
        cache.set(key, value);
      }
      return value;
    };
    const hasContent = (list: MsDocBlock[]) => list.some((block) => block.type !== 'paragraph' || block.text.trim() || block.inlines.some((node) => node.type !== 'text' || node.text.trim()));
    sections.forEach((section, index) => {
      const ranges = layout.ranges[index]!;
      const assign = (target: 'headers' | 'footers', kind: 'default' | 'first' | 'even', range?: [number, number]) => {
        if (!range) return;
        const content = blocksForRange(range);
        if (hasContent(content)) section[target][kind] = content;
      };
      assign('headers', 'default', ranges.header);
      assign('footers', 'default', ranges.footer);
      if (section.titlePage) {
        assign('headers', 'first', ranges.firstHeader);
        assign('footers', 'first', ranges.firstFooter);
      }
      if (dop.facingPages) {
        assign('headers', 'even', ranges.evenHeader);
        assign('footers', 'even', ranges.evenFooter);
      }
    });
  }

  // 각주·미주 본문
  const footnotes: NoteInfo[] = [];
  const endnotes: NoteInfo[] = [];
  for (const note of noteLayouts) {
    const info = noteLabels.get(note)!;
    const content = safely(() => buildBlocksFor({ kind: note.kind, cpStart: note.textStart, cpEnd: note.textEnd }, makeContext(note.kind, { marks })), [], warnings, 'notes');
    const item: NoteInfo = { kind: note.kind, index: note.index, id: info.id, label: info.label, refCp: note.refCp, blocks: content };
    (note.kind === 'footnote' ? footnotes : endnotes).push(item);
  }

  const trailingAttachments = Array.from(objectPool.values())
    .filter((item) => item?.attachment && !usedAttachmentNames.has(item.entry.name))
    .map((item) => item.attachment as AttachmentAsset);

  for (const attachment of trailingAttachments) assets.push(attachment);
  if (trailingAttachments.length) {
    blocks.push({ type: 'attachments', id: uniqueId('attachments'), items: trailingAttachments });
  }

  return {
    kind: 'msdoc',
    version: 1,
    warnings,
    meta: {
      fib: {
        wIdent: fib.base.wIdent,
        nFib: fib.base.nFib,
        fWhichTblStm: fib.base.fWhichTblStm,
        fComplex: fib.base.fComplex,
        fEncrypted: fib.base.fEncrypted,
        ccpText: fib.fibRgLw.ccpText,
        version,
      },
      counts: {
        paragraphs: blocks.filter((block) => block.type === 'paragraph').length,
        blocks: blocks.length,
        assets: assets.length,
        styles: styles.styles.size,
        fonts: fonts.fonts.length,
      },
    },
    fonts: fonts.fonts,
    styles: Array.from(styles.styles.values()).map((style) => ({
      istd: style.istd,
      name: style.name,
      type: style.stdfBase?.stk,
      basedOn: style.stdfBase?.istdBase,
      next: style.stdfBase?.istdNext,
    })),
    blocks,
    assets,
    sections,
    notes: { footnotes, endnotes },
  };
}

/** doc-viewer: 부가 정보(목록·도형·머리말 등)를 읽다가 실패해도 본문은 살린다. */
function safely<T>(fn: () => T, fallback: T, warnings: MsDocWarning[], what: string): T {
  try {
    return fn();
  } catch (error) {
    pushWarning(warnings, `Skipped ${what}: ${String((error as Error)?.message ?? error)}`, { code: 'MSDOC_PARTIAL_FAILURE' });
    return fallback;
  }
}

function buildAnchoredShape(
  fspa: { spid: number; xaLeft: number; yaTop: number; xaRight: number; yaBottom: number; wrap: number; belowText: boolean },
  drawing: DrawingInfo | null,
  textboxRanges: TextboxRange[],
  blocksFor: (range: TextboxRange) => MsDocBlock[],
  wordBytes: Uint8Array,
  options: MsDocParseOptions,
): ShapeBlock | null {
  const members = drawing?.members.get(fspa.spid) ?? [fspa.spid];
  const contentBlocks: MsDocBlock[] = [];
  const seen = new Set<number>();
  for (const spid of members) {
    const shape = drawing?.shapes.get(spid);
    if (shape?.hidden) continue;
    const byLid = textboxRanges.filter((range) => range.spid === spid && !range.reusable);
    // lTxid = (글상자 이야기 번호 << 16) | 연결 순서. 연결된 글상자는 첫 상자(순서 0)에 이야기 전체를 그린다.
    const byTxid = shape?.txid && (shape.txid & 0xffff) === 0
      ? textboxRanges.filter((range) => range.index === (shape.txid! >>> 16) - 1)
      : [];
    if (shape?.txid && (shape.txid & 0xffff) !== 0) continue;
    for (const range of [...byLid, ...byTxid]) {
      if (seen.has(range.index)) continue;
      seen.add(range.index);
      contentBlocks.push(...blocksFor(range));
    }
  }
  let image: ShapeBlock['image'];
  if (!contentBlocks.length && drawing) {
    for (const spid of members) {
      const shape = drawing.shapes.get(spid);
      if (!shape?.pib || shape.hidden) continue;
      const asset = extractShapeImage(drawing, shape.pib, wordBytes, options);
      if (asset && asset.displayable !== false) {
        image = asset;
        break;
      }
    }
  }
  if (!contentBlocks.length && !image) return null;
  const top = drawing?.shapes.get(fspa.spid);
  const width = fspa.xaRight - fspa.xaLeft;
  const height = fspa.yaBottom - fspa.yaTop;
  const lineOn = top?.line ?? (contentBlocks.length > 0 && top?.shapeType === 202);
  return {
    type: 'shape',
    id: uniqueId('shape'),
    kind: contentBlocks.length ? 'textbox' : 'picture',
    blocks: contentBlocks,
    image,
    widthTwips: width > 0 ? width : undefined,
    heightTwips: height > 0 ? height : undefined,
    wrap: fspa.wrap,
    behindText: fspa.belowText,
    fillColor: top?.filled === false ? undefined : colorRefToHex(top?.fillColor),
    lineColor: lineOn ? colorRefToHex(top?.lineColor) ?? '#000000' : undefined,
    lineWidthPx: lineOn ? Math.max(1, Math.round(((top?.lineWidthEmu ?? 9525) / 12700) * (96 / 72))) : undefined,
    leftTwips: fspa.xaLeft,
    topTwips: fspa.yaTop,
  };
}
