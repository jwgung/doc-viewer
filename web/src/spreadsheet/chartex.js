// 엑셀 2016 이후의 새 차트(chartEx: xl/charts/chartExN.xml) → 독립 SVG 문자열.
// 폭포·깔때기·히스토그램·파레토·트리맵·선버스트·상자 수염을 그린다. 지도(regionMap)는 지도 데이터가 없어 그리지 않는다.
// 옛 차트(c:chartSpace)와 구조가 달라 슬라이드 차트 렌더러에 넘기지 않고 여기서 축·값 계산까지 직접 그린다.
// 값은 파일에 저장된 캐시(cx:lvl의 cx:pt)를 쓴다. 화면(메인 스레드)에서 DOMParser로 읽는다.

const DEFAULT_ACCENTS = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];
const FONT = "-apple-system, 'Segoe UI', Roboto, 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif";

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const r2 = (v) => Math.round(v * 100) / 100;
const kidsOf = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => (el ? [...el.children].find((c) => c.localName === name) ?? null : null);
const walk = (el, ...names) => names.reduce((node, name) => kid(node, name), el);
const num = (v) => (v == null || v === '' ? NaN : Number(v));

function accentsOf(themeXml) {
  const out = DEFAULT_ACCENTS.slice();
  if (!themeXml) return { accents: out, scheme: {} };
  const doc = new DOMParser().parseFromString(themeXml, 'application/xml');
  const scheme = {};
  const clr = doc.getElementsByTagNameNS('*', 'clrScheme')[0];
  for (const c of clr ? [...clr.children] : []) {
    const v = c.firstElementChild;
    if (!v) continue;
    scheme[c.localName] = v.getAttribute('val') && v.localName === 'srgbClr' ? v.getAttribute('val') : v.getAttribute('lastClr') ?? '000000';
  }
  for (let i = 0; i < 6; i++) if (scheme[`accent${i + 1}`]) out[i] = scheme[`accent${i + 1}`];
  return { accents: out, scheme };
}

/** spPr 안의 단색 채우기(srgbClr·schemeClr). 없으면 null */
function solidOf(spPr, scheme) {
  const fill = kid(spPr, 'solidFill');
  const c = fill?.firstElementChild;
  if (!c) return null;
  if (c.localName === 'srgbClr') return c.getAttribute('val');
  if (c.localName === 'schemeClr') {
    const name = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' }[c.getAttribute('val')] ?? c.getAttribute('val');
    return scheme[name] ?? null;
  }
  return null;
}

function textOf(tx) {
  if (!tx) return '';
  const v = walk(tx, 'txData', 'v');
  if (v) return v.textContent.trim();
  return [...tx.getElementsByTagNameNS('*', 't')].map((t) => t.textContent).join('').trim();
}

/** 차원(cx:strDim·cx:numDim)의 단계별 값. levels[0]이 가장 안쪽(잎) 단계다. */
function dimOf(dim) {
  return kidsOf(dim, 'lvl').map((lvl) => {
    const count = Number(lvl.getAttribute('ptCount')) || 0;
    const out = new Array(count).fill(undefined);
    for (const pt of kidsOf(lvl, 'pt')) {
      const i = Number(pt.getAttribute('idx'));
      if (i >= 0 && i < 100000) out[i] = pt.textContent;
    }
    return { values: out, format: lvl.getAttribute('formatCode') };
  });
}

