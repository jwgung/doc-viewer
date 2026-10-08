import type { Paragraph, Presentation, ShapeElement, Slide, TextBody, TextRun } from '../types';

/**
 * [doc-viewer] PowerPoint 95·4.0처럼 97 이전 형식에서 글자만 뽑아 슬라이드로 보여 준다.
 *
 * 두 형식 모두 공개 명세가 없어 도형·서식은 읽지 않는다. 목적은 '열 수 없음' 대신 내용을 읽을 수 있게 하는 것이다.
 * - PowerPoint 95: 레코드 구조가 97과 비슷하지만 머리가 16바이트다. 슬라이드(0x03EE)마다 글 상자의
 *   위치(0x0BC1)와 글자(0x0FE0 바로 아래 0x07EE)를 읽어 원래 자리에 놓는다.
 * - PowerPoint 4.0(PP40 스트림): 구조를 모른다. 글자 레코드가 u32 길이 + ANSI 글자로 들어 있어
 *   그 꼴만 골라 내고, 레코드 사이가 크게 벌어지는 곳을 슬라이드 경계로 본다.
 */

const MASTER_TO_PX = 96 / 576;

interface Rec95 {
  type: number;
  container: boolean;
  start: number;
  len: number;
}

/** PowerPoint 95 레코드: type(u16) · 예약(u16) · 종류(u32, 0xFFFF면 컨테이너) · 길이(u32) · 예약(u32) */
function* records95(dv: DataView, start: number, end: number): Generator<Rec95> {
  let off = start;
  while (off + 16 <= end) {
    const len = dv.getUint32(off + 8, true);
    if (off + 16 + len > end) return;
    yield { type: dv.getUint16(off, true), container: dv.getUint32(off + 4, true) === 0xffff, start: off + 16, len };
    off += 16 + len;
  }
}

/** 'PowerPoint Document' 스트림이 PowerPoint 95 형식인지(루트 0x0003 컨테이너 안에 Document 0x03E8) */
export function isPpt95(doc: Uint8Array): boolean {
  if (doc.length < 32) return false;
  const dv = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
  return dv.getUint16(0, true) === 0x0003 && dv.getUint32(4, true) === 0xffff
    && dv.getUint32(8, true) + 16 <= doc.length && dv.getUint16(16, true) === 0x03e8;
}

/** 바이트 → 글자(ANSI). 문단 구분 \r, 줄 바꿈 \v만 남기고 나머지 제어 문자는 버린다 */
function ansiText(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    if (b === 13 || b === 11 || b === 9 || b >= 32) s += String.fromCharCode(b);
  }
  return s;
}

const run = (text: string, size: number, bold: boolean): TextRun => ({
  text, b: bold, i: false, u: false, strike: false, size, color: 'rgb(0,0,0)', fonts: [],
});

/** 글자 → 글 상자. 크기를 알 수 없어 넘치면 렌더러가 줄이게(autoFitCompute) 한다 */
function textBody(text: string, size: number, bold: boolean, anchor: TextBody['anchor']): TextBody {
  const paragraphs: Paragraph[] = text.split(/[\r\v]/).map((line) => ({
    align: 'left', lvl: 0, marL: 0, indent: 0, bullet: null, lineHeight: null, spaceBefore: 0, spaceAfter: size * 0.25,
    runs: [run(line, size, bold)],
  }));
  return { anchor, insets: [4.8, 9.6, 4.8, 9.6], wrap: true, fontScale: 1, autoFitCompute: true, paragraphs };
}

const box = (x: number, y: number, w: number, h: number, text: TextBody): ShapeElement => ({
  kind: 'shape', x, y, w, h, rot: 0, flipH: false, flipV: false, path: null, fill: null, stroke: null, text,
});

