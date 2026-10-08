// 문서 파일의 바깥 상자 두 가지를 직접 읽는다: ZIP(docx·xlsx·pptx·hwpx)과 CFB/OLE2(doc·xls·ppt·hwp, 암호 걸린 OOXML).
// 렌더러 라이브러리가 실패했을 때(최후 대안)와 암호 해제에 쓰므로, 손상·잘린 파일도 읽을 수 있는 만큼 읽는다.
// 압축 해제는 브라우저 내장 DecompressionStream을 써서 번들에 압축 라이브러리를 더하지 않는다.

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffa; // 이 값 이상은 사슬 끝·빈 섹터 표시

export const isZip = (bytes) => bytes.length >= 4 && view(bytes).getUint32(0, true) === ZIP_LOCAL;
export const isCompound = (bytes) => bytes.length >= 512 && CFB_MAGIC.every((b, i) => bytes[i] === b);

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** raw deflate를 푼다. 잘렸거나 뒤에 다른 바이트가 붙어 있으면 그때까지 풀린 만큼만 돌려준다. */
export async function inflateRaw(data) {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch {
    // 손상된 압축 데이터: 읽은 데까지 쓴다.
  }
  return concat(chunks);
}

export function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * ZIP 목차를 읽는다. 중앙 디렉터리가 없거나 깨졌으면(잘린 파일) 앞에서부터 지역 헤더를 찾아 읽는다.
 * 항목 이름은 '\\'를 '/'로 바꾸고, 찾을 때는 대소문자를 가리지 않는다(이를 어긴 파일을 만드는 프로그램이 있다).
 * 돌려주는 객체: names(항목 이름 목록), has(name), bytes(name) → Promise<Uint8Array|null>, text(name) → Promise<string|null>
 */
export function readZip(bytes) {
  const raw = readCentralDirectory(bytes) ?? scanLocalHeaders(bytes);
  const entries = new Map([...raw].map(([name, entry]) => [name.replaceAll('\\', '/'), entry]));
  const byLowerName = new Map([...entries].map(([name, entry]) => [name.toLowerCase(), entry]));
  const read = async (name) => {
    const entry = entries.get(name) ?? byLowerName.get(name.toLowerCase());
    if (!entry) return null;
    const data = bytes.subarray(entry.start, Math.min(bytes.length, entry.start + entry.size));
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRaw(data);
    return null;
  };
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name) || byLowerName.has(name.toLowerCase()),
    bytes: read,
    async text(name) {
      const data = await read(name);
      return data && new TextDecoder().decode(data);
    },
  };
}

/**
 * 압축을 풀면 몇 바이트가 되는지: 중앙 디렉터리에 적힌 항목 크기의 합. 압축 폭탄처럼 풀면 기기 메모리를 넘는 문서를
 * 렌더러에 넘기기 전에 거르는 데 쓴다. 목차가 없거나 깨졌으면 0(거르지 않는다).
 */
export function zipExpandedSize(bytes) {
  const v = view(bytes);
  const end = findZipEnd(bytes);
  if (end < 0) return 0;
  let total = 0;
  let o = v.getUint32(end + 16, true);
  const count = v.getUint16(end + 10, true);
  for (let i = 0; i < count && o + 46 <= bytes.length && v.getUint32(o, true) === ZIP_CENTRAL; i++) {
    const nameLength = v.getUint16(o + 28, true);
    const extraLength = v.getUint16(o + 30, true);
    let size = v.getUint32(o + 24, true);
    // 4GB 이상이면 0xFFFFFFFF로 적고 실제 크기는 ZIP64 확장 필드에 둔다.
    if (size === 0xffffffff) size = zip64Size(v, o + 46 + nameLength, Math.min(bytes.length, o + 46 + nameLength + extraLength)) ?? size;
    total += size;
    o += 46 + nameLength + extraLength + v.getUint16(o + 32, true);
  }
  return total;
}

