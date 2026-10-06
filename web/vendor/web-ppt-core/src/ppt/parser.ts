import type {
  AnimStep, ElementBase, Fill, GroupElement, ImageElement, Paragraph, Presentation, ShapeElement,
  Slide, SlideElement, TableCell, TableElement, TableRow, TextBody, TextRun, Transition,
} from '../types';
import { metafileDataUrl } from '../metafile';
import { presetGeom } from '../geometry';
import { AutoNum, collectAutoNums, formatAutoNum } from './autonum';
import { Cfb } from './cfb';
import { getPptDecryptor } from '../crypto/hook';
import { isPptEncrypted } from '../crypto/ppt';
import {
  ESCHER, EscherProps, MSO_SHAPE, P, Scheme, SP_FLAG, arrayElementSize, escherColor, extractBlips,
  isTableGroup, MSO_PICTURE_FRAME, parseOpt, readAnchor, readChildAnchor, readSp, readSpgr,
  inheritProps, shapeFill, shapeShadow, shapeStroke, tableRowHeights,
} from './escher';
import { ansi, findAll, findRec, Rec, records, RT, utf16 } from './records';
import { parseAnimations, parseSlideShowInfo } from './timing';

/**
 * .ppt（PowerPoint 97-2003）纯浏览器解析。
 * CFB 容器 → PowerPoint Document 流 → 幻灯片容器 → OfficeArt 图形树 → 统一 Schema。
 */

/** 主坐标单位：1/576 英寸 → CSS px（96dpi） */
const MASTER_TO_PX = 96 / 576;

const DEFAULT_SCHEME: Scheme = ['FFFFFF', '000000', '808080', '000000', 'CCFFFF', 'B2B2B2', '3333CC', '009999'];

interface TextRunProps {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: number;
  fontIdx?: number;
  asianFontIdx?: number;
}

interface ParaProps {
  align?: number;
  bulletChar?: string;
  hasBullet?: boolean;
  indentLevel?: number;
  leftMargin?: number;
  indent?: number;
  /** [doc-viewer] 글머리표 글꼴·색·크기와 그것을 쓸지(bulletFlags의 fBulletHas*) */
  bulletHasFont?: boolean;
  bulletHasColor?: boolean;
  bulletHasSize?: boolean;
  bulletFontIdx?: number;
  /** ColorIndexStruct */
  bulletColor?: number;
  /** 양수면 글자 크기 대비 %, 음수면 절대 크기(pt) */
  bulletSize?: number;
  /** [doc-viewer] 줄 간격·문단 앞뒤 간격: 0 이상이면 줄 높이 대비 %, 음수면 마스터 단위(1/576인치) */
  lineSpacing?: number;
  spaceBefore?: number;
  spaceAfter?: number;
}

/** 超链接覆盖的字符区间（左闭右开） */
interface LinkRange {
  begin: number;
  end: number;
  link: string;
}

interface StyledText {
  text: string;
  paraProps: { chars: number; props: ParaProps }[];
  charProps: { chars: number; props: TextRunProps }[];
  /** TextHeaderAtom 里的 TextTypeEnum，决定继承哪一套母版样式 */
  textType?: number;
  links?: LinkRange[];
}

// ---------------- TextPFException / TextCFException ----------------

/**
 * [MS-PPT] 2.9.44 TextPFException：字段在数据区里的排列顺序与掩码位顺序**不一致**，
 * 必须严格按下表读取（顺序或宽度错一位，后面的字符属性就整体错位）。
 * 该结构同时用于 StyleTextPropAtom 与 TxMasterStyleAtom。
 */
const PF_BULLET_FLAGS = 0x0000000f;
const PF_TAB_STOPS = 0x00100000;

const PARA_FIELDS: [number, number][] = [
  [PF_BULLET_FLAGS, 2], // bulletFlags：fHasBullet / fBulletHasFont / …
  [0x00000080, 2], // bullet.char
  [0x00000010, 2], // bullet.font
  [0x00000040, 2], // bullet.size
  [0x00000020, 4], // bullet.color
  [0x00000800, 2], // alignment
  [0x00001000, 2], // lineSpacing
  [0x00002000, 2], // spaceBefore
  [0x00004000, 2], // spaceAfter
  [0x00000100, 2], // leftMargin
  [0x00000400, 2], // indent
  [0x00008000, 2], // defaultTabSize
  [PF_TAB_STOPS, -1], // tabStops：u16 count + count×4，长度可变
  [0x00010000, 2], // fontAlign
  [0x000e0000, 2], // wrapFlags
  [0x00200000, 2], // textDirection
];

/** [MS-PPT] 2.9.20 TextCFException：同样按数据区顺序排列 */
const CHAR_FIELDS: [number, number][] = [
  [0x0000ffff, 2], // 样式位（粗 / 斜 / 下划线 …）
  [0x00010000, 2], // font.index
  [0x00200000, 2], // asian.font.index
  [0x00400000, 2], // ansi.font.index
  [0x00800000, 2], // symbol.font.index
  [0x00020000, 2], // font.size
  [0x00040000, 4], // font.color
  [0x00080000, 2], // superscript
];

/** 读一份段落属性；返回读完后的偏移，越界时返回 -1 让调用方放弃后续解析 */
function readParaProps(dv: DataView, start: number, end: number, mask: number, props: ParaProps): number {
  let off = start;
  for (const [flag, size] of PARA_FIELDS) {
    if (!(mask & flag)) continue;
    if (flag === PF_TAB_STOPS) {
      if (off + 2 > end) return -1;
      off += 2 + dv.getUint16(off, true) * 4;
      if (off > end) return -1;
      continue;
    }
    if (off + size > end) return -1;
    const v = size === 2 ? dv.getUint16(off, true) : dv.getUint32(off, true);
    if (flag === PF_BULLET_FLAGS) {
      // [doc-viewer] bulletFlags의 각 비트는 마스크에서 같은 비트가 켜진 것만 유효하다
      if (mask & 0x1) props.hasBullet = (v & 0x1) !== 0;
      if (mask & 0x2) props.bulletHasFont = (v & 0x2) !== 0;
      if (mask & 0x4) props.bulletHasColor = (v & 0x4) !== 0;
      if (mask & 0x8) props.bulletHasSize = (v & 0x8) !== 0;
    } else if (flag === 0x00000080) props.bulletChar = String.fromCharCode(v);
    else if (flag === 0x00000010) props.bulletFontIdx = v;
    else if (flag === 0x00000020) props.bulletColor = v;
    else if (flag === 0x00000040) props.bulletSize = (v << 16) >> 16;
    else if (flag === 0x00001000) props.lineSpacing = (v << 16) >> 16;
    else if (flag === 0x00002000) props.spaceBefore = (v << 16) >> 16;
    else if (flag === 0x00004000) props.spaceAfter = (v << 16) >> 16;
    else if (flag === 0x00000100) props.leftMargin = v;
    else if (flag === 0x00000400) props.indent = (v << 16) >> 16;
    else if (flag === 0x00000800) props.align = v;
    off += size;
  }
  // 有 bullet.char 但没写标志位时按「有符号」处理：部分生成器会漏掉标志位
  if (props.hasBullet === undefined && (mask & 0x80) !== 0) props.hasBullet = true;
  return off;
}

function readCharProps(dv: DataView, start: number, end: number, mask: number, props: TextRunProps): number {
  let off = start;
  for (const [flag, size] of CHAR_FIELDS) {
    if (!(mask & flag)) continue;
    if (off + size > end) return -1;
    const v = size === 2 ? dv.getUint16(off, true) : dv.getUint32(off, true);
    if (flag === 0x0000ffff) {
      if (mask & 0x1) props.bold = (v & 0x1) !== 0;
      if (mask & 0x2) props.italic = (v & 0x2) !== 0;
      if (mask & 0x4) props.underline = (v & 0x4) !== 0;
    } else if (flag === 0x00010000) props.fontIdx = v;
    else if (flag === 0x00200000) props.asianFontIdx = v;
    else if (flag === 0x00020000) props.size = v;
    else if (flag === 0x00040000) props.color = v;
    off += size;
  }
  return off;
}

// ---------------- StyleTextPropAtom ----------------

interface StyleRuns {
  para: { chars: number; props: ParaProps }[];
  char: { chars: number; props: TextRunProps }[];
}

function parseStyleTextProp(dv: DataView, rec: Rec, textLen: number): StyleRuns {
  const para: StyleRuns['para'] = [];
  const char: StyleRuns['char'] = [];
  let off = rec.start;
  const end = rec.start + rec.len;
  const total = textLen + 1;

  let covered = 0;
  while (off + 10 <= end && covered < total) {
    const chars = dv.getUint32(off, true);
    const indentLevel = dv.getUint16(off + 4, true);
    const mask = dv.getUint32(off + 6, true);
    const props: ParaProps = { indentLevel };
    const next = readParaProps(dv, off + 10, end, mask, props);
    if (next < 0) break;
    off = next;
    para.push({ chars, props });
    covered += chars;
    if (chars === 0) break;
  }

  covered = 0;
  while (off + 8 <= end && covered < total) {
    const chars = dv.getUint32(off, true);
    // 字符段与段落段错位时读到的长度会离谱，此时放弃字符属性走默认值
    if (chars > total) break;
    const mask = dv.getUint32(off + 4, true);
    const props: TextRunProps = {};
    const next = readCharProps(dv, off + 8, end, mask, props);
    if (next < 0) break;
    off = next;
    char.push({ chars, props });
    covered += chars;
    if (chars === 0) break;
  }

  return { para, char };
}

// ---------------- TxMasterStyleAtom（母版按级别的默认样式） ----------------

interface LevelStyle {
  para: ParaProps;
  char: TextRunProps;
}

/** TextTypeEnum → 逐级默认样式 */
type MasterStyles = Map<number, LevelStyle[]>;

/** [MS-PPT] TextTypeEnum */
const TX = { TITLE: 0, BODY: 1, NOTES: 2, OTHER: 4, CENTER_BODY: 5, CENTER_TITLE: 6 } as const;

/** [doc-viewer] 마스터 스타일을 물려받는 기준 종류: 가운데 본문·반/사분 본문 → 본문, 가운데 제목 → 제목 */
const TX_BASE: Record<number, number> = { 5: TX.BODY, 7: TX.BODY, 8: TX.BODY, 6: TX.TITLE };

/** OEPlaceholderAtom.placeholderId → TextTypeEnum */
const PH_TEXT_TYPE: Record<number, number> = {
  1: TX.TITLE, 2: TX.BODY, 3: TX.CENTER_TITLE, 4: TX.CENTER_BODY,
  6: TX.NOTES, 12: TX.NOTES,
  13: TX.TITLE, 14: TX.BODY, 15: TX.CENTER_TITLE, 16: TX.CENTER_BODY,
  17: TX.TITLE, 18: TX.BODY, 19: TX.BODY,
};

/**
 * TxMasterStyleAtom：cLevels 后跟每一级的 TextPFException + TextCFException。
 * recInstance ≥ 5 的类型每级前多一个 2 字节的 level 字段。
 */
function parseTxMasterStyle(dv: DataView, rec: Rec, out: MasterStyles): void {
  const end = rec.start + rec.len;
  let off = rec.start;
  if (off + 2 > end) return;
  const levels = dv.getUint16(off, true);
  off += 2;
  const list: LevelStyle[] = [];
  for (let i = 0; i < levels; i++) {
    if (rec.instance >= 5) off += 2;
    if (off + 4 > end) break;
    const pMask = dv.getUint32(off, true);
    const para: ParaProps = {};
    let next = readParaProps(dv, off + 4, end, pMask, para);
    if (next < 0 || next + 4 > end) break;
    const cMask = dv.getUint32(next, true);
    const char: TextRunProps = {};
    next = readCharProps(dv, next + 4, end, cMask, char);
    if (next < 0) break;
    off = next;
    list.push({ para, char });
  }
  if (list.length) out.set(rec.instance, list);
}

// ---------------- 文本块 ----------------

const ALIGN_MAP: Record<number, Paragraph['align']> = { 0: 'left', 1: 'center', 2: 'right', 3: 'justify', 4: 'justify' };

/** 文本解析环境：字体表、配色方案，以及按段落级别取到的母版默认样式 */
interface TextEnv {
  fonts: string[];
  scheme: Scheme;
  /** 该文本类型在 lvl 级上的母版默认样式（已按 母版 → 环境 合并） */
  levelStyle: (lvl: number) => LevelStyle;
  /** 认领 ___PPT9 里 paraCount 段的自动编号；认领不到返回 undefined */
  claimAutoNums: (paraCount: number) => (AutoNum | null)[] | undefined;
}

