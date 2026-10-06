// 암호 걸린 docx·xlsx·pptx를 푼다(ECMA-376 문서 암호화, [MS-OFFCRYPTO]).
// 암호 문서는 CFB 안에 EncryptionInfo(알고리즘·암호 검증값)와 EncryptedPackage(원래 ZIP을 암호화한 것)를 담는다.
// - 표준 암호화(Office 2007, 버전 x.2): AES-ECB, SHA-1 50,000회 반복
// - 애자일 암호화(Office 2010 이후, 버전 4.4): AES-CBC를 4096바이트씩, SHA-512 등 100,000회 반복
// WebCrypto는 쓰지 않는다: digest가 비동기라 10만 번 반복이 매우 느리고, AES-CBC는 PKCS#7 채움을 검사해
// 0으로 채운 Office 데이터를 풀지 못하며, ECB는 아예 없다.
// 복호화 흐름은 web-ppt(MIT, Copyright (c) 2026 unStone)의 crypto/ooxml.ts를 따랐고,
// AES는 큰 파일에서도 빠르도록 T-table 방식으로 다시 썼다.

export class WrongPasswordError extends Error {
  constructor() {
    super('wrong password');
    this.name = 'WrongPasswordError';
  }
}

// ---------- 해시: SHA-1 · SHA-256 · SHA-384 · SHA-512 ----------

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

/** SHA 계열 채움: 0x80, 0, 빅엔디언 비트 길이 */
function pad(message, blockBytes, lengthBytes) {
  const total = Math.ceil((message.length + 1 + lengthBytes) / blockBytes) * blockBytes;
  const out = new Uint8Array(total);
  out.set(message);
  out[message.length] = 0x80;
  const v = new DataView(out.buffer);
  const bits = message.length * 8;
  v.setUint32(total - 4, bits >>> 0);
  v.setUint32(total - 8, Math.floor(bits / 0x100000000));
  return out;
}

export function sha1(message) {
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const data = pad(message, 64, 8);
  const v = new DataView(data.buffer);
  const w = new Uint32Array(80);
  for (let off = 0; off < data.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = v.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }
  return words(h, 20);
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(message) {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const data = pad(message, 64, 8);
  const v = new DataView(data.buffer);
  const w = new Uint32Array(64);
  const rr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < data.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = v.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((x, i) => (h[i] = (h[i] + x) >>> 0));
  }
  return words(h, 32);
}

// SHA-512는 64비트 연산을 상위·하위 32비트 쌍으로 흉내 낸다(BigInt는 10만 번 반복에서 너무 느리다).
const K512 = new Uint32Array([
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc, 0x3956c25b, 0xf348b538, 0x59f111f1,
  0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118, 0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c,
  0x550c7dc3, 0xd5ffb4e2, 0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694, 0xe49b69c1,
  0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65, 0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483,
  0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5, 0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7,
  0xbeef0ee4, 0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70, 0x27b70a85, 0x46d22ffc,
  0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df, 0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e,
  0x47edaee6, 0x92722c85, 0x1482353b, 0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
  0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8, 0x19a4c116, 0xb8d2d0c8, 0x1e376c08,
  0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8, 0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373,
  0x682e6ff3, 0xd6b2b8a3, 0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec, 0x90befffa,
  0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b, 0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207,
  0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178, 0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35,
  0x131c471b, 0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c, 0x4cc5d4be, 0xcb3e42b6,
  0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
]);
const IV512 = [
  0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1, 0x510e527f, 0xade682d1, 0x9b05688c,
  0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179,
];
const IV384 = [
  0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939, 0x67332667, 0xffc00b31, 0x8eb44a87,
  0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4,
];
const W512 = new Uint32Array(160); // 상위·하위가 번갈아 든다. 한 스레드에서만 쓰므로 재사용한다.