/** ZIP64 확장 필드(id 1)의 첫 값(푼 크기). */
function zip64Size(v, from, to) {
  for (let p = from; p + 4 <= to; p += 4 + v.getUint16(p + 2, true)) {
    if (v.getUint16(p, true) === 0x0001 && v.getUint16(p + 2, true) >= 8 && p + 12 <= to) return Number(v.getBigUint64(p + 4, true));
  }
  return null;
}

function findZipEnd(bytes) {
  const v = view(bytes);
  for (let o = bytes.length - 22; o >= Math.max(0, bytes.length - 65557); o--) {
    if (v.getUint32(o, true) === ZIP_END) return o;
  }
  return -1;
}

function readCentralDirectory(bytes) {
  const v = view(bytes);
  const end = findZipEnd(bytes);
  if (end < 0) return null;
  const entries = new Map();
  let o = v.getUint32(end + 16, true);
  const count = v.getUint16(end + 10, true);
  for (let i = 0; i < count && o + 46 <= bytes.length && v.getUint32(o, true) === ZIP_CENTRAL; i++) {
    const nameLength = v.getUint16(o + 28, true);
    const local = v.getUint32(o + 42, true);
    if (local + 30 <= bytes.length && v.getUint32(local, true) === ZIP_LOCAL) {
      entries.set(new TextDecoder().decode(bytes.subarray(o + 46, o + 46 + nameLength)), {
        method: v.getUint16(o + 10, true),
        start: local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true),
        size: v.getUint32(o + 20, true),
      });
    }
    o += 46 + nameLength + v.getUint16(o + 30, true) + v.getUint16(o + 32, true);
  }
  return entries.size ? entries : null;
}

function scanLocalHeaders(bytes) {
  const v = view(bytes);
  const entries = new Map();
  const next = (from) => {
    for (let o = bytes.indexOf(0x50, from); o >= 0 && o + 30 <= bytes.length; o = bytes.indexOf(0x50, o + 1)) {
      if (v.getUint32(o, true) === ZIP_LOCAL) return o;
    }
    return -1;
  };
  for (let o = next(0); o >= 0; ) {
    const flags = v.getUint16(o + 6, true);
    const nameLength = v.getUint16(o + 26, true);
    const start = o + 30 + nameLength + v.getUint16(o + 28, true);
    const following = next(start);
    const until = following < 0 ? bytes.length : following;
    // 크기를 데이터 뒤에 적는 방식(bit 3)이면 헤더의 크기가 0이라 다음 항목 직전까지로 본다.
    const declared = v.getUint32(o + 18, true);
    const size = flags & 0x08 || declared === 0 ? until - start : declared;
    entries.set(new TextDecoder().decode(bytes.subarray(o + 30, o + 30 + nameLength)), {
      method: v.getUint16(o + 8, true),
      start,
      size,
    });
    o = following;
  }
  return entries;
}

/**
 * CFB(OLE2 복합 문서)를 읽는다. 스트림 경로는 'BodyText/Section0'처럼 저장소 이름을 '/'로 잇는다.
 * CFB 이름은 대소문자를 가리지 않으므로('worddocument'로 저장한 파일도 있다) 찾을 때도 가리지 않는다.
 * 돌려주는 객체: names(스트림 경로 목록), has(path), read(path) → Uint8Array|null
 */