function buildTextBody(styled: StyledText, env: TextEnv, props?: TextBoxProps): TextBody | null {
  // [doc-viewer] 글자 수를 바꾸지 않는다(\r\n을 한 글자로 줄이면 문단·글자 속성 구간이 한 칸씩 밀린다). \r과 \v는 줄을 나눌 때 구분한다
  const raw = styled.text;
  if (!raw.trim()) return null;

  // 按段落属性覆盖长度切分文本，再在段内按字符属性切分 run
  const paragraphs: Paragraph[] = [];
  let charPos = 0;
  let charIdx = 0;
  let charUsed = 0;

  const nextRunProps = (need: number): { props: TextRunProps; take: number } => {
    while (charIdx < styled.charProps.length && charUsed >= styled.charProps[charIdx].chars) {
      charUsed = 0;
      charIdx++;
    }
    const entry = styled.charProps[charIdx];
    if (!entry) return { props: {}, take: need };
    const avail = Math.max(1, entry.chars - charUsed);
    return { props: entry.props, take: Math.min(need, avail) };
  };

  // 超链接按绝对字符位置生效，run 不能跨越区间边界
  const links = styled.links ?? [];
  const linkAt = (pos: number): string | undefined => links.find((l) => pos >= l.begin && pos < l.end)?.link;
  const linkBreak = (pos: number, limit: number): number => {
    let stop = limit;
    for (const l of links) {
      if (l.begin > pos && l.begin - pos < stop) stop = l.begin - pos;
      if (l.end > pos && l.end - pos < stop) stop = l.end - pos;
    }
    return Math.max(1, stop);
  };

  const paraList = styled.paraProps.length ? styled.paraProps : [{ chars: raw.length + 1, props: {} as ParaProps }];
  // 自动编号只存在于 ___PPT9 扩展块，按段落序号对齐；计数器按级别维护
  const autoNums = env.claimAutoNums(paraList.length);
  const counters: number[] = [];

  paraList.forEach((pEntry, paraIdx) => {
    const paraText = raw.slice(charPos, charPos + pEntry.chars);
    const paraStart = charPos;
    charPos += pEntry.chars;
    // 段落自带的终止符会切出一条多余的空行，丢掉它（但仍要算进字符属性的游标）
    const parts = paraText.split(/[\r\n\v]/);
    // [doc-viewer] 구분 문자를 기억해 둔다. \v(줄 바꿈)로 이어진 줄은 같은 문단이라 글머리표·문단 간격이 없다
    const seps = paraText.match(/[\r\n\v]/g) ?? [];
    const dropped = parts.length > 1 && parts[parts.length - 1] === '';
    const lines = dropped ? parts.slice(0, -1) : parts;
    const pp = pEntry.props;
    const dft = env.levelStyle(pp.indentLevel ?? 0);
    const lvl = pp.indentLevel ?? 0;

    // 编号只给段首行，段内的软换行不重新起号
    const anm = autoNums?.[paraIdx] ?? null;
    let numText: string | null = null;
    if (anm) {
      counters.length = lvl + 1;
      counters[lvl] = (counters[lvl] ?? anm.startNum - 1) + 1;
      numText = formatAutoNum(anm.scheme, counters[lvl]);
    }

    let lineStart = paraStart;
    lines.forEach((line, li) => {
      const runs: TextRun[] = [];
      let i = 0;
      while (i < line.length) {
        const { props, take } = nextRunProps(line.length - i);
        const abs = lineStart + i;
        const n = linkBreak(abs, take);
        const slice = line.slice(i, i + n);
        charUsed += n;
        i += n;
        runs.push(makeRun(slice, props, dft.char, env, linkAt(abs)));
      }
      if (li < lines.length - 1 || dropped) charUsed += 1; // 换行符也占一个字符
      if (!runs.length) {
        const { props } = nextRunProps(1);
        runs.push(makeRun('', props, dft.char, env, undefined));
      }
      lineStart += line.length + 1;

      // [doc-viewer] soft: 앞 줄과 \v로 이어진 줄, hardEnd: 이 줄로 문단이 끝남
      const soft = li > 0 && seps[li - 1] === '\v';
      const hardEnd = li === lines.length - 1 || seps[li] !== '\v';
      const bulletNum = li === 0 ? numText : null;
      const hasBullet = !soft && (bulletNum !== null || (pp.hasBullet ?? dft.para.hasBullet ?? false));
      const leftMargin = pp.leftMargin ?? dft.para.leftMargin;
      const marL = leftMargin !== undefined ? leftMargin * MASTER_TO_PX : hasBullet ? 24 : 0;
      // [doc-viewer] indent는 첫 줄(글머리표)이 시작하는 절대 위치다. 있으면 그대로 따르고, 없으면 원래처럼 내어쓰기
      const indentRaw = pp.indent ?? dft.para.indent;
      const indent = soft ? 0 : indentRaw !== undefined && leftMargin !== undefined
        ? Math.max(-marL, indentRaw * MASTER_TO_PX - marL)
        : hasBullet ? -Math.min(marL, 24) : 0;
      const bulletStyle = hasBullet && bulletNum === null ? bulletLook(pp, dft.para, env) : null;
      const size = Math.max(...runs.map((r) => r.size), 1);
      paragraphs.push({
        align: ALIGN_MAP[pp.align ?? dft.para.align ?? 0] ?? 'left',
        lvl,
        marL,
        indent,
        bullet: bulletNum ?? (hasBullet ? bulletStyle?.char ?? '•' : null),
        bulletColor: bulletStyle?.color ?? null,
        bulletSize: bulletStyle?.size ?? null,
        lineHeight: lineHeightOf(pp.lineSpacing ?? dft.para.lineSpacing, size),
        spaceBefore: soft ? 0 : spacingOf(pp.spaceBefore ?? dft.para.spaceBefore, size, 0),
        spaceAfter: hardEnd ? spacingOf(pp.spaceAfter ?? dft.para.spaceAfter, size, 2) : 0,
        runs,
      });
    });
  });

  if (!paragraphs.length) return null;
  // [doc-viewer] anchorText([MS-ODRAW] MSOANCHOR): 0·3·6·8 위, 1·4 가운데, 2·5·7·9 아래.
  // 원본은 5(bottomCentered)를 가운데로, 6(topBaseline)을 아래로 읽었다
  const anchor: TextBody['anchor'] = props?.anchor === 1 || props?.anchor === 4 ? 'middle'
    : props?.anchor === 2 || props?.anchor === 5 || props?.anchor === 7 || props?.anchor === 9 ? 'bottom' : 'top';
  return { anchor, insets: props?.insets ?? [3.6, 7.2, 3.6, 7.2], wrap: props?.wrap ?? true, fontScale: 1, paragraphs };
}

/** [doc-viewer] 글 상자 속성: 세로 정렬, 여백(px, 위·오른쪽·아래·왼쪽), 줄바꿈 */
interface TextBoxProps {
  anchor?: number;
  insets?: [number, number, number, number];
  wrap?: boolean;
}

/** [doc-viewer] 도형 속성표 → 글 상자 속성. 여백 기본값은 [MS-ODRAW]의 0.1인치(좌우)·0.05인치(위아래) */
function textBoxProps(props: EscherProps): TextBoxProps {
  const emu = (id: number, dflt: number): number => (props.simple.get(id) ?? dflt) / 9525;
  return {
    anchor: props.simple.get(P.anchorText),
    insets: [emu(P.dyTextTop, 45720), emu(P.dxTextRight, 91440), emu(P.dyTextBottom, 45720), emu(P.dxTextLeft, 91440)],
    wrap: props.simple.get(P.wrapText) !== 2,
  };
}

/** 形状自带属性 → 母版按级默认值 → 内建兜底 */
function makeRun(text: string, own: TextRunProps, dft: TextRunProps, env: TextEnv, link: string | undefined): TextRun {
  const color = own.color ?? dft.color;
  const fonts: string[] = [];
  for (const idx of [own.fontIdx ?? dft.fontIdx, own.asianFontIdx ?? dft.asianFontIdx]) {
    const name = idx !== undefined ? env.fonts[idx] : undefined;
    if (name && !fonts.includes(name)) fonts.push(name);
  }
  return {
    text,
    b: own.bold ?? dft.bold ?? false,
    i: own.italic ?? dft.italic ?? false,
    u: own.underline ?? dft.underline ?? false,
    strike: false,
    size: (own.size ?? dft.size ?? 18) * (96 / 72),
    color: color !== undefined ? textColor(color, env.scheme) : 'rgb(0,0,0)',
    fonts,
    link,
  };
}

/**
 * [doc-viewer] 글자·글머리표 색(ColorIndexStruct, [MS-PPT] 2.12.2).
 * 맨 위 바이트가 0xFE(·0xFF)면 RGB, 0x00~0x07이면 색 구성표 번호다. 나머지는 도형 색 규칙으로 푼다(LibreOffice와 같은 규칙).
 * 원본은 도형 색 규칙만 써서 구성표 1번(본문 글자색)을 0번(배경색)으로, 2~7번을 검정으로 칠했다.
 */
function textColor(value: number, scheme: Scheme): string {
  const top = value >>> 24;
  if ((top & 0xfe) === 0xfe) return escherColor(value & 0xffffff, scheme);
  if (top <= 7) return escherColor(0x08000000 | top, scheme);
  return escherColor(value, scheme);
}

/**
 * Wingdings / Symbol 的符号字体码位（0xF000 私用区）→ 通用 Unicode。
 * 直接原样输出会渲染成豆腐块，必须映射成常见符号。
 */
const SYMBOL_BULLET: Record<number, string> = {
  0x6c: '●', 0x6e: '■', 0x6d: '❑', 0x71: '❑', 0x75: '◆', 0x76: '❖',
  0xa7: '▪', 0xa8: '◻', 0xb7: '•', 0xd8: '➢', 0xfc: '✓', 0xfe: '☑',
};

/** [doc-viewer] Wingdings 계열 기호 글꼴에서 글머리표로 흔히 쓰는 문자(위 표에 없는 것) */
const DINGBAT_BULLET: Record<number, string> = {
  0x6f: '□', 0x70: '◻', 0x72: '❒', 0x73: '⬧', 0x74: '⧫', 0x77: '⬥', 0x9f: '•', 0xa1: '○',
  0xe0: '➔', 0xe8: '➔', 0xf0: '⇨', 0xfb: '✗', 0xfd: '☒',
};

/** [doc-viewer] Symbol 글꼴 문자 */
const SYMBOL_FONT_BULLET: Record<number, string> = {
  0x2d: '−', 0xb7: '•', 0xd7: '⋅', 0xae: '→', 0xde: '⇒', 0xa8: '♦', 0xa7: '♣', 0xa9: '♥', 0xaa: '♠', 0xe0: '◊',
};

const SYMBOL_FONT = /wingdings|webdings|symbol|monotype sorts|dingbats|marlett/i;

function bulletChar(ch: string | undefined, font?: string): string {
  if (!ch) return '•';
  const code = ch.charCodeAt(0);
  const low = code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code;
  // [doc-viewer] 글머리표 글꼴이 기호 글꼴이면 ASCII 문자도 기호다('l'은 Wingdings의 ●)
  if (font && SYMBOL_FONT.test(font) && low < 0x100) {
    const table = /symbol/i.test(font) ? SYMBOL_FONT_BULLET : DINGBAT_BULLET;
    return table[low] ?? SYMBOL_BULLET[low] ?? '•';
  }
  const mapped = SYMBOL_BULLET[low];
  if (mapped && (code >= 0xf000 || code > 0x7f)) return mapped;
  if (code >= 0xf000) return '•';
  if (code < 32 || code === 0xfffd) return '•';
  return ch;
}

/** [doc-viewer] 글머리표의 문자·색·크기(fBulletHas* 플래그가 켠 것만 따른다) */
function bulletLook(pp: ParaProps, dft: ParaProps, env: TextEnv): { char: string; color: string | null; size: number | null } {
  const hasFont = pp.bulletHasFont ?? dft.bulletHasFont;
  const fontIdx = pp.bulletFontIdx ?? dft.bulletFontIdx;
  const font = hasFont !== false && fontIdx !== undefined ? env.fonts[fontIdx] : undefined;
  const colorRaw = pp.bulletColor ?? dft.bulletColor;
  const sizeRaw = pp.bulletSize ?? dft.bulletSize;
  return {
    char: bulletChar(pp.bulletChar ?? dft.bulletChar, font),
    color: (pp.bulletHasColor ?? dft.bulletHasColor) && colorRaw !== undefined ? textColor(colorRaw, env.scheme) : null,
    // 양수는 글자 크기 대비 %. 음수(절대 pt)는 글자 크기를 모르는 여기서 다루지 않는다
    size: (pp.bulletHasSize ?? dft.bulletHasSize) && sizeRaw !== undefined && sizeRaw > 0 ? sizeRaw / 100 : null,
  };
}

/** [doc-viewer] 줄 간격: 0 이상이면 한 줄(글자 크기의 1.2배) 대비 %, 음수면 마스터 단위 절대값 */
function lineHeightOf(v: number | undefined, size: number): number | null {
  if (v === undefined || v === 100) return null;
  if (v >= 0) return Math.max(0.5, (v / 100) * 1.2);
  return Math.max(0.5, (-v * MASTER_TO_PX) / size);
}

