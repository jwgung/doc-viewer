// xlsx(zip) 안의 파일을 꺼낸다. 압축 풀기는 브라우저 내장 DecompressionStream을 써서 빠르고,
// 큰 시트 XML은 조각(문자열 스트림)으로 받아 전체를 한 번에 메모리에 올리지 않는다.
// 내장 기능이 없거나 zip 구조를 못 읽으면 SheetJS의 CFB(zip) 읽기로 대신한다.
import { CFB } from 'xlsx';

const decoder = () => new TextDecoder('utf-8');

export function isZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7);
}

const normalize = (name) => name.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();

export function openZip(bytes) {
  try {
    if (typeof DecompressionStream !== 'undefined') return new NativeZip(bytes);
  } catch {
    // 아래 SheetJS 경로로
  }
  return new SheetJsZip(bytes);
}

class NativeZip {
  constructor(bytes) {
    this.bytes = bytes;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('zip: no central directory');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    if (p === 0xffffffff) throw new Error('zip64');
    this.entries = new Map();
    for (let i = 0; i < count; i++) {
      if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip: bad central directory');
      const method = dv.getUint16(p + 10, true);
      const compressed = dv.getUint32(p + 20, true);
      const size = dv.getUint32(p + 24, true);
      const nameLength = dv.getUint16(p + 28, true);
      const extraLength = dv.getUint16(p + 30, true);
      const commentLength = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));
      this.entries.set(normalize(name), { method, compressed, size, local });
      p += 46 + nameLength + extraLength + commentLength;
    }
    this.dv = dv;
  }

  has(name) {
    return this.entries.has(normalize(name));
  }

  raw(entry) {
    const { dv, bytes } = this;
    if (dv.getUint32(entry.local, true) !== 0x04034b50) throw new Error('zip: bad local header');
    const start = entry.local + 30 + dv.getUint16(entry.local + 26, true) + dv.getUint16(entry.local + 28, true);
    return bytes.subarray(start, start + entry.compressed);
  }

  /** 압축을 풀며 문자열 조각을 차례로 넘긴다. */
  async stream(name, onChunk) {
    const entry = this.entries.get(normalize(name));
    if (!entry) return false;
    const data = this.raw(entry);
    if (entry.method === 0) {
      onChunk(decoder().decode(data));
      return true;
    }
    if (entry.method !== 8) throw new Error(`zip: method ${entry.method}`);
    const text = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).pipeThrough(new TextDecoderStream());
    const reader = text.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(value);
    }
    return true;
  }

  async text(name) {
    let out = '';
    const found = await this.stream(name, (chunk) => {
      out += chunk;
    });
    return found ? out : null;
  }
}

class SheetJsZip {
  constructor(bytes) {
    this.container = CFB.read(bytes, { type: 'array' });
  }

  find(name) {
    return CFB.find(this.container, `/${name.replace(/^\/+/, '')}`);
  }

  has(name) {
    return Boolean(this.find(name));
  }

  async stream(name, onChunk) {
    const text = await this.text(name);
    if (text == null) return false;
    onChunk(text);
    return true;
  }

  async text(name) {
    const entry = this.find(name);
    if (!entry?.content) return null;
    const content = entry.content instanceof Uint8Array ? entry.content : Uint8Array.from(entry.content);
    return decoder().decode(content);
  }
}