function parse(xml, themeXml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  const { accents, scheme } = accentsOf(themeXml);
  const data = new Map();
  for (const d of kidsOf(kid(root, 'chartData'), 'data')) {
    const entry = { cats: [], vals: [], format: null };
    for (const dim of [...d.children]) {
      const type = dim.getAttribute('type');
      if (dim.localName === 'strDim' || (dim.localName === 'numDim' && type === 'cat')) entry.cats = dimOf(dim).map((l) => l.values);
      else if (dim.localName === 'numDim' && (type === 'val' || type === 'size')) {
        const [lvl] = dimOf(dim);
        entry.vals = (lvl?.values ?? []).map(num);
        entry.format = lvl?.format ?? null;
      }
    }
    data.set(d.getAttribute('id'), entry);
  }
  const chart = kid(root, 'chart');
  const series = kidsOf(walk(chart, 'plotArea', 'plotAreaRegion'), 'series').map((s, k) => {
    const layoutPr = kid(s, 'layoutPr');
    const binning = kid(layoutPr, 'binning');
    const visibility = kid(layoutPr, 'visibility');
    return {
      layout: s.getAttribute('layoutId'),
      hidden: s.getAttribute('hidden') === '1',
      owner: s.getAttribute('ownerIdx'),
      name: textOf(kid(s, 'tx')),
      data: data.get(walk(s, 'dataId')?.getAttribute('val')) ?? { cats: [], vals: [] },
      color: solidOf(kid(s, 'spPr'), scheme) ?? accents[k % 6],
      points: new Map(kidsOf(s, 'dataPt').map((p) => [Number(p.getAttribute('idx')), solidOf(kid(p, 'spPr'), scheme)])),
      labels: Boolean(kid(s, 'dataLabels')) && walk(s, 'dataLabels', 'visibility')?.getAttribute('value') !== '0',
      subtotals: new Set(kidsOf(walk(layoutPr, 'subtotals'), 'idx').map((i) => Number(i.getAttribute('val')))),
      binning: binning && {
        size: num(walk(binning, 'binSize')?.getAttribute('val')),
        count: num(walk(binning, 'binCount')?.getAttribute('val')),
        closedLeft: binning.getAttribute('intervalClosed') === 'l',
        under: num(binning.getAttribute('underflow')),
        over: num(binning.getAttribute('overflow')),
      },
      aggregation: Boolean(kid(layoutPr, 'aggregation')),
      showMean: visibility?.getAttribute('meanMarker') !== '0',
      showOutliers: visibility?.getAttribute('outliers') !== '0',
    };
  });
  return { title: textOf(walk(chart, 'title', 'tx')), series, accents };
}

// ---- 그리기 도구 -------------------------------------------------------------

function niceScale(lo, hi, target = 5) {
  let a = Number.isFinite(lo) ? lo : 0;
  let b = Number.isFinite(hi) ? hi : 1;
  if (a === b) b = a + 1;
  const raw = (b - a) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const min = Math.floor(a / step + 1e-9) * step;
  const max = Math.ceil(b / step - 1e-9) * step;
  const ticks = [];
  for (let v = min; v <= max + step / 2 && ticks.length < 50; v += step) ticks.push(Number(v.toPrecision(12)));
  return { min, max: max > min ? max : min + step, ticks };
}

const fmt = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(Number(v.toPrecision(6))));
const textWidth = (s, size) => [...String(s)].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.58), 0) * size;

function text(x, y, value, size, { anchor = 'middle', color = '#404040', weight = 'normal', baseline = 'middle' } = {}) {
  return `<text x="${r2(x)}" y="${r2(y)}" font-size="${r2(size)}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" dominant-baseline="${baseline}">${esc(value)}</text>`;
}

/** 제목·축이 있는 차트 틀. plot(x, y, w, h)를 돌려준다. */
function frame(W, H, { title, size, valueScale, cats, rightScale = null, rightFormat = (v) => `${v}%` }) {
  let out = '';
  let top = 8;
  if (title) {
    out += text(W / 2, 8 + size * 0.8, title, size * 1.3, { color: '#262626' });
    top += size * 2;
  }
  const leftW = Math.max(...valueScale.ticks.map((t) => textWidth(fmt(t), size))) + 10;
  const rightW = rightScale ? Math.max(...rightScale.ticks.map((t) => textWidth(rightFormat(t), size))) + 10 : 12;
  const bottomH = size * 2;
  const plot = { x: leftW, y: top, w: Math.max(10, W - leftW - rightW), h: Math.max(10, H - top - bottomH - 4) };
  const yOf = (v) => plot.y + plot.h - ((v - valueScale.min) / (valueScale.max - valueScale.min)) * plot.h;
  for (const t of valueScale.ticks) {
    const y = yOf(t);
    out += `<line x1="${r2(plot.x)}" y1="${r2(y)}" x2="${r2(plot.x + plot.w)}" y2="${r2(y)}" stroke="#d9d9d9" stroke-width="1"/>`;
    out += text(plot.x - 6, y, fmt(t), size, { anchor: 'end' });
  }
  if (rightScale) {
    for (const t of rightScale.ticks) {
      const y = plot.y + plot.h - ((t - rightScale.min) / (rightScale.max - rightScale.min)) * plot.h;
      out += text(plot.x + plot.w + 6, y, rightFormat(t), size, { anchor: 'start' });
    }
  }
  // 항목 이름: 칸보다 넓으면 몇 개씩 건너뛴다.
  const band = plot.w / Math.max(1, cats.length);
  const widest = Math.max(0, ...cats.map((c) => textWidth(c, size)));
  const skip = widest > band ? Math.ceil((widest + size) / band) : 1;
  cats.forEach((c, i) => {
    if (i % skip) return;
    out += text(plot.x + band * (i + 0.5), plot.y + plot.h + size, c, size);
  });
  return { out, plot, yOf, band };
}

