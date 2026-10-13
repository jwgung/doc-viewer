// xls(BIFF8) 차트 하위 스트림 → DrawingML 차트 XML(c:chartSpace).
// 그리기는 xlsx 차트와 같은 길(web-ppt chartToSvg)을 쓰려고, 구형 차트 레코드를 읽어 xlsx 차트 XML로 옮겨 적는다.
// 값은 차트에 저장된 캐시(SIIndex 뒤 NUMBER·LABEL)를 먼저 쓰고, 없으면 계열이 가리키는 시트 칸에서 읽는다.
// 읽는 것: 차트 종류(막대·꺾은선·원형·영역·분산·방사·거품), 쌓기, 계열 이름·색·표식·값 표시, 제목·축 제목, 범례 위치,
// 축 최소·최대·눈금선, 차트·그림 영역 채우기. 글꼴·숫자 서식·3차원 회전은 아직 읽지 않는다.

const RT = {
  CHART: 0x1002, SERIES: 0x1003, DATAFORMAT: 0x1006, LINEFORMAT: 0x1007, MARKERFORMAT: 0x1009, AREAFORMAT: 0x100a,
  ATTACHEDLABEL: 0x100c, SERIESTEXT: 0x100d, CHARTFORMAT: 0x1014, LEGEND: 0x1015, BAR: 0x1017, LINE: 0x1018,
  PIE: 0x1019, AREA: 0x101a, SCATTER: 0x101b, AXIS: 0x101d, VALUERANGE: 0x101f, AXISLINE: 0x1021, TEXT: 0x1025,
  OBJECTLINK: 0x1027, FRAME: 0x1032, BEGIN: 0x1033, END: 0x1034, PLOTAREA: 0x1035, CHART3D: 0x103a, RADAR: 0x103e,
  SURF: 0x103f, RADARAREA: 0x1040, AXISPARENT: 0x1041, SERTOCRT: 0x1045, BRAI: 0x1051, BOPPOP: 0x1061, SIINDEX: 0x1065,
  SERPARENT: 0x104a, NUMBER: 0x0203, LABEL: 0x0204, BOF: 0x0809, EOF: 0x000a,
};
const MARKERS = ['none', 'square', 'diamond', 'triangle', 'x', 'star', 'dash', 'dash', 'circle', 'plus'];
const LEGEND_POS = { 0: 'b', 1: 'tr', 2: 't', 3: 'r', 4: 'l' };
const MAX_POINTS = 10000;
const utf16 = new TextDecoder('utf-16le');

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const hex = (b, at) => ((b[at] << 16) | (b[at + 1] << 8) | b[at + 2]).toString(16).padStart(6, '0').toUpperCase();

/** XLUnicodeStringNoCch(플래그 1바이트 + 글자) */
function chars(b, at, cch, end) {
  const high = b[at] & 1;
  const from = at + 1;
  const to = Math.min(end, from + cch * (high ? 2 : 1));
  if (high) return utf16.decode(b.subarray(from, to));
  let out = '';
  for (let i = from; i < to; i++) out += String.fromCharCode(b[i]);
  return out;
}

/** 수식(rgce)의 첫 3차원 참조: { ixti, r1, c1, r2, c2 } 또는 null */
function ref3d(dv, at, cce) {
  if (cce < 7) return null;
  const ptg = dv.getUint8(at);
  const base = ptg & 0x1f | 0x20; // 0x3A·0x5A·0x7A → 0x3A
  if (base === 0x3b && cce >= 11) {
    return { ixti: dv.getUint16(at + 1, true), r1: dv.getUint16(at + 3, true), r2: dv.getUint16(at + 5, true), c1: dv.getUint16(at + 7, true) & 0x3fff, c2: dv.getUint16(at + 9, true) & 0x3fff };
  }
  if (base === 0x3a) {
    const r = dv.getUint16(at + 3, true);
    const c = dv.getUint16(at + 5, true) & 0x3fff;
    return { ixti: dv.getUint16(at + 1, true), r1: r, r2: r, c1: c, c2: c };
  }
  return null;
}