/** PowerPoint 95 → 글자만 담은 슬라이드. 읽을 슬라이드가 없으면 null */
export function parsePpt95(doc: Uint8Array): Presentation | null {
  const dv = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
  const root = records95(dv, 0, doc.length).next().value;
  if (!root) return null;
  const docRec = [...records95(dv, root.start, root.start + root.len)].find((r) => r.type === 0x03e8 && r.container);
  if (!docRec) return null;

  let wm = 5760;
  let hm = 4320;
  const slideRecs: Rec95[] = [];
  for (const r of records95(dv, docRec.start, docRec.start + docRec.len)) {
    if (r.type === 0x03e9 && r.len >= 8) {
      wm = dv.getInt32(r.start, true) || wm;
      hm = dv.getInt32(r.start + 4, true) || hm;
    } else if (r.type === 0x07d0 && r.container) {
      // 슬라이드 목록. 마스터(0x03F8)가 든 목록은 마스터·제목 마스터 목록이라 건너뛴다
      const kids = [...records95(dv, r.start, r.start + r.len)];
      if (kids.some((k) => k.type === 0x03f8)) continue;
      slideRecs.push(...kids.filter((k) => k.type === 0x03ee && k.container));
    }
  }

  const width = wm * MASTER_TO_PX;
  const height = hm * MASTER_TO_PX;
  const slides: Slide[] = [];
  for (const s of slideRecs) {
    // 글 상자: 0x0BC2 컨테이너 안의 위치(0x0BC1: 가운데가 원점인 left·top·right·bottom)와 글자
    const shapes: { x: number; y: number; w: number; h: number; text: string }[] = [];
    const walk = (start: number, end: number, depth: number, inText: boolean): void => {
      for (const r of records95(dv, start, end)) {
        if (r.type === 0x0bc2 && r.container) {
          let bounds: number[] | null = null;
          const texts: string[] = [];
          const collect = (cs: number, ce: number, d: number): void => {
            for (const c of records95(dv, cs, ce)) {
              if (c.type === 0x0bc1 && !c.container && c.len >= 28 && !bounds) {
                bounds = [12, 16, 20, 24].map((o) => dv.getInt32(c.start + o, true));
              } else if (c.type === 0x0fe0 && c.container) {
                for (const t of records95(dv, c.start, c.start + c.len)) {
                  if (t.type === 0x07ee && !t.container && t.len > 0) texts.push(ansiText(doc.subarray(t.start, t.start + t.len)));
                }
              } else if (c.container && d < 8) collect(c.start, c.start + c.len, d + 1);
            }
          };
          collect(r.start, r.start + r.len, 0);
          const text = texts.join('\r').replace(/\0/g, '');
          if (bounds && text.trim()) {
            const [l, t, rr, b] = bounds as number[];
            shapes.push({
              x: (l + wm / 2) * MASTER_TO_PX, y: (t + hm / 2) * MASTER_TO_PX,
              w: Math.max(1, rr - l) * MASTER_TO_PX, h: Math.max(1, b - t) * MASTER_TO_PX, text,
            });
          }
        } else if (r.container && depth < 8 && !inText) {
          // 메모(0x03F0)의 글은 슬라이드에 그리지 않는다
          if (r.type !== 0x03f0) walk(r.start, r.start + r.len, depth + 1, inText);
        }
      }
    };
    walk(s.start, s.start + s.len, 0, false);
    // 맨 위에 가까운 글 상자를 제목으로 크게 쓴다
    const top = shapes.reduce<typeof shapes[number] | null>((a, b) => (!a || b.y < a.y ? b : a), null);
    const elements = shapes.map((sh) => {
      const title = sh === top && sh.y < height * 0.3;
      return box(sh.x, sh.y, sh.w, sh.h, textBody(sh.text, title ? 48 : 32, false, title ? 'middle' : 'top'));
    });
    slides.push({ background: { type: 'solid', color: 'rgb(255,255,255)' }, elements });
  }
  if (!slides.some((s) => s.elements.length)) return null;
  return { width, height, slides, source: 'ppt' };
}

/** PowerPoint 4.0(PP40 스트림) → 글자만 담은 슬라이드. 글자를 못 찾으면 null */
export function parsePp40(stream: Uint8Array): Presentation | null {
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const isText = (b: number): boolean => b === 13 || b === 11 || b === 9 || (b >= 32 && b !== 127);
  const blocks: { start: number; end: number; text: string }[] = [];
  let i = 0;
  while (i + 4 < stream.length) {
    const len = dv.getUint32(i, true);
    // u32 길이 바로 뒤가 그 길이만큼 모두 글자이고 글자가 하나라도 있으면 글 레코드로 본다
    if (len >= 2 && len <= 20000 && i + 4 + len <= stream.length) {
      let ok = true;
      let letters = 0;
      for (let k = i + 4; k < i + 4 + len; k++) {
        const b = stream[k];
        if (!isText(b)) {
          ok = false;
          break;
        }
        if ((b >= 65 && b <= 90) || (b >= 97 && b <= 122)) letters++;
      }
      if (ok && letters >= Math.min(2, len)) {
        blocks.push({ start: i, end: i + 4 + len, text: ansiText(stream.subarray(i + 4, i + 4 + len)) });
        i += 4 + len;
        continue;
      }
    }
    i++;
  }
  if (!blocks.length) return null;

  // 레코드 사이가 크게 벌어지는 곳을 슬라이드 경계로 본다(같은 슬라이드의 글 상자는 몇백 바이트 안에 몰려 있다)
  const groups: string[][] = [];
  let last = -Infinity;
  for (const b of blocks) {
    if (b.start - last > 600 || !groups.length) groups.push([]);
    groups[groups.length - 1].push(b.text);
    last = b.end;
  }

  const width = 960;
  const height = 720;
  const slides: Slide[] = groups.map((texts) => {
    const [first, ...rest] = texts;
    const elements: ShapeElement[] = [box(48, 32, width - 96, 120, textBody(first, 40, true, 'middle'))];
    if (rest.length) elements.push(box(48, 168, width - 96, height - 200, textBody(rest.join('\r'), 28, false, 'top')));
    return { background: { type: 'solid', color: 'rgb(255,255,255)' }, elements };
  });
  return { width, height, slides, source: 'ppt' };
}