function svg(W, H, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(W)}" height="${r2(H)}" viewBox="0 0 ${r2(W)} ${r2(H)}" font-family="${FONT}">`
    + `<rect width="100%" height="100%" fill="#ffffff" stroke="#d9d9d9"/>${body}</svg>`;
}

const catLabel = (series, i) => {
  const levels = series.data.cats;
  return levels.length ? levels[0][i] ?? '' : String(i + 1);
};

// ---- 종류별 ----------------------------------------------------------------

function waterfall(chart, s, W, H, size) {
  const vals = s.data.vals;
  const n = vals.length;
  const bars = [];
  let running = 0;
  for (let i = 0; i < n; i++) {
    const v = Number.isFinite(vals[i]) ? vals[i] : 0;
    if (s.subtotals.has(i)) {
      bars.push({ from: 0, to: v, kind: 'total' });
      running = v;
    } else {
      bars.push({ from: running, to: running + v, kind: v >= 0 ? 'up' : 'down' });
      running += v;
    }
  }
  const scale = niceScale(Math.min(0, ...bars.map((b) => Math.min(b.from, b.to))), Math.max(0, ...bars.map((b) => Math.max(b.from, b.to))));
  const cats = bars.map((_, i) => catLabel(s, i));
  const { out, plot, yOf, band } = frame(W, H, { title: chart.title, size, valueScale: scale, cats });
  const colors = { up: chart.accents[0], down: chart.accents[1], total: chart.accents[2] };
  let body = out;
  bars.forEach((b, i) => {
    const color = s.points.get(i) ?? colors[b.kind];
    const x = plot.x + band * i + band * 0.15;
    const y1 = yOf(Math.max(b.from, b.to));
    const y2 = yOf(Math.min(b.from, b.to));
    body += `<rect x="${r2(x)}" y="${r2(y1)}" width="${r2(band * 0.7)}" height="${r2(Math.max(1, y2 - y1))}" fill="#${color}"/>`;
    // 막대 사이 이음선
    if (i + 1 < n) body += `<line x1="${r2(x + band * 0.7)}" y1="${r2(yOf(b.to))}" x2="${r2(x + band)}" y2="${r2(yOf(b.to))}" stroke="#a6a6a6" stroke-width="1"/>`;
    if (s.labels) body += text(x + band * 0.35, y1 - size * 0.7, fmt(b.kind === 'total' ? b.to : b.to - b.from), size * 0.9);
  });
  return svg(W, H, body);
}