/** [doc-viewer] 문단 앞뒤 간격(px): 0 이상이면 한 줄 대비 %, 음수면 마스터 단위 절대값 */
function spacingOf(v: number | undefined, size: number, fallback: number): number {
  if (v === undefined) return fallback;
  return v >= 0 ? (v / 100) * size * 1.2 : -v * MASTER_TO_PX;
}

// ---------------- 幻灯片解析 ----------------

/** 组内坐标 → 绝对坐标的映射基准 */
interface Origin {
  x: number;
  y: number;
  sx: number;
  sy: number;
}

/** [doc-viewer] 텍스트 필드에 들어갈 값(이 슬라이드 기준) */
interface SlideFields {
  slideNumber: string;
  date: string;
  header: string;
  footer: string;
}

interface Ctx {
  dv: DataView;
  scheme: Scheme;
  fonts: string[];
  blobs: (string | null)[];
  /** SlideListWithText 中按 lTxid 索引的文本 */
  listText: StyledText[];
  /** [doc-viewer] SlideListWithText에서 이 슬라이드에 딸린 텍스트(OutlineTextRefAtom 순번으로 찾는다) */
  outlineText: (StyledText | null)[];
  /** [doc-viewer] 필드 값. 없으면 필드 자리 문자를 그대로 둔다 */
  fields?: SlideFields;
  scale: number;
  /** 母版逐级文本样式（TextTypeEnum → 各级），以及全局环境兜底 */
  styles: MasterStyles;
  envStyles: MasterStyles;
  /** ExHyperlink id → 链接目标（已归一为 URL 或 slide:<n>） */
  links: Map<number, string>;
  /** 当前页序号（1 起）与总页数，用于解析「下一页 / 末页」这类跳转 */
  slideIndex: number;
  slideCount: number;
  /** 解析母版图形时为 true：跳过占位符形状，只保留装饰图形 */
  masterPass: boolean;
  /** [doc-viewer] 마스터 도형(shape id → 속성·위치). 슬라이드 도형의 hspMaster가 가리키는 것을 물려받는다 */
  masterShapes?: Map<number, MasterShape>;
  levelCache: Map<string, LevelStyle>;
  /** ___PPT9 里的逐段自动编号，与游标一起按文本对象顺序认领 */
  autoNums: (AutoNum | null)[];
  autoNumCursor: number;
}

/**
 * ___PPT9 的自动编号块没写明属于哪个文本对象，只能按「段数吻合」认领：
 * 从游标处切出与本文本对象段数相同的一段，其中确实含编号才算命中并推进游标。
 * 认不出来就当没有，绝不硬套到别的文本上。
 */
function claimAutoNums(ctx: Ctx, paraCount: number): (AutoNum | null)[] | undefined {
  const from = ctx.autoNumCursor;
  if (paraCount <= 0 || from + paraCount > ctx.autoNums.length) return undefined;
  const slice = ctx.autoNums.slice(from, from + paraCount);
  if (!slice.some((a) => a !== null)) return undefined;
  ctx.autoNumCursor = from + paraCount;
  return slice;
}

/**
 * 母版文本样式解析：优先本类型，其次母版的 other，最后是 Environment 里的全局默认。
 * 越靠前的越具体，用对象展开做「后写覆盖」即可得到合并结果。
 */
function levelStyleOf(ctx: Ctx, textType: number, lvl: number): LevelStyle {
  const key = `${textType}:${lvl}`;
  const hit = ctx.levelCache.get(key);
  if (hit) return hit;
  // [doc-viewer] 단계는 아래 단계에서 물려받고(2단계에 없는 글꼴·색은 1단계 값), 가운데 제목·가운데 본문 같은 종류는
  // 기준 종류(제목·본문)에서 물려받는다([MS-PPT], POI와 같은 순서). 원본은 해당 단계 하나만 봐서
  // 2단계 이하 글머리 줄과 제목 슬라이드의 글꼴·색이 빠졌다.
  const pick = (styles: MasterStyles, type: number | undefined): LevelStyle[] => {
    const list = type !== undefined ? styles.get(type) : undefined;
    if (!list || !list.length) return [];
    return list.slice(0, Math.min(lvl, list.length - 1) + 1);
  };
  const chain = [
    ...pick(ctx.envStyles, TX.OTHER),
    ...pick(ctx.styles, TX.OTHER),
    ...pick(ctx.styles, TX_BASE[textType]),
    ...pick(ctx.styles, textType),
  ];
  const merged: LevelStyle = {
    para: Object.assign({}, ...chain.map((s) => s?.para ?? {})) as ParaProps,
    char: Object.assign({}, ...chain.map((s) => s?.char ?? {})) as TextRunProps,
  };
  ctx.levelCache.set(key, merged);
  return merged;
}

function textEnv(ctx: Ctx, textType: number): TextEnv {
  return {
    fonts: ctx.fonts,
    scheme: ctx.scheme,
    levelStyle: (lvl) => levelStyleOf(ctx, textType, lvl),
    claimAutoNums: (paraCount) => claimAutoNums(ctx, paraCount),
  };
}

function textFromClientTextbox(ctx: Ctx, rec: Rec): StyledText | null {
  return styledText(ctx, records(ctx.dv, rec.start, rec.start + rec.len));
}

/** [doc-viewer] 필드 자리 문자를 가리키는 레코드 → 필드 종류 */
const MC_FIELD: Record<number, keyof SlideFields> = {
  [RT.SlideNumberMCAtom]: 'slideNumber',
  [RT.DateTimeMCAtom]: 'date',
  [RT.GenericDateMCAtom]: 'date',
  [RT.RTFDateTimeMCAtom]: 'date',
  [RT.HeaderMCAtom]: 'header',
  [RT.FooterMCAtom]: 'footer',
};

/**
 * 텍스트 레코드 묶음 → StyledText.
 * ClientTextbox 안의 레코드와 SlideListWithText의 TextHeaderAtom 묶음([doc-viewer])이 같은 모양이라 함께 쓴다.
 */
function styledText(ctx: Ctx, recs: Iterable<Rec>): StyledText | null {
  const { dv } = ctx;
  let text: string | null = null;
  let styleRec: Rec | null = null;
  let textType: number | undefined;
  const links: LinkRange[] = [];
  let pendingLink: string | undefined;
  const fields: { pos: number; kind: keyof SlideFields }[] = [];
  for (const r of recs) {
    if (r.type === RT.TextCharsAtom) text = utf16(dv, r.start, r.len);
    else if (r.type === RT.TextBytesAtom) text = ansi(dv, r.start, r.len);
    else if (r.type === RT.StyleTextPropAtom) styleRec = r;
    else if (r.type === RT.TextHeaderAtom && r.len >= 4) textType = dv.getUint32(r.start, true);
    else if (r.type === RT.InteractiveInfo) pendingLink = interactiveLink(ctx, r);
    else if (r.type === RT.TextInteractiveInfoAtom && r.len >= 8) {
      // 紧跟在 InteractiveInfo 之后，给出该链接覆盖的字符区间
      const begin = dv.getUint32(r.start, true);
      const end = dv.getUint32(r.start + 4, true);
      if (pendingLink && end > begin) links.push({ begin, end, link: pendingLink });
      pendingLink = undefined;
    } else if (MC_FIELD[r.type] && r.len >= 4) {
      fields.push({ pos: dv.getInt32(r.start, true), kind: MC_FIELD[r.type] });
    }
  }
  if (text === null) return null;
  const styles = styleRec ? parseStyleTextProp(dv, styleRec, text.length) : { para: [], char: [] };
  const out: StyledText = { text, paraProps: styles.para, charProps: styles.char, textType, links: links.length ? links : undefined };
  // 뒤쪽 필드부터 바꿔야 앞쪽 위치가 밀리지 않는다
  if (ctx.fields) {
    for (const f of fields.sort((a, b) => b.pos - a.pos)) spliceField(out, f.pos, ctx.fields[f.kind]);
  }
  return out;
}

/**
 * [doc-viewer] pos 위치의 필드 자리 문자(보통 '*') 하나를 실제 값으로 바꾸고,
 * 그 글자를 덮던 문단·글자 속성 구간의 길이를 같은 만큼 늘리거나 줄인다.
 */
function spliceField(st: StyledText, pos: number, value: string): void {
  if (pos < 0 || pos >= st.text.length) return;
  const delta = value.length - 1;
  st.text = st.text.slice(0, pos) + value + st.text.slice(pos + 1);
  const grow = (runs: { chars: number }[]): void => {
    let at = 0;
    for (const run of runs) {
      if (pos < at + run.chars) {
        run.chars = Math.max(0, run.chars + delta);
        return;
      }
      at += run.chars;
    }
  };
  grow(st.paraProps);
  grow(st.charProps);
  if (st.links) {
    for (const l of st.links) {
      if (l.begin > pos) l.begin += delta;
      if (l.end > pos) l.end += delta;
    }
  }
}

/** ClientData / ClientTextbox 里的 OEPlaceholderAtom.placeholderId */
function placeholderId(ctx: Ctx, rec: Rec): number | null {
  const { dv } = ctx;
  const data = findRec(dv, rec.start, rec.start + rec.len, ESCHER.ClientData);
  if (!data) return null;
  const ph = findRec(dv, data.start, data.start + data.len, RT.OEPlaceholderAtom);
  return ph && ph.len >= 6 ? dv.getUint8(ph.start + 4) : null;
}

// ---------------- 超链接 ----------------

/** InteractiveInfoAtom.jump 枚举 → 目标页 */
const JUMP_SLIDE: Record<number, (i: number, n: number) => number> = {
  1: (i, n) => Math.min(i + 1, n),
  2: (i) => Math.max(i - 1, 1),
  3: () => 1,
  4: (_i, n) => n,
};

/**
 * InteractiveInfo 容器 → 链接串。
 * 优先用 ExHyperlink 的目标字符串，其次退回 InteractiveInfoAtom 自带的翻页动作。
 */
function interactiveLink(ctx: Ctx, rec: Rec): string | undefined {
  const { dv } = ctx;
  const atom = findRec(dv, rec.start, rec.start + rec.len, RT.InteractiveInfoAtom);
  if (!atom || atom.len < 16) return undefined;
  const idRef = dv.getUint32(atom.start + 4, true);
  const hit = ctx.links.get(idRef);
  if (hit) return hit;
  const jump = JUMP_SLIDE[dv.getUint8(atom.start + 10)];
  return jump ? `slide:${jump(ctx.slideIndex, ctx.slideCount)}` : undefined;
}

/** 整个形状的超链接：InteractiveInfo 挂在 ClientData 下 */
function clientDataLink(ctx: Ctx, rec: Rec): string | undefined {
  const { dv } = ctx;
  const data = findRec(dv, rec.start, rec.start + rec.len, ESCHER.ClientData);
  if (!data) return undefined;
  const info = findRec(dv, data.start, data.start + data.len, RT.InteractiveInfo);
  return info ? interactiveLink(ctx, info) : undefined;
}

/** Document > ExObjList 下的 ExHyperlink：id → 目标字符串（未归一） */
function collectHyperlinks(dv: DataView, docRec: Rec): Map<number, string> {
  const out = new Map<number, string>();
  const list = findRec(dv, docRec.start, docRec.start + docRec.len, RT.ExObjList);
  if (!list) return out;
  for (const link of findAll(dv, list.start, list.start + list.len, RT.ExHyperlink)) {
    let id: number | null = null;
    let target: string | null = null;
    let friendly: string | null = null;
    for (const r of records(dv, link.start, link.start + link.len)) {
      if (r.type === RT.ExHyperlinkAtom && r.len >= 4) id = dv.getUint32(r.start, true);
      else if (r.type === RT.CString) {
        const s = utf16(dv, r.start, r.len).replace(/\0+$/, '');
        // recInstance：0 = 显示名，1 = 目标，3 = 目标内定位
        if (r.instance === 1) target = s;
        else if (r.instance === 0) friendly = s;
      }
    }
    const value = target ?? friendly;
    if (id !== null && value) out.set(id, value);
  }
  return out;
}

/**
 * 目标字符串 → 统一链接格式。
 * PowerPoint 用 `<id>,<页序>,<页名>` 表示跳页，LibreOffice 用 `#action?jump=…`。
 */
function resolveLink(target: string, index: number, count: number): string | null {
  const raw = target.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  const action = /^#?action\?jump=(.+)$/.exec(lower) ?? /^#action\?jump=(.+)$/.exec(lower);
  if (action) {
    const what = action[1];
    if (what === 'firstslide') return 'slide:1';
    if (what === 'lastslide') return `slide:${count}`;
    if (what === 'nextslide') return `slide:${Math.min(index + 1, count)}`;
    if (what === 'previousslide') return `slide:${Math.max(index - 1, 1)}`;
    const page = /(\d+)/.exec(what);
    return page ? `slide:${page[1]}` : null;
  }

  const pptJump = /^\s*\d+\s*,\s*(\d+)\s*,/.exec(raw);
  if (pptJump) return `slide:${pptJump[1]}`;

  if (raw.startsWith('#')) {
    const page = /(\d+)\s*$/.exec(raw);
    return page ? `slide:${page[1]}` : null;
  }
  if (/^[a-z][a-z0-9+.-]*:/.test(lower)) return raw;
  if (/^www\./.test(lower)) return `https://${raw}`;
  return raw;
}

