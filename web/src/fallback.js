// 최후 대안: 렌더러가 문서를 그리지 못하면 원래 모양은 포기하고 본문 글자만 뽑아 보여준다.
// 확장자를 믿지 않고 실제 내용(앞부분 서명)으로 판별하므로, 확장자가 틀린 파일
// (RTF·HTML·MHTML로 저장된 .doc·.xls 등)도 여기서 건진다.
import DOMPurify from 'dompurify';
import { isCompound, isZip, inflateRaw, readCompound, readZip } from './containers.js';
import { t } from './strings.js';
import { decodeText } from './text.js';

/** 아주 큰 문서에서 화면이 멈추지 않도록 이만큼까지만 보인다. */
const MAX_CHARS = 2_000_000;
const MAX_ROWS = 5000;

/**
 * 문서에서 본문을 뽑는다.
 * @returns {Promise<{blocks: Block[]} | {html: string} | {encrypted: true} | null>}
 *   Block은 { text } 문단, { heading } 제목, { cells } 표의 한 행 중 하나다.
 */
export async function extractFallback(bytes) {
  if (isZip(bytes)) return extractZip(bytes);
  if (isCompound(bytes)) return extractCompound(bytes);
  const head = headText(bytes).trimStart().toLowerCase();
  if (head.startsWith('%pdf')) return null;
  if (head.startsWith('{\\rtf')) return { blocks: rtfBlocks(bytes) };
  if (head.startsWith('mime-version:') || /^content-type:\s*multipart\/related/m.test(head)) return mhtml(bytes);
  if (/^<(!doctype html|html|head|body|table|meta)[\s>]/.test(head) || /<html[\s>]/.test(head)) return { html: decodeMarkup(bytes) };
  if (head.startsWith('<?xml') || head.startsWith('<')) return { blocks: textBlocks(xmlText(decodeMarkup(bytes))) };
  if (looksLikeText(bytes)) return { blocks: textBlocks(decodeText(bytes)) };
  return null;
}

/** 뽑은 본문을 그린다. 그릴 것이 없으면 false. */
export function renderFallback(extracted, container) {
  const article = document.createElement('article');
  article.className = 'flow fallback';
  const note = document.createElement('p');
  note.className = 'fallback-note';
  note.textContent = t.fallbackNotice;
  const body = document.createElement('div');
  if (extracted.html !== undefined) {
    body.innerHTML = DOMPurify.sanitize(extracted.html, {
      // 문서의 스타일 시트가 뷰어 화면 전체를 바꾸지 않게 style·link 요소는 뺀다(인라인 스타일은 둔다).
      FORBID_TAGS: ['style', 'link', 'meta', 'base', 'form', 'input', 'button', 'select', 'textarea', 'iframe', 'object', 'embed'],
    });
  } else {
    appendBlocks(extracted.blocks, body);
  }
  if (!body.textContent.trim()) return false;
  article.append(note, body);
  container.replaceChildren(article);
  return true;
}

function appendBlocks(blocks, parent) {
  let table = null;
  let chars = 0;
  for (const block of blocks) {
    if (chars > MAX_CHARS) break;
    if (block.cells) {
      table ??= parent.appendChild(document.createElement('table'));
      const row = table.insertRow();
      for (const cell of block.cells) row.insertCell().textContent = cell;
      chars += block.cells.join('').length;
      continue;
    }
    table = null;
    const text = block.heading ?? block.text;
    if (!text?.trim()) continue;
    const el = document.createElement(block.heading !== undefined ? 'h2' : 'p');
    el.textContent = text;
    parent.appendChild(el);
    chars += text.length;
  }
}

const textBlocks = (text) => text.split(/\r\n|\r|\n|\f/).map((line) => ({ text: line }));

/** 앞부분 2KB를 글자로(바이트 순서 표시가 있으면 UTF-16으로) 읽는다. 서명 확인용. */
function headText(bytes) {
  const head = bytes.subarray(0, 2048);
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder('utf-16le').decode(head.subarray(2));
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder('utf-16be').decode(head.subarray(2));
  return new TextDecoder('latin1').decode(head).replace(/^\xef\xbb\xbf/, '');
}