function funnel(chart, s, W, H, size) {
  const vals = s.data.vals.map((v) => (Number.isFinite(v) ? v : 0));
  const max = Math.max(1, ...vals);
  let body = '';
  let top = 8;
  if (chart.title) {
    body += text(W / 2, 8 + size * 0.8, chart.title, size * 1.3, { color: '#262626' });
    top += size * 2;
  }
  const labelW = Math.max(0, ...vals.map((_, i) => textWidth(catLabel(s, i), size))) + 12;
  const area = { x: labelW, w: Math.max(10, W - labelW - 8), y: top, h: Math.max(10, H - top - 8) };
  const rowH = area.h / Math.max(1, vals.length);
  vals.forEach((v, i) => {
    const w = (v / max) * area.w;
    const x = area.x + (area.w - w) / 2;
    const y = area.y + rowH * i + rowH * 0.1;
    body += `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(Math.max(1, w))}" height="${r2(rowH * 0.8)}" fill="#${s.points.get(i) ?? s.color}"/>`;
    body += text(area.x - 6, y + rowH * 0.4, catLabel(s, i), size, { anchor: 'end' });
    body += text(area.x + area.w / 2, y + rowH * 0.4, fmt(v), size, { color: '#ffffff' });
  });
  return svg(W, H, body);
}

function histogramBins(values, binning) {
  const vals = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!vals.length) return [];
  const lo = vals[0];
  const hi = vals[vals.length - 1];
  let width;
  if (binning?.size > 0) width = binning.size;
  else if (binning?.count > 0) width = (hi - lo) / binning.count || 1;
  else {
    // 엑셀 자동 구간: 스콧 규칙(3.5σ / n^(1/3))
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, vals.length - 1));
    width = (3.5 * sd) / Math.cbrt(vals.length) || 1;
  }
  const count = Math.min(200, Math.max(1, Math.ceil((hi - lo) / width) || 1));
  const bins = Array.from({ length: count }, (_, i) => ({ from: lo + width * i, to: lo + width * (i + 1), n: 0 }));
  for (const v of vals) {
    // 오른쪽 닫힘(엑셀 기본): (a, b], 첫 구간은 [a, b]
    let k = binning?.closedLeft ? Math.floor((v - lo) / width) : Math.ceil((v - lo) / width) - 1;
    k = Math.max(0, Math.min(count - 1, k));
    bins[k].n++;
  }
  const round = (v) => Number(v.toPrecision(4));
  return bins.map((b, i) => ({ label: binning?.closedLeft ? `[${round(b.from)}, ${round(b.to)})` : `${i ? '(' : '['}${round(b.from)}, ${round(b.to)}]`, value: b.n }));
}

function columns(chart, s, items, W, H, size, line = null) {
  const scale = niceScale(0, Math.max(1, ...items.map((b) => b.value)));
  const rightScale = line ? { min: 0, max: 100, ticks: [0, 20, 40, 60, 80, 100] } : null;
  const { out, plot, yOf, band } = frame(W, H, { title: chart.title, size, valueScale: scale, cats: items.map((b) => b.label), rightScale });
  let body = out;
  items.forEach((b, i) => {
    const x = plot.x + band * i + (line ? band * 0.1 : 1);
    const y = yOf(b.value);
    body += `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(Math.max(1, line ? band * 0.8 : band - 2))}" height="${r2(Math.max(0, plot.y + plot.h - y))}" fill="#${s.points.get(i) ?? s.color}"/>`;
    if (s.labels) body += text(x + band / 2, y - size * 0.7, fmt(b.value), size * 0.9);
  });
  if (line) {
    const pts = line.map((p, i) => `${r2(plot.x + band * (i + 0.5))},${r2(plot.y + plot.h - (p / 100) * plot.h)}`);
    body += `<polyline points="${pts.join(' ')}" fill="none" stroke="#${chart.accents[1]}" stroke-width="2"/>`;
    for (const p of pts) body += `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="2.5" fill="#${chart.accents[1]}"/>`;
  }
  return svg(W, H, body);
}

function pareto(chart, s, W, H, size) {
  // 같은 항목은 더하고, 큰 것부터 늘어놓고, 누적 비율 선을 겹친다.
  const sums = new Map();
  s.data.vals.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    const key = catLabel(s, i);
    sums.set(key, (sums.get(key) ?? 0) + v);
  });
  const items = [...sums].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  let acc = 0;
  const line = items.map((b) => ((acc += b.value) / total) * 100);
  return columns(chart, s, items, W, H, size, line);
}

/**
 * 계층 항목: 단계(바깥→안)별 이름 경로와 값. 표에서 위 행과 같은 상위 이름은 비워 두므로(병합하듯),
 * 빈 칸은 위 행의 이름을 이어받는다. 바깥 단계 이름이 새로 나오면 그 안쪽 단계는 이어받지 않는다.
 */