/** 解析形状的定位框：顶层用 ClientAnchor（主坐标），组内用 ChildAnchor（组坐标） */
function anchorBox(ctx: Ctx, rec: Rec, origin: Origin): { x: number; y: number; w: number; h: number } | null {
  const { dv } = ctx;
  const clientRec = findRec(dv, rec.start, rec.start + rec.len, ESCHER.ClientAnchor);
  if (clientRec) {
    const a = readAnchor(dv, clientRec);
    if (a) return { x: a.x * ctx.scale, y: a.y * ctx.scale, w: a.w * ctx.scale, h: a.h * ctx.scale };
  }
  const childRec = findRec(dv, rec.start, rec.start + rec.len, ESCHER.ChildAnchor);
  if (childRec) {
    const a = readChildAnchor(dv, childRec);
    if (a) return { x: origin.x + a.x * origin.sx, y: origin.y + a.y * origin.sy, w: a.w * origin.sx, h: a.h * origin.sy };
  }
  return null;
}

/** 定位框 + 旋转 / 翻转 / 阴影 / 形状 id：所有元素共用的基础字段 */
function elementBase(
  box: { x: number; y: number; w: number; h: number },
  sp: { id: number; flags: number },
  props: EscherProps,
  scheme: Scheme,
): ElementBase {
  const rotationRaw = props.simple.get(P.rotation);
  const base: ElementBase = {
    x: box.x, y: box.y, w: box.w, h: box.h,
    rot: rotationRaw !== undefined ? (rotationRaw / 65536) % 360 : 0,
    // 翻转标志在 Sp 记录的 flags 里，不在属性表
    flipH: (sp.flags & SP_FLAG.FLIPH) !== 0,
    flipV: (sp.flags & SP_FLAG.FLIPV) !== 0,
    // 动画按 Escher 形状 id 定位目标
    id: sp.id,
  };
  const shadow = shapeShadow(props, scheme);
  if (shadow) base.effects = { shadow };
  return base;
}

function parseSpContainer(ctx: Ctx, rec: Rec, origin: Origin): SlideElement | null {
  const { dv } = ctx;
  const spRec = findRec(dv, rec.start, rec.start + rec.len, ESCHER.Sp);
  if (!spRec) return null;
  const sp = readSp(dv, spRec);
  if (sp.flags & SP_FLAG.DELETED) return null;
  // 组壳与图形树的根都只是坐标系载体，本身不画东西
  if (sp.flags & (SP_FLAG.PATRIARCH | SP_FLAG.GROUP)) return null;
  if (sp.flags & SP_FLAG.BACKGROUND) return null;

  const ph = placeholderId(ctx, rec);
  // 母版上的占位符只是「请在此键入…」的提示框，本身不该出现在幻灯片上
  if (ctx.masterPass && ph !== null && ph !== 0) return null;

  const shapeType = spRec.instance;
  const optRec = findRec(dv, rec.start, rec.start + rec.len, ESCHER.Opt);
  const props: EscherProps = optRec ? parseOpt(dv, optRec) : { simple: new Map(), complex: new Map() };
  // [doc-viewer] 마스터 도형(hspMaster) 속성 상속: 글 상자 세로 정렬·여백·채우기 등
  const masterShape = ctx.masterPass ? undefined : ctx.masterShapes?.get(props.simple.get(P.hspMaster) ?? -1);
  if (masterShape) inheritProps(props, masterShape.props);

  let box = anchorBox(ctx, rec, origin);
  if (!box && masterShape?.anchor) {
    const a = readAnchor(dv, masterShape.anchor);
    if (a) box = { x: a.x * ctx.scale, y: a.y * ctx.scale, w: a.w * ctx.scale, h: a.h * ctx.scale };
  }
  if (!box || box.w <= 0 || box.h <= 0) return null;

  const base = elementBase(box, sp, props, ctx.scheme);
  const shapeLink = clientDataLink(ctx, rec);
  if (shapeLink) base.link = shapeLink;

  const blipUrl = (idx: number): string | null => ctx.blobs[idx - 1] ?? null;

  // 图片
  const pib = props.simple.get(P.pib);
  if (pib !== undefined && (shapeType === MSO_PICTURE_FRAME || pib > 0)) {
    const src = blipUrl(pib);
    if (src) {
      const img: ImageElement = { kind: 'image', ...base, src, crop: null, stroke: shapeStroke(props, ctx.scheme) };
      return img;
    }
  }

  const fill = shapeFill(props, ctx.scheme, blipUrl);
  const stroke = shapeStroke(props, ctx.scheme);

  // 几何
  let path: string | null = null;
  let openGeom = false;
  if (shapeType === 0 && props.complex.has(P.pVertices)) {
    path = customPath(ctx, props, box.w, box.h);
  }
  if (!path) {
    const prst = MSO_SHAPE[shapeType] ?? 'rect';
    const g = presetGeom(prst, box.w, box.h, msoAdjusts(props, shapeType));
    path = g.d;
    openGeom = g.open;
  }

  // 文本
  const tbRec = findRec(dv, rec.start, rec.start + rec.len, ESCHER.ClientTextbox);
  let styled = tbRec ? textFromClientTextbox(ctx, tbRec) : null;
  let fromOutline = false;
  if (!styled && tbRec) {
    // [doc-viewer] PowerPoint 97~2003이 저장한 자리표시자는 글자를 SlideListWithText에 두고
    // ClientTextbox에는 그 순번(OutlineTextRefAtom)만 남긴다. 이것을 읽지 않으면 제목·본문이 통째로 빠진다.
    const ref = findRec(dv, tbRec.start, tbRec.start + tbRec.len, RT.OutlineTextRefAtom);
    if (ref && ref.len >= 4) {
      styled = ctx.outlineText[dv.getInt32(ref.start, true)] ?? null;
      fromOutline = styled !== null;
    }
  }
  if (!styled) {
    const txid = props.simple.get(P.lTxid);
    if (txid !== undefined && ctx.listText[txid]) styled = ctx.listText[txid];
  }
  // 文本类型决定继承哪一套母版样式：优先 TextHeaderAtom，其次由占位符类型推断
  const textType = styled?.textType ?? (ph !== null ? PH_TEXT_TYPE[ph] : undefined) ?? TX.OTHER;
  const env = textEnv(ctx, textType);
  // [doc-viewer] ___PPT9 자동 번호는 도형 자신의 텍스트 순서대로 쌓여 있다. 개요 텍스트가 가로채면 뒤 도형의 번호가 밀린다
  if (fromOutline) env.claimAutoNums = () => undefined;
  const text = styled ? buildTextBody(styled, env, textBoxProps(props)) : null;

  if (!text && (!fill || fill.type === 'none') && !stroke) return null;

  const shape: ShapeElement = {
    kind: 'shape', ...base, path,
    fill: openGeom ? { type: 'none' } : fill,
    stroke, text, openGeom: openGeom || undefined,
  };
  return shape;
}

/** 以角度为调节值的 MSO 形状（值为 度×65536） */
const ANGLE_SHAPES = new Set([19, 98, 102, 103]);

/**
 * MSO 调节值 → 本项目预设几何期望的 OOXML 口径。
 * MSO 长度类调节值以 1/21600 为单位，OOXML 用 100000 制；
 * 角度类以 度×65536 存储，OOXML 用 1/60000 度。
 * 数值离谱时直接丢弃，让预设走自身默认值。
 */
function msoAdjusts(props: EscherProps, shapeType: number): Record<string, number> {
  const isAngle = ANGLE_SHAPES.has(shapeType);
  const out: Record<string, number> = {};
  const ids: [number, string][] = [
    [P.adjustValue, 'adj1'], [P.adjust2Value, 'adj2'],
    [P.adjust3Value, 'adj3'], [P.adjust4Value, 'adj4'],
  ];
  for (const [id, key] of ids) {
    const raw = props.simple.get(id);
    if (raw === undefined) continue;
    const signed = raw > 0x7fffffff ? raw - 0x100000000 : raw;
    if (isAngle) {
      out[key] = (signed / 65536) * 60000;
      continue;
    }
    // 超出几何盒 4 倍的值视为无效
    if (Math.abs(signed) > 21600 * 4) continue;
    out[key] = (signed / 21600) * 100000;
  }
  if (out.adj1 !== undefined) out.adj = out.adj1;
  return out;
}

/** pVertices + pSegmentInfo → SVG path（复用 pptx 的 custGeom 逻辑不适用，这里直接生成） */
function customPath(ctx: Ctx, props: EscherProps, w: number, h: number): string | null {
  const { dv } = ctx;
  const v = props.complex.get(P.pVertices);
  const s = props.complex.get(P.pSegmentInfo);
  if (!v || v.len < 6) return null;
  // 复杂属性数组头：u16 count, u16 countMax, u16 entrySize
  // [doc-viewer] 원소 크기 0xFFF0(−16)은 4바이트 원소(int16 좌표 두 개)다. 원본은 이것을 음수 크기로 써서 꼭짓점을 거꾸로 읽었다
  const readArray = (c: { start: number; len: number }, parse: (off: number, size: number) => number[]): number[][] => {
    if (c.len < 6) return [];
    const count = dv.getUint16(c.start, true);
    const size = arrayElementSize(dv.getInt16(c.start + 4, true));
    const out: number[][] = [];
    if (size <= 0) return out;
    for (let i = 0; i < count; i++) {
      const off = c.start + 6 + i * size;
      if (off + size > c.start + c.len) break;
      out.push(parse(off, size));
    }
    return out;
  };
  const pts = readArray(v, (off, size) =>
    size >= 8 ? [dv.getInt32(off, true), dv.getInt32(off + 4, true)] : [dv.getInt16(off, true), dv.getInt16(off + 2, true)],
  );
  if (!pts.length) return null;

  const gl = props.simple.get(P.geoLeft) ?? 0;
  const gt = props.simple.get(P.geoTop) ?? 0;
  const gr = props.simple.get(P.geoRight) ?? 21600;
  const gb = props.simple.get(P.geoBottom) ?? 21600;
  const sx = w / Math.max(1, gr - gl);
  const sy = h / Math.max(1, gb - gt);
  const px = (p: number[]): string => `${((p[0] - gl) * sx).toFixed(2)} ${((p[1] - gt) * sy).toFixed(2)}`;

  if (!s) return `M ${pts.map(px).join(' L ')} Z`;

  // [doc-viewer] [MS-ODRAW] MSOPATHINFO: 위 3비트가 종류, 아래 13비트가 개수.
  // 0 lineTo(점 n개), 1 curveTo(3차 베지어 n개 = 점 3n개), 2 moveTo, 3 close, 4 end, 5 escape, 6 clientEscape.
  // escape는 5비트 코드 + 8비트 꼭짓점 수다. PowerPoint·LibreOffice는 꼭짓점마다 0xAC00·0xB000·0xB300 같은
  // 꼭짓점 종류 표시(점 0개)를 앞에 붙이는데, 원본은 0xB300을 곡선으로, curveTo(0x2001)를 직선으로 읽어 점이 밀렸다.
  const segs = readArray(s, (off) => [dv.getUint16(off, true)]);
  const out: string[] = [];
  let pi = 0;
  let cur: number[] = pts[0];
  let quadrantX = true;
  const take = (): number[] | undefined => {
    const p = pts[pi++];
    if (p) cur = p;
    return p;
  };
  for (const [seg] of segs) {
    const type = seg >> 13;
    const count = seg & 0x1fff;
    if (type === 0) {
      for (let i = 0; i < Math.max(1, count) && pts[pi]; i++) out.push(`L ${px(take()!)}`);
    } else if (type === 1) {
      for (let i = 0; i < Math.max(1, count); i++) {
        const a = take(), b = take(), c = take();
        if (a && b && c) out.push(`C ${px(a)} ${px(b)} ${px(c)}`);
      }
    } else if (type === 2) {
      const p = take();
      if (p) out.push(`M ${px(p)}`);
      quadrantX = true;
    } else if (type === 3) {
      out.push('Z');
    } else if (type === 5 || type === 6) {
      const code = (seg >> 8) & 0x1f;
      const n = seg & 0xff;
      if (type === 5 && (code === 0x07 || code === 0x08)) {
        // 타원 사분호: 시작 방향이 가로(0x07)·세로(0x08)이고 점마다 방향이 번갈아 바뀐다
        quadrantX = code === 0x07;
        for (let i = 0; i < n; i++) {
          const from = cur;
          const to = take();
          if (!to) break;
          const k = 0.5523;
          const c1 = quadrantX ? [from[0] + (to[0] - from[0]) * k, from[1]] : [from[0], from[1] + (to[1] - from[1]) * k];
          const c2 = quadrantX ? [to[0], to[1] - (to[1] - from[1]) * k] : [to[0] - (to[0] - from[0]) * k, to[1]];
          out.push(`C ${px(c1)} ${px(c2)} ${px(to)}`);
          quadrantX = !quadrantX;
        }
      } else if (type === 5 && code === 0x09) {
        // 2차 베지어: 점 두 개씩
        for (let i = 0; i + 1 < n; i += 2) {
          const a = take(), b = take();
          if (a && b) out.push(`Q ${px(a)} ${px(b)}`);
        }
      } else if (n > 0) {
        // 호(arcTo 등)는 끝점까지 직선으로 근사하고, 나머지 escape는 점만 건너뛴다
        let last: number[] | undefined;
        for (let i = 0; i < n; i++) last = take() ?? last;
        if (type === 5 && code >= 0x01 && code <= 0x06 && last) out.push(`L ${px(last)}`);
      }
    }
    // type 4(end)는 하위 경로의 끝일 뿐이라 뒤에 다른 하위 경로가 이어질 수 있다
  }
  if (out.length && !out[0].startsWith('M')) out.unshift(`M ${px(pts[0])}`);
  return out.length ? out.join(' ') : `M ${pts.map(px).join(' L ')} Z`;
}