/** NUL이 없고 제어 문자가 거의 없으면 텍스트 파일로 본다. */
function looksLikeText(bytes) {
  const sample = bytes.subarray(0, 8192);
  let control = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) control++;
  }
  return sample.length > 0 && control / sample.length < 0.02;
}

/** HTML·XML을 문자열로: 바이트 순서 표시 → meta/xml 선언의 charset → UTF-8/EUC-KR 추정 순으로 정한다. */
function decodeMarkup(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const declared = /(?:charset|encoding)\s*=\s*["']?([\w-]+)/i.exec(new TextDecoder('latin1').decode(bytes.subarray(0, 4096)))?.[1];
  return decodeWith(bytes, declared) ?? decodeText(bytes);
}

function decodeWith(bytes, label) {
  if (!label) return null;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return null; // 브라우저가 모르는 문자 집합 이름
  }
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[name] ?? match;
  });
}

/** 형식을 모르는 XML: 태그를 걷어 내고 줄 단위로 남긴다. */
function xmlText(xml) {
  return unescapeXml(
    xml
      .replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, '')
      .replace(/<\/(p|h\d|div|li|tr|row|para|title)>/gi, '\n')
      .replace(/<\/(cell|td|th|entry)>/gi, '\t')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

const byNumber = (a, b) => Number(/(\d+)\D*$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\D*$/.exec(b)?.[1] ?? 0);

// ---------- ZIP 계열: docx·pptx·xlsx·hwpx ----------

async function extractZip(bytes) {
  const zip = readZip(bytes);
  const some = (pattern) => zip.names.some((n) => pattern.test(n));
  if (zip.has('word/document.xml')) return { blocks: ooxmlParagraphs(await zip.text('word/document.xml'), 'w') };
  if (some(/^ppt\/slides\/slide\d+\.xml$/i)) return pptxText(zip);
  if (zip.has('xl/workbook.xml') || some(/^xl\/worksheets\//i)) return xlsxText(zip);
  const sections = zip.names.filter((n) => /^Contents\/section\d+\.xml$/i.test(n)).sort(byNumber);
  if (sections.length) {
    if ((await zip.text('META-INF/manifest.xml'))?.includes('encryption-data')) return { encrypted: true };
    const blocks = [];
    for (const name of sections) blocks.push(...hwpxParagraphs(await zip.text(name)));
    return { blocks };
  }
  return null;
}

/** OOXML 문단: 글자(<w:t>·<a:t>), 탭, 줄바꿈, 문단 끝을 문서 순서대로 훑는다(태그가 깨져도 읽을 수 있게 정규식으로). */
function ooxmlParagraphs(xml, ns) {
  if (!xml) return [];
  const blocks = [];
  let text = '';
  // <w:tab/>은 글 속 탭이고, 속성이 붙은 <w:tab .../>·<a:tab .../>은 탭 위치 설정이라 빼야 한다.
  const pattern = new RegExp(`<${ns}:t(?:\\s[^>]*)?>([^<]*)</${ns}:t>|<${ns}:(tab)\\s*/>|<${ns}:(br|cr)\\b[^>]*>|</${ns}:p>`, 'g');
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) text += unescapeXml(match[1]);
    else if (match[2]) text += '\t';
    else if (match[3]) text += '\n';
    else {
      blocks.push({ text });
      text = '';
    }
  }
  if (text) blocks.push({ text });
  return blocks;
}

async function pptxText(zip) {
  const slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n)).sort(byNumber);
  const blocks = [];
  for (const [i, name] of slides.entries()) {
    blocks.push({ heading: t.fallbackSlide(i + 1) }, ...ooxmlParagraphs(await zip.text(name), 'a'));
  }
  return { blocks };
}