function areaOf(dv, b, at) {
  const flags = dv.getUint16(at + 10, true);
  return { color: hex(b, at), none: dv.getUint16(at + 8, true) === 0, auto: Boolean(flags & 1) };
}

function lineOf(dv, b, at) {
  const flags = dv.getUint16(at + 8, true);
  const we = dv.getInt16(at + 6, true);
  return { color: hex(b, at), none: dv.getUint16(at + 4, true) === 5, auto: Boolean(flags & 1), width: we < 0 ? 0.25 : [0.75, 1.5, 2.25][we] ?? 0.75 };
}

/** 차트 레코드를 읽어 중간 모델로 */
function parse(b, start, end) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const chart = { w: 0, h: 0, series: [], groups: [], axes: [], title: null, legend: null, area: null, areaLine: null, plot: null, plotLine: null };
  const stack = [];
  let last = 0;
  let depth = 0;
  let parent = { iax: 0 };
  let series = null;
  let dataFormat = null;
  let text = null;
  let axis = null;
  let group = null;
  let frame = null;
  let plotNext = false;
  let siIndex = 0;
  const top = () => stack[stack.length - 1];
  for (let pos = start; pos + 4 <= end; ) {
    const type = dv.getUint16(pos, true);
    const size = dv.getUint16(pos + 2, true);
    const at = pos + 4;
    pos = at + size;
    if (pos > end) break;
    if (type === RT.BOF) depth++;
    else if (type === RT.EOF && --depth <= 0) break;
    if (depth !== 1) continue; // 차트 안에 든 다른 하위 스트림은 없지만 안전하게
    if (type === RT.BEGIN) {
      stack.push(last);
      continue;
    }
    if (type === RT.END) {
      const closed = stack.pop();
      if (closed === RT.SERIES) series = null;
      else if (closed === RT.DATAFORMAT) dataFormat = null;
      else if (closed === RT.AXIS) axis = null;
      else if (closed === RT.CHARTFORMAT) group = null;
      else if (closed === RT.FRAME) frame = null;
      else if (closed === RT.TEXT && text) {
        if (text.link === 1 && text.value) chart.title = text.value;
        else if ((text.link === 2 || text.link === 3 || text.link === 7) && text.value) {
          chart.axisTitles ??= {};
          chart.axisTitles[`${parent.iax}:${text.link}`] = text.value;
        }
        text = null;
      }
      continue;
    }
    last = type;
    switch (type) {
      case RT.CHART:
        chart.w = dv.getInt32(at + 8, true) / 65536;
        chart.h = dv.getInt32(at + 12, true) / 65536;
        break;
      case RT.SERIES:
        series = { index: chart.series.length, name: null, nameRef: null, valRef: null, catRef: null, sizeRef: null, vals: [], cats: [], sizes: [], group: 0, fill: null, line: null, marker: null, labels: null, points: new Map() };
        chart.series.push(series);
        break;
      case RT.BRAI: {
        const id = b[at];
        const rt = b[at + 1];
        const cce = dv.getUint16(at + 6, true);
        const ref = rt === 2 ? ref3d(dv, at + 8, cce) : null;
        if (top() === RT.SERIES && series) {
          if (id === 0) series.nameRef = ref;
          else if (id === 1) series.valRef = ref;
          else if (id === 2) series.catRef = ref;
          else if (id === 3) series.sizeRef = ref;
        } else if (top() === RT.TEXT && text && id === 0 && ref) text.ref = ref;
        break;
      }
      case RT.SERIESTEXT: {
        const value = chars(b, at + 3, b[at + 2], at + size);
        if (top() === RT.SERIES && series) series.name = value;
        else if (top() === RT.TEXT && text) text.value = value;
        break;
      }
      case RT.TEXT:
        text = { link: 0, value: null, ref: null };
        break;
      case RT.OBJECTLINK:
        if (text) text.link = dv.getUint16(at, true);
        break;
      case RT.DATAFORMAT:
        if (top() === RT.SERIES && series) dataFormat = { xi: dv.getUint16(at, true), series };
        break;
      case RT.SERTOCRT:
        if (series) series.group = dv.getUint16(at, true);
        break;
      case RT.SERPARENT: // 추세선·오차 막대도 SERIES로 저장되고 SERTOCRT 대신 SERPARENT를 가진다. 데이터 계열이 아니다.
        if (series) series.derived = true;
        break;
      case RT.AREAFORMAT: {
        const area = areaOf(dv, b, at);
        if (dataFormat) {
          if (dataFormat.xi === 0xffff) dataFormat.series.fill = area;
          else dataFormat.series.points.set(dataFormat.xi, { ...dataFormat.series.points.get(dataFormat.xi), fill: area });
        } else if (frame) chart[frame] = area;
        break;
      }
      case RT.LINEFORMAT: {
        const line = lineOf(dv, b, at);
        if (dataFormat) {
          if (dataFormat.xi === 0xffff) dataFormat.series.line = line;
        } else if (frame) chart[`${frame}Line`] = line;
        else if (axis?.gridNext) {
          axis.grid = line.none ? null : line;
          axis.gridNext = false;
        }
        break;
      }
      case RT.MARKERFORMAT:
        if (dataFormat?.xi === 0xffff) {
          const flags = dv.getUint16(at + 10, true);
          dataFormat.series.marker = { auto: Boolean(flags & 1), symbol: MARKERS[dv.getUint16(at + 8, true)] ?? 'none', fg: hex(b, at), bg: hex(b, at + 4), size: Math.max(2, Math.round(dv.getUint32(at + 16, true) / 20)), noFill: Boolean(flags & 0x10), noLine: Boolean(flags & 0x20) };
        }
        break;
      case RT.ATTACHEDLABEL:
        if (dataFormat?.xi === 0xffff) {
          const f = dv.getUint16(at, true);
          dataFormat.series.labels = { val: Boolean(f & 1), pct: Boolean(f & 2) || Boolean(f & 4), cat: Boolean(f & 0x10) || Boolean(f & 4), ser: Boolean(f & 0x40) };
        }
        break;
      case RT.FRAME:
        frame = plotNext ? 'plot' : stack.length === 1 && stack[0] === RT.CHART ? 'area' : null;
        plotNext = false;
        break;
      case RT.PLOTAREA:
        plotNext = true;
        break;
      case RT.AXISPARENT:
        parent = { iax: dv.getUint16(at, true) };
        break;
      case RT.AXIS:
        axis = { iax: parent.iax, type: dv.getUint16(at, true), min: null, max: null, major: null, grid: null, gridNext: false, reversed: false, log: false };
        chart.axes.push(axis);
        break;
      case RT.VALUERANGE:
        if (axis) {
          const f = dv.getUint16(at + 40, true);
          if (!(f & 1)) axis.min = dv.getFloat64(at, true);
          if (!(f & 2)) axis.max = dv.getFloat64(at + 8, true);
          if (!(f & 4)) axis.major = dv.getFloat64(at + 16, true);
          axis.log = Boolean(f & 0x20);
          axis.reversed = Boolean(f & 0x40);
        }
        break;
      case RT.AXISLINE:
        if (axis) axis.gridNext = dv.getUint16(at, true) === 1;
        break;
      case RT.CHARTFORMAT:
        group = { iax: parent.iax, kind: null, varied: Boolean(dv.getUint16(at + 16, true) & 1), is3D: false };
        chart.groups.push(group);
        break;
      case RT.BAR:
        if (group) {
          const f = dv.getUint16(at + 4, true);
          Object.assign(group, { kind: 'bar', overlap: -dv.getInt16(at, true), gap: dv.getUint16(at + 2, true), horizontal: Boolean(f & 1), stacked: Boolean(f & 2), pct: Boolean(f & 4) });
        }
        break;
      case RT.LINE:
      case RT.AREA:
        if (group) {
          const f = dv.getUint16(at, true);
          Object.assign(group, { kind: type === RT.LINE ? 'line' : 'area', stacked: Boolean(f & 1), pct: Boolean(f & 2) });
        }
        break;
      case RT.PIE:
        if (group) Object.assign(group, { kind: 'pie', start: dv.getUint16(at, true), hole: dv.getUint16(at + 2, true) });
        break;
      case RT.BOPPOP:
        if (group) Object.assign(group, { kind: 'pie', start: 0, hole: 0 });
        break;
      case RT.SCATTER:
        if (group) Object.assign(group, { kind: size >= 6 && dv.getUint16(at + 4, true) & 1 ? 'bubble' : 'scatter' });
        break;
      case RT.RADAR:
      case RT.RADARAREA:
        if (group) Object.assign(group, { kind: 'radar', filled: type === RT.RADARAREA });
        break;
      case RT.SURF:
        if (group) Object.assign(group, { kind: 'surface' });
        break;
      case RT.CHART3D:
        if (group) group.is3D = true;
        break;
      case RT.LEGEND:
        chart.legend = LEGEND_POS[b[at + 16]] ?? 'r';
        break;
      case RT.SIINDEX:
        siIndex = dv.getUint16(at, true);
        break;
      case RT.NUMBER:
      case RT.LABEL: {
        if (stack.length) break;
        const row = dv.getUint16(at, true);
        const col = dv.getUint16(at + 2, true);
        const s = chart.series[col];
        if (!s || row >= MAX_POINTS) break;
        const value = type === RT.NUMBER ? dv.getFloat64(at + 6, true) : chars(b, at + 8, dv.getUint16(at + 6, true), at + size);
        const list = siIndex === 1 ? s.vals : siIndex === 2 ? s.cats : siIndex === 3 ? s.sizes : null;
        if (list) list[row] = value;
        break;
      }
      default:
        break;
    }
  }
  return chart;
}