/** 组自身：定位框、子坐标系，以及旋转 / 翻转所需的 Sp 与属性表 */
interface GroupSelf {
  rec: Rec;
  sp: { id: number; flags: number };
  props: EscherProps;
  box: { x: number; y: number; w: number; h: number };
  space: { x: number; y: number; w: number; h: number };
}

/**
 * 组内子元素的坐标基准：只把组单位换算成 px，不做组自身的缩放
 * ——缩放交给 GroupElement 的 scaleX/scaleY，这样组被拉伸时文字也跟着变，
 * 与 .pptx 侧 chOff/chExt 的口径一致。
 */
const groupOrigin = (ctx: Ctx): Origin => ({ x: 0, y: 0, sx: ctx.scale, sy: ctx.scale });

/**
 * 组容器。
 * 真正的组产出 GroupElement 保留层级：子元素坐标留在组坐标系里，
 * 由 childX/childY + scaleX/scaleY 描述到父坐标系的映射。
 * 表格组与最外层的 patriarch 例外——前者要还原成表格，后者只是图形树的根。
 */
function parseSpgrContainer(ctx: Ctx, rec: Rec, parent: Origin, depth = 0): SlideElement[] {
  const { dv } = ctx;
  const out: SlideElement[] = [];
  const children = [...records(dv, rec.start, rec.start + rec.len)];
  const first = children.find((c) => c.type === ESCHER.SpContainer);
  const self = first ? readGroupSelf(ctx, first, parent) : null;
  const groupSelf = self?.rec ?? null;

  // 展平用的坐标映射：组框左上角 − 子坐标系原点 × 缩放
  let flat = parent;
  if (self) {
    const sx = self.box.w / self.space.w;
    const sy = self.box.h / self.space.h;
    flat = { x: self.box.x - self.space.x * sx, y: self.box.y - self.space.y * sy, sx, sy };
  }

  const childShapes = (origin: Origin): SlideElement[] => {
    const els: SlideElement[] = [];
    for (const child of children) {
      if (child === groupSelf || child.type !== ESCHER.SpContainer) continue;
      const el = parseSpContainer(ctx, child, origin);
      if (el) els.push(el);
    }
    return els;
  };

  // 表格组：子形状即单元格，按行高与列边界还原成表格元素
  if (self && isTableGroup(self.props)) {
    const cells = childShapes(flat);
    const table = buildTable(cells, tableRowHeights(dv, self.props).map((h) => h * ctx.scale));
    if (table) return [table];
    return cells;
  }

  // 没有表格标记时用网格启发式：导出器常把表格拆成「底色矩形 + 文字框」两层
  if (self && children.filter((c) => c.type === ESCHER.SpContainer).length >= 4) {
    const merged = mergeCellLayers(childShapes(flat));
    if (looksLikeGrid(merged)) {
      const table = buildTable(merged, []);
      if (table) return [table];
    }
  }

  const collect = (origin: Origin, into: SlideElement[]): void => {
    for (const child of children) {
      if (child === groupSelf) continue;
      if (child.type === ESCHER.SpContainer) {
        const el = parseSpContainer(ctx, child, origin);
        if (el) into.push(el);
      } else if (child.type === ESCHER.SpgrContainer && depth < 8) {
        into.push(...parseSpgrContainer(ctx, child, origin, depth + 1));
      }
    }
  };

  if (self) {
    const kids: SlideElement[] = [];
    collect(groupOrigin(ctx), kids);
    if (!kids.length) return [];
    const spaceW = self.space.w * ctx.scale;
    const spaceH = self.space.h * ctx.scale;
    const group: GroupElement = {
      kind: 'group',
      ...elementBase(self.box, self.sp, self.props, ctx.scheme),
      childX: self.space.x * ctx.scale,
      childY: self.space.y * ctx.scale,
      scaleX: self.box.w / spaceW,
      scaleY: self.box.h / spaceH,
      children: kids,
    };
    return [group];
  }

  collect(flat, out);
  return out;
}

/**
 * 组容器的首个 SpContainer 若带 GROUP 标志就是组自身。
 * patriarch（图形树的根）与退化成零尺寸的组不算，交给调用方按展平处理。
 */
function readGroupSelf(ctx: Ctx, rec: Rec, parent: Origin): GroupSelf | null {
  const { dv } = ctx;
  const spgr = findRec(dv, rec.start, rec.start + rec.len, ESCHER.Spgr);
  const spRec = findRec(dv, rec.start, rec.start + rec.len, ESCHER.Sp);
  if (!spgr || !spRec) return null;
  const sp = readSp(dv, spRec);
  if (!(sp.flags & SP_FLAG.GROUP) || (sp.flags & SP_FLAG.PATRIARCH)) return null;
  const space = readSpgr(dv, spgr);
  const box = anchorBox(ctx, rec, parent);
  if (!space || !box || space.w <= 0 || space.h <= 0 || box.w <= 0 || box.h <= 0) return null;
  const optRec = findRec(dv, rec.start, rec.start + rec.len, ESCHER.Opt);
  const props: EscherProps = optRec ? parseOpt(dv, optRec) : { simple: new Map(), complex: new Map() };
  return { rec, sp, props, box, space };
}

/**
 * 把落在同一格的多个图形合并成一个单元格：
 * 包围盒基本重合时，取有填充的那个作底色、有文字的那个作内容。
 */
function mergeCellLayers(els: SlideElement[]): SlideElement[] {
  const shapes = els.filter((e): e is ShapeElement => e.kind === 'shape');
  if (shapes.length !== els.length) return els;

  const TOL = 3;
  const out: ShapeElement[] = [];
  for (const s of shapes) {
    const hit = out.find(
      (o) => Math.abs(o.x - s.x) <= TOL && Math.abs(o.y - s.y) <= TOL &&
        Math.abs(o.w - s.w) <= TOL * 2 && Math.abs(o.h - s.h) <= TOL * 2,
    );
    if (!hit) {
      out.push({ ...s });
      continue;
    }
    if (!hit.text && s.text) hit.text = s.text;
    if ((!hit.fill || hit.fill.type === 'none') && s.fill && s.fill.type !== 'none') hit.fill = s.fill;
    if (!hit.stroke && s.stroke) hit.stroke = s.stroke;
  }
  return out;
}

/**
 * 网格启发式：一组矩形要构成表格，需满足行列都 ≥2、单元格数接近行列乘积、
 * 且相邻单元格紧邻（无明显间隙）。条件从严，避免把普通图形组误判成表格。
 */
function looksLikeGrid(cells: SlideElement[]): boolean {
  const shapes = cells.filter((c): c is ShapeElement => c.kind === 'shape' && c.path !== null);
  if (shapes.length < 4 || shapes.length !== cells.length) return false;

  const TOL = 2.5;
  const cluster = (vals: number[]): number[] => {
    const sorted = [...vals].sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of sorted) if (!out.length || v - out[out.length - 1] > TOL) out.push(v);
    return out;
  };
  const cols = cluster(shapes.map((s) => s.x));
  const rows = cluster(shapes.map((s) => s.y));
  if (cols.length < 2 || rows.length < 2) return false;
  if (shapes.length > cols.length * rows.length) return false;
  // 允许合并单元格造成的缺口，但不能太稀疏
  if (shapes.length < cols.length * rows.length * 0.5) return false;

  // 相邻列/行之间不能有空隙：下一条边界应落在上一格右/下边缘附近
  const edgeFits = (edges: number[], starts: number[], ends: number[]): boolean => {
    for (let i = 0; i + 1 < edges.length; i++) {
      const near = starts.some((s, k) => Math.abs(s - edges[i]) <= TOL && Math.abs(ends[k] - edges[i + 1]) <= TOL * 2);
      if (!near) return false;
    }
    return true;
  };
  const okCols = edgeFits(cols, shapes.map((s) => s.x), shapes.map((s) => s.x + s.w));
  const okRows = edgeFits(rows, shapes.map((s) => s.y), shapes.map((s) => s.y + s.h));
  return okCols && okRows;
}

/**
 * 由单元格形状还原表格结构。
 * 二进制格式不直接存列宽，用所有单元格的左边界聚类得到列边界，
 * 单元格跨列数由其宽度覆盖了几个列区间推出。
 */
function buildTable(cells: SlideElement[], rowHeights: number[]): TableElement | null {
  const shapes = cells.filter((c): c is ShapeElement => c.kind === 'shape');
  if (shapes.length < 2) return null;

  const TOL = 2;
  const uniq = (vals: number[]): number[] => {
    const sorted = [...vals].sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of sorted) if (!out.length || v - out[out.length - 1] > TOL) out.push(v);
    return out;
  };

  const colEdges = uniq(shapes.map((s) => s.x));
  const rowEdges = uniq(shapes.map((s) => s.y));
  if (colEdges.length < 1 || rowEdges.length < 1) return null;

  const x0 = colEdges[0];
  const y0 = rowEdges[0];
  const right = Math.max(...shapes.map((s) => s.x + s.w));
  const bottom = Math.max(...shapes.map((s) => s.y + s.h));

  const colWidths = colEdges.map((edge, i) => (i + 1 < colEdges.length ? colEdges[i + 1] : right) - edge);
  const heights = rowEdges.map((edge, i) => (i + 1 < rowEdges.length ? rowEdges[i + 1] : bottom) - edge);
  const finalHeights = rowHeights.length === rowEdges.length ? rowHeights : heights;

  const colOf = (x: number): number => {
    let best = 0;
    for (let i = 0; i < colEdges.length; i++) if (x >= colEdges[i] - TOL) best = i;
    return best;
  };
  const rowOf = (y: number): number => {
    let best = 0;
    for (let i = 0; i < rowEdges.length; i++) if (y >= rowEdges[i] - TOL) best = i;
    return best;
  };

  const grid: (TableCell | null)[][] = rowEdges.map(() => colEdges.map(() => null));
  for (const s of shapes) {
    const r = rowOf(s.y);
    const c = colOf(s.x);
    if (grid[r][c]) continue;
    let colSpan = 0;
    for (let i = c; i < colEdges.length && colEdges[i] < s.x + s.w - TOL; i++) colSpan++;
    let rowSpan = 0;
    for (let i = r; i < rowEdges.length && rowEdges[i] < s.y + s.h - TOL; i++) rowSpan++;
    grid[r][c] = {
      colSpan: Math.max(1, colSpan),
      rowSpan: Math.max(1, rowSpan),
      merged: false,
      fill: s.fill,
      text: s.text,
      borders: { l: s.stroke, r: s.stroke, t: s.stroke, b: s.stroke },
      vAlign: s.text?.anchor === 'middle' ? 'middle' : s.text?.anchor === 'bottom' ? 'bottom' : 'top',
    };
    // 被跨越覆盖的格子标记为已合并
    for (let rr = r; rr < r + Math.max(1, rowSpan); rr++) {
      for (let cc = c; cc < c + Math.max(1, colSpan); cc++) {
        if (rr === r && cc === c) continue;
        if (grid[rr]?.[cc] === null) {
          grid[rr][cc] = { colSpan: 1, rowSpan: 1, merged: true, fill: null, text: null };
        }
      }
    }
  }

  const rows: TableRow[] = grid.map((cellRow, i) => ({
    height: finalHeights[i] ?? 0,
    cells: cellRow.map((c) => c ?? { colSpan: 1, rowSpan: 1, merged: false, fill: null, text: null }),
  }));

  return {
    kind: 'table',
    x: x0, y: y0, w: right - x0, h: bottom - y0,
    rot: 0, flipH: false, flipV: false,
    colWidths,
    rows,
    name: '表格',
  };
}

// ---------------- 持久化目录（persistId → 记录） ----------------

/**
 * PersistDirectoryAtom：一串 (startId | count<<20) + count 个流内偏移。
 * 增量保存会追加新的目录，靠后的条目覆盖靠前的，正好等于「按文档顺序后写覆盖先写」。
 */
