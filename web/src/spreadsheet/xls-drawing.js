// xls(BIFF8) 그림. ppt와 같은 OfficeArt(Escher) 구조다.
// 전역 부분의 MSODRAWINGGROUP에 그림 저장소(BStore)가, 시트의 MSODRAWING에 도형 트리가 조각나 들어 있다.
// 그림(pib 속성이 있는 도형)만 읽고, 위치는 셀 앵커(열·행 + 칸 너비·높이에 대한 비율)로 넘긴다.
// 붙여 넣은 개체(OLE)도 엑셀처럼 미리보기 그림을 보인다. 차트·도형·글상자는 아직 그리지 않는다.
import { blipsFromStore, parseOpt } from '@web-ppt/core/escher';
import { toMedia } from './media.js';

const ET = {
  DGG: 0xf000, BSTORE: 0xf001, DG: 0xf002, SPGR_C: 0xf003, SP_C: 0xf004,
  SPGR: 0xf009, SP: 0xf00a, OPT: 0xf00b, CHILD_ANCHOR: 0xf00f, CLIENT_ANCHOR: 0xf010, TOPT: 0xf122,
};
const PROP = { rot: 0x0004, cropTop: 0x0100, cropBottom: 0x0101, cropLeft: 0x0102, cropRight: 0x0103, pib: 0x0104, groupBools: 0x03bf };
const SP_FLAG = { GROUP: 0x1, PATRIARCH: 0x4, DELETED: 0x8, FLIPH: 0x40, FLIPV: 0x80 };
const MAX_PICTURES = 2000;

function* records(dv, start, end) {
  let off = start;
  while (off + 8 <= end) {
    const verInst = dv.getUint16(off, true);
    const len = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (body + len > end) return;
    yield { type: dv.getUint16(off + 2, true), instance: verInst >> 4, version: verInst & 0xf, isContainer: (verInst & 0xf) === 0xf, start: body, len };
    off = body + len;
  }
}

const find = (dv, rec, type) => {
  for (const r of records(dv, rec.start, rec.start + rec.len)) if (r.type === type) return r;
  return null;
};

const fixed = (v) => (v | 0) / 65536; // 부호 있는 16.16 고정소수점

/** OfficeArtClientAnchorSheet: 열·행과 칸 안 위치(너비의 1/1024, 높이의 1/256) */
function sheetAnchor(dv, rec) {
  if (rec.len < 18) return null;
  const at = rec.start;
  const u = (k) => dv.getUint16(at + k, true);
  const s = (k) => dv.getInt16(at + k, true);
  return {
    from: [u(2), Math.min(1, Math.max(0, s(4) / 1024)), u(6), Math.min(1, Math.max(0, s(8) / 256))],
    to: [u(10), Math.min(1, Math.max(0, s(12) / 1024)), u(14), Math.min(1, Math.max(0, s(16) / 256))],
  };
}

function rect(dv, rec) {
  if (rec.len < 16) return null;
  const x = dv.getInt32(rec.start, true);
  const y = dv.getInt32(rec.start + 4, true);
  return { x, y, w: dv.getInt32(rec.start + 8, true) - x, h: dv.getInt32(rec.start + 12, true) - y };
}

/**
 * group: 전역 MSODRAWINGGROUP 바이트, drawing: 시트 MSODRAWING 바이트(이어 붙인 것).
 * { pictures, media }(xlsx와 같은 모양, 앵커는 frac) 또는 null
 */