async function xlsxText(zip) {
  const shared = [];
  const sharedXml = (await zip.text('xl/sharedStrings.xml')) ?? '';
  for (const si of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    // 일본어 읽기 표시(<rPh>)는 빼고 본문 글자만 잇는다.
    const body = si[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    shared.push([...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => unescapeXml(m[1])).join(''));
  }
  const sheets = await worksheetOrder(zip);
  const blocks = [];
  for (const { name, path } of sheets) {
    const xml = await zip.text(path);
    if (!xml) continue;
    blocks.push({ heading: name });
    let rows = 0;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows++ >= MAX_ROWS) break;
      const cells = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1];
        const column = columnIndex(/\br="([A-Z]+)\d+"/.exec(attrs)?.[1]) ?? cells.length;
        const type = /\bt="(\w+)"/.exec(attrs)?.[1];
        const inner = cell[2] ?? '';
        const value = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        let text = '';
        if (type === 's') text = shared[Number(value)] ?? '';
        else if (type === 'inlineStr') text = [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => m[1]).join('');
        else if (type === 'b') text = value === '1' ? 'TRUE' : 'FALSE';
        else text = value ?? '';
        while (cells.length < column) cells.push('');
        cells[column] = unescapeXml(text);
      }
      if (cells.some((c) => c)) blocks.push({ cells });
    }
  }
  return { blocks };
}

function columnIndex(letters) {
  if (!letters) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.min(n - 1, 16383);
}

/** 시트 이름과 파일 경로를 통합 문서 순서대로. 관계 파일이 깨졌으면 파일 번호 순서로. */
async function worksheetOrder(zip) {
  const workbook = (await zip.text('xl/workbook.xml')) ?? '';
  const rels = (await zip.text('xl/_rels/workbook.xml.rels')) ?? '';
  const targets = new Map();
  for (const rel of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(rel[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(rel[0])?.[1];
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const sheets = [];
  for (const sheet of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(sheet[0])?.[1];
    const path = targets.get(/\br:id="([^"]+)"/.exec(sheet[0])?.[1]);
    if (name !== undefined && path && zip.has(path)) sheets.push({ name: unescapeXml(name), path });
  }
  if (sheets.length) return sheets;
  return zip.names
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(n))
    .sort(byNumber)
    .map((path, i) => ({ name: `Sheet${i + 1}`, path }));
}

/** HWPX 문단: <hp:t> 안에 탭·줄바꿈 같은 태그가 섞여 있다. */
function hwpxParagraphs(xml) {
  if (!xml) return [];
  const blocks = [];
  let text = '';
  for (const match of xml.matchAll(/<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>|<\/hp:p>/g)) {
    if (match[1] === undefined) {
      blocks.push({ text });
      text = '';
      continue;
    }
    text += unescapeXml(
      match[1]
        .replace(/<hp:tab\b[^>]*\/>/g, '\t')
        .replace(/<hp:lineBreak\b[^>]*\/>/g, '\n')
        .replace(/<[^>]+>/g, ''),
    );
  }
  if (text) blocks.push({ text });
  return blocks;
}

// ---------- CFB 계열: hwp·doc·ppt·xls, 암호 걸린 OOXML ----------

async function extractCompound(bytes) {
  const cfb = readCompound(bytes);
  if (cfb.has('EncryptedPackage')) return { encrypted: true };
  if (cfb.has('FileHeader')) return hwpText(cfb);
  if (cfb.has('WordDocument')) return wordText(cfb);
  if (cfb.has('PowerPoint Document')) return pptText(cfb);
  if (cfb.has('Workbook') || cfb.has('Book')) return xlsEncrypted(cfb.read(cfb.has('Workbook') ? 'Workbook' : 'Book')) ? { encrypted: true } : null;
  return null;
}

/** HWP 5.0: BodyText/Section* 스트림의 문단 글자 레코드(HWPTAG_PARA_TEXT)를 모은다. */
async function hwpText(cfb) {
  const header = cfb.read('FileHeader');
  if (!header || header.length < 40) return null;
  const flags = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(36, true);
  if (flags & 0x02) return { encrypted: true };
  // 배포용 문서는 본문이 ViewText 아래에 암호화돼 있어 글자를 뽑을 수 없다.
  const sections = cfb.names.filter((n) => /^BodyText\/Section\d+$/i.test(n)).sort(byNumber);
  if (flags & 0x04 || !sections.length) return null;
  const blocks = [];
  for (const name of sections) {
    let data = cfb.read(name);
    if (flags & 0x01) data = await inflateRaw(data);
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let o = 0; o + 4 <= data.length; ) {
      const head = v.getUint32(o, true);
      let size = head >>> 20;
      o += 4;
      if (size === 0xfff) {
        if (o + 4 > data.length) break;
        size = v.getUint32(o, true);
        o += 4;
      }
      if ((head & 0x3ff) === 67) blocks.push(...hwpParagraph(data, o, Math.min(data.length, o + size)));
      o += size;
    }
  }
  return { blocks };
}

