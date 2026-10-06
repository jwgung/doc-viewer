import { BinaryReader, toUint8Array } from './binary.js';
import { pushWarning } from './utils.js';
import type { BinaryInput, CFBEntry, MsDocWarning, ParsedCFB } from '../types.js';

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const MAX_CHAIN_SECTORS = 1 << 20;
const MINI_STREAM_CUTOFF = 4096;

function isSpecialSectorId(sid: number): boolean {
  return sid === FREESECT || sid === ENDOFCHAIN || sid === FATSECT || sid === DIFSECT;
}

function readSectorAbsolute(bytes: Uint8Array, sectorSize: number, sid: number): Uint8Array {
  const start = 512 + sid * sectorSize;
  const end = start + sectorSize;
  if (start < 0 || start >= bytes.length) {
    throw new Error(`Sector ${sid} is out of bounds`);
  }
  if (end <= bytes.length) return bytes.subarray(start, end);
  const sector = new Uint8Array(sectorSize);
  sector.set(bytes.subarray(start));
  return sector;
}

// doc-viewer: 손상된 체인(순환·범위 밖 섹터)을 만나면 예외 대신 거기까지 읽은 내용을 돌려준다.
// 문서 전체를 포기하는 것보다 일부라도 보여주는 편이 '무조건 열림'에 맞다. 경고는 warnings로 남긴다.
function collectChain(
  startSid: number,
  nextSectorFn: (sid: number) => number,
  isValid: (sid: number) => boolean,
  warnings: MsDocWarning[] | null,
  limit = MAX_CHAIN_SECTORS,
): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  let sid = startSid;
  while (sid !== ENDOFCHAIN && sid !== FREESECT && sid >= 0) {
    if (seen.has(sid)) {
      if (warnings) pushWarning(warnings, `Detected sector loop at ${sid}; truncating the stream`);
      break;
    }
    if (!isValid(sid)) {
      if (warnings) pushWarning(warnings, `Sector ${sid} is out of bounds; truncating the stream`);
      break;
    }
    seen.add(sid);
    chain.push(sid);
    sid = nextSectorFn(sid);
    if (chain.length > limit) {
      if (warnings) pushWarning(warnings, 'Sector chain exceeds safe limit; truncating the stream');
      break;
    }
  }
  return chain;
}

function readChainBytes(
  bytes: Uint8Array,
  sectorSize: number,
  startSid: number,
  fat: number[],
  expectedSize: number | null = null,
  warnings: MsDocWarning[] | null = null,
): Uint8Array {
  if (startSid === ENDOFCHAIN || startSid === FREESECT || startSid < 0) {
    return new Uint8Array(0);
  }
  const isValid = (sid: number) => 512 + sid * sectorSize < bytes.length;
  const chain = collectChain(startSid, (sid) => fat[sid] ?? ENDOFCHAIN, isValid, warnings);
  const out = new Uint8Array(chain.length * sectorSize);
  let offset = 0;
  for (const sid of chain) {
    out.set(readSectorAbsolute(bytes, sectorSize, sid), offset);
    offset += sectorSize;
  }
  return expectedSize == null ? out : out.subarray(0, Math.min(expectedSize, out.length));
}

function parseDirectoryTree(entries: CFBEntry[]): CFBEntry {
  // doc-viewer: 손상된 디렉터리 트리의 순환 참조로 무한 재귀에 빠지지 않게 한 번 본 항목은 다시 걷지 않는다.
  const visited = new Set<number>();
  function walkSiblings(entryId: number, out: number[], depth = 0): void {
    if (entryId < 0 || entryId >= entries.length || visited.has(entryId) || depth > 512) return;
    const entry = entries[entryId];
    if (!entry) return;
    visited.add(entryId);
    walkSiblings(entry.leftSiblingId, out, depth + 1);
    out.push(entryId);
    walkSiblings(entry.rightSiblingId, out, depth + 1);
  }

  function attachChildren(storageId: number, depth = 0): void {
    const storage = entries[storageId];
    if (!storage || storage.childId < 0 || depth > 64) return;
    const childIds: number[] = [];
    walkSiblings(storage.childId, childIds);
    storage.children = childIds;
    for (const childId of childIds) {
      const child = entries[childId];
      if (!child) continue;
      child.parentId = storageId;
      attachChildren(childId, depth + 1);
    }
  }

  const root = entries.find((entry) => entry?.objectType === 5);
  if (!root) throw new Error('CFB root storage not found');
  visited.add(root.id);
  attachChildren(root.id);
  return root;
}

function buildPathMap(entries: CFBEntry[]): Map<string, CFBEntry> {
  const map = new Map<string, CFBEntry>();
  for (const entry of entries) {
    if (!entry || !entry.name) continue;
    const parts: string[] = [];
    let current: CFBEntry | null = entry;
    while (current) {
      if (current.objectType !== 5) parts.push(current.name);
      current = current.parentId != null ? entries[current.parentId] ?? null : null;
    }
    const path = `/${parts.reverse().join('/')}`;
    entry.path = path === '/' ? `/${entry.name}` : path;
    map.set(entry.path, entry);
  }
  return map;
}

