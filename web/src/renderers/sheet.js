// 스프레드시트(xls·xlsx·csv) 렌더러. 파싱은 워커가 하고, 화면은 보이는 행·열만 그리는 가상 스크롤 표다.
import './sheet.css';
import { t } from '../strings.js';
import { connect } from '../worker-client.js';
import { SheetGrid } from './sheet-grid.js';

const THUMB_PX = 44;

export async function render(bytes, container, ctx) {
  const worker = new Worker(new URL('../workers/sheet-worker.js', import.meta.url), { type: 'module' });
  const request = connect(worker);
  const opened = await request({ type: 'open', fmt: ctx.fmt, bytes: bytes.buffer }, 'opened', [bytes.buffer]);
  addEventListener('pagehide', () => worker.terminate(), { once: true });

  container.classList.add('sheet-doc');
  const tabs = document.createElement('nav');
  tabs.className = 'sheet-tabs';
  const body = document.createElement('div');
  body.className = 'sheet-body';
  const note = document.createElement('p');
  note.className = 'sheet-note';
  container.append(tabs, body, note);

  let requestId = 0;
  const scrubber = new Scrubber(body);
  const grid = new SheetGrid(body, {
    fetchBlock: (sheet, block) => request({ type: 'rows', index: ++requestId, sheet, block }, 'rows'),
    onScroll: () => scrubber.follow(),
  });
  scrubber.grid = grid;

  // 숨긴 시트는 엑셀처럼 탭에 두지 않는다(전부 숨겨져 있으면 모두 보인다).
  const all = opened.sheets.map((sheet, index) => ({ ...sheet, index }));
  const list = all.some((s) => !s.hidden) ? all.filter((s) => !s.hidden) : all;
  tabs.hidden = list.length < 2;
  let current = -1;
  let wanted = -1;
  const show = async (index, payload) => {
    current = index;
    tabs.querySelectorAll('button').forEach((button) => button.setAttribute('aria-selected', String(Number(button.dataset.index) === index)));
    const meta = payload.meta;
    // 차트는 슬라이드 렌더러의 차트 코드로 그린다. 차트가 있는 시트를 처음 열 때만 불러온다.
    if (!grid.renderChart && payload.media?.some((m) => m?.type === 'chart')) {
      try {
        grid.renderChart = (await import('@web-ppt/core/chart')).chartToSvg;
      } catch (error) {
        console.warn('[sheet] chart renderer unavailable', error);
      }
    }
    note.textContent =
      meta.kind !== 'sheet' && !meta.pictures.length
        ? t.chartSheet
        : meta.truncatedRow >= 0
          ? t.rowsLimited(meta.truncatedRow.toLocaleString(), meta.totalRows.toLocaleString())
          : '';
    await grid.show(index, payload);
    scrubber.reset();
  };
  const select = async (index) => {
    if (index === current) return;
    wanted = index;
    const reply = await request({ type: 'sheet', index }, 'sheet');
    if (wanted === index) await show(index, reply);
  };
  for (const sheet of list) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = sheet.name;
    button.dataset.index = String(sheet.index);
    button.addEventListener('click', () => select(sheet.index));
    tabs.appendChild(button);
  }
  // 문서 안 검색: 표는 보이는 칸만 그리므로 워커가 모든 칸의 표시 문자열에서 찾고, 결과 칸으로 스크롤해 표시한다.
  ctx.setSearchProvider({
    async find(query) {
      const reply = await request({ type: 'search', index: ++requestId, sheet: Math.max(0, current), query }, 'found');
      const hits = [];
      for (let i = 0; i < reply.hits.length; i += 3) hits.push({ sheet: reply.hits[i], row: reply.hits[i + 1], col: reply.hits[i + 2] });
      return hits;
    },
    async show(hit) {
      await select(hit.sheet);
      tabs.querySelector(`[data-index="${hit.sheet}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      grid.reveal(hit.row, hit.col);
    },
    clear: () => grid.clearFound(),
  });
  await show(opened.initial, opened.sheet);
  tabs.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  ctx.markFirstPage();
  return {
    pages: list.length,
    extra: { reader: opened.reader, parseMs: opened.parseMs, rows: opened.sheet.meta.rowCount, cells: opened.sheet.meta.cellCount },
  };
}

/** 오른쪽 가장자리의 빠른 이동 손잡이. 행이 많을 때만 보이고, 끄는 동안 맨 위 행 번호를 띄운다. */
class Scrubber {
  constructor(body) {
    this.body = body;
    this.track = document.createElement('div');
    this.track.className = 'scrubber sheet-scrubber';
    this.thumb = document.createElement('div');
    this.thumb.className = 'scrubber-thumb';
    this.bubble = document.createElement('div');
    this.bubble.className = 'scrubber-bubble';
    this.track.append(this.thumb, this.bubble);
    this.track.hidden = true;
    document.body.appendChild(this.track);
    let dragging = false;
    const move = (y) => {
      const rect = this.track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (y - rect.top - THUMB_PX / 2) / (rect.height - THUMB_PX)));
      body.scrollTop = ratio * (body.scrollHeight - body.clientHeight);
      this.place(ratio);
    };
    this.track.addEventListener('pointerdown', (e) => {
      dragging = true;
      this.track.setPointerCapture(e.pointerId);
      this.track.classList.add('active');
      move(e.clientY);
    });
    this.track.addEventListener('pointermove', (e) => dragging && move(e.clientY));
    const end = () => {
      dragging = false;
      this.track.classList.remove('active');
    };
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);
    this.dragging = () => dragging;
  }

  reset() {
    const rect = this.body.getBoundingClientRect();
    this.track.style.top = `${rect.top + 24}px`;
    this.track.hidden = this.body.scrollHeight < this.body.clientHeight * 4;
    this.follow();
  }

  follow() {
    if (this.track.hidden) return;
    const range = this.body.scrollHeight - this.body.clientHeight;
    if (!this.dragging()) this.place(range > 0 ? this.body.scrollTop / range : 0);
    this.bubble.textContent = String((this.grid?.topRow() ?? 0) + 1);
  }

  place(ratio) {
    const top = `calc(${ratio} * (100% - ${THUMB_PX}px))`;
    this.thumb.style.top = top;
    this.bubble.style.top = top;
  }
}
