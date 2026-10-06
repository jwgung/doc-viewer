// doc-viewer: OLE 복합 문서가 아닌 아주 오래된 Word 파일에서 본문 글자만이라도 살린다.
//
// - Word for Macintosh 4.0/5.x(첫 2바이트 FE 37, 큰 끝 바이트 순서): fcMin(0x14)~fcMac(0x18)에 Mac Roman 글자
// - Word for Windows 1.x(9B A5 / 9C A5): Word 2와 비슷한 머리, fcMin(0x18)~fcMac(0x1C)에 cp1252 글자
// - Word for DOS(31 BE 00 00 00 AB): 글자가 0x80부터 fcMac(0x0E)까지
//
// 서식 정보는 읽지 않는다. 문단(0x0D)·탭·줄 바꿈만 살리고 필드 명령은 숨긴다.
import { pushWarning, uniqueId } from '../core/utils.js';
import { charPropsToState, paraPropsToState } from './properties.js';
import type { MsDocBlock, MsDocParseResult, MsDocWarning, ParagraphBlock } from '../types.js';

function be32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}

function le32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0;
}

function locateText(bytes: Uint8Array): { start: number; end: number; encoding: string; format: string; wIdent: number } | null {
  if (bytes.length < 0x80) return null;
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  if (b0 === 0xfe && (b1 === 0x37 || b1 === 0x34)) {
    const start = be32(bytes, 0x14);
    const end = be32(bytes, 0x18);
    if (start >= 0x80 && end > start && end <= bytes.length) {
      return { start, end, encoding: 'macintosh', format: 'Word for Macintosh', wIdent: (b0 << 8) | b1 };
    }
  }
  const wIdent = b0 | (b1 << 8);
  if (wIdent === 0xa59b || wIdent === 0xa59c || wIdent === 0xa5db) {
    const start = le32(bytes, 0x18);
    const end = le32(bytes, 0x1c);
    if (start >= 0x80 && end > start && end <= bytes.length) {
      return { start, end, encoding: 'windows-1252', format: wIdent === 0xa5db ? 'Word 2.0' : 'Word 1.x', wIdent };
    }
  }
  if (b0 === 0x31 && b1 === 0xbe && bytes[2] === 0 && bytes[3] === 0) {
    const end = le32(bytes, 0x0e);
    if (end > 0x80 && end <= bytes.length) {
      return { start: 0x80, end, encoding: 'windows-1252', format: 'Word for DOS', wIdent };
    }
  }
  return null;
}

function plainParagraph(text: string): ParagraphBlock {
  const style = charPropsToState([]);
  return {
    type: 'paragraph',
    id: uniqueId('para'),
    styleId: 0,
    styleName: '',
    paraState: paraPropsToState([]),
    inlines: text ? [{ type: 'text', text, style }] : [],
    text,
    storyKind: 'main',
    sectionIndex: 0,
  };
}

/** 필드 명령(0x13~0x14)은 숨기고 결과(0x14~0x15)만 남긴다. 그 밖의 제어 문자는 버린다. */
function cleanLegacyText(text: string): string {
  let out = '';
  const stack: boolean[] = [];
  for (const ch of text) {
    if (ch === '\u0013') {
      stack.push(true);
      continue;
    }
    if (ch === '\u0014') {
      if (stack.length) stack[stack.length - 1] = false;
      continue;
    }
    if (ch === '\u0015') {
      stack.pop();
      continue;
    }
    if (stack.length && stack[stack.length - 1]) continue;
    if (ch === '\r' || ch === '\t' || ch === '\u000b' || ch === '\u000c') {
      out += ch;
      continue;
    }
    if (ch < ' ') continue;
    out += ch;
  }
  return out;
}

export function parseNonOleDocument(bytes: Uint8Array): MsDocParseResult | null {
  const located = locateText(bytes);
  if (!located) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder(located.encoding).decode(bytes.subarray(located.start, located.end));
  } catch {
    decoded = Array.from(bytes.subarray(located.start, located.end), (b) => String.fromCharCode(b)).join('');
  }
  const text = cleanLegacyText(decoded);
  const warnings: MsDocWarning[] = [];
  pushWarning(warnings, `${located.format} document; only the plain text could be recovered.`, {
    code: 'MSDOC_LEGACY_PLAIN_TEXT',
    format: located.format,
  });
  const blocks: MsDocBlock[] = [];
  for (const line of text.split('\r')) {
    const parts = line.split('\u000c');
    parts.forEach((part, index) => {
      const block = plainParagraph(part.replace(/\u000b/g, '\n'));
      if (index < parts.length - 1) block.inlines.push({ type: 'pageBreak' });
      blocks.push(block);
    });
  }
  while (blocks.length && blocks[blocks.length - 1]!.type === 'paragraph' && !(blocks[blocks.length - 1] as ParagraphBlock).text) blocks.pop();
  return {
    kind: 'msdoc',
    version: 1,
    warnings,
    meta: {
      fib: {
        wIdent: located.wIdent,
        nFib: 0,
        fWhichTblStm: 0,
        fComplex: false,
        fEncrypted: false,
        ccpText: text.length,
        version: 1,
      },
      counts: { paragraphs: blocks.length, blocks: blocks.length, assets: 0, styles: 0, fonts: 0 },
    },
    fonts: [],
    styles: [],
    blocks,
    assets: [],
    sections: [{
      index: 0,
      cpStart: 0,
      cpEnd: text.length,
      breakType: 2,
      titlePage: false,
      headers: {},
      footers: {},
    }],
    notes: { footnotes: [], endnotes: [] },
  };
}