function persistOffsets(dv: DataView, docLen: number): Map<number, number> {
  const map = new Map<number, number>();
  for (const r of records(dv, 0, docLen)) {
    if (r.type !== RT.PersistDirectoryAtom) continue;
    readPersistDirectory(dv, r, map, false);
  }
  return map;
}

/**
 * [doc-viewer] PersistDirectoryAtom 하나를 map에 합친다.
 * keepExisting이면 이미 있는 항목을 덮어쓰지 않는다(편집 사슬을 최신 → 과거 순으로 따라갈 때).
 */
function readPersistDirectory(dv: DataView, rec: Rec, map: Map<number, number>, keepExisting: boolean): void {
  const end = rec.start + rec.len;
  let off = rec.start;
  while (off + 4 <= end) {
    const head = dv.getUint32(off, true);
    off += 4;
    const startId = head & 0xfffff;
    const count = head >>> 20;
    for (let i = 0; i < count && off + 4 <= end; i++, off += 4) {
      if (!keepExisting || !map.has(startId + i)) map.set(startId + i, dv.getUint32(off, true));
    }
  }
}

/** [doc-viewer] 스트림의 off 위치에 있는 레코드 하나. 머리가 범위를 넘거나 길이가 맞지 않으면 null */
function recAt(dv: DataView, off: number, limit: number): Rec | null {
  if (!(off >= 0) || off + 8 > limit) return null;
  const verInst = dv.getUint16(off, true);
  const len = dv.getUint32(off + 4, true);
  if (off + 8 + len > limit) return null;
  const version = verInst & 0xf;
  return { type: dv.getUint16(off + 2, true), instance: verInst >> 4, version, isContainer: version === 0xf, start: off + 8, len };
}

interface EditChain {
  offsets: Map<number, number>;
  /** 가장 최근 UserEditAtom.docPersistIdRef: 현재 Document 컨테이너의 persist id */
  docPersistId: number;
}

/**
 * [doc-viewer] UserEditAtom 사슬을 따라 지속성 디렉터리를 만든다([MS-PPT] 2.3.2).
 *
 * '빠른 저장'한 파일은 저장할 때마다 Document·Slide 컨테이너와 디렉터리가 스트림 뒤에 덧붙는다.
 * 원본처럼 스트림 순서대로 훑으면 첫(가장 오래된) Document를 잡아 슬라이드 목록과 글자가
 * 옛 판으로 나온다. 사슬은 최신 편집부터 시작하므로 먼저 본 항목이 이긴다.
 */
function editChain(dv: DataView, docLen: number, firstEdit: number): EditChain | null {
  const offsets = new Map<number, number>();
  let docPersistId = -1;
  const seen = new Set<number>();
  let off = firstEdit;
  while (off > 0 && !seen.has(off) && seen.size < 10000) {
    seen.add(off);
    const ue = recAt(dv, off, docLen);
    if (!ue || ue.type !== RT.UserEditAtom || ue.len < 20) break;
    if (docPersistId < 0) docPersistId = dv.getUint32(ue.start + 16, true);
    const dir = recAt(dv, dv.getUint32(ue.start + 12, true), docLen);
    if (dir && dir.type === RT.PersistDirectoryAtom) readPersistDirectory(dv, dir, offsets, true);
    off = dv.getUint32(ue.start + 8, true);
  }
  return offsets.size && docPersistId >= 0 ? { offsets, docPersistId } : null;
}

interface PersistEntry {
  rec: Rec;
  /** SlidePersistAtom.slideId：SlideAtom 的 masterIdRef / notesIdRef 按它做关联 */
  slideId: number;
  /**
   * [doc-viewer] SlideListWithText에서 이 슬라이드의 SlidePersistAtom 뒤에 오는 텍스트 묶음.
   * 묶음마다 TextHeaderAtom으로 시작하며, 자리표시자는 OutlineTextRefAtom의 순번으로 이것을 가리킨다.
   */
  texts: Rec[][];
}

/**
 * 按 SlideListWithText 的顺序取出幻灯片 / 母版 / 备注容器。
 * 这是文件里权威的顺序来源；持久化目录解析不出来时由调用方退回文档顺序扫描。
 */
function persistList(
  dv: DataView,
  docRec: Rec,
  instance: number,
  resolve: (persistId: number) => Rec | null,
  types: number[],
): PersistEntry[] {
  const out: PersistEntry[] = [];
  for (const list of findAll(dv, docRec.start, docRec.start + docRec.len, RT.SlideListWithText)) {
    if (list.instance !== instance) continue;
    // 찾지 못한 슬라이드의 텍스트가 다음 슬라이드로 넘어가지 않도록 현재 항목을 따로 쥔다
    let current: PersistEntry | null = null;
    for (const r of records(dv, list.start, list.start + list.len)) {
      if (r.type === RT.SlidePersistAtom) {
        current = null;
        if (r.len < 16) continue;
        const rec = resolve(dv.getUint32(r.start, true));
        if (rec && types.includes(rec.type)) {
          current = { rec, slideId: dv.getUint32(r.start + 12, true), texts: [] };
          out.push(current);
        }
      } else if (current) {
        if (r.type === RT.TextHeaderAtom) current.texts.push([r]);
        else current.texts[current.texts.length - 1]?.push(r);
      }
    }
  }
  return out;
}

// ---------------- 母版 ----------------

interface MasterInfo {
  scheme: Scheme;
  styles: MasterStyles;
  background: Fill | null;
  elements: SlideElement[];
  /** [doc-viewer] 마스터의 날짜·쪽 번호·바닥글 자리표시자. 슬라이드마다 머리글·바닥글 설정에 따라 그린다 */
  hfShapes: { kind: HfKind; rec: Rec }[];
  /** [doc-viewer] shape id → 속성·위치(슬라이드 자리표시자가 hspMaster로 물려받는다) */
  shapes: Map<number, MasterShape>;
}

/** [doc-viewer] 마스터 도형 하나의 속성표와 ClientAnchor */
interface MasterShape {
  props: EscherProps;
  anchor: Rec | null;
}

/** [doc-viewer] 도형 트리 전체에서 shape id → 속성·위치 */
function masterShapes(dv: DataView, drawing: Rec): Map<number, MasterShape> {
  const out = new Map<number, MasterShape>();
  const walk = (start: number, end: number, depth: number): void => {
    for (const r of records(dv, start, end)) {
      if (r.type === ESCHER.SpContainer) {
        const sp = findRec(dv, r.start, r.start + r.len, ESCHER.Sp);
        const opt = findRec(dv, r.start, r.start + r.len, ESCHER.Opt);
        if (sp && opt) {
          out.set(readSp(dv, sp).id, {
            props: parseOpt(dv, opt),
            anchor: findRec(dv, r.start, r.start + r.len, ESCHER.ClientAnchor),
          });
        }
      } else if (r.isContainer && depth < 8) walk(r.start, r.start + r.len, depth + 1);
    }
  };
  walk(drawing.start, drawing.start + drawing.len, 0);
  return out;
}

/** [doc-viewer] 머리글·바닥글 자리표시자 종류 */
type HfKind = 'date' | 'slideNumber' | 'footer';

/** [doc-viewer] PlaceholderEnum의 마스터 날짜(7)·쪽 번호(8)·바닥글(9) */
const PH_HF: Record<number, HfKind> = { 7: 'date', 8: 'slideNumber', 9: 'footer' };

/** [doc-viewer] HeadersFootersAtom 플래그([MS-PPT] 2.4.15.2) */
const HF_FLAG = { DATE: 0x1, TODAY: 0x2, USER_DATE: 0x4, SLIDE_NUMBER: 0x8, HEADER: 0x10, FOOTER: 0x20 } as const;

/** [doc-viewer] 도형 트리 맨 위층에서 placeholderId가 머리글·바닥글인 SpContainer */
function hfPlaceholders(dv: DataView, drawing: Rec): { kind: HfKind; rec: Rec }[] {
  const out: { kind: HfKind; rec: Rec }[] = [];
  const dg = findRec(dv, drawing.start, drawing.start + drawing.len, ESCHER.DgContainer);
  if (!dg) return out;
  for (const spgr of findAll(dv, dg.start, dg.start + dg.len, ESCHER.SpgrContainer)) {
    for (const sp of findAll(dv, spgr.start, spgr.start + spgr.len, ESCHER.SpContainer)) {
      const data = findRec(dv, sp.start, sp.start + sp.len, ESCHER.ClientData);
      const ph = data ? findRec(dv, data.start, data.start + data.len, RT.OEPlaceholderAtom) : null;
      const kind = ph && ph.len >= 6 ? PH_HF[dv.getUint8(ph.start + 4)] : undefined;
      if (kind) out.push({ kind, rec: sp });
    }
  }
  return out;
}

/** [doc-viewer] 머리글·바닥글 컨테이너 → 플래그와 문구 */
interface HfSettings {
  flags: number;
  /** 날짜 형식 번호(오늘 날짜를 쓸 때) */
  formatId: number;
  userDate: string;
  header: string;
  footer: string;
}

function readHeadersFooters(dv: DataView, rec: Rec): HfSettings {
  const hf: HfSettings = { flags: 0, formatId: 0, userDate: '', header: '', footer: '' };
  for (const r of records(dv, rec.start, rec.start + rec.len)) {
    if (r.type === RT.HeadersFootersAtom && r.len >= 4) {
      hf.formatId = dv.getInt16(r.start, true);
      hf.flags = dv.getUint16(r.start + 2, true);
    } else if (r.type === RT.CString) {
      const s = utf16(dv, r.start, r.len).replace(/\0+$/, '');
      if (r.instance === 0) hf.userDate = s;
      else if (r.instance === 1) hf.header = s;
      else if (r.instance === 2) hf.footer = s;
    }
  }
  return hf;
}

