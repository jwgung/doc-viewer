// xls(BIFF8) 그림. ppt와 같은 OfficeArt(Escher) 구조다.
// 전역 부분의 MSODRAWINGGROUP에 그림 저장소(BStore)가, 시트의 MSODRAWING에 도형 트리가 조각나 들어 있다.
// 그림(pib 속성이 있는 도형)만 읽고, 위치는 셀 앵커(열·행 + 칸 너비·높이에 대한 비율)로 넘긴다.
// 붙여 넣은 개체(OLE)도 엑셀처럼 미리보기 그림을 보인다. 차트는 xls-chart.js가 옮겨 적은 XML로 넘긴다.
// 도형·글상자는 OfficeArt 속성(모양·채우기·선·화살촉)과 TXO 글자를 xlsx 도형 XML(xdr:sp)로 옮겨 적어 같은 렌더러로 그린다.
import { MSO_SHAPE, blipsFromStore, parseOpt } from '@web-ppt/core/escher';
import { toMedia } from './media.js';

const ET = {
  DGG: 0xf000, BSTORE: 0xf001, DG: 0xf002, SPGR_C: 0xf003, SP_C: 0xf004,
  SPGR: 0xf009, SP: 0xf00a, OPT: 0xf00b, CHILD_ANCHOR: 0xf00f, CLIENT_ANCHOR: 0xf010, CLIENT_DATA: 0xf011, TOPT: 0xf122,
};
const PROP = {
  rot: 0x0004, cropTop: 0x0100, cropBottom: 0x0101, cropLeft: 0x0102, cropRight: 0x0103, pib: 0x0104, groupBools: 0x03bf,
  fillColor: 0x0181, fillOpacity: 0x0182, fillBools: 0x01bf, lineColor: 0x01c0, lineWidth: 0x01cb, lineDashing: 0x01ce,
  lineStartArrow: 0x01d0, lineEndArrow: 0x01d1, lineBools: 0x01ff,
};
// 도형으로 그리는 OBJ 종류: 선, 사각형, 타원, 호, 글상자, 다각형, 그리기 개체(자동 도형). 메모·양식 컨트롤은 그리지 않는다.
const SHAPE_OBJECTS = new Set([0x01, 0x02, 0x03, 0x04, 0x06, 0x09, 0x1e]);
const DASHES = ['solid', 'sysDash', 'sysDot', 'sysDashDot', 'sysDashDotDot', 'dot', 'dash', 'lgDash', 'dashDot', 'lgDashDot', 'lgDashDotDot'];
const ARROWS = [null, 'triangle', 'stealth', 'diamond', 'oval', 'arrow'];
const H_ALIGN = { 1: 'l', 2: 'ctr', 3: 'r', 4: 'just', 7: 'dist' };
const V_ALIGN = { 1: 't', 2: 'ctr', 3: 'b', 4: 'ctr', 7: 'ctr' };
const EMU = 9525;
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** OfficeArtCOLORREF → RRGGBB. 색상표 번호(엑셀은 fSchemeIndex로 적는다)·RGB를 읽고, 시스템 색은 fallback */
function colorRef(value, palette, fallback) {
  if (value === undefined) return fallback;
  const flags = value >>> 24;
  if (flags & 0x10) return fallback; // 시스템 색
  if (flags & 0x09) {
    const index = value & 0xff;
    if (index === 0x40) return '000000'; // 기본 글자색
    if (index === 0x41) return 'FFFFFF'; // 기본 바탕색
    return (palette[index] ?? fallback).replace('#', '').toUpperCase();
  }
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** 불리언 묶음 속성의 한 비트: 정해 둔 값이면 true/false, 아니면 dflt (위 16비트가 '정했음' 표시) */
const bool = (value, bit, dflt) => (value !== undefined && value & (bit << 16) ? Boolean(value & bit) : dflt);

/** xls 도형 하나 → xlsx 도형 XML(<anchor><xdr:sp>…). 크기는 화면 px(앵커를 열 너비·행 높이로 잰 값) */
function shapeXml(spType, flags, props, obj, size, env) {
  // 자유형(0)처럼 모양 표가 없는 도형은 글자가 있을 때만 사각형 글상자로 보인다.
  const prst = MSO_SHAPE[spType] ?? (obj?.text?.text ? 'rect' : null);
  if (!prst) return null;
  const line = prst === 'line' || prst.endsWith('Connector1') || /Connector[2-5]$/.test(prst);
  const rot = fixedDeg(props.get(PROP.rot) ?? 0);
  const xfrm = `<a:xfrm${rot ? ` rot="${Math.round(rot * 60000)}"` : ''}${flags & SP_FLAG.FLIPH ? ' flipH="1"' : ''}${flags & SP_FLAG.FLIPV ? ' flipV="1"' : ''}>`
    + `<a:off x="0" y="0"/><a:ext cx="${Math.round(size.w * EMU)}" cy="${Math.round(size.h * EMU)}"/></a:xfrm>`;
  const filled = !line && bool(props.get(PROP.fillBools), 0x10, true);
  const opacity = props.get(PROP.fillOpacity);
  const fill = filled
    ? `<a:solidFill><a:srgbClr val="${colorRef(props.get(PROP.fillColor), env.palette, 'FFFFFF')}">${opacity !== undefined && opacity < 65536 ? `<a:alpha val="${Math.round((opacity / 65536) * 100000)}"/>` : ''}</a:srgbClr></a:solidFill>`
    : '<a:noFill/>';
  const stroked = bool(props.get(PROP.lineBools), 0x08, true);
  let ln = '<a:ln><a:noFill/></a:ln>';
  if (stroked) {
    const head = ARROWS[props.get(PROP.lineStartArrow) ?? 0];
    const tail = ARROWS[props.get(PROP.lineEndArrow) ?? 0];
    const dash = DASHES[props.get(PROP.lineDashing) ?? 0] ?? 'solid';
    ln = `<a:ln w="${props.get(PROP.lineWidth) ?? EMU}"><a:solidFill><a:srgbClr val="${colorRef(props.get(PROP.lineColor), env.palette, '000000')}"/></a:solidFill>`
      + `${dash !== 'solid' ? `<a:prstDash val="${dash}"/>` : ''}${head ? `<a:headEnd type="${head}"/>` : ''}${tail ? `<a:tailEnd type="${tail}"/>` : ''}</a:ln>`;
  }
  let text = '';
  if (obj?.text?.text) {
    const { runs, h, v } = obj.text;
    const value = obj.text.text;
    // 서식 묶음을 글자 위치로 나눠 run을 만들고, 줄바꿈마다 문단을 나눈다.
    const marks = runs.length ? runs : [{ at: 0, font: 0 }];
    const pieces = marks.map((r, i) => ({ text: value.slice(r.at, marks[i + 1]?.at ?? value.length), font: env.font(r.font) }));
    if (marks[0].at > 0) pieces.unshift({ text: value.slice(0, marks[0].at), font: env.font(0) });
    const rPr = (f) => {
      if (!f) return '<a:rPr lang="ko-KR"/>';
      return `<a:rPr lang="ko-KR" sz="${Math.round(f.size * 100)}"${f.bold ? ' b="1"' : ''}${f.italic ? ' i="1"' : ''}${f.underline ? ' u="sng"' : ''}>`
        + `${f.color ? `<a:solidFill><a:srgbClr val="${f.color.replace('#', '').toUpperCase()}"/></a:solidFill>` : ''}<a:latin typeface="${esc(f.name)}"/><a:ea typeface="${esc(f.name)}"/></a:rPr>`;
    };
    const paras = [[]];
    for (const piece of pieces) {
      piece.text.split('\n').forEach((part, i) => {
        if (i > 0) paras.push([]);
        if (part) paras[paras.length - 1].push(`<a:r>${rPr(piece.font)}<a:t>${esc(part)}</a:t></a:r>`);
      });
    }
    const algn = H_ALIGN[h] ?? 'l';
    text = `<xdr:txBody><a:bodyPr wrap="square" anchor="${V_ALIGN[v] ?? 't'}" lIns="91440" tIns="45720" rIns="91440" bIns="45720"/><a:lstStyle/>`
      + paras.map((runsXml) => `<a:p><a:pPr algn="${algn}"/>${runsXml.join('') || `<a:endParaRPr lang="ko-KR"/>`}</a:p>`).join('')
      + '</xdr:txBody>';
  }
  return `<anchor><xdr:sp><xdr:nvSpPr><xdr:cNvPr id="1" name=""/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr>${xfrm}<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${fill}${ln}</xdr:spPr>${text}</xdr:sp></anchor>`;
}

const fixedDeg = (v) => (v | 0) / 65536;
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
 * group: 전역 MSODRAWINGGROUP 바이트(없으면 null), drawing: 시트 MSODRAWING 바이트(이어 붙인 것).
 * objects: 시트의 OBJ 순서({ ot, chart }), chartXml(범위) → 차트 XML. 차트 개체(ot=5)는 그 자리에 차트를 놓는다.
 * { pictures, media }(xlsx와 같은 모양, 앵커는 frac) 또는 null
 */
export async function readXlsPictures(group, drawing, { objects = [], chartXml = null, shapes = null } = {}) {
  let blips = [];
  if (group) {
    const gdv = new DataView(group.buffer, group.byteOffset, group.byteLength);
    const dgg = [...records(gdv, 0, group.length)].find((r) => r.type === ET.DGG);
    const bstore = dgg && find(gdv, dgg, ET.BSTORE);
    if (bstore) blips = blipsFromStore(group, bstore, null) ?? [];
  }

  const dv = new DataView(drawing.buffer, drawing.byteOffset, drawing.byteLength);
  const pictures = [];
  const mediaOf = new Map(); // BStore 번호 → media 번호
  const mediaList = []; // { blip } | { chart: XML }

  // 도형마다 따라오는 OBJ 레코드는 도형 트리에서 ClientData를 가진 도형 순서(앞쪽 우선)와 같다.
  const objectAt = new Map(); // SpContainer 위치 → OBJ 번호
  const number = (container) => {
    for (const rec of records(dv, container.start, container.start + container.len)) {
      if (rec.type === ET.SP_C) {
        if (find(dv, rec, ET.CLIENT_DATA)) objectAt.set(rec.start, objectAt.size);
      } else if (rec.type === ET.SPGR_C) number(rec);
    }
  };

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
    const props = optRec ? parseOpt(dv, optRec).simple : new Map();
    const tertiary = find(dv, sp, ET.TOPT);
    if (tertiary) for (const [k, v] of parseOpt(dv, tertiary).simple) if (!props.has(k)) props.set(k, v);
    const obj = objects[objectAt.get(sp.start)];
    const chart = obj?.chart && chartXml ? obj.chart : null;
    const pib = props.get(PROP.pib);
    const picture = Boolean(pib && blips[pib - 1]);
    const drawn = !chart && !picture && shapes && SHAPE_OBJECTS.has(obj?.ot);
    if ((!chart && !picture && !drawn) || isHidden(sp)) return;
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
    if (drawn) {
      // 크기(px): 그룹 안이면 그룹 앵커 상자에 대한 비율만큼
      const whole = shapes.boxPx(anchor.from, anchor.to);
      const size = { w: whole.w * (box[2] - box[0]), h: whole.h * (box[3] - box[1]) };
      let xml = null;
      try {
        xml = shapeXml(dv.getUint16(spRec.start - 8, true) >> 4, flags, props, obj, size, shapes);
      } catch (error) {
        console.warn('[sheet] shape skipped', error);
      }
      if (!xml) return;
      pictures.push({ from: anchor.from, to: anchor.to, frac: true, size: null, pos: null, box, media: mediaList.length, crop: null, rot: 0, flipH: false, flipV: false, shapes: true });
      mediaList.push({ shapes: xml });
      return;
    }
    if (chart) {
      let xml = null;
      try {
        xml = chartXml(chart);
      } catch (error) {
        console.warn('[sheet] chart skipped', error);
      }
      if (!xml) return;
      // 앵커 높이나 너비가 0인 차트는 엑셀에서도 보이지 않는다(크기를 0으로 줄여 숨긴 것). 화면 쪽에서 크기 0이면 숨긴다.
      pictures.push({ from: anchor.from, to: anchor.to, frac: true, size: null, pos: null, box, media: mediaList.length, crop: null, rot: 0, flipH: false, flipV: false });
      mediaList.push({ chart: xml });
      return;
    }
    let media = mediaOf.get(pib);
    if (media === undefined) {
      media = mediaList.length;
      mediaOf.set(pib, media);
      mediaList.push({ blip: blips[pib - 1] });
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
    for (const rec of records(dv, dg.start, dg.start + dg.len)) {
      if (rec.type !== ET.SPGR_C) continue;
      number(rec);
      walk(rec, null, true);
    }
  }
  if (!pictures.length) return null;
  // 그림 하나를 못 읽어도 나머지는 보인다. 바이트는 저장소 전체가 아닌 그 그림만 복사해 넘긴다.
  const media = await Promise.all(
    mediaList.map(({ blip, chart, shapes: shapeXmlText }) => {
      if (chart) return { type: 'chart', xml: chart, theme: null };
      if (shapeXmlText) return { type: 'shapes', xml: shapeXmlText, theme: null };
      return blip.mime === 'image/tiff' ? null : toMedia(blip.data.slice()).catch(() => null);
    }),
  );
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