export async function readXlsPictures(group, drawing) {
  const gdv = new DataView(group.buffer, group.byteOffset, group.byteLength);
  const dgg = [...records(gdv, 0, group.length)].find((r) => r.type === ET.DGG);
  const bstore = dgg && find(gdv, dgg, ET.BSTORE);
  if (!bstore) return null;
  const blips = blipsFromStore(group, bstore, null) ?? [];

  const dv = new DataView(drawing.buffer, drawing.byteOffset, drawing.byteLength);
  const pictures = [];
  const mediaOf = new Map(); // BStore 번호 → media 번호
  const blipList = [];

  // 그룹 컨테이너의 첫 도형은 그룹 자신(좌표계 Spgr·앵커)이다. 맨 위(patriarch)는 앵커가 없고 자식이 각자 셀 앵커를 가진다.
  // 그룹 안 도형은 자식 좌표를 맨 위 그룹 앵커 상자 안의 비율(box)로 바꾼다.
  const walk = (container, ctx, patriarch) => {
    const kids = [...records(dv, container.start, container.start + container.len)];
    const headIndex = kids.findIndex((r) => r.type === ET.SP_C);
    let inner = ctx;
    if (!patriarch) {
      const head = kids[headIndex];
      if (!head || isHidden(head)) return;
      const spgr = find(dv, head, ET.SPGR);
      const coord = spgr && rect(dv, spgr);
      if (!coord || coord.w <= 0 || coord.h <= 0) return;
      if (ctx) {
        const child = find(dv, head, ET.CHILD_ANCHOR);
        const box = child && childBox(rect(dv, child), ctx);
        if (!box) return;
        inner = { anchor: ctx.anchor, box, coord };
      } else {
        const client = find(dv, head, ET.CLIENT_ANCHOR);
        const anchor = client && sheetAnchor(dv, client);
        if (!anchor) return;
        inner = { anchor, box: [0, 0, 1, 1], coord };
      }
    }
    kids.forEach((rec, i) => {
      if (i === headIndex || pictures.length >= MAX_PICTURES) return;
      if (rec.type === ET.SP_C) shape(rec, inner);
      else if (rec.type === ET.SPGR_C) walk(rec, inner, false);
    });
  };

  const isHidden = (sp) => {
    for (const type of [ET.OPT, ET.TOPT]) {
      const opt = find(dv, sp, type);
      const v = opt && parseOpt(dv, opt).simple.get(PROP.groupBools);
      if (v !== undefined && v & 0x20000 && v & 0x2) return true; // fUsefHidden·fHidden
    }
    return false;
  };

  const shape = (sp, ctx) => {
    const spRec = find(dv, sp, ET.SP);
    if (!spRec || spRec.len < 8) return;
    const flags = dv.getUint32(spRec.start + 4, true);
    if (flags & (SP_FLAG.DELETED | SP_FLAG.PATRIARCH | SP_FLAG.GROUP)) return;
    const optRec = find(dv, sp, ET.OPT);
    if (!optRec) return;
    const props = parseOpt(dv, optRec).simple;
    const tertiary = find(dv, sp, ET.TOPT);
    if (tertiary) for (const [k, v] of parseOpt(dv, tertiary).simple) if (!props.has(k)) props.set(k, v);
    const pib = props.get(PROP.pib);
    if (!pib || !blips[pib - 1] || isHidden(sp)) return;
    let anchor;
    let box = [0, 0, 1, 1];
    if (ctx) {
      const child = find(dv, sp, ET.CHILD_ANCHOR);
      const b = child && childBox(rect(dv, child), ctx);
      if (!b) return;
      anchor = ctx.anchor;
      box = b;
    } else {
      const client = find(dv, sp, ET.CLIENT_ANCHOR);
      anchor = client && sheetAnchor(dv, client);
      if (!anchor) return;
    }
    let media = mediaOf.get(pib);
    if (media === undefined) {
      media = blipList.length;
      mediaOf.set(pib, media);
      blipList.push(blips[pib - 1]);
    }
    const crop = [PROP.cropLeft, PROP.cropTop, PROP.cropRight, PROP.cropBottom].map((id) => fixed(props.get(id) ?? 0));
    pictures.push({
      from: anchor.from, to: anchor.to, frac: true, size: null, pos: null, box, media,
      crop: crop.some((v) => v !== 0) ? crop : null,
      rot: fixed(props.get(PROP.rot) ?? 0),
      flipH: Boolean(flags & SP_FLAG.FLIPH),
      flipV: Boolean(flags & SP_FLAG.FLIPV),
    });
  };

  for (const dg of records(dv, 0, drawing.length)) {
    if (dg.type !== ET.DG) continue;
    for (const rec of records(dv, dg.start, dg.start + dg.len)) if (rec.type === ET.SPGR_C) walk(rec, null, true);
  }
  if (!pictures.length) return null;
  // 그림 하나를 못 읽어도 나머지는 보인다. 바이트는 저장소 전체가 아닌 그 그림만 복사해 넘긴다.
  const media = await Promise.all(blipList.map((b) => (b.mime === 'image/tiff' ? null : toMedia(b.data.slice()).catch(() => null))));
  return { pictures: pictures.filter((p) => media[p.media]), media };
}

function childBox(r, ctx) {
  const { coord, box } = ctx;
  if (!r || !coord || coord.w <= 0 || coord.h <= 0) return null;
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  return [
    box[0] + ((r.x - coord.x) / coord.w) * w,
    box[1] + ((r.y - coord.y) / coord.h) * h,
    box[0] + ((r.x + r.w - coord.x) / coord.w) * w,
    box[1] + ((r.y + r.h - coord.y) / coord.h) * h,
  ];
}
