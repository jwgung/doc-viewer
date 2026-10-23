// 그림 파일 머리말에서 가로·세로(px)만 읽는다. 디코드 전에 터무니없이 큰 그림을 거르려는 용도라 읽지 못하면 null을 돌려주고
// 호출자는 그대로 디코드에 맡긴다. 모든 반복은 bytes 길이로 막혀 있어 깨진 입력에도 선형 시간에 끝난다. SVG·ICO는 다루지 않는다.

/** 가로×세로가 이보다 크면 열지 않는다(2^29 ≈ 23170²). 20000×20000(4억)은 열리고, 크로미움이 스스로 거부하는 30000² 급(9억)은 미리 거른다. */
export const MAX_IMAGE_PIXELS = 2 ** 29;

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const i32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) | 0;
const ascii = (b, i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

/** @returns {{ width: number, height: number } | null} */
export function imageSize(b) {
  try {
    const size = read(b);
    return size && size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}

function read(b) {
  // PNG: 서명 8바이트 + IHDR(길이 4, 'IHDR', 가로 4, 세로 4)
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 'PNG') && ascii(b, 12, 'IHDR')) {
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  // GIF: 서명 6바이트 + 논리 화면 가로·세로(2바이트씩, 리틀 엔디언)
  if (b.length >= 10 && ascii(b, 0, 'GIF8')) return { width: u16le(b, 6), height: u16le(b, 8) };
  // BMP: BITMAPCOREHEADER(12)는 2바이트, 그 밖의 헤더는 4바이트 부호 있는 값. 세로가 음수면 위에서 아래 순서라 절댓값을 쓴다.
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    if (u32le(b, 14) === 12) return { width: u16le(b, 18), height: u16le(b, 20) };
    return { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) };
  }
  if (b.length >= 30 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return webpSize(b);
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
  return null;
}

const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

function webpSize(b) {
  if (ascii(b, 12, 'VP8X')) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (ascii(b, 12, 'VP8L')) {
    // 서명 0x2f 다음 14비트씩 (가로-1)·(세로-1)
    if (b[20] !== 0x2f) return null;
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8 ')) {
    // 프레임 태그 3바이트 + 시작 코드 9d 01 2a + 14비트 가로·세로(위 2비트는 비율)
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  return null;
}

/** SOFn 표식까지 세그먼트를 건너뛴다. 매번 위치가 2 이상 늘어나므로 최대 length/2번 돈다. */
function jpegSize(b) {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) {
      i++; // 표식이 아닌 바이트는 한 칸씩 넘긴다
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++; // 채움 바이트
      continue;
    }
    // 길이 없는 표식(TEM, RSTn, SOI)
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI, SOS까지 SOF가 없으면 포기
    const len = u16be(b, i + 2);
    // SOF0~15 중 DHT(c4)·JPG(c8)·DAC(cc) 제외
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return null;
      return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
    }
    if (len < 2) {
      i += 2; // 깨진 길이: 표식만 넘기고 계속 훑는다(전진 보장)
      continue;
    }
    i += 2 + len;
  }
  return null;
}
