import { BinaryReader } from '../core/binary.js';
import type { FibRgFcLcb, FontInfo, FontsCollection } from '../types.js';

function decodeUtf16Z(bytes: Uint8Array, offset: number): { value: string; nextOffset: number } {
  let end = offset;
  while (end + 1 < bytes.length) {
    if (bytes[end] === 0 && bytes[end + 1] === 0) break;
    end += 2;
  }
  const text = new TextDecoder('utf-16le').decode(bytes.subarray(offset, end));
  return { value: text, nextOffset: Math.min(bytes.length, end + 2) };
}

function parseFfn(recordBytes: Uint8Array, index: number): FontInfo | null {
  if (!recordBytes.length) return null;
  const reader = new BinaryReader(recordBytes);
  const cbFfnM1 = reader.u8(0);
  const ffid = reader.u8(1);
  const wWeight = reader.u16(2);
  const chs = reader.u8(4);
  const ixchSzAlt = reader.u8(5);
  const panose = reader.slice(6, 10);
  const fontSignature = reader.slice(16, 24);

  const namesOffset = 40;
  let name = '';
  let altName = '';
  if (recordBytes.length > namesOffset) {
    const full = new TextDecoder('utf-16le').decode(recordBytes.subarray(namesOffset));
    const parts = full.split('\u0000').filter(Boolean);
    name = parts[0] || '';
    altName = parts[1] || '';
    if (!altName && ixchSzAlt) {
      const altOffset = namesOffset + ixchSzAlt * 2;
      if (altOffset + 2 <= recordBytes.length) {
        altName = decodeUtf16Z(recordBytes, altOffset).value;
      }
    }
  }

  return {
    index,
    cbFfnM1,
    ffid,
    weight: wWeight,
    charset: chs,
    ixchSzAlt,
    panose,
    fontSignature,
    name,
    altName,
  };
}

/**
 * doc-viewer: Word 6/95 글꼴 표. 앞 2바이트는 표 전체 크기이고, FFN은 6바이트 머리 + 8비트 이름(0 종료)이다.
 * 이름은 그 글꼴의 문자 집합으로 저장된다(LibreOffice WW8Fonts와 같은 처리).
 */
function parseLegacyFonts(bytes: Uint8Array, decodeName: (raw: Uint8Array, charset: number) => string): FontInfo[] {
  const fonts: FontInfo[] = [];
  let offset = 2;
  while (offset < bytes.length && fonts.length < 4096) {
    const cbFfnM1 = bytes[offset] ?? 0;
    const record = bytes.subarray(offset, Math.min(bytes.length, offset + cbFfnM1 + 1));
    if (record.length < 6) break;
    const ffid = record[1] ?? 0;
    const weight = (record[2] ?? 0) | ((record[3] ?? 0) << 8);
    const charset = record[4] ?? 0;
    const ixchSzAlt = record[5] ?? 0;
    const nameBytes = record.subarray(6);
    const end = nameBytes.indexOf(0);
    const name = decodeName(nameBytes.subarray(0, end < 0 ? nameBytes.length : end), charset);
    let altName = '';
    if (ixchSzAlt && ixchSzAlt < nameBytes.length) {
      const alt = nameBytes.subarray(ixchSzAlt);
      const altEnd = alt.indexOf(0);
      altName = decodeName(alt.subarray(0, altEnd < 0 ? alt.length : altEnd), charset);
    }
    fonts.push({
      index: fonts.length,
      cbFfnM1,
      ffid,
      weight,
      charset,
      ixchSzAlt,
      panose: new Uint8Array(0),
      fontSignature: new Uint8Array(0),
      name,
      altName,
    });
    offset += cbFfnM1 + 1;
  }
  return fonts;
}

export function parseFonts(
  tableBytes: Uint8Array,
  fibRgFcLcb: FibRgFcLcb,
  version = 8,
  decodeName: (raw: Uint8Array, charset: number) => string = (raw) => new TextDecoder('windows-1252').decode(raw),
): FontsCollection {
  const fcSttbfFfn = fibRgFcLcb.fcSttbfFfn as number | undefined;
  const lcbSttbfFfn = fibRgFcLcb.lcbSttbfFfn as number | undefined;
  if (version === 6 && fcSttbfFfn != null && lcbSttbfFfn != null && lcbSttbfFfn > 2) {
    const fonts = parseLegacyFonts(tableBytes.subarray(fcSttbfFfn, fcSttbfFfn + lcbSttbfFfn), decodeName);
    return {
      header: { cData: fonts.length, cbExtra: 0 },
      fonts,
      byIndex(index: number | null | undefined): FontInfo | null {
        if (index == null || index < 0) return null;
        return fonts[index] || null;
      },
    };
  }
  if (version !== 8 || fcSttbfFfn == null || lcbSttbfFfn == null || lcbSttbfFfn <= 0) {
    return {
      header: null,
      fonts: [],
      byIndex(index: number | null | undefined): FontInfo | null {
        return index == null ? null : null;
      },
    };
  }

  const bytes = tableBytes.subarray(fcSttbfFfn, fcSttbfFfn + lcbSttbfFfn);
  const reader = new BinaryReader(bytes);
  const cData = reader.u16(0);
  const cbExtra = reader.u16(2);
  let offset = 4;
  const fonts: FontInfo[] = [];

  for (let i = 0; i < cData && offset < bytes.length; i += 1) {
    const cbFfnM1 = reader.u8(offset);
    const recordLength = cbFfnM1 + 1;
    const recordBytes = bytes.subarray(offset, Math.min(offset + recordLength, bytes.length));
    const font = parseFfn(recordBytes, i);
    if (font) fonts.push(font);
    offset += recordLength + cbExtra;
  }

  return {
    header: { cData, cbExtra },
    fonts,
    byIndex(index: number | null | undefined): FontInfo | null {
      if (index == null || index < 0) return null;
      return fonts[index] || null;
    },
  };
}