/**
 * stream[start, end): 차트 하위 스트림(BOF~EOF). env: { palette(hex 64개), cells(ixti, r1, c1, r2, c2) → [{ num, text } | null] }
 * 그릴 것이 없으면 null
 */
export function biffChartXml(stream, start, end, env) {
  const chart = parse(stream, start, end);
  const groups = chart.groups;
  if (!groups.some((g) => g.kind) || !chart.series.length) return null;
  const palette = env.palette;
  const color = (i) => palette[i % 64] ?? '000000';
  const cells = (ref) => (ref ? env.cells(ref) ?? [] : []);

  // 값: 캐시가 비었으면 참조 칸에서
  for (const s of chart.series) {
    if (!s.vals.some((v) => v !== undefined) && s.valRef) s.vals = cells(s.valRef).map((v) => (v && Number.isFinite(v.num) ? v.num : undefined));
    // 항목 캐시가 숫자(날짜 등)면 서식 없는 일련번호라, 가리키는 칸의 표시 문자열을 쓴다.
    const xy = ['scatter', 'bubble'].includes(groups[s.group]?.kind ?? groups[0]?.kind);
    if (xy) {
      if (!s.cats.some((v) => v !== undefined) && s.catRef) s.cats = cells(s.catRef).map((v) => (v && Number.isFinite(v.num) ? v.num : undefined));
    } else if ((!s.cats.some((v) => v !== undefined) || s.cats.some((v) => typeof v === 'number')) && s.catRef) {
      const texts = cells(s.catRef).map((v) => v?.text ?? '');
      if (texts.some(Boolean)) s.cats = texts;
    }
    if (!s.sizes.some((v) => v !== undefined) && s.sizeRef) s.sizes = cells(s.sizeRef).map((v) => (v && Number.isFinite(v.num) ? v.num : undefined));
    if (s.name == null && s.nameRef) s.name = cells(s.nameRef)[0]?.text ?? null;
  }

  const fillXml = (f, autoColor) => {
    if (f && !f.auto) return f.none ? '<a:noFill/>' : `<a:solidFill><a:srgbClr val="${f.color}"/></a:solidFill>`;
    return autoColor ? `<a:solidFill><a:srgbClr val="${autoColor}"/></a:solidFill>` : '';
  };
  const lnXml = (l, autoColor, width = 0.75) => {
    if (l && !l.auto) return l.none ? '<a:ln><a:noFill/></a:ln>' : `<a:ln w="${Math.round(l.width * 12700)}"><a:solidFill><a:srgbClr val="${l.color}"/></a:solidFill></a:ln>`;
    return autoColor ? `<a:ln w="${Math.round(width * 12700)}"><a:solidFill><a:srgbClr val="${autoColor}"/></a:solidFill></a:ln>` : '';
  };
  const numCache = (vals) => {
    const n = Math.min(MAX_POINTS, vals.length);
    let pts = '';
    for (let i = 0; i < n; i++) if (Number.isFinite(vals[i])) pts += `<c:pt idx="${i}"><c:v>${vals[i]}</c:v></c:pt>`;
    return `<c:numRef><c:f></c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${n}"/>${pts}</c:numCache></c:numRef>`;
  };
  const strCache = (vals) => {
    const n = Math.min(MAX_POINTS, vals.length);
    let pts = '';
    for (let i = 0; i < n; i++) if (vals[i] != null && vals[i] !== '') pts += `<c:pt idx="${i}"><c:v>${esc(vals[i])}</c:v></c:pt>`;
    return `<c:strRef><c:f></c:f><c:strCache><c:ptCount val="${n}"/>${pts}</c:strCache></c:strRef>`;
  };
  const rich = (t) => `<c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p></c:rich></c:tx>`;

  let axId = 1;
  let plot = '';
  let axesXml = '';
  groups.forEach((g, gi) => {
    if (!g.kind) return;
    const members = chart.series.filter((s) => !s.derived && ((s.group ?? 0) === gi || (gi === 0 && s.group >= groups.length)));
    if (!members.length) return;
    const pie = g.kind === 'pie';
    const lineLike = g.kind === 'line' || g.kind === 'scatter' || (g.kind === 'radar' && !g.filled);
    const xy = g.kind === 'scatter' || g.kind === 'bubble';
    const grouping = g.pct ? 'percentStacked' : g.stacked ? 'stacked' : g.kind === 'bar' ? 'clustered' : 'standard';
    let ser = '';
    for (const s of members) {
      const k = chart.series.indexOf(s);
      // 자동 색: 엑셀 97 차트 색상표(채우기 24~31, 선 32~39)
      const autoFill = color(24 + (k % 8));
      const autoLine = color(32 + (k % 8));
      let sp = '';
      if (lineLike) sp = `<c:spPr>${lnXml(s.line, autoLine, 2.25)}</c:spPr>`;
      else if (!pie) sp = `<c:spPr>${fillXml(s.fill, autoFill)}${lnXml(s.line, null)}</c:spPr>`;
      let dpts = '';
      if (pie || g.varied) {
        const n = Math.max(s.vals.length, s.cats.length);
        for (let i = 0; i < Math.min(n, 255); i++) {
          const own = s.points.get(i)?.fill;
          dpts += `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr>${fillXml(own, color(24 + (i % 8)))}${lnXml(null, null)}</c:spPr></c:dPt>`;
        }
      } else {
        for (const [i, p] of s.points) if (p.fill && !p.fill.auto) dpts += `<c:dPt><c:idx val="${i}"/><c:spPr>${fillXml(p.fill)}</c:spPr></c:dPt>`;
      }
      let marker = '';
      if (lineLike) {
        const m = s.marker;
        if (m && !m.auto) {
          marker = m.symbol === 'none'
            ? '<c:marker><c:symbol val="none"/></c:marker>'
            : `<c:marker><c:symbol val="${m.symbol}"/><c:size val="${m.size}"/><c:spPr>${m.noFill ? '<a:noFill/>' : `<a:solidFill><a:srgbClr val="${m.bg}"/></a:solidFill>`}${m.noLine ? '<a:ln><a:noFill/></a:ln>' : `<a:ln><a:solidFill><a:srgbClr val="${m.fg}"/></a:solidFill></a:ln>`}</c:spPr></c:marker>`;
        } else if (g.kind !== 'radar') marker = `<c:marker><c:symbol val="${['diamond', 'square', 'triangle', 'x', 'star', 'circle', 'plus', 'dash'][k % 8]}"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="${autoLine}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="${autoLine}"/></a:solidFill></a:ln></c:spPr></c:marker>`;
      }
      const l = s.labels;
      const labels = l && (l.val || l.pct || l.cat || l.ser)
        ? `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="${l.val ? 1 : 0}"/><c:showCatName val="${l.cat ? 1 : 0}"/><c:showSerName val="${l.ser ? 1 : 0}"/><c:showPercent val="${l.pct ? 1 : 0}"/><c:showBubbleSize val="0"/></c:dLbls>`
        : '';
      const cats = s.cats.some((v) => v !== undefined && v !== '') ? s.cats : null;
      const data = xy
        ? `<c:xVal>${cats && cats.every((v) => v === undefined || typeof v === 'number') ? numCache(cats) : cats ? strCache(cats) : numCache(s.vals.map((_, i) => i + 1))}</c:xVal><c:yVal>${numCache(s.vals)}</c:yVal>${g.kind === 'bubble' ? `<c:bubbleSize>${numCache(s.sizes.length ? s.sizes : s.vals.map(() => 1))}</c:bubbleSize>` : ''}`
        : `${cats ? `<c:cat>${strCache(cats.map((v) => (v === undefined ? '' : String(v))))}</c:cat>` : ''}<c:val>${numCache(s.vals)}</c:val>`;
      ser += `<c:ser><c:idx val="${k}"/><c:order val="${k}"/>${s.name ? `<c:tx><c:v>${esc(s.name)}</c:v></c:tx>` : ''}${sp}${marker}${dpts}${labels}${data}${g.kind === 'line' || g.kind === 'scatter' ? '<c:smooth val="0"/>' : ''}</c:ser>`;
    }
    const ids = pie ? '' : `<c:axId val="${axId}"/><c:axId val="${axId + 1}"/>`;
    let body;
    if (g.kind === 'bar') {
      const tag = g.is3D ? 'bar3DChart' : 'barChart';
      body = `<c:${tag}><c:barDir val="${g.horizontal ? 'bar' : 'col'}"/><c:grouping val="${grouping}"/><c:varyColors val="${g.varied ? 1 : 0}"/>${ser}<c:gapWidth val="${g.gap}"/>${g.is3D ? '' : `<c:overlap val="${g.stacked || g.pct ? 100 : Math.max(-100, Math.min(100, g.overlap))}"/>`}${ids}</c:${tag}>`;
    } else if (g.kind === 'line') body = `<c:lineChart><c:grouping val="${grouping}"/><c:varyColors val="0"/>${ser}<c:marker val="1"/>${ids}</c:lineChart>`;
    else if (g.kind === 'area') body = `<c:areaChart><c:grouping val="${grouping}"/><c:varyColors val="0"/>${ser}${ids}</c:areaChart>`;
    else if (pie) {
      body = g.hole > 0
        ? `<c:doughnutChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="${g.start}"/><c:holeSize val="${g.hole}"/></c:doughnutChart>`
        : `<c:${g.is3D ? 'pie3DChart' : 'pieChart'}><c:varyColors val="1"/>${ser}${g.is3D ? '' : `<c:firstSliceAng val="${g.start}"/>`}</c:${g.is3D ? 'pie3DChart' : 'pieChart'}>`;
    } else if (g.kind === 'scatter') body = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${ser}${ids}</c:scatterChart>`;
    else if (g.kind === 'bubble') body = `<c:bubbleChart><c:varyColors val="0"/>${ser}${ids}</c:bubbleChart>`;
    else if (g.kind === 'radar') body = `<c:radarChart><c:radarStyle val="${g.filled ? 'filled' : 'marker'}"/><c:varyColors val="0"/>${ser}${ids}</c:radarChart>`;
    else body = `<c:surfaceChart>${ser}${ids}</c:surfaceChart>`;
    plot += body;

    if (!pie) {
      const axisOf = (type) => chart.axes.find((a) => a.iax === g.iax && a.type === type);
      const titleOf = (link) => chart.axisTitles?.[`${g.iax}:${link}`];
      const cat = axisOf(0);
      const val = axisOf(1);
      const secondary = g.iax === 1;
      const horizontal = g.kind === 'bar' && g.horizontal;
      const scaling = (a) => `<c:scaling>${a?.log ? '<c:logBase val="10"/>' : ''}<c:orientation val="${a?.reversed ? 'maxMin' : 'minMax'}"/>${a?.max != null ? `<c:max val="${a.max}"/>` : ''}${a?.min != null ? `<c:min val="${a.min}"/>` : ''}</c:scaling>`;
      const grid = (a) => (a?.grid ? `<c:majorGridlines><c:spPr>${lnXml(a.grid, null)}</c:spPr></c:majorGridlines>` : '');
      const title = (t) => (t ? `<c:title>${rich(t)}<c:overlay val="0"/></c:title>` : '');
      const catPos = horizontal ? (secondary ? 'r' : 'l') : secondary ? 't' : 'b';
      const valPos = horizontal ? (secondary ? 't' : 'b') : secondary ? 'r' : 'l';
      const catTag = xy ? 'valAx' : 'catAx';
      axesXml += `<c:${catTag}><c:axId val="${axId}"/>${scaling(cat)}<c:delete val="${cat ? 0 : 1}"/><c:axPos val="${catPos}"/>${grid(cat)}${title(titleOf(3))}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${axId + 1}"/><c:crosses val="autoZero"/>${xy ? '<c:crossBetween val="midCat"/>' : ''}</c:${catTag}>`;
      axesXml += `<c:valAx><c:axId val="${axId + 1}"/>${scaling(val)}<c:delete val="${val ? 0 : 1}"/><c:axPos val="${valPos}"/>${grid(val)}${title(titleOf(2))}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${axId}"/><c:crosses val="${secondary ? 'max' : 'autoZero'}"/><c:crossBetween val="${xy ? 'midCat' : 'between'}"/>${val?.major ? `<c:majorUnit val="${val.major}"/>` : ''}</c:valAx>`;
      axId += 2;
    }
  });
  if (!plot) return null;

  const frameSp = (fill, line) => {
    const f = fill && !fill.auto ? fillXml(fill) : '';
    const l = line && !line.auto ? lnXml(line, null) : '';
    return f || l ? `<c:spPr>${f}${l}</c:spPr>` : '';
  };
  return (
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<c:chart>' +
    (chart.title ? `<c:title>${rich(chart.title)}<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` : '<c:autoTitleDeleted val="1"/>') +
    `<c:plotArea><c:layout/>${plot}${axesXml}${frameSp(chart.plot, chart.plotLine)}</c:plotArea>` +
    (chart.legend ? `<c:legend><c:legendPos val="${chart.legend}"/><c:overlay val="0"/></c:legend>` : '') +
    '<c:plotVisOnly val="1"/></c:chart>' +
    // 차트 영역: 지정이 없으면 엑셀처럼 흰 바탕에 검은 테두리
    (frameSp(chart.area, chart.areaLine) || '<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></c:spPr>') +
    '</c:chartSpace>'
  );
}

/** 차트 하위 스트림의 차트 영역 크기(pt). 차트 시트를 그릴 크기에 쓴다. */
export function biffChartSize(stream, start, end) {
  const chart = parse(stream, start, end);
  return { w: chart.w, h: chart.h };
}