function sha512Core(message, iv, outBytes) {
  const h = Uint32Array.from(iv);
  const data = pad(message, 128, 16);
  const v = new DataView(data.buffer);
  const w = W512;
  for (let off = 0; off < data.length; off += 128) {
    for (let i = 0; i < 32; i++) w[i] = v.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const xh = w[(i - 15) * 2];
      const xl = w[(i - 15) * 2 + 1];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      const yh = w[(i - 2) * 2];
      const yl = w[(i - 2) * 2 + 1];
      const s1h = ((yh >>> 19) | (yl << 13)) ^ ((yl >>> 29) | (yh << 3)) ^ (yh >>> 6);
      const s1l = ((yl >>> 19) | (yh << 13)) ^ ((yh >>> 29) | (yl << 3)) ^ ((yl >>> 6) | (yh << 26));
      const lo = (w[(i - 16) * 2 + 1] >>> 0) + (s0l >>> 0) + (w[(i - 7) * 2 + 1] >>> 0) + (s1l >>> 0);
      w[i * 2 + 1] = lo;
      w[i * 2] = w[(i - 16) * 2] + s0h + w[(i - 7) * 2] + s1h + Math.floor(lo / 0x100000000);
    }
    let ah = h[0], al = h[1], bh = h[2], bl = h[3], ch = h[4], cl = h[5], dh = h[6], dl = h[7];
    let eh = h[8], el = h[9], fh = h[10], fl = h[11], gh = h[12], gl = h[13], hh = h[14], hl = h[15];
    for (let i = 0; i < 80; i++) {
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh);
      const chl = (el & fl) ^ (~el & gl);
      let lo = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + K512[i * 2 + 1] + w[i * 2 + 1];
      const t1l = lo >>> 0;
      const t1h = (hh + S1h + chh + K512[i * 2] + w[i * 2] + Math.floor(lo / 0x100000000)) >>> 0;
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
      const mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
      lo = (S0l >>> 0) + (mjl >>> 0);
      const t2l = lo >>> 0;
      const t2h = (S0h + mjh + Math.floor(lo / 0x100000000)) >>> 0;
      hh = gh;
      hl = gl;
      gh = fh;
      gl = fl;
      fh = eh;
      fl = el;
      lo = (dl >>> 0) + t1l;
      el = lo >>> 0;
      eh = (dh + t1h + Math.floor(lo / 0x100000000)) >>> 0;
      dh = ch;
      dl = cl;
      ch = bh;
      cl = bl;
      bh = ah;
      bl = al;
      lo = t1l + t2l;
      al = lo >>> 0;
      ah = (t1h + t2h + Math.floor(lo / 0x100000000)) >>> 0;
    }
    const add = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl];
    for (let i = 0; i < 16; i += 2) {
      const lo = h[i + 1] + (add[i + 1] >>> 0);
      h[i + 1] = lo;
      h[i] = h[i] + add[i] + Math.floor(lo / 0x100000000);
    }
  }
  return words(h, outBytes);
}

export const sha512 = (message) => sha512Core(message, IV512, 64);
export const sha384 = (message) => sha512Core(message, IV384, 48);

function words(h, bytes) {
  const out = new Uint8Array(h.length * 4);
  const v = new DataView(out.buffer);
  h.forEach((x, i) => v.setUint32(i * 4, x >>> 0));
  return out.subarray(0, bytes);
}

const HASHES = { SHA1: sha1, SHA256: sha256, SHA384: sha384, SHA512: sha512 };
const hashByName = (name) => HASHES[String(name).toUpperCase().replace(/[-_]/g, '')] ?? null;

// ---------- AES 복호화(T-table) ----------

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const TD = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];

(function buildTables() {
  const exp = new Uint8Array(256);
  const log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 256; i++) {
    exp[i] = x;
    log[x] = i;
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
    x &= 0xff;
  }
  const mul = (a, b) => (a && b ? exp[(log[a] + log[b]) % 255] : 0);
  for (let i = 0; i < 256; i++) {
    // 곱셈 역원에 아핀 변환
    let inverse = i ? exp[255 - log[i]] : 0;
    let s = inverse;
    for (let k = 0; k < 4; k++) {
      inverse = ((inverse << 1) | (inverse >>> 7)) & 0xff;
      s ^= inverse;
    }
    SBOX[i] = s ^ 0x63;
  }
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
  for (let i = 0; i < 256; i++) {
    const s = INV_SBOX[i];
    let t = ((mul(s, 0x0e) << 24) | (mul(s, 0x09) << 16) | (mul(s, 0x0d) << 8) | mul(s, 0x0b)) >>> 0;
    for (let k = 0; k < 4; k++) {
      TD[k][i] = t;
      t = ((t >>> 8) | (t << 24)) >>> 0;
    }
  }
})();

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

