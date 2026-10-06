// doc-viewer: Word 6.0/95 이하의 8비트 본문 글자를 코드 페이지에 맞게 푼다.
//
// Word 97 이후는 글자를 UTF-16(또는 cp1252로 압축)으로 저장하지만, Word 6/95는 글꼴의 문자 집합에 따른
// 코드 페이지(1252, 1251, 949 등)로 저장한다. 한글(cp949) 같은 2바이트 문자는 한 글자가 CP 두 칸을 차지하므로,
// 파서 전체가 기대하는 'CP 한 칸 = 문자열 한 칸' 관계를 지키려고 두 번째 바이트 자리에 FILLER_CHAR를 둔다.
// FILLER_CHAR는 화면에 그리기 전에 지운다(parser의 normalizePlainTextChar, normalizeParagraphText).
//
// 코드 페이지 고르는 순서는 LibreOffice(ww8par.cxx GetCurrentCharSet, ww8par6.cxx GetFontParams)를 따랐다.
// 1) sprmCChse로 직접 지정한 문자 집합 2) 글꼴 문자 집합(chs) 3) 글자 언어(lid) 4) cp1252

export const FILLER_CHAR = '￿';

const decoders = new Map<string, TextDecoder | null>();

function getDecoder(label: string): TextDecoder | null {
  if (decoders.has(label)) return decoders.get(label) ?? null;
  let decoder: TextDecoder | null = null;
  try {
    decoder = new TextDecoder(label, { fatal: false });
  } catch {
    decoder = null;
  }
  decoders.set(label, decoder);
  return decoder;
}

/** Windows 글꼴 문자 집합(FFN.chs) → TextDecoder 이름. 알 수 없으면 null. */
export function charsetToEncoding(chs: number | undefined | null): string | null {
  switch (chs) {
    case 0: return 'windows-1252';
    case 2: return 'x-symbol';
    case 77: return 'macintosh';
    case 128: return 'shift_jis';
    case 129: return 'euc-kr';
    case 134: return 'gbk';
    case 136: return 'big5';
    case 161: return 'windows-1253';
    case 162: return 'windows-1254';
    case 163: return 'windows-1258';
    case 177: return 'windows-1255';
    case 178: return 'windows-1256';
    case 186: return 'windows-1257';
    case 204: return 'windows-1251';
    case 222: return 'windows-874';
    case 238: return 'windows-1250';
    default: return null;
  }
}

/** 언어 ID(LID) → 그 언어를 쓰던 Windows의 기본 코드 페이지. */
export function lidToEncoding(lid: number | undefined | null): string | null {
  if (!lid || lid === 0x0400 || lid === 0x0000) return null;
  const primary = lid & 0x3ff;
  switch (primary) {
    case 0x12: return 'euc-kr';
    case 0x11: return 'shift_jis';
    case 0x04: return lid === 0x0404 || lid === 0x0c04 || lid === 0x1404 ? 'big5' : 'gbk';
    case 0x02: case 0x19: case 0x22: case 0x23: case 0x2f: case 0x44: case 0x40: case 0x3f: case 0x50:
      return 'windows-1251';
    case 0x1a: return lid === 0x0c1a || lid === 0x1c1a ? 'windows-1251' : 'windows-1250';
    case 0x05: case 0x0e: case 0x15: case 0x18: case 0x1b: case 0x1c: case 0x24:
      return 'windows-1250';
    case 0x08: return 'windows-1253';
    case 0x1f: case 0x2c: return 'windows-1254';
    case 0x0d: return 'windows-1255';
    case 0x01: case 0x20: case 0x29: return 'windows-1256';
    case 0x25: case 0x26: case 0x27: return 'windows-1257';
    case 0x2a: return 'windows-1258';
    case 0x1e: return 'windows-874';
    default: return 'windows-1252';
  }
}