/** HWP 문단 글자: UTF-16 사이에 제어 문자가 섞여 있다. 0·10·13·24~31은 한 글자, 나머지 제어 문자는 8글자를 차지한다. */
function hwpParagraph(data, start, end) {
  const utf16 = new TextDecoder('utf-16le');
  let text = '';
  let run = start;
  const flush = (until) => {
    if (until > run) text += utf16.decode(data.subarray(run, until));
  };
  let o = start;
  while (o + 1 < end) {
    const code = data[o] | (data[o + 1] << 8);
    if (code >= 32) {
      o += 2;
      continue;
    }
    flush(o);
    if (code === 9) text += '\t';
    else if (code === 10) text += '\n';
    else if (code === 24) text += '-';
    else if (code === 30 || code === 31) text += ' ';
    o += code === 0 || code === 10 || code === 13 || code >= 24 ? 2 : 16;
    run = o;
  }
  flush(Math.min(o, end));
  return text.split('\n').map((line) => ({ text: line }));
}

const WORD_CODEPAGES = { 0x0412: 'euc-kr', 0x0411: 'shift_jis', 0x0804: 'gbk', 0x0404: 'big5', 0x0419: 'windows-1251' };

/** Word 97 이후는 조각 표(piece table)를 따라, Word 6/95는 본문 범위를 그대로 읽는다. */
function wordText(cfb) {
  const doc = cfb.read('WordDocument');
  if (!doc || doc.length < 0x60) return null;
  const v = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
  const nFib = v.getUint16(2, true);
  const lid = v.getUint16(6, true);
  const flags = v.getUint16(0x0a, true);
  if (flags & 0x0100) return { encrypted: true };
  let text = '';
  if (nFib < 0xc0) {
    // Word 6/95: 글자가 지역 코드 페이지의 1바이트(한글은 2바이트) 문자로 fcMin~fcMac에 있다.
    const fcMin = v.getUint32(0x18, true);
    const fcMac = Math.min(doc.length, v.getUint32(0x1c, true));
    text = decodeWith(doc.subarray(fcMin, fcMac), WORD_CODEPAGES[lid]) ?? new TextDecoder('windows-1252').decode(doc.subarray(fcMin, fcMac));
  } else {
    text = wordPieces(cfb, doc, v, flags);
    if (text === null) return null;
  }
  return { blocks: wordParagraphs(text) };
}

function wordPieces(cfb, doc, v, flags) {
  const table = cfb.read(flags & 0x0200 ? '1Table' : '0Table');
  if (!table) return null;
  const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const csw = v.getUint16(0x20, true);
  const cslwAt = 0x22 + csw * 2;
  const cslw = v.getUint16(cslwAt, true);
  const lw = cslwAt + 2;
  const ccpText = v.getInt32(lw + 12, true);
  const fcLcb = lw + cslw * 4 + 2;
  if (fcLcb + 34 * 8 > doc.length) return null;
  const fcClx = v.getUint32(fcLcb + 33 * 8, true);
  const lcbClx = v.getUint32(fcLcb + 33 * 8 + 4, true);
  let o = fcClx;
  const end = Math.min(table.length, fcClx + lcbClx);
  while (o < end && table[o] === 0x01) o += 3 + tv.getUint16(o + 1, true); // Prc(서식 묶음)는 건너뛴다.
  if (o + 5 > end || table[o] !== 0x02) return null;
  const count = Math.floor((tv.getUint32(o + 1, true) - 4) / 12);
  const cps = o + 5;
  const pcds = cps + (count + 1) * 4;
  if (count <= 0 || pcds + count * 8 > table.length) return null;
  const limit = ccpText > 0 ? ccpText : Infinity;
  const cp1252 = new TextDecoder('windows-1252');
  const utf16 = new TextDecoder('utf-16le');
  let text = '';
  for (let i = 0; i < count; i++) {
    const cpStart = tv.getInt32(cps + i * 4, true);
    if (cpStart >= limit) break;
    const length = Math.min(tv.getInt32(cps + (i + 1) * 4, true), limit) - cpStart;
    if (length <= 0) continue;
    const fc = tv.getUint32(pcds + i * 8 + 2, true);
    if (fc & 0x40000000) {
      const at = (fc & 0x3fffffff) / 2;
      text += cp1252.decode(doc.subarray(at, at + length));
    } else {
      text += utf16.decode(doc.subarray(fc, fc + length * 2));
    }
    if (text.length > MAX_CHARS) break;
  }
  return text;
}