/** 복호화용 라운드 키(역순, 가운데 라운드는 InvMixColumns 적용) */
function decryptionKeys(key) {
  const nk = key.length / 4;
  const rounds = nk + 6;
  const w = new Uint32Array(4 * (rounds + 1));
  for (let i = 0; i < nk; i++) w[i] = ((key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3]) >>> 0;
  const sub = (t) => ((SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) | (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff]) >>> 0;
  for (let i = nk; i < w.length; i++) {
    let t = w[i - 1];
    if (i % nk === 0) t = (sub(((t << 8) | (t >>> 24)) >>> 0) ^ (RCON[i / nk - 1] << 24)) >>> 0;
    else if (nk > 6 && i % nk === 4) t = sub(t);
    w[i] = (w[i - nk] ^ t) >>> 0;
  }
  const dk = new Uint32Array(w.length);
  for (let r = 0; r <= rounds; r++) {
    for (let c = 0; c < 4; c++) {
      const x = w[(rounds - r) * 4 + c];
      dk[r * 4 + c] =
        r === 0 || r === rounds
          ? x
          : (TD[0][SBOX[x >>> 24]] ^ TD[1][SBOX[(x >>> 16) & 0xff]] ^ TD[2][SBOX[(x >>> 8) & 0xff]] ^ TD[3][SBOX[x & 0xff]]) >>> 0;
    }
  }
  return { dk, rounds };
}

/** 16바이트 한 블록을 풀어 out[outOff..]에 쓴다. */
function decryptBlock({ dk, rounds }, input, off, out, outOff) {
  const [T0, T1, T2, T3] = TD;
  const word = (o) => (input[o] << 24) | (input[o + 1] << 16) | (input[o + 2] << 8) | input[o + 3];
  let s0 = word(off) ^ dk[0];
  let s1 = word(off + 4) ^ dk[1];
  let s2 = word(off + 8) ^ dk[2];
  let s3 = word(off + 12) ^ dk[3];
  let k = 4;
  for (let r = 1; r < rounds; r++, k += 4) {
    const t0 = T0[s0 >>> 24] ^ T1[(s3 >>> 16) & 0xff] ^ T2[(s2 >>> 8) & 0xff] ^ T3[s1 & 0xff] ^ dk[k];
    const t1 = T0[s1 >>> 24] ^ T1[(s0 >>> 16) & 0xff] ^ T2[(s3 >>> 8) & 0xff] ^ T3[s2 & 0xff] ^ dk[k + 1];
    const t2 = T0[s2 >>> 24] ^ T1[(s1 >>> 16) & 0xff] ^ T2[(s0 >>> 8) & 0xff] ^ T3[s3 & 0xff] ^ dk[k + 2];
    const t3 = T0[s3 >>> 24] ^ T1[(s2 >>> 16) & 0xff] ^ T2[(s1 >>> 8) & 0xff] ^ T3[s0 & 0xff] ^ dk[k + 3];
    s0 = t0;
    s1 = t1;
    s2 = t2;
    s3 = t3;
  }
  const last = (a, b, c, d, key) =>
    ((INV_SBOX[a >>> 24] << 24) | (INV_SBOX[(b >>> 16) & 0xff] << 16) | (INV_SBOX[(c >>> 8) & 0xff] << 8) | INV_SBOX[d & 0xff]) ^ key;
  const o = [last(s0, s3, s2, s1, dk[k]), last(s1, s0, s3, s2, dk[k + 1]), last(s2, s1, s0, s3, dk[k + 2]), last(s3, s2, s1, s0, dk[k + 3])];
  for (let i = 0; i < 4; i++) {
    out[outOff + i * 4] = o[i] >>> 24;
    out[outOff + i * 4 + 1] = o[i] >>> 16;
    out[outOff + i * 4 + 2] = o[i] >>> 8;
    out[outOff + i * 4 + 3] = o[i];
  }
}