export function readCompound(bytes) {
  const v = view(bytes);
  const u32 = (o) => v.getUint32(o, true);
  const shift = v.getUint16(0x1e, true);
  if (shift !== 9 && shift !== 12) throw new Error('CFB 섹터 크기가 올바르지 않습니다');
  const size = 1 << shift;
  const sectorLimit = Math.ceil(bytes.length / size) + 1;
  const offsetOf = (sector) => (sector + 1) * size;

  // FAT 섹터 목록: 헤더에 든 109개 + DIFAT 사슬
  const fatCount = u32(0x2c);
  const fatSectors = [];
  for (let i = 0; i < Math.min(109, fatCount); i++) fatSectors.push(u32(0x4c + i * 4));
  for (let s = u32(0x44), guard = 0; s < END_OF_CHAIN && fatSectors.length < fatCount && guard < sectorLimit; guard++) {
    const base = offsetOf(s);
    if (base + size > bytes.length) break;
    for (let i = 0; i < size / 4 - 1 && fatSectors.length < fatCount; i++) fatSectors.push(u32(base + i * 4));
    s = u32(base + size - 4);
  }
  const fat = new Uint32Array(fatSectors.length * (size / 4)).fill(0xfffffffe);
  fatSectors.forEach((s, i) => {
    const base = offsetOf(s);
    if (s < END_OF_CHAIN && base + size <= bytes.length) {
      for (let j = 0; j < size / 4; j++) fat[i * (size / 4) + j] = u32(base + j * 4);
    }
  });

  /** 섹터 사슬을 따라 읽는다. 순환·범위 밖 섹터를 만나면 거기서 멈춘다. */
  const readChain = (start, length, table, unit, source) => {
    // 손상된 파일의 터무니없는 크기 값은 실제 데이터 크기로 줄인다.
    const want = Math.min(length, source.length);
    const parts = [];
    const seen = new Set();
    let pos = 0;
    for (let s = start; s < END_OF_CHAIN && !seen.has(s) && pos < want; s = s < table.length ? table[s] : END_OF_CHAIN) {
      seen.add(s);
      const base = source === bytes ? offsetOf(s) : s * unit;
      const piece = source.subarray(base, base + Math.min(unit, want - pos));
      if (!piece.length) break;
      parts.push(piece);
      pos += piece.length;
    }
    return concat(parts);
  };

  const dir = readChain(u32(0x30), Infinity, fat, size, bytes);
  const dv = view(dir);
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLength = Math.min(64, dv.getUint16(o + 0x40, true));
    entries.push({
      name: new TextDecoder('utf-16le').decode(dir.subarray(o, o + Math.max(0, nameLength - 2))),
      type: dir[o + 0x42],
      left: dv.getUint32(o + 0x44, true),
      right: dv.getUint32(o + 0x48, true),
      child: dv.getUint32(o + 0x4c, true),
      start: dv.getUint32(o + 0x74, true),
      size: dv.getUint32(o + 0x78, true), // 상위 4바이트는 무시한다(4GB를 넘는 스트림은 없다).
    });
  }
  if (!entries.length) throw new Error('CFB 디렉터리가 비어 있습니다');

  // 미니 스트림(4096바이트 미만 스트림을 64바이트 단위로 모아 둔 곳)
  const miniCutoff = u32(0x38);
  const miniSize = 1 << v.getUint16(0x20, true);
  const miniStream = readChain(entries[0].start, entries[0].size, fat, size, bytes);
  const miniFatBytes = readChain(u32(0x3c), u32(0x40) * size, fat, size, bytes);
  const miniFat = new Uint32Array(miniFatBytes.buffer.slice(miniFatBytes.byteOffset, miniFatBytes.byteOffset + (miniFatBytes.length & ~3)));

  // 저장소 트리를 따라 경로를 만든다(형제는 이진 트리로 연결돼 있다).
  const paths = new Map();
  const seen = new Set();
  const stack = [[entries[0].child, '']];
  while (stack.length) {
    const [id, prefix] = stack.pop();
    if (id >= entries.length || seen.has(id)) continue;
    seen.add(id);
    const entry = entries[id];
    stack.push([entry.left, prefix], [entry.right, prefix]);
    if (entry.type === 2) paths.set((prefix + entry.name).toLowerCase(), { ...entry, path: prefix + entry.name });
    if (entry.type === 1) stack.push([entry.child, `${prefix}${entry.name}/`]);
  }

  return {
    names: [...paths.values()].map((entry) => entry.path),
    has: (path) => paths.has(path.toLowerCase()),
    read(path) {
      const entry = paths.get(path.toLowerCase());
      if (!entry) return null;
      return entry.size < miniCutoff
        ? readChain(entry.start, entry.size, miniFat, miniSize, miniStream)
        : readChain(entry.start, entry.size, fat, size, bytes);
    },
  };
}