/** Word 특수 문자 정리: 필드 코드는 버리고 결과만 남기며, 문단(\r)·쪽 나눔(\f)으로 나눈다. */
function wordParagraphs(text) {
  let out = '';
  const fields = []; // 필드마다 '결과를 보이는 중인지'
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code === 0x13) fields.push(false);
    else if (code === 0x14) {
      if (fields.length) fields[fields.length - 1] = true;
    } else if (code === 0x15) fields.pop();
    else if (fields.includes(false)) continue;
    else if (code === 0x0d || code === 0x0c) out += '\n';
    else if (code === 0x0b) out += ' ';
    else if (code === 0x07) out += '\t';
    else if (code === 0x1e) out += '-';
    else if (code >= 0x20 || code === 0x09) out += ch;
  }
  return out.split('\n').map((line) => ({ text: line.replaceAll(' ', '\n') }));
}

/** PPT 97 이후: 레코드를 훑어 글자 레코드(TextCharsAtom·TextBytesAtom)를 모은다. 마스터·노트·유인물은 건너뛴다. */
function pptText(cfb) {
  if (cfb.has('EncryptedSummary')) return { encrypted: true };
  // PowerPoint 95와 97 형식을 함께 담은 파일은 97 쪽 스트림을 저장소 안에 따로 둔다.
  const data = cfb.read('PP97_DUALSTORAGE/PowerPoint Document') ?? cfb.read('PowerPoint Document');
  if (!data) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const SKIP = new Set([0x03f8, 0x03f0, 0x0fc9]); // MainMaster, Notes, Handout
  const utf16 = new TextDecoder('utf-16le');
  const latin1 = new TextDecoder('latin1');
  const blocks = [];
  for (let o = 0; o + 8 <= data.length; ) {
    const version = v.getUint16(o, true) & 0x0f;
    const type = v.getUint16(o + 2, true);
    const length = v.getUint32(o + 4, true);
    if (version === 0x0f && !SKIP.has(type)) {
      o += 8; // 컨테이너는 안으로 들어간다.
      continue;
    }
    const body = data.subarray(o + 8, Math.min(data.length, o + 8 + length));
    if (type === 0x0fa0 || type === 0x0fa8) {
      const text = (type === 0x0fa0 ? utf16 : latin1).decode(body);
      for (const line of text.split('\r')) blocks.push({ text: line.replaceAll('\v', '\n') });
    }
    o += 8 + length;
  }
  return { blocks };
}

/** xls: 통합 문서 앞부분에 FILEPASS 레코드가 있으면 암호가 걸린 문서다. */
function xlsEncrypted(data) {
  if (!data) return false;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let o = 0, n = 0; o + 4 <= data.length && n < 64; n++) {
    if (v.getUint16(o, true) === 0x002f) return true;
    o += 4 + v.getUint16(o + 2, true);
  }
  return false;
}

// ---------- 텍스트 계열: RTF·MHTML ----------

const RTF_CODEPAGES = { 949: 'euc-kr', 932: 'shift_jis', 936: 'gbk', 950: 'big5', 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 874: 'windows-874' };
// 본문이 아닌 묶음(글꼴 표·색 표·그림·필드 명령 등)은 통째로 건너뛴다.
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'filetbl', 'revtbl', 'fldinst', 'header', 'footer', 'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf', 'pgdsctbl', 'mmathPr', 'fchars', 'lchars', 'shppict', 'nonshppict', 'bkmkstart', 'bkmkend', 'xe', 'tc', 'objdata', 'blipuid', 'falt', 'panose', 'template', 'userprops', 'docvar']);