/** [doc-viewer] 오늘 날짜를 DateTimeFormat 번호에 가깝게 쓴다. 형식 표는 로캘마다 달라 대표 형식만 맞춘다 */
function formatToday(formatId: number): string {
  const now = new Date();
  try {
    if (formatId === 1) return now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    if (formatId === 2 || formatId === 3) return now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    if (formatId >= 9) return now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (formatId === 7 || formatId === 8) return now.toLocaleString();
    return now.toLocaleDateString();
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** 幻灯片 / 母版容器里的 ColorSchemeAtom → 8 色配色方案 */
function readScheme(dv: DataView, rec: Rec, instance: number): Scheme | null {
  for (const r of findAll(dv, rec.start, rec.start + rec.len, RT.ColorSchemeAtom)) {
    if (r.instance !== instance || r.len < 32) continue;
    const out: Scheme = [];
    for (let i = 0; i < 8; i++) {
      const v = dv.getUint32(r.start + i * 4, true);
      const parts = [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
      out.push(parts.map((c) => c.toString(16).padStart(2, '0')).join(''));
    }
    return out;
  }
  return null;
}

/** PPDrawing → DgContainer 直属的背景形状（fBackground），其填充即整页底色 */
function drawingBackground(dv: DataView, drawing: Rec, scheme: Scheme, blipUrl: (i: number) => string | null): Fill | null {
  const dg = findRec(dv, drawing.start, drawing.start + drawing.len, ESCHER.DgContainer);
  if (!dg) return null;
  for (const sp of findAll(dv, dg.start, dg.start + dg.len, ESCHER.SpContainer)) {
    const spRec = findRec(dv, sp.start, sp.start + sp.len, ESCHER.Sp);
    if (!spRec || !(readSp(dv, spRec).flags & SP_FLAG.BACKGROUND)) continue;
    const optRec = findRec(dv, sp.start, sp.start + sp.len, ESCHER.Opt);
    if (!optRec) continue;
    const props = parseOpt(dv, optRec);
    // 只有真的写了填充属性才算数：转换器常留一个「已填充但没给颜色」的空壳
    if (!props.simple.has(P.fillColor) && !props.simple.has(P.fillType) && !props.simple.has(P.fillBlip)) continue;
    const fill = shapeFill(props, scheme, blipUrl);
    if (fill && fill.type !== 'none') return fill;
  }
  return null;
}

/** 遍历 PPDrawing 的图形树 */
function drawingElements(ctx: Ctx, drawing: Rec): SlideElement[] {
  const out: SlideElement[] = [];
  const dg = findRec(ctx.dv, drawing.start, drawing.start + drawing.len, ESCHER.DgContainer);
  if (!dg) return out;
  for (const spgr of findAll(ctx.dv, dg.start, dg.start + dg.len, ESCHER.SpgrContainer)) {
    out.push(...parseSpgrContainer(ctx, spgr, { x: 0, y: 0, sx: ctx.scale, sy: ctx.scale }));
  }
  return out;
}

function parseMaster(
  dv: DataView, rec: Rec, shared: Shared, slideScheme: Scheme | null = null, parent: MasterInfo | null = null,
): MasterInfo {
  // [doc-viewer] 슬라이드가 자기 색 구성표를 가지면 마스터 도형·배경도 그 구성표로 칠한다
  const scheme = slideScheme ?? readScheme(dv, rec, 1) ?? readScheme(dv, rec, 6) ?? DEFAULT_SCHEME;
  // [doc-viewer] 제목 마스터(Slide 컨테이너)는 글자 스타일을 따로 두지 않고 기본 마스터의 것을 쓴다.
  // 원본은 빈 스타일로 풀어 제목 슬라이드의 제목·부제목이 왼쪽 정렬·기본 글꼴로 나왔다
  const styles: MasterStyles = new Map(parent?.styles ?? []);
  for (const r of findAll(dv, rec.start, rec.start + rec.len, RT.TxMasterStyleAtom)) {
    parseTxMasterStyle(dv, r, styles);
  }

  const drawing = findRec(dv, rec.start, rec.start + rec.len, RT.PPDrawing);
  const blipUrl = (idx: number): string | null => shared.blobs[idx - 1] ?? null;
  // 제목 마스터가 '마스터 배경 따름'(SlideAtom.slideFlags bit 2)이고 자기 배경 도형이 없으면 기본 마스터 배경
  const atom = parent ? findRec(dv, rec.start, rec.start + rec.len, RT.SlideAtom) : null;
  const followBackground = !!atom && atom.len >= 24 && (dv.getUint16(atom.start + 20, true) & 0x4) !== 0;
  const background = (drawing ? drawingBackground(dv, drawing, scheme, blipUrl) : null)
    ?? (followBackground ? parent?.background ?? null : null);

  const ctx: Ctx = {
    dv, scheme, fonts: shared.fonts, blobs: shared.blobs, listText: [], outlineText: [], scale: shared.scale,
    styles, envStyles: shared.envStyles, links: new Map(), masterPass: true,
    levelCache: new Map(), slideIndex: 1, slideCount: 1,
    autoNums: collectAutoNums(dv, rec), autoNumCursor: 0,
  };
  const elements = drawing ? drawingElements(ctx, drawing) : [];
  // [doc-viewer] 제목 마스터 도형도 기본 마스터 도형을 물려받을 수 있어 사슬을 미리 풀고, 기본 마스터 도형도 함께 찾게 둔다
  const shapes = drawing ? masterShapes(dv, drawing) : new Map<number, MasterShape>();
  if (parent) {
    for (const s of shapes.values()) {
      const from = parent.shapes.get(s.props.simple.get(P.hspMaster) ?? -1);
      if (from) inheritProps(s.props, from.props);
    }
    for (const [id, s] of parent.shapes) if (!shapes.has(id)) shapes.set(id, s);
  }
  return {
    scheme, styles, background, elements,
    hfShapes: drawing ? hfPlaceholders(dv, drawing) : [],
    shapes,
  };
}

// ---------------- 演讲者备注 ----------------

/** Notes 容器里 TextTypeEnum 为 notes 的文本即备注正文（页码 / 页脚域不算） */
function notesText(dv: DataView, rec: Rec): string {
  const lines: string[] = [];
  let type = -1;
  const walk = (start: number, end: number, depth: number): void => {
    for (const r of records(dv, start, end)) {
      if (r.type === RT.TextHeaderAtom && r.len >= 4) type = dv.getUint32(r.start, true);
      else if (r.type === RT.TextCharsAtom || r.type === RT.TextBytesAtom) {
        if (type === TX.NOTES) {
          const raw = r.type === RT.TextCharsAtom ? utf16(dv, r.start, r.len) : ansi(dv, r.start, r.len);
          const text = raw.replace(/\r\n?/g, '\n').replace(/\v/g, '\n').replace(/\0/g, '').trim();
          if (text) lines.push(text);
        }
        type = -1;
      } else if (r.isContainer && depth < 8) walk(r.start, r.start + r.len, depth + 1);
    }
  };
  walk(rec.start, rec.start + rec.len, 0);
  return lines.join('\n');
}

// ---------------- 入口 ----------------

interface Shared {
  fonts: string[];
  blobs: (string | null)[];
  scale: number;
  envStyles: MasterStyles;
}

export function parsePpt(bytes: Uint8Array, password?: string): Presentation {
  const cfb = new Cfb(bytes);

  // 加密的 .pptx 已在 parse() 里被 EncryptedPackage 流拦下并解密，走不到这里
  if (cfb.stream('EncryptedPackage') || cfb.stream('EncryptionInfo')) {
    throw new Error('该文件是加密的 OOXML 容器，请用 parse(input, { password })');
  }

  let doc = cfb.stream('PowerPoint Document');
  if (!doc) throw new Error('无效的 .ppt：找不到 PowerPoint Document 流');

  // 老式 .ppt 的 RC4 CryptoAPI 加密。判据在 Current User 流的 headerToken 上，
  // 不看这一处就只会得到「.ppt 中未找到幻灯片」——实测 POI 语料里 5 个加密文件
  // 全都被这样误诊过。
  const currentUser = cfb.stream('Current User');
  if (isPptEncrypted(currentUser) && currentUser) {
    const decrypt = getPptDecryptor();
    if (!decrypt) throw new Error('该 .ppt 已加密，但未注入解密器（setPptDecryptor）');
    if (password === undefined) throw new Error('该 .ppt 已加密，请通过 parse(input, { password }) 提供打开密码');
    const plain = decrypt(doc, currentUser, password);
    if (!plain) throw new Error('该 .ppt 已加密，但加密结构无法识别');
    doc = plain;
  }
  const dv = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);

  let width = 720 * (96 / 72);
  let height = 540 * (96 / 72);

  // 图片
  const pictures = cfb.stream('Pictures');
  const blips = pictures ? extractBlips(pictures) : [];
  const blobs = blips.map((b) => {
    try {
      // 图元文件浏览器无法直接解码，转成 SVG data URI。
      // PICT 是 Mac 版存的，同样要走解码器——直接丢给 <img> 只会是裂图
      if (b.mime === 'image/emf' || b.mime === 'image/wmf' || b.mime === 'image/pict') {
        return metafileDataUrl(b.data);
      }
      return URL.createObjectURL(new Blob([b.data.slice().buffer], { type: b.mime }));
    } catch {
      return null;
    }
  });

  // 顶层记录索引：持久化目录里的偏移是记录头的位置
  const topLevel: Rec[] = [];
  for (const r of records(dv, 0, doc.length)) topLevel.push(r);
  const byType = (type: number): Rec[] => topLevel.filter((r) => r.type === type);

  // [doc-viewer] 지속성 디렉터리와 현재 Document는 Current User → UserEditAtom 사슬로 찾는다.
  // 사슬이 끊겼으면 스트림의 마지막 UserEditAtom에서 다시 시작하고, 그래도 안 되면 원래 방식(디렉터리를 문서 순서로 합침)으로 간다.
  // 레코드는 디렉터리의 오프셋에서 바로 읽으므로, 중간 레코드가 깨져 순차 탐색이 멈춘 파일도 열린다.
  let chain: EditChain | null = null;
  if (currentUser && currentUser.length >= 20) {
    const cdv = new DataView(currentUser.buffer, currentUser.byteOffset, currentUser.byteLength);
    chain = editChain(dv, doc.length, cdv.getUint32(16, true));
  }
  if (!chain) {
    const edits = byType(RT.UserEditAtom);
    if (edits.length) chain = editChain(dv, doc.length, edits[edits.length - 1].start - 8);
  }
  const offsets = chain?.offsets ?? persistOffsets(dv, doc.length);
  const resolve = (persistId: number): Rec | null => {
    const off = offsets.get(persistId);
    return off !== undefined ? recAt(dv, off, doc.length) : null;
  };
  const chainDoc = chain ? resolve(chain.docPersistId) : null;
  const documents = byType(RT.Document);
  const docRec = chainDoc?.type === RT.Document ? chainDoc : documents[documents.length - 1] ?? null;

  // 字体表与 Environment 的全局默认文本样式
  const fonts: string[] = [];
  const envStyles: MasterStyles = new Map();
  let firstSlideNumber = 1;
  let omitTitlePlace = false;
  const scan = (start: number, end: number, depth: number): void => {
    for (const r of records(dv, start, end)) {
      if (r.type === RT.DocumentAtom && r.len >= 8) {
        width = dv.getInt32(r.start, true) * MASTER_TO_PX;
        height = dv.getInt32(r.start + 4, true) * MASTER_TO_PX;
        // [doc-viewer] firstSlideNumber(u16 @32), fOmitTitlePlace(u8 @37)
        if (r.len >= 40) {
          firstSlideNumber = dv.getUint16(r.start + 32, true) || 1;
          omitTitlePlace = dv.getUint8(r.start + 37) !== 0;
        }
      } else if (r.type === RT.FontEntityAtom) {
        const name = utf16(dv, r.start, Math.min(r.len, 64)).replace(/\0.*$/, '');
        // recInstance 即字体索引；异常时退回追加顺序
        if (name) fonts[r.instance < 512 ? r.instance : fonts.length] = name;
      } else if (r.type === RT.TxMasterStyleAtom) {
        parseTxMasterStyle(dv, r, envStyles);
      }
      if (r.isContainer && depth < 4) scan(r.start, r.start + r.len, depth + 1);
    }
  };
  if (docRec) scan(docRec.start, docRec.start + docRec.len, 0);

  const shared: Shared = { fonts, blobs, scale: MASTER_TO_PX, envStyles };

  // 幻灯片 / 母版 / 备注：优先按持久化目录的顺序，缺失时退回文档顺序
  const masterEntries = docRec ? persistList(dv, docRec, 1, resolve, [RT.MainMaster, RT.Slide]) : [];
  const notesEntries = docRec ? persistList(dv, docRec, 2, resolve, [RT.Notes]) : [];
  let slideEntries = docRec ? persistList(dv, docRec, 0, resolve, [RT.Slide]) : [];
  if (!slideEntries.length) {
    // 제목 마스터도 Slide 컨테이너라서 마스터로 잡힌 것은 뺀다([doc-viewer])
    const masters = new Set(masterEntries.map((m) => m.rec.start));
    slideEntries = byType(RT.Slide).filter((rec) => !masters.has(rec.start)).map((rec) => ({ rec, slideId: 0, texts: [] }));
  }

  // [doc-viewer] 마스터는 슬라이드 색 구성표마다 따로 해석한다. 구성표 색을 쓰는 마스터 도형·배경이 슬라이드 구성표를 따라야 한다
  const masterCache = new Map<string, MasterInfo>();
  const masterById = new Map<number, Rec>();
  for (const m of masterEntries) masterById.set(m.slideId, m.rec);
  const fallbackMaster = masterEntries[0]?.rec ?? byType(RT.MainMaster)[0] ?? null;
  const masterFor = (id: number) => (slideScheme: Scheme | null, depth = 0): MasterInfo | null => {
    const rec = masterById.get(id) ?? fallbackMaster;
    if (!rec) return null;
    const key = `${rec.start}|${slideScheme ? slideScheme.join(',') : ''}`;
    let info = masterCache.get(key);
    if (!info) {
      // [doc-viewer] 제목 마스터(Slide 컨테이너)는 SlideAtom.masterIdRef로 기본 마스터를 가리킨다
      let parent: MasterInfo | null = null;
      if (rec.type === RT.Slide && depth < 2) {
        const atom = findRec(dv, rec.start, rec.start + rec.len, RT.SlideAtom);
        const parentId = atom && atom.len >= 24 ? dv.getUint32(atom.start + 12, true) : 0;
        if (parentId && masterById.get(parentId) && masterById.get(parentId) !== rec) parent = masterFor(parentId)(slideScheme, depth + 1);
      }
      info = parseMaster(dv, rec, shared, slideScheme, parent);
      masterCache.set(key, info);
    }
    return info;
  };

  // 备注：先按 notesIdRef 关联，取不到时退回 NotesAtom.slideIdRef 反查
  const notesById = new Map<number, PersistEntry>();
  for (const n of notesEntries) notesById.set(n.slideId, n);
  const notesBySlideId = new Map<number, Rec>();
  for (const rec of byType(RT.Notes)) {
    const atom = findRec(dv, rec.start, rec.start + rec.len, RT.NotesAtom);
    if (atom && atom.len >= 4) notesBySlideId.set(dv.getUint32(atom.start, true), rec);
  }

  const hyperlinks = docRec ? collectHyperlinks(dv, docRec) : new Map<number, string>();
  // [doc-viewer] 문서 단위 슬라이드 머리글·바닥글 설정(HeadersFooters, instance 3)
  const docHfRec = docRec ? findAll(dv, docRec.start, docRec.start + docRec.len, RT.HeadersFooters).find((r) => r.instance === 3) : undefined;
  const docHf = docHfRec ? readHeadersFooters(dv, docHfRec) : null;

  const count = slideEntries.length;
  let slides: Slide[] = slideEntries.map((entry, i) => {
    const atom = findRec(dv, entry.rec.start, entry.rec.start + entry.rec.len, RT.SlideAtom);
    const masterIdRef = atom && atom.len >= 24 ? dv.getUint32(atom.start + 12, true) : 0;
    const notesIdRef = atom && atom.len >= 24 ? dv.getUint32(atom.start + 16, true) : 0;
    // [MS-PPT] SlideFlags：bit0 = 跟随母版图形，bit2 = 跟随母版背景
    const flags = atom && atom.len >= 24 ? dv.getUint16(atom.start + 20, true) : 0x7;
    const notesEntry = notesById.get(notesIdRef);
    const notesRec = notesEntry?.rec ?? notesBySlideId.get(entry.slideId) ?? null;
    let notes = notesRec ? notesText(dv, notesRec) : '';
    if (!notes && notesEntry) notes = outlineNotes(dv, notesEntry.texts);
    // [doc-viewer] 슬라이드에 머리글·바닥글 컨테이너가 있으면 문서 설정 대신 그것을 쓴다
    const ownHf = findRec(dv, entry.rec.start, entry.rec.start + entry.rec.len, RT.HeadersFooters);
    const layout = atom && atom.len >= 4 ? dv.getUint32(atom.start, true) : -1;
    return parseSlide(dv, entry.rec, shared, {
      master: masterFor(masterIdRef),
      followMasterObjects: (flags & 0x1) !== 0,
      followMasterBackground: (flags & 0x4) !== 0,
      notes,
      hyperlinks,
      index: i + 1,
      count,
      outline: entry.texts,
      hf: ownHf ? readHeadersFooters(dv, ownHf) : docHf,
      omitHf: omitTitlePlace && layout === 0,
      slideNumber: firstSlideNumber + i,
    });
  });

  // 兜底：没有 Slide 容器（或图形树为空）时，退回 SlideListWithText 的纯文本
  if (!slides.length || slides.every((s) => !s.elements.length)) {
    const textOnly = docRec ? slidesFromTextList(dv, docRec.start - 8, docRec.start + docRec.len, width, height) : [];
    if (textOnly.length) slides = textOnly;
  }

  // [doc-viewer] 문서 구조는 멀쩡한데 슬라이드가 하나도 없는 빈 프레젠테이션은 오류 대신 빈 슬라이드 한 장으로 연다
  if (!slides.length && docRec) {
    const master = masterFor(0)(null);
    slides = [{ background: master?.background ?? { type: 'solid', color: 'rgb(255,255,255)' }, elements: [...(master?.elements ?? [])] }];
  }

  if (!slides.length) throw new Error('.ppt 中未找到幻灯片');
  return { width, height, slides, source: 'ppt' };
}

/** [doc-viewer] SlideListWithText(메모)에 있는 메모 본문 */
function outlineNotes(dv: DataView, groups: Rec[][]): string {
  const lines: string[] = [];
  for (const group of groups) {
    const head = group[0];
    if (!head || head.len < 4 || dv.getUint32(head.start, true) !== TX.NOTES) continue;
    for (const r of group) {
      if (r.type !== RT.TextCharsAtom && r.type !== RT.TextBytesAtom) continue;
      const raw = r.type === RT.TextCharsAtom ? utf16(dv, r.start, r.len) : ansi(dv, r.start, r.len);
      const text = raw.replace(/\r\n?/g, '\n').replace(/\v/g, '\n').replace(/\0/g, '').trim();
      if (text) lines.push(text);
    }
  }
  return lines.join('\n');
}

/**
 * 兜底路径：只从 SlideListWithText 抽文本，按标题 / 正文两个文本框排版。
 * 用于图形树缺失或非常规结构的文件，保证至少能读到内容。
 */
function slidesFromTextList(dv: DataView, from: number, to: number, width: number, height: number): Slide[] {
  // [doc-viewer] 스트림 전체가 아니라 현재 Document 범위에서만 찾는다(빠른 저장 파일의 옛 판을 피한다)
  const listRec = (function find(start: number, end: number, depth: number): Rec | null {
    for (const r of records(dv, start, end)) {
      if (r.type === RT.SlideListWithText && r.instance === 0) return r;
      if (r.isContainer && depth < 4) {
        const hit = find(r.start, r.start + r.len, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  })(from, to, 0);
  if (!listRec) return [];

  const out: { titles: string[]; bodies: string[] }[] = [];
  let cur: { titles: string[]; bodies: string[] } | null = null;
  let txType = 4;
  for (const r of records(dv, listRec.start, listRec.start + listRec.len)) {
    if (r.type === RT.SlidePersistAtom) {
      cur = { titles: [], bodies: [] };
      out.push(cur);
    } else if (r.type === RT.TextHeaderAtom && r.len >= 4) {
      txType = dv.getUint32(r.start, true);
    } else if (cur && (r.type === RT.TextCharsAtom || r.type === RT.TextBytesAtom)) {
      const text = r.type === RT.TextCharsAtom ? utf16(dv, r.start, r.len) : ansi(dv, r.start, r.len);
      (txType === 0 || txType === 6 ? cur.titles : cur.bodies).push(text);
    }
  }

  const mkRun = (text: string, size: number, b: boolean, color: string): TextRun => ({
    text, b, i: false, u: false, strike: false, size, color, fonts: [],
  });
  const mkPara = (runs: TextRun[], bullet: string | null): Paragraph => ({
    align: 'left', lvl: 0, marL: bullet ? 24 : 0, indent: bullet ? -24 : 0,
    bullet, lineHeight: null, spaceBefore: 0, spaceAfter: 6, runs,
  });
  const splitLines = (t: string): string[] => t.split(/[\r\n\v]/).map((x) => x.trim()).filter(Boolean);

  return out
    .filter((s) => s.titles.length || s.bodies.length)
    .map((s): Slide => {
      const elements: ShapeElement[] = [];
      if (s.titles.length) {
        elements.push({
          kind: 'shape', x: width * 0.06, y: height * 0.05, w: width * 0.88, h: height * 0.16,
          rot: 0, flipH: false, flipV: false, path: null, fill: null, stroke: null,
          text: {
            anchor: 'middle', insets: [4, 8, 4, 8], wrap: true, fontScale: 1,
            paragraphs: s.titles.flatMap((t) => splitLines(t).map((l) => mkPara([mkRun(l, 34, true, 'rgb(30,30,30)')], null))),
          },
        });
      }
      if (s.bodies.length) {
        elements.push({
          kind: 'shape', x: width * 0.06, y: height * 0.24, w: width * 0.88, h: height * 0.68,
          rot: 0, flipH: false, flipV: false, path: null, fill: null, stroke: null,
          text: {
            anchor: 'top', insets: [4, 8, 4, 8], wrap: true, fontScale: 1,
            paragraphs: s.bodies.flatMap((t) => splitLines(t).map((l) => mkPara([mkRun(l, 20, false, 'rgb(50,50,50)')], '•'))),
          },
        });
      }
      return { background: { type: 'solid', color: 'rgb(255,255,255)' }, elements };
    });
}

/** 一页所继承的母版信息与关联内容 */
interface SlideEnv {
  /** [doc-viewer] 슬라이드 색 구성표에 맞춰 마스터를 해석해 돌려준다(슬라이드마다 구성표가 다를 수 있다) */
  master: ((scheme: Scheme | null) => MasterInfo | null) | null;
  followMasterObjects: boolean;
  followMasterBackground: boolean;
  notes: string;
  hyperlinks: Map<number, string>;
  index: number;
  count: number;
  /** [doc-viewer] SlideListWithText에 있는 이 슬라이드의 텍스트 묶음 */
  outline: Rec[][];
  /** [doc-viewer] 머리글·바닥글 설정(슬라이드 자체 → 문서 순). 없으면 null */
  hf: HfSettings | null;
  /** [doc-viewer] 제목 슬라이드에서 머리글·바닥글을 숨기는지(DocumentAtom.fOmitTitlePlace && 제목 슬라이드 레이아웃) */
  omitHf: boolean;
  /** [doc-viewer] 쪽 번호 필드에 쓸 번호 */
  slideNumber: number;
}

function parseSlide(dv: DataView, slideRec: Rec, shared: Shared, env: SlideEnv): Slide {
  const end = slideRec.start + slideRec.len;
  const ownScheme = readScheme(dv, slideRec, 1);
  const master = env.master ? env.master(ownScheme) : null;
  const scheme = ownScheme ?? master?.scheme ?? DEFAULT_SCHEME;

  // 幻灯片内的文本列表（占位符文本按 TextHeaderAtom 顺序）
  const listText: StyledText[] = [];
  let pendingStyle: Rec | null = null;
  let pendingText: string | null = null;
  let pendingType: number | undefined;
  const flush = (): void => {
    if (pendingText === null) return;
    const st = pendingStyle ? parseStyleTextProp(dv, pendingStyle, pendingText.length) : { para: [], char: [] };
    listText.push({ text: pendingText, paraProps: st.para, charProps: st.char, textType: pendingType });
    pendingText = null;
    pendingStyle = null;
    pendingType = undefined;
  };
  for (const r of records(dv, slideRec.start, end)) {
    if (r.type === RT.TextHeaderAtom) {
      flush();
      if (r.len >= 4) pendingType = dv.getUint32(r.start, true);
    } else if (r.type === RT.TextCharsAtom) pendingText = utf16(dv, r.start, r.len);
    else if (r.type === RT.TextBytesAtom) pendingText = ansi(dv, r.start, r.len);
    else if (r.type === RT.StyleTextPropAtom) pendingStyle = r;
  }
  flush();

  // 超链接目标按当前页序号归一（「下一页」「末页」这类跳转与页码相关）
  const links = new Map<number, string>();
  for (const [id, target] of env.hyperlinks) {
    const resolved = resolveLink(target, env.index, env.count);
    if (resolved) links.set(id, resolved);
  }

  // [doc-viewer] 필드 값: 날짜는 사용자 지정 문구가 있으면 그것, 아니면 오늘 날짜
  const hf = env.hf;
  const fields: SlideFields = {
    slideNumber: String(env.slideNumber),
    date: hf && hf.flags & HF_FLAG.USER_DATE ? hf.userDate : formatToday(hf?.formatId ?? 0),
    header: hf?.header ?? '',
    footer: hf?.footer ?? '',
  };

  const ctx: Ctx = {
    dv, scheme, fonts: shared.fonts, blobs: shared.blobs, listText, outlineText: [], fields, scale: shared.scale,
    styles: master?.styles ?? new Map(), envStyles: shared.envStyles, links,
    masterPass: false, masterShapes: master?.shapes, levelCache: new Map(), slideIndex: env.index, slideCount: env.count,
    autoNums: collectAutoNums(dv, slideRec), autoNumCursor: 0,
  };
  ctx.outlineText = env.outline.map((group) => styledText(ctx, group));

  // 母版图形垫在最底层，其次才是本页自己的图形
  const elements: SlideElement[] = [];
  const drawing = findRec(dv, slideRec.start, end, RT.PPDrawing);
  if (master && env.followMasterObjects) {
    elements.push(...master.elements);
    // [doc-viewer] 마스터의 날짜·쪽 번호·바닥글 자리표시자는 머리글·바닥글 설정이 켠 것만 그린다.
    // 슬라이드에 같은 종류의 자리표시자가 따로 있으면(PowerPoint 2007 이후 저장본) 그쪽을 쓴다.
    const own = new Set(drawing ? hfPlaceholders(dv, drawing).map((p) => p.kind) : []);
    const flag: Record<HfKind, number> = { date: HF_FLAG.DATE, slideNumber: HF_FLAG.SLIDE_NUMBER, footer: HF_FLAG.FOOTER };
    // 자동 번호 목록은 슬라이드 도형 순서로 맞춰 가므로 마스터 도형이 가로채지 않게 따로 둔다
    const hfCtx: Ctx = { ...ctx, autoNums: [], autoNumCursor: 0 };
    for (const p of master.hfShapes) {
      if (!hf || env.omitHf || !(hf.flags & flag[p.kind]) || own.has(p.kind)) continue;
      const el = parseSpContainer(hfCtx, p.rec, { x: 0, y: 0, sx: ctx.scale, sy: ctx.scale });
      if (el) elements.push(el);
    }
  }
  if (drawing) elements.push(...drawingElements(ctx, drawing));

  // 背景：本页自带的背景形状 → 母版背景 → 配色方案第 0 项
  const blipUrl = (idx: number): string | null => shared.blobs[idx - 1] ?? null;
  const own = drawing ? drawingBackground(dv, drawing, scheme, blipUrl) : null;
  const inherited = env.followMasterBackground ? master?.background ?? null : null;
  const background: Fill = inherited ?? own ?? { type: 'solid', color: escherColor(0x08000000, scheme) };

  // 放映信息：隐藏标记、切换效果、动画
  const show = parseSlideShowInfo(dv, slideRec);
  const transition: Transition | undefined = show?.transition;
  const animations: AnimStep[] | undefined = parseAnimations(dv, slideRec);

  return {
    background,
    elements,
    notes: env.notes || undefined,
    hidden: show?.hidden ? true : undefined,
    transition,
    animations,
  };
}