function normalizeName(name: string): string {
  return name.replace(/\u0000+$/, '');
}

/**
 * Parses the CFB/OLE container that wraps a legacy `.doc` file.
 * The returned object exposes stream helpers so higher layers can focus on
 * Word-specific structures instead of low-level sector navigation.
 */
export function parseCFB(input: BinaryInput, _options: Record<string, unknown> = {}): ParsedCFB {
  const bytes = toUint8Array(input);
  const reader = new BinaryReader(bytes);
  const warnings: MsDocWarning[] = [];

  for (let i = 0; i < CFB_SIGNATURE.length; i += 1) {
    if (reader.u8(i) !== CFB_SIGNATURE[i]) {
      throw new Error('Not a Compound File Binary document');
    }
  }

  const majorVersion = reader.u16(26);
  const sectorShift = reader.u16(30);
  const miniSectorShift = reader.u16(32);
  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniSectorShift;
  const numDirSectors = reader.u32(40);
  const numFatSectors = reader.u32(44);
  const firstDirSector = reader.i32(48);
  const transactionSignature = reader.u32(52);
  const miniStreamCutoffSize = reader.u32(56);
  const firstMiniFatSector = reader.i32(60);
  const numMiniFatSectors = reader.u32(64);
  const firstDifatSector = reader.i32(68);
  const numDifatSectors = reader.u32(72);

  if (miniStreamCutoffSize !== MINI_STREAM_CUTOFF) {
    pushWarning(warnings, `Unexpected mini stream cutoff size ${miniStreamCutoffSize}`);
  }

  // doc-viewer: 헤더 DIFAT는 앞의 numFatSectors개만 유효하다. 손상된 파일은 그 뒤에 쓰레기 값을 담기도 해서
  // 그대로 읽으면 범위를 벗어난 섹터를 FAT로 읽다가 문서 전체를 못 연다(LibreOffice·olefile도 개수만큼만 읽는다).
  const sectorCount = Math.max(0, Math.floor((bytes.length - 512 + sectorSize - 1) / sectorSize));
  const isValidSector = (sid: number) => sid >= 0 && sid < sectorCount;
  const headerDifat: number[] = [];
  for (let i = 0; i < 109; i += 1) {
    const sid = reader.i32(76 + i * 4);
    if (!isSpecialSectorId(sid) && sid >= 0) headerDifat.push(sid);
  }

  const difat = [...headerDifat];
  let difatSid = firstDifatSector;
  let difatCount = 0;
  while (difatSid !== ENDOFCHAIN && difatSid !== FREESECT && difatSid >= 0) {
    if (!isValidSector(difatSid)) {
      pushWarning(warnings, `DIFAT sector ${difatSid} is out of bounds; stopping early`);
      break;
    }
    const sector = readSectorAbsolute(bytes, sectorSize, difatSid);
    const sectorReader = new BinaryReader(sector);
    const entriesPerDifatSector = sectorSize / 4 - 1;
    for (let i = 0; i < entriesPerDifatSector; i += 1) {
      const sid = sectorReader.i32(i * 4);
      if (!isSpecialSectorId(sid) && sid >= 0) difat.push(sid);
    }
    difatSid = sectorReader.i32(sectorSize - 4);
    difatCount += 1;
    if (difatCount > numDifatSectors + 4) {
      pushWarning(warnings, 'DIFAT chain exceeded declared sector count; stopping early');
      break;
    }
  }

  if (numFatSectors && difat.length < numFatSectors) {
    pushWarning(warnings, `FAT sector count mismatch: header says ${numFatSectors}, found ${difat.length}`);
  }
  if (numFatSectors && difat.length > numFatSectors) difat.length = numFatSectors;

  const fat: number[] = [];
  for (const fatSid of difat) {
    if (!isValidSector(fatSid)) {
      pushWarning(warnings, `FAT sector ${fatSid} is out of bounds; treating it as free`);
      for (let i = 0; i < sectorSize / 4; i += 1) fat.push(-1);
      continue;
    }
    const fatSector = readSectorAbsolute(bytes, sectorSize, fatSid);
    const fatReader = new BinaryReader(fatSector);
    for (let i = 0; i < sectorSize / 4; i += 1) {
      fat.push(fatReader.i32(i * 4));
    }
  }

  const directoryBytes = readChainBytes(bytes, sectorSize, firstDirSector, fat, null, warnings);
  const directoryReader = new BinaryReader(directoryBytes);
  const entries: CFBEntry[] = [];
  for (let offset = 0, id = 0; offset + 128 <= directoryBytes.length; offset += 128, id += 1) {
    const nameLength = directoryReader.u16(offset + 64);
    const name = normalizeName(directoryReader.utf16le(offset, Math.max(0, Math.min(64, nameLength) - 2)));
    // doc-viewer: 빈 항목도 자리를 지켜야 entries[id]가 디렉터리 번호와 맞는다(형제·자식 번호로 찾는다).
    entries.push({
      id,
      name,
      objectType: directoryReader.u8(offset + 66),
      colorFlag: directoryReader.u8(offset + 67),
      leftSiblingId: directoryReader.i32(offset + 68),
      rightSiblingId: directoryReader.i32(offset + 72),
      childId: directoryReader.i32(offset + 76),
      clsid: directoryReader.slice(offset + 80, 16),
      stateBits: directoryReader.u32(offset + 96),
      creationTime: directoryReader.u64(offset + 100),
      modifiedTime: directoryReader.u64(offset + 108),
      startSector: directoryReader.i32(offset + 116),
      streamSize: majorVersion === 3 ? directoryReader.u32(offset + 120) : directoryReader.u64(offset + 120),
      children: [],
      parentId: null,
    });
  }

  const root = parseDirectoryTree(entries);
  const pathMap = buildPathMap(entries);

  const miniFat: number[] = [];
  if (numMiniFatSectors && firstMiniFatSector >= 0) {
    const miniFatBytes = readChainBytes(bytes, sectorSize, firstMiniFatSector, fat, null, warnings);
    const miniFatReader = new BinaryReader(miniFatBytes);
    for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) {
      miniFat.push(miniFatReader.i32(i));
    }
  }

  const rootStreamBytes = readChainBytes(bytes, sectorSize, root.startSector, fat, root.streamSize, warnings);

  function readMiniStream(entry: CFBEntry): Uint8Array {
    if (entry.startSector < 0) return new Uint8Array(0);
    const isValid = (sid: number) => (sid + 1) * miniSectorSize <= rootStreamBytes.length;
    const chain = collectChain(entry.startSector, (sid) => miniFat[sid] ?? ENDOFCHAIN, isValid, warnings);
    const out = new Uint8Array(chain.length * miniSectorSize);
    let offset = 0;
    for (const miniSid of chain) {
      const start = miniSid * miniSectorSize;
      const end = start + miniSectorSize;
      out.set(rootStreamBytes.subarray(start, end), offset);
      offset += miniSectorSize;
    }
    return out.subarray(0, Math.min(entry.streamSize, out.length));
  }

  // doc-viewer: 복합 문서의 이름은 대소문자를 가리지 않는다([MS-CFB] 2.6.4). 'worddocument'·'1TABLE'처럼
  // 대소문자가 다른 이름으로 저장된 파일도 열리게 정확히 일치하는 이름이 없으면 대소문자 무시로 다시 찾는다.
  const lowerPathMap = new Map<string, CFBEntry>();
  for (const [path, entry] of pathMap) {
    const key = path.toLowerCase();
    if (!lowerPathMap.has(key)) lowerPathMap.set(key, entry);
  }
  function lookup(path: string): CFBEntry | null {
    return pathMap.get(path) ?? lowerPathMap.get(path.toLowerCase()) ?? null;
  }

  function getStream(identifier: string | CFBEntry): Uint8Array | null {
    const entry = typeof identifier === 'string' ? lookup(identifier) : identifier;
    if (!entry) return null;
    if (entry.objectType !== 2 && entry.objectType !== 5) return null;
    if (entry.objectType === 5) return rootStreamBytes;
    if (entry.streamSize < miniStreamCutoffSize && entry.startSector >= 0 && miniFat.length) {
      return readMiniStream(entry);
    }
    return readChainBytes(bytes, sectorSize, entry.startSector, fat, entry.streamSize, warnings);
  }

  function listChildren(path: string | CFBEntry): CFBEntry[] {
    const entry = typeof path === 'string' ? lookup(path) : path;
    if (!entry) return [];
    return (entry.children || []).map((id) => entries[id]).filter((child): child is CFBEntry => Boolean(child));
  }

  return {
    bytes,
    majorVersion,
    sectorSize,
    miniSectorSize,
    numDirSectors,
    numFatSectors,
    firstDirSector,
    transactionSignature,
    miniStreamCutoffSize,
    warnings,
    entries,
    root,
    pathMap,
    getEntry(path: string): CFBEntry | null {
      return lookup(path);
    },
    getStream,
    listChildren,
    findByName(name: string, startPath = '/'): CFBEntry | null {
      const start = startPath === '/' ? root : lookup(startPath);
      if (!start) return null;
      const stack: CFBEntry[] = [start];
      while (stack.length) {
        const entry = stack.pop();
        if (!entry) continue;
        if (entry.name === name) return entry;
        for (const childId of entry.children || []) {
          const child = entries[childId];
          if (child) stack.push(child);
        }
      }
      return null;
    },
  };
}
