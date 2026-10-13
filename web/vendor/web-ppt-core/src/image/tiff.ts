/**
 * [doc-viewer] TIFF → PNG. 브라우저(WebView)는 TIFF를 그리지 못해 문서 속 TIFF 그림이 빈칸으로 나온다.
 *
 * 문서에 붙는 TIFF(스캐너·맥에서 붙여 넣은 그림)의 흔한 경우만 푼다.
 * - 압축: 없음(1), LZW(5), Deflate(8·32946), PackBits(32773). CCITT 팩스·JPEG 압축은 null
 * - 색: 흑백·회색(0·1), RGB(2), 팔레트(3), CMYK(5). 표본 1·2·4·8·16비트(16비트는 위 바이트만), 알파 표본
 * - 스트립·타일, 수평 예측기(2), 표본 묶음(PlanarConfiguration 1)
 * 첫 번째 IFD(첫 장)만 읽는다.
 */

import { unzlibSync } from 'fflate';
import { encodePng } from './gdi';

/** 너비·높이 상한. 그 이상은 메모리를 너무 써서 그리지 않는다. */
const MAX_PIXELS = 40_000_000;

export function isTiff(bytes: Uint8Array): boolean {
  return bytes.length >= 8 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 42));
}

interface Ifd {
  get(tag: number): number[] | undefined;
}

function readIfd(dv: DataView, le: boolean): Ifd | null {
  const at = dv.getUint32(4, le);
  if (at + 2 > dv.byteLength) return null;
  const count = dv.getUint16(at, le);
  const tags = new Map<number, number[]>();
  const SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };
  for (let i = 0; i < count; i++) {
    const e = at + 2 + i * 12;
    if (e + 12 > dv.byteLength) break;
    const tag = dv.getUint16(e, le);
    const type = dv.getUint16(e + 2, le);
    const n = dv.getUint32(e + 4, le);
    const size = SIZES[type];
    if (!size || n > 1 << 24) continue;
    let p = size * n <= 4 ? e + 8 : dv.getUint32(e + 8, le);
    if (p + size * n > dv.byteLength) continue;
    const values: number[] = [];
    for (let k = 0; k < n; k++, p += size) {
      if (type === 3 || type === 8) values.push(dv.getUint16(p, le));
      else if (type === 4 || type === 9 || type === 13) values.push(dv.getUint32(p, le));
      else if (type === 5) values.push(dv.getUint32(p, le) / (dv.getUint32(p + 4, le) || 1));
      else if (type === 16) values.push(Number(dv.getBigUint64(p, le)));
      else values.push(dv.getUint8(p));
    }
    tags.set(tag, values);
  }
  return { get: (tag) => tags.get(tag) };
}

/** TIFF LZW(최상위 비트부터, 코드 길이를 한 칸 먼저 늘린다) */
function lzw(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let o = 0;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) { suffix[i] = i; length[i] = 1; prefix[i] = -1; }
  let next = 258;
  let width = 9;
  let old = -1;
  let bitPos = 0;
  const totalBits = src.length * 8;
  /** 코드가 뜻하는 문자열을 out에 쓰고 첫 글자를 돌려준다 */
  const emit = (code: number): number => {
    let c = code;
    let first = 0;
    for (let k = o + length[code] - 1; k >= o; k--) {
      if (k < expected) out[k] = suffix[c];
      first = suffix[c];
      c = prefix[c];
    }
    o = Math.min(o + length[code], expected);
    return first;
  };
  while (bitPos + width <= totalBits && o < expected) {
    let code = 0;
    for (let k = 0; k < width; k++, bitPos++) code = (code << 1) | ((src[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
    if (code === 257) break;
    if (code === 256) {
      next = 258;
      width = 9;
      old = -1;
      continue;
    }
    if (old < 0) {
      if (code > 255) break;
      emit(code);
      old = code;
      continue;
    }
    let first: number;
    if (code < next) {
      first = emit(code);
      if (next < 4096) { prefix[next] = old; suffix[next] = first; length[next] = length[old] + 1; next++; }
    } else if (code === next && next < 4096) {
      // 아직 없는 코드: 앞 문자열 + 그 첫 글자
      let c = old;
      while (prefix[c] >= 0) c = prefix[c];
      prefix[next] = old; suffix[next] = suffix[c]; length[next] = length[old] + 1; next++;
      emit(code);
    } else break;
    old = code;
    if (next + 1 >= 1 << width && width < 12) width++;
  }
  return out;
}

function packBits(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let o = 0;
  for (let i = 0; i < src.length && o < expected; ) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) {
      for (let k = 0; k <= n && i < src.length && o < expected; k++) out[o++] = src[i++];
    } else if (n !== -128) {
      const b = src[i++];
      for (let k = 0; k < 1 - n && o < expected; k++) out[o++] = b;
    }
  }
  return out;
}

