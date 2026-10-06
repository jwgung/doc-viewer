// 복합 문서(CFB, xls의 컨테이너)에서 스트림 하나를 꺼낸다.
// SheetJS의 CFB 읽기는 브라우저에서 스트림을 일반 JS 배열로 만들어(28MB xls면 2천8백만 칸) 느리고 메모리를 많이 쓴다.
// 여기서는 섹터가 연속이면 원본을 복사하지 않고 그대로 보고, 아니면 Uint8Array 하나에 모은다.
const ENDOFCHAIN = -2;
const FREESECT = -1;
const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function isCfb(bytes) {
  return bytes.length >= 512 && SIGNATURE.every((b, i) => bytes[i] === b);
}

/** names 중 처음 찾은 스트림의 내용을 돌려준다. 없으면 null. */
export function readCfbStream(bytes, names) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorSize = 1 << dv.getUint16(30, true);
  const miniSectorSize = 1 << dv.getUint16(32, true);
  const dirStart = dv.getInt32(48, true);
  const miniCutoff = dv.getUint32(56, true);
  const miniFatStart = dv.getInt32(60, true);
  const difatStart = dv.getInt32(68, true);
  const difatCount = dv.getUint32(72, true);
  if (sectorSize !== 512 && sectorSize !== 4096) throw new Error('CFB sector size');
  const sectorCount = Math.floor((bytes.length - sectorSize) / sectorSize) + 1;
  const offsetOf = (sector) => (sector + 1) * sectorSize;

  // FAT 섹터 목록: 헤더의 109칸 + DIFAT 사슬
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = dv.getInt32(76 + i * 4, true);
    if (s >= 0) fatSectors.push(s);
  }
  for (let d = difatStart, guard = 0; d >= 0 && d < sectorCount && guard <= difatCount; guard++) {
    const base = offsetOf(d);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per; i++) {
      const s = dv.getInt32(base + i * 4, true);
      if (s >= 0) fatSectors.push(s);
    }
    d = dv.getInt32(base + per * 4, true);
  }
  const perSector = sectorSize / 4;
  const fat = new Int32Array(fatSectors.length * perSector).fill(FREESECT);
  fatSectors.forEach((s, k) => {
    const base = offsetOf(s);
    if (base + sectorSize > bytes.length) return;
    for (let i = 0; i < perSector; i++) fat[k * perSector + i] = dv.getInt32(base + i * 4, true);
  });

  const chain = (start, table, limit) => {
    const out = [];
    for (let s = start; s >= 0 && s !== ENDOFCHAIN && out.length <= limit; s = s < table.length ? table[s] : ENDOFCHAIN) out.push(s);
    return out;
  };
  const readChain = (start, size) => {
    const sectors = chain(start, fat, sectorCount);
    // 섹터가 이어져 있으면 원본의 한 구간을 그대로 쓴다.
    let contiguous = true;
    for (let i = 1; i < sectors.length && contiguous; i++) contiguous = sectors[i] === sectors[i - 1] + 1;
    const begin = offsetOf(sectors[0] ?? 0);
    if (contiguous && begin + size <= bytes.length) return bytes.subarray(begin, begin + size);
    const out = new Uint8Array(size);
    let at = 0;
    for (const s of sectors) {
      if (at >= size) break;
      const from = offsetOf(s);
      const n = Math.min(sectorSize, size - at, Math.max(0, bytes.length - from));
      out.set(bytes.subarray(from, from + n), at);
      at += n;
    }
    return out;
  };

  // 디렉터리 항목(128바이트)
  const dirSectors = chain(dirStart, fat, sectorCount);
  const entries = [];
  for (const s of dirSectors) {
    const base = offsetOf(s);
    for (let off = 0; off + 128 <= sectorSize && base + off + 128 <= bytes.length; off += 128) {
      const at = base + off;
      const nameLength = Math.min(64, dv.getUint16(at + 64, true));
      let name = '';
      for (let i = 0; i + 2 < nameLength; i += 2) name += String.fromCharCode(dv.getUint16(at + i, true));
      entries.push({ name, type: dv.getUint8(at + 66), start: dv.getInt32(at + 116, true), size: dv.getUint32(at + 120, true) });
    }
  }
  const root = entries[0];
  const wanted = names.map((n) => n.toLowerCase());
  const entry = entries.find((e) => e.type === 2 && wanted.includes(e.name.toLowerCase()));
  if (!entry) return null;
  if (entry.size >= miniCutoff || !root) return readChain(entry.start, entry.size);

  // 작은 스트림은 미니 스트림 안에 있다.
  const miniStream = readChain(root.start, root.size);
  const miniFatBytes = readChain(miniFatStart, chain(miniFatStart, fat, sectorCount).length * sectorSize);
  const miniDv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
  const miniFat = new Int32Array(miniFatBytes.byteLength / 4);
  for (let i = 0; i < miniFat.length; i++) miniFat[i] = miniDv.getInt32(i * 4, true);
  const out = new Uint8Array(entry.size);
  let at = 0;
  for (const s of chain(entry.start, miniFat, miniFat.length)) {
    const from = s * miniSectorSize;
    const n = Math.min(miniSectorSize, entry.size - at);
    out.set(miniStream.subarray(from, from + n), at);
    at += n;
    if (at >= entry.size) break;
  }
  return out;
}