function hierarchy(s) {
  const levels = s.data.cats.slice().reverse(); // 바깥 단계부터
  const carry = levels.map(() => undefined);
  const rows = [];
  s.data.vals.forEach((v, i) => {
    levels.forEach((level, L) => {
      const name = level[i];
      if (name !== undefined && name !== '') {
        carry[L] = name;
        for (let k = L + 1; k < levels.length - 1; k++) carry[k] = undefined; // 안쪽(잎 제외) 단계는 새로 시작
      } else if (L === levels.length - 1) carry[L] = undefined; // 잎은 이어받지 않는다
    });
    if (!Number.isFinite(v) || v <= 0) return;
    const path = carry.filter((name) => name !== undefined);
    rows.push({ path: path.length ? path : [String(i + 1)], value: v });
  });
  return rows;
}

function squarify(items, x, y, w, h) {
  // 큰 것부터 짧은 변을 따라 줄을 채운다(가로세로 비율이 1에 가깝게).
  const out = [];
  let rest = items.slice().sort((a, b) => b.value - a.value);
  let box = { x, y, w, h };
  let total = rest.reduce((a, b) => a + b.value, 0);
  while (rest.length) {
    const vertical = box.w >= box.h;
    const side = vertical ? box.h : box.w;
    let row = [];
    let best = Infinity;
    for (let k = 1; k <= rest.length; k++) {
      const cand = rest.slice(0, k);
      const sum = cand.reduce((a, b) => a + b.value, 0);
      const thick = ((sum / total) * (vertical ? box.w : box.h));
      const worst = Math.max(...cand.map((c) => {
        const len = (c.value / sum) * side;
        return Math.max(thick / len, len / thick);
      }));
      if (worst > best) break;
      best = worst;
      row = cand;
    }
    const sum = row.reduce((a, b) => a + b.value, 0);
    const thick = total > 0 ? (sum / total) * (vertical ? box.w : box.h) : 0;
    let offset = 0;
    for (const c of row) {
      const len = sum > 0 ? (c.value / sum) * side : 0;
      out.push({ ...c, x: vertical ? box.x : box.x + offset, y: vertical ? box.y + offset : box.y, w: vertical ? thick : len, h: vertical ? len : thick });
      offset += len;
    }
    rest = rest.slice(row.length);
    total -= sum;
    box = vertical ? { x: box.x + thick, y: box.y, w: box.w - thick, h: box.h } : { x: box.x, y: box.y + thick, w: box.w, h: box.h - thick };
  }
  return out;
}