/** TIFF 바이트 → PNG 바이트. 풀 수 없는 형식이면 null */
export function tiffToPng(bytes: Uint8Array): Uint8Array | null {
  try {
    if (!isTiff(bytes)) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const le = bytes[0] === 0x49;
    const ifd = readIfd(dv, le);
    if (!ifd) return null;
    const one = (tag: number, fallback: number) => ifd.get(tag)?.[0] ?? fallback;
    const w = one(256, 0);
    const h = one(257, 0);
    if (!w || !h || w * h > MAX_PIXELS) return null;
    const compression = one(259, 1);
    const photometric = one(262, 1);
    const spp = one(277, 1);
    const bits = one(258, 1);
    const predictor = one(317, 1);
    if (one(284, 1) !== 1 || ![1, 2, 4, 8, 16].includes(bits) || one(339, 1) !== 1) return null;
    if (![1, 5, 8, 32946, 32773].includes(compression)) return null;
    if (![0, 1, 2, 3, 5].includes(photometric)) return null;
    const extra = ifd.get(338) ?? [];
    const colorSamples = spp - extra.length;
    const alphaIndex = extra.findIndex((e) => e === 1 || e === 2);
    const premultiplied = alphaIndex >= 0 && extra[alphaIndex] === 1;
    if ((photometric === 2 && colorSamples < 3) || (photometric === 5 && colorSamples < 4)) return null;

    // 조각(스트립 또는 타일) 목록
    const tiled = ifd.get(322) !== undefined;
    const tw = tiled ? one(322, w) : w;
    const th = tiled ? one(323, h) : Math.min(h, one(278, h));
    const offsets = ifd.get(tiled ? 324 : 273) ?? [];
    const counts = ifd.get(tiled ? 325 : 279) ?? [];
    const across = tiled ? Math.ceil(w / tw) : 1;
    const rowBytes = Math.ceil((tw * spp * bits) / 8);

    const rgba = new Uint8ClampedArray(w * h * 4);
    const map = ifd.get(320);
    const maxValue = (1 << bits) - 1;
    const sample = (row: Uint8Array, x: number, s: number): number => {
      const idx = x * spp + s;
      if (bits === 8) return row[idx];
      if (bits === 16) return row[idx * 2 + (le ? 1 : 0)];
      const bit = idx * bits;
      const v = (row[bit >> 3] >> (8 - bits - (bit & 7))) & maxValue;
      return photometric === 3 ? v : Math.round((v * 255) / maxValue);
    };

    for (let piece = 0; piece < offsets.length; piece++) {
      const x0 = tiled ? (piece % across) * tw : 0;
      const y0 = tiled ? Math.floor(piece / across) * th : piece * th;
      if (y0 >= h) break;
      const rows = tiled ? th : Math.min(th, h - y0);
      const expected = rowBytes * rows;
      const raw = bytes.subarray(offsets[piece], offsets[piece] + (counts[piece] ?? bytes.length - offsets[piece]));
      let data: Uint8Array;
      if (compression === 1) data = predictor === 2 ? raw.slice() : raw;
      else if (compression === 5) data = lzw(raw, expected);
      else if (compression === 32773) data = packBits(raw, expected);
      else data = unzlibSync(raw);
      if (predictor === 2 && bits === 8) {
        for (let y = 0; y < rows; y++) {
          const base = y * rowBytes;
          for (let i = spp; i < tw * spp; i++) data[base + i] = (data[base + i] + data[base + i - spp]) & 0xff;
        }
      }
      for (let y = 0; y < rows; y++) {
        const py = y0 + y;
        if (py >= h) break;
        const row = data.subarray(y * rowBytes, (y + 1) * rowBytes);
        if (row.length < rowBytes) break;
        for (let x = 0; x < tw; x++) {
          const px = x0 + x;
          if (px >= w) break;
          const o = (py * w + px) * 4;
          let r: number, g: number, b: number;
          if (photometric === 2) {
            r = sample(row, x, 0); g = sample(row, x, 1); b = sample(row, x, 2);
          } else if (photometric === 5) {
            const k = 255 - sample(row, x, 3);
            r = ((255 - sample(row, x, 0)) * k) / 255; g = ((255 - sample(row, x, 1)) * k) / 255; b = ((255 - sample(row, x, 2)) * k) / 255;
          } else if (photometric === 3) {
            const i = sample(row, x, 0);
            const n = 1 << bits;
            r = (map?.[i] ?? 0) >> 8; g = (map?.[n + i] ?? 0) >> 8; b = (map?.[2 * n + i] ?? 0) >> 8;
          } else {
            const v = sample(row, x, 0);
            r = g = b = photometric === 0 ? 255 - v : v;
          }
          let a = 255;
          if (alphaIndex >= 0) {
            a = sample(row, x, colorSamples + alphaIndex);
            if (premultiplied && a > 0 && a < 255) { r = (r * 255) / a; g = (g * 255) / a; b = (b * 255) / a; }
          }
          rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
        }
      }
    }
    return encodePng(new Uint8Array(rgba.buffer), w, h);
  } catch {
    return null;
  }
}