export function isDoubleByteEncoding(label: string | null | undefined): boolean {
  return label === 'euc-kr' || label === 'shift_jis' || label === 'gbk' || label === 'big5';
}

function isLeadByte(label: string, byte: number): boolean {
  if (label === 'shift_jis') return (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc);
  return byte >= 0x81 && byte <= 0xfe;
}

const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f'
  + '\u0090‘’“”•–—˜™š›œ\u009džŸ';

function cp1252Char(byte: number): string {
  if (byte >= 0x80 && byte < 0xa0) return CP1252_HIGH[byte - 0x80] ?? '';
  return String.fromCharCode(byte);
}

const pairCache = new Map<string, Map<number, string>>();

function decodeDoubleByte(bytes: Uint8Array, label: string): string {
  const decoder = getDecoder(label);
  let cache = pairCache.get(label);
  if (!cache) {
    cache = new Map();
    pairCache.set(label, cache);
  }
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte < 0x80) {
      out.push(String.fromCharCode(byte));
      continue;
    }
    const next = bytes[i + 1];
    if (decoder && next != null && next >= 0x40 && isLeadByte(label, byte)) {
      const key = (byte << 8) | next;
      let ch = cache.get(key);
      if (ch == null) {
        ch = decoder.decode(bytes.subarray(i, i + 2));
        cache.set(key, ch);
      }
      if (ch.length === 1 && ch !== '�') {
        out.push(ch, FILLER_CHAR);
        i += 1;
        continue;
      }
    }
    // 잘못된 2바이트 조합은 LibreOffice(Custom8BitToUnicode)처럼 cp1252 한 글자로 읽는다.
    if (decoder && label === 'shift_jis' && byte >= 0xa1 && byte <= 0xdf) {
      out.push(decoder.decode(bytes.subarray(i, i + 1)));
      continue;
    }
    out.push(cp1252Char(byte));
  }
  return out.join('');
}

/**
 * 8비트 글자 바이트를 문자열로 푼다. 결과 길이는 늘 bytes.length와 같다(2바이트 문자 뒤에 FILLER_CHAR).
 * x-symbol은 LibreOffice처럼 U+F000 영역 문자로 바꿔 두고, 렌더러가 기호 글꼴 표로 다시 바꾼다.
 */
export function decode8BitText(bytes: Uint8Array, label: string | null | undefined): string {
  const encoding = label || 'windows-1252';
  if (encoding === 'x-symbol') {
    let out = '';
    for (const byte of bytes) out += byte >= 0x20 ? String.fromCharCode(0xf000 + byte) : String.fromCharCode(byte);
    return out;
  }
  if (isDoubleByteEncoding(encoding)) return decodeDoubleByte(bytes, encoding);
  const decoder = getDecoder(encoding) ?? getDecoder('windows-1252');
  if (!decoder) {
    let out = '';
    for (const byte of bytes) out += cp1252Char(byte);
    return out;
  }
  // 제어 문자(0x00~0x1F)는 코드 페이지와 상관없이 그대로 두어야 문단·셀·필드 표시가 살아 있다.
  const text = decoder.decode(bytes);
  return text.length === bytes.length ? text : Array.from(bytes, (byte) => cp1252Char(byte)).join('');
}

/** 2바이트 코드 페이지로 읽은 결과가 그럴듯한지(깨진 조합이 없는지) 본다. */
export function looksLikeValidDoubleByte(bytes: Uint8Array, label: string): boolean {
  const decoder = getDecoder(label);
  if (!decoder) return false;
  let high = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte < 0x80) continue;
    high += 1;
    const next = bytes[i + 1];
    if (next == null || next < 0x40 || !isLeadByte(label, byte)) {
      if (label === 'shift_jis' && byte >= 0xa1 && byte <= 0xdf) continue;
      return false;
    }
    const ch = decoder.decode(bytes.subarray(i, i + 2));
    if (ch.length !== 1 || ch === '�') return false;
    i += 1;
  }
  return high > 0;
}