/** RTF에서 글자만 남긴다. \'hh는 문서 코드 페이지로, \uN은 유니코드로 읽는다. */
function rtfBlocks(bytes) {
  const src = new TextDecoder('latin1').decode(bytes);
  const codepage = RTF_CODEPAGES[/\\ansicpg(\d+)/.exec(src.slice(0, 4096))?.[1]] ?? 'windows-1252';
  const decoder = new TextDecoder(codepage);
  let out = '';
  let pending = []; // 이어지는 \'hh 바이트(2바이트 한글을 함께 디코딩하려고 모은다)
  const flushBytes = () => {
    if (!pending.length) return;
    out += decoder.decode(new Uint8Array(pending));
    pending = [];
  };
  const stack = [];
  let skip = false;
  let uc = 1;
  let skipChars = 0;
  for (let i = 0; i < src.length && out.length < MAX_CHARS; ) {
    const ch = src[i];
    if (ch === '{' || ch === '}') {
      flushBytes();
      if (ch === '{') stack.push({ skip, uc });
      else ({ skip, uc } = stack.pop() ?? { skip: false, uc: 1 });
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (ch !== '\\') {
      flushBytes();
      if (skipChars > 0) skipChars--;
      else if (!skip) out += ch;
      i++;
      continue;
    }
    const next = src[i + 1];
    if (next === "'") {
      const byte = parseInt(src.substr(i + 2, 2), 16);
      i += 4;
      if (skipChars > 0) skipChars--;
      else if (!skip && !Number.isNaN(byte)) pending.push(byte);
      continue;
    }
    flushBytes();
    if (next === '*') {
      skip = true; // 모르는 확장 묶음
      i += 2;
      continue;
    }
    if (!/[a-z]/i.test(next ?? '')) {
      if (!skip && (next === '\\' || next === '{' || next === '}')) out += next;
      else if (!skip && next === '~') out += ' ';
      else if (!skip && next === '_') out += '-';
      i += 2;
      continue;
    }
    const word = /^([a-z]+)(-?\d+)? ?/i.exec(src.slice(i + 1, i + 40));
    i += 1 + word[0].length;
    const [, name, arg] = word;
    if (RTF_SKIP.has(name)) skip = true;
    if (skip) continue;
    if (name === 'par' || name === 'line' || name === 'sect' || name === 'page' || name === 'row') out += '\n';
    else if (name === 'tab' || name === 'cell') out += '\t';
    else if (name === 'uc') uc = Number(arg ?? 1);
    else if (name === 'u') {
      let code = Number(arg ?? 0);
      if (code < 0) code += 65536;
      out += String.fromCharCode(code);
      skipChars = uc;
    }
  }
  flushBytes();
  return textBlocks(out);
}

/** MHTML(웹 페이지 한 파일로 저장): HTML 부분을 꺼내 전송 인코딩·문자 집합을 풀어 준다. */
function mhtml(bytes) {
  const text = new TextDecoder('latin1').decode(bytes);
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(text)?.[1];
  if (!boundary) return null;
  for (const part of text.split(`--${boundary}`)) {
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const headers = part.slice(0, split);
    if (!/content-type:\s*text\/html/i.test(headers)) continue;
    const body = part.slice(split).replace(/^\r?\n\r?\n/, '');
    let raw;
    if (/content-transfer-encoding:\s*base64/i.test(headers)) {
      raw = Uint8Array.from(atob(body.replace(/[^A-Za-z0-9+/=]/g, '')), (c) => c.charCodeAt(0));
    } else if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
      const decoded = body.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      raw = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    } else {
      raw = Uint8Array.from(body, (c) => c.charCodeAt(0));
    }
    const charset = /charset="?([\w-]+)/i.exec(headers)?.[1];
    return { html: decodeWith(raw, charset) ?? decodeMarkup(raw) };
  }
  return null;
}