function treemap(chart, s, W, H, size) {
  const rows = hierarchy(s);
  let top = 6;
  let body = '';
  if (chart.title) {
    body += text(W / 2, 8 + size * 0.8, chart.title, size * 1.3, { color: '#262626' });
    top += size * 2;
  }
  // 맨 바깥 단계로 묶어 색을 정하고, 그 안을 다시 나눈다.
  const groups = new Map();
  for (const r of rows) {
    const key = r.path[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const outer = squarify([...groups].map(([name, items]) => ({ name, items, value: items.reduce((a, b) => a + b.value, 0) })), 4, top, W - 8, H - top - 4);
  outer.forEach((g, gi) => {
    const color = chart.accents[gi % 6];
    const inner = squarify(g.items.map((r) => ({ name: r.path[r.path.length - 1], value: r.value })), g.x, g.y, g.w, g.h);
    for (const c of inner) {
      body += `<rect x="${r2(c.x)}" y="${r2(c.y)}" width="${r2(Math.max(0, c.w))}" height="${r2(Math.max(0, c.h))}" fill="#${color}" stroke="#ffffff" stroke-width="1.5"/>`;
      if (c.w > size * 2.5 && c.h > size * 1.6) {
        const label = c.name.length * size * 0.6 > c.w - 6 ? `${c.name.slice(0, Math.max(1, Math.floor((c.w - 6) / (size * 0.6)) - 1))}…` : c.name;
        body += text(c.x + 4, c.y + size, label, size, { anchor: 'start', color: '#ffffff' });
      }
    }
    if (g.items.length > 1 && g.w > size * 4) body += text(g.x + 4, g.y + g.h - size * 0.8, g.name, size * 0.9, { anchor: 'start', color: '#ffffff', weight: 'bold' });
  });
  return svg(W, H, body);
}

function sunburst(chart, s, W, H, size) {
  const rows = hierarchy(s);
  let top = 4;
  let body = '';
  if (chart.title) {
    body += text(W / 2, 8 + size * 0.8, chart.title, size * 1.3, { color: '#262626' });
    top += size * 2;
  }
  const depth = Math.max(1, ...rows.map((r) => r.path.length));
  const cx = W / 2;
  const cy = top + (H - top) / 2;
  const R = Math.max(10, Math.min(W, H - top) / 2 - 4);
  const ring = R / depth;
  const total = rows.reduce((a, b) => a + b.value, 0) || 1;
  const arc = (r0, r1, a0, a1) => {
    const p = (r, a) => `${r2(cx + r * Math.sin(a))},${r2(cy - r * Math.cos(a))}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4;
    return `M${p(r0, a0)} L${p(r1, a0)} A${r2(r1)},${r2(r1)} 0 ${large} 1 ${p(r1, a1)} L${p(r0, a1)} A${r2(r0)},${r2(r0)} 0 ${large} 0 ${p(r0, a0)}Z`;
  };
  // 단계마다 같은 경로 앞부분끼리 묶어 각도를 나눈다.
  const draw = (items, level, a0, a1, colorIndex) => {
    if (level >= depth) return;
    const groups = new Map();
    for (const r of items) {
      if (r.path.length <= level) continue;
      const key = r.path[level];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const sum = items.reduce((a, b) => a + b.value, 0) || 1;
    let a = a0;
    let k = 0;
    for (const [name, group] of groups) {
      const v = group.reduce((x, y) => x + y.value, 0);
      const b = a + ((a1 - a0) * v) / sum;
      const ci = level === 0 ? k : colorIndex;
      const color = chart.accents[ci % 6];
      body += `<path d="${arc(ring * level + (level === 0 ? ring * 0.3 : 0), ring * (level + 1), a, b)}" fill="#${color}" fill-opacity="${1 - level * 0.18}" stroke="#ffffff" stroke-width="1.5"/>`;
      const mid = (a + b) / 2;
      const rm = ring * (level + 0.6);
      if ((b - a) * rm > textWidth(name, size * 0.9) + 4 || (b - a) > 0.5) body += text(cx + rm * Math.sin(mid), cy - rm * Math.cos(mid), name, size * 0.9, { color: '#ffffff' });
      draw(group, level + 1, a, b, ci);
      a = b;
      k++;
    }
  };
  draw(rows, 0, 0, Math.PI * 2 * (rows.reduce((x, y) => x + y.value, 0) / total), 0);
  return svg(W, H, body);
}

function quartiles(sorted) {
  // 엑셀 기본(포함 중앙값 아님, exclusive): 위치 (n+1)p
  const q = (p) => {
    const pos = (sorted.length + 1) * p - 1;
    const lo = Math.max(0, Math.min(sorted.length - 1, Math.floor(pos)));
    const hi = Math.max(0, Math.min(sorted.length - 1, Math.ceil(pos)));
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - Math.floor(pos));
  };
  return [q(0.25), q(0.5), q(0.75)];
}

function boxWhisker(chart, seriesList, W, H, size) {
  // 항목마다(항목이 없으면 계열마다) 상자를 그린다. 계열이 여럿이면 항목 칸 안에 나란히 놓는다.
  const cats = [];
  const index = new Map();
  for (const s of seriesList) {
    s.data.vals.forEach((_, i) => {
      const c = s.data.cats.length ? catLabel(s, i) : '';
      if (!index.has(c)) {
        index.set(c, cats.length);
        cats.push(c);
      }
    });
  }
  const groups = seriesList.map((s) => {
    const byCat = cats.map(() => []);
    s.data.vals.forEach((v, i) => Number.isFinite(v) && byCat[index.get(s.data.cats.length ? catLabel(s, i) : '')].push(v));
    return byCat.map((vals) => vals.sort((a, b) => a - b));
  });
  const all = groups.flat(2);
  const scale = niceScale(Math.min(...all), Math.max(...all));
  const { out, plot, yOf, band } = frame(W, H, { title: chart.title, size, valueScale: scale, cats: cats.map((c) => c || ' ') });
  let body = out;
  const slot = (band * 0.8) / seriesList.length;
  groups.forEach((byCat, si) => {
    const s = seriesList[si];
    byCat.forEach((vals, ci) => {
      if (!vals.length) return;
      const [q1, med, q3] = quartiles(vals);
      const iqr = q3 - q1;
      const inside = vals.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
      const lo = inside[0] ?? vals[0];
      const hi = inside[inside.length - 1] ?? vals[vals.length - 1];
      const x = plot.x + band * ci + band * 0.1 + slot * si;
      const mx = x + slot / 2;
      body += `<line x1="${r2(mx)}" y1="${r2(yOf(hi))}" x2="${r2(mx)}" y2="${r2(yOf(lo))}" stroke="#595959"/>`;
      body += `<line x1="${r2(x + slot * 0.25)}" y1="${r2(yOf(hi))}" x2="${r2(x + slot * 0.75)}" y2="${r2(yOf(hi))}" stroke="#595959"/>`;
      body += `<line x1="${r2(x + slot * 0.25)}" y1="${r2(yOf(lo))}" x2="${r2(x + slot * 0.75)}" y2="${r2(yOf(lo))}" stroke="#595959"/>`;
      body += `<rect x="${r2(x + slot * 0.1)}" y="${r2(yOf(q3))}" width="${r2(slot * 0.8)}" height="${r2(Math.max(1, yOf(q1) - yOf(q3)))}" fill="#${s.color}" stroke="#595959"/>`;
      body += `<line x1="${r2(x + slot * 0.1)}" y1="${r2(yOf(med))}" x2="${r2(x + slot * 0.9)}" y2="${r2(yOf(med))}" stroke="#ffffff" stroke-width="1.5"/>`;
      if (s.showMean) {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const my = yOf(mean);
        body += `<path d="M${r2(mx - 3)},${r2(my - 3)}L${r2(mx + 3)},${r2(my + 3)}M${r2(mx - 3)},${r2(my + 3)}L${r2(mx + 3)},${r2(my - 3)}" stroke="#262626" stroke-width="1.2"/>`;
      }
      if (s.showOutliers) for (const v of vals) if (v < lo || v > hi) body += `<circle cx="${r2(mx)}" cy="${r2(yOf(v))}" r="2.5" fill="none" stroke="#595959"/>`;
    });
  });
  return svg(W, H, body);
}

/** chartEx XML → SVG(w×h px). 그릴 수 없는 종류(지도 등)면 null */
export function chartExToSvg(xml, themeXml, w, h) {
  const W = Math.max(40, w);
  const H = Math.max(30, h);
  const chart = parse(xml, themeXml);
  const shown = chart.series.filter((s) => !s.hidden);
  const main = shown.find((s) => s.layout !== 'paretoLine');
  if (!main) return null;
  const size = Math.max(9, Math.min(13, Math.min(W, H) / 22));
  switch (main.layout) {
    case 'waterfall':
      return waterfall(chart, main, W, H, size);
    case 'funnel':
      return funnel(chart, main, W, H, size);
    case 'clusteredColumn':
      // 파레토: 누적 비율 선 계열이 붙어 있거나 같은 항목을 모으는(aggregation) 막대
      if (shown.some((s) => s.layout === 'paretoLine') || main.aggregation) return pareto(chart, main, W, H, size);
      return columns(chart, main, histogramBins(main.data.vals, main.binning), W, H, size);
    case 'treemap':
      return treemap(chart, main, W, H, size);
    case 'sunburst':
      return sunburst(chart, main, W, H, size);
    case 'boxWhisker':
      return boxWhisker(chart, shown.filter((s) => s.layout === 'boxWhisker'), W, H, size);
    default:
      return null; // regionMap 등
  }
}