/** AES-ECB 복호화(표준 암호화). 16바이트에 못 미치는 꼬리는 버린다. */
export function aesDecryptEcb(key, data) {
  const schedule = decryptionKeys(key);
  const out = new Uint8Array(data.length - (data.length % 16));
  for (let i = 0; i < out.length; i += 16) decryptBlock(schedule, data, i, out, i);
  return out;
}

/** AES-CBC 복호화(애자일 암호화). Office는 0으로 채우므로 채움을 걷어 내지 않는다. */
export function aesDecryptCbc(key, iv, data) {
  const schedule = decryptionKeys(key);
  const out = new Uint8Array(data.length - (data.length % 16));
  for (let i = 0; i < out.length; i += 16) {
    decryptBlock(schedule, data, i, out, i);
    const previous = i === 0 ? iv : data;
    const p = i === 0 ? 0 : i - 16;
    for (let j = 0; j < 16; j++) out[i + j] ^= previous[p + j];
  }
  return out;
}

// ---------- 문서 암호화 ----------

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 암호는 UTF-16LE로 키를 만든다(규격). */
function utf16le(text) {
  const out = new Uint8Array(text.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) v.setUint16(i * 2, text.charCodeAt(i), true);
  return out;
}

function le32(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
}

function sameBytes(a, b, length) {
  if (a.length < length || b.length < length) return false;
  let diff = 0;
  for (let i = 0; i < length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 반복 해시: H0 = hash(salt + 암호), Hi = hash(LE32(i) + H(i-1)) */
function spin(hash, salt, password, count) {
  let h = hash(concat(salt, utf16le(password)));
  const buffer = new Uint8Array(4 + h.length);
  const v = new DataView(buffer.buffer);
  for (let i = 0; i < count; i++) {
    v.setUint32(0, i, true);
    buffer.set(h, 4);
    h = hash(buffer);
  }
  return h;
}

/** 키 길이에 맞춰 자르거나 0x36으로 채운다(규격). */
function fit(key, bytes) {
  if (key.length >= bytes) return key.subarray(0, bytes);
  const out = new Uint8Array(bytes).fill(0x36);
  out.set(key);
  return out;
}

const packageSize = (pkg) => Number(new DataView(pkg.buffer, pkg.byteOffset, pkg.byteLength).getBigUint64(0, true));

function decryptStandard(info, pkg, password) {
  const v = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const headerSize = v.getUint32(8, true);
  if (headerSize < 32 || 12 + headerSize + 8 > info.length) throw new Error('EncryptionInfo(표준)를 읽지 못했습니다');
  const keyBits = v.getUint32(12 + 16, true);
  const keyBytes = keyBits >= 8 ? keyBits / 8 : 16;
  let off = 12 + headerSize;
  if (v.getUint32(off, true) !== 16) throw new Error('EncryptionInfo(표준)의 솔트 길이가 올바르지 않습니다');
  const salt = info.subarray(off + 4, off + 20);
  const encryptedVerifier = info.subarray(off + 20, off + 36);
  off += 36;
  if (v.getUint32(off, true) < 20) throw new Error('EncryptionInfo(표준)의 검증값 길이가 올바르지 않습니다');
  const encryptedVerifierHash = info.subarray(off + 4, off + 36);

  const h = sha1(concat(spin(sha1, salt, password, 50000), le32(0)));
  const derive = (fill) => sha1(new Uint8Array(64).map((_, i) => (i < h.length ? h[i] : 0) ^ fill));
  const key = fit(concat(derive(0x36), derive(0x5c)), keyBytes);
  if (!sameBytes(sha1(aesDecryptEcb(key, encryptedVerifier)), aesDecryptEcb(key, encryptedVerifierHash), 20)) throw new WrongPasswordError();
  const plain = aesDecryptEcb(key, pkg.subarray(8));
  return plain.subarray(0, Math.min(packageSize(pkg), plain.length));
}

const BLOCK_VERIFIER_INPUT = new Uint8Array([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]);
const BLOCK_VERIFIER_VALUE = new Uint8Array([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]);
const BLOCK_KEY_VALUE = new Uint8Array([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]);

const base64 = (text) => Uint8Array.from(atob(text ?? ''), (c) => c.charCodeAt(0));

/** 애자일 암호화 설명(XML)에서 필요한 속성만 읽는다. */
function parseAgile(info) {
  const xml = new TextDecoder().decode(info.subarray(8));
  const keyData = /<[^>]*keyData\b[^>]*>/.exec(xml)?.[0] ?? '';
  const encryptedKey = /<[^>]*encryptedKey\b[^>]*>/.exec(xml)?.[0] ?? '';
  const attr = (element, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(element)?.[1] ?? null;
  const number = (element, name, fallback) => {
    const n = Number(attr(element, name));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const hash = hashByName(attr(keyData, 'hashAlgorithm'));
  const passwordHash = hashByName(attr(encryptedKey, 'hashAlgorithm'));
  if (!keyData || !encryptedKey || !hash || !passwordHash || (attr(keyData, 'cipherAlgorithm') ?? 'AES') !== 'AES') {
    throw new Error('지원하지 않는 애자일 암호화 설정입니다');
  }
  return {
    hash,
    hashSize: number(keyData, 'hashSize', 64),
    blockSize: number(keyData, 'blockSize', 16),
    keyBytes: number(keyData, 'keyBits', 256) / 8,
    keySalt: base64(attr(keyData, 'saltValue')),
    passwordHash,
    passwordKeyBytes: number(encryptedKey, 'keyBits', 256) / 8,
    passwordSalt: base64(attr(encryptedKey, 'saltValue')),
    spinCount: number(encryptedKey, 'spinCount', 100000),
    encryptedKeyValue: base64(attr(encryptedKey, 'encryptedKeyValue')),
    encryptedVerifierHashInput: base64(attr(encryptedKey, 'encryptedVerifierHashInput')),
    encryptedVerifierHashValue: base64(attr(encryptedKey, 'encryptedVerifierHashValue')),
  };
}

function decryptAgile(info, pkg, password) {
  const a = parseAgile(info);
  const base = spin(a.passwordHash, a.passwordSalt, password, a.spinCount);
  const blockKey = (block) => fit(a.passwordHash(concat(base, block)), a.passwordKeyBytes);
  const input = aesDecryptCbc(blockKey(BLOCK_VERIFIER_INPUT), a.passwordSalt, a.encryptedVerifierHashInput);
  const value = aesDecryptCbc(blockKey(BLOCK_VERIFIER_VALUE), a.passwordSalt, a.encryptedVerifierHashValue);
  if (!sameBytes(a.passwordHash(input.subarray(0, a.passwordSalt.length)), value, Math.min(a.hashSize, value.length))) {
    throw new WrongPasswordError();
  }
  const secret = aesDecryptCbc(blockKey(BLOCK_KEY_VALUE), a.passwordSalt, a.encryptedKeyValue).subarray(0, a.keyBytes);
  // 4096바이트마다 따로 푼다. IV는 keyData 솔트와 조각 번호로 만든다.
  const body = pkg.subarray(8);
  const out = new Uint8Array(body.length - (body.length % 16));
  for (let i = 0, off = 0; off < out.length; i++, off += 4096) {
    const iv = fit(a.hash(concat(a.keySalt, le32(i))), a.blockSize);
    out.set(aesDecryptCbc(secret, iv, body.subarray(off, Math.min(off + 4096, out.length))), off);
  }
  return out.subarray(0, Math.min(packageSize(pkg), out.length));
}

/** EncryptionInfo·EncryptedPackage 스트림을 풀어 원래 ZIP 바이트를 돌려준다. 암호가 틀리면 WrongPasswordError. */
export function decryptOoxml(info, pkg, password) {
  if (info.length < 16 || pkg.length < 16) throw new Error('암호화 스트림이 잘렸습니다');
  const v = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const major = v.getUint16(0, true);
  const minor = v.getUint16(2, true);
  if (major === 4 && minor === 4) return decryptAgile(info, pkg, password);
  if (minor === 3 && (major === 3 || major === 4)) throw new Error('확장 암호화(사용자 지정 암호화 공급자)는 지원하지 않습니다');
  return decryptStandard(info, pkg, password);
}
