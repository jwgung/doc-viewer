// 문서 안 검색. 앱 상단바의 검색 버튼이 window.viewer.openSearch()를 부른다.
// - 쪽이 있는 문서는 렌더러가 준 쪽별 글자(textOf)로 어느 쪽에 몇 개 있는지 먼저 센다. 그리지 않은 쪽은 DOM에
//   없으므로, 결과로 옮겨 갈 때 그 쪽을 그린 뒤 그려진 글자에서 다시 찾아 표시한다.
// - 쪽이 없는 문서(doc·마크다운·최후 대안 등)는 그려진 글자 전체에서 찾는다.
// 표시는 CSS Custom Highlight API(::highlight)로 해서 문서 DOM을 바꾸지 않는다.
// 공백은 무시하고 찾는다: HWP는 글자마다 따로 그려 띄어쓰기가 글자로 남지 않고, 한국어는 띄어쓰기가
// 사람마다 달라 '산불 조심'으로 '산불조심'을 찾을 수 있어야 한다. 대소문자도 가리지 않는다.
import { t } from './strings.js';

/** 결과를 이만큼까지만 모은다(아주 흔한 글자를 찾을 때 메모리·시간이 끝없이 늘지 않게). */
const MAX_HITS = 10000;

const ICONS = {
  prev: '<svg viewBox="0 0 24 24"><path d="M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>',
};

/**
 * @param {object} options
 * @param {HTMLElement} options.container 문서를 그리는 곳
 * @param {() => import('./paged-viewer.js').PagedViewer | null} options.viewer 쪽 뷰어(없으면 쪽 없는 문서)
 * @param {() => ((index: number) => Promise<string>) | null} options.textOf 쪽별 글자(없으면 DOM에서 찾는다)
 * @param {() => {find(query: string): Promise<object[]>, show(hit: object): Promise<void>, clear(): void} | null} options.provider
 *   렌더러가 직접 찾고 보여 주는 경우(가상 스크롤 표처럼 DOM에 일부만 있는 문서)
 */
export function createSearch({ container, viewer, textOf, provider }) {
  const bar = document.createElement('div');
  bar.className = 'search-bar';
  bar.setAttribute('role', 'search');
  bar.innerHTML =
    `<input type="search" enterkeyhint="search" autocomplete="off" aria-label="${t.searchPlaceholder}" placeholder="${t.searchPlaceholder}">` +
    '<span class="search-count" aria-live="polite"></span>' +
    `<button type="button" class="search-prev" aria-label="${t.searchPrev}">${ICONS.prev}</button>` +
    `<button type="button" class="search-next" aria-label="${t.searchNext}">${ICONS.next}</button>` +
    `<button type="button" class="search-close" aria-label="${t.searchClose}">${ICONS.close}</button>`;
  const input = bar.querySelector('input');
  const count = bar.querySelector('.search-count');

  let query = '';
  let generation = 0; // 새 검색이 시작되면 앞선 검색의 비동기 작업을 버린다.
  let hits = []; // 쪽 있는 문서: [{ page, nth }], 쪽 없는 문서: Range[]
  let current = -1;
  let scanning = false; // 쪽을 다 세기 전에는 개수 뒤에 '+'를 붙인다.
  let timer = null;

  const supported = typeof CSS !== 'undefined' && 'highlights' in CSS;

  function open() {
    if (!bar.isConnected) document.body.appendChild(bar);
    bar.hidden = false;
    document.body.classList.add('searching');
    input.focus();
    input.select();
    dispatchEvent(new Event('viewerinputopen'));
  }

  function close() {
    bar.hidden = true;
    document.body.classList.remove('searching');
    generation++;
    clearHighlights();
    input.blur();
  }

  function clearHighlights() {
    provider()?.clear();
    if (!supported) return;
    CSS.highlights.delete('search-hit');
    CSS.highlights.delete('search-current');
  }

  async function run() {
    const token = ++generation;
    scanning = false;
    query = normalize(input.value);
    hits = [];
    current = -1;
    clearHighlights();
    if (!query) {
      count.textContent = '';
      return;
    }
    const custom = provider();
    if (custom) {
      count.textContent = t.searching;
      const found = await custom.find(query).catch(() => []);
      if (token !== generation) return;
      hits = found;
      if (!hits.length) {
        count.textContent = t.searchNone;
        return;
      }
      current = 0;
      await show();
      return;
    }
    const paged = viewer();
    const source = textOf();
    if (paged && source) {
      count.textContent = t.searching;
      scanning = true;
      for (let page = 0; page < paged.doc.count; page++) {
        const text = normalize(await source(page).catch(() => ''));
        if (token !== generation) return;
        for (let nth = 0, at = text.indexOf(query); at >= 0 && hits.length < MAX_HITS; nth++, at = text.indexOf(query, at + query.length)) hits.push({ page, nth });
        if (hits.length >= MAX_HITS) break;
        // 앞쪽에서 찾았으면 다 세기 전에 먼저 보여 준다.
        if (current < 0 && hits.length && hits.at(-1).page >= paged.current) {
          current = hits.findIndex((hit) => hit.page >= paged.current);
          await show();
          if (token !== generation) return;
        }
        if (page % 10 === 9) {
          if (current >= 0) updateCount();
          else count.textContent = `${t.searching} ${page + 1}/${paged.doc.count}`;
        }
      }
      scanning = false;
      if (!hits.length) {
        count.textContent = t.searchNone;
        return;
      }
      if (current < 0) {
        current = 0;
        await show();
      }
      updateCount();
      return;
    }
    const index = textIndex(container);
    for (let at = index.text.indexOf(query); at >= 0 && hits.length < MAX_HITS; at = index.text.indexOf(query, at + query.length)) {
      hits.push(rangeAt(index, at, at + query.length));
    }
    if (!hits.length) {
      count.textContent = t.searchNone;
      return;
    }
    if (supported) CSS.highlights.set('search-hit', new Highlight(...hits));
    // 지금 화면 아래쪽에서 가장 가까운 결과부터 보인다.
    const firstBelow = hits.findIndex((range) => range.getBoundingClientRect().bottom > 0);
    current = Math.max(0, firstBelow);
    await show();
  }

  async function show() {
    const token = generation;
    const custom = provider();
    if (custom) {
      updateCount();
      await custom.show(hits[current]);
      return;
    }
    const paged = viewer();
    let range;
    if (paged && textOf()) {
      const { page, nth } = hits[current];
      paged.goTo(page);
      await paged.whenRendered(page);
      if (token !== generation) return;
      const el = paged.pageElement(page);
      if (!el) return;
      const index = textIndex(el);
      const ranges = [];
      for (let at = index.text.indexOf(query); at >= 0; at = index.text.indexOf(query, at + query.length)) {
        ranges.push(rangeAt(index, at, at + query.length));
      }
      if (supported) CSS.highlights.set('search-hit', new Highlight(...ranges));
      range = ranges[Math.min(nth, ranges.length - 1)];
    } else {
      range = hits[current];
    }
    updateCount();
    if (!range) return;
    if (supported) CSS.highlights.set('search-current', new Highlight(range));
    scrollToRange(range);
  }

  function updateCount() {
    count.textContent = hits.length ? `${current + 1}/${hits.length}${scanning || hits.length >= MAX_HITS ? '+' : ''}` : '';
  }

  function step(delta) {
    if (!hits.length) return;
    current = (current + delta + hits.length) % hits.length;
    show();
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    clearTimeout(timer);
    // 같은 검색어면 다음 결과로, 바뀌었으면 새로 찾는다.
    if (normalize(input.value) === query && hits.length) step(event.shiftKey ? -1 : 1);
    else run();
  });
  bar.querySelector('.search-prev').addEventListener('click', () => step(-1));
  bar.querySelector('.search-next').addEventListener('click', () => step(1));
  bar.querySelector('.search-close').addEventListener('click', close);

  return { open, close, isOpen: () => bar.isConnected && !bar.hidden };
}

/** 찾을 글과 찾는 대상을 같은 모양으로: 공백을 빼고 소문자로(쪽별 글자도 이 모양으로 센다). */
function normalize(text) {
  return lowerSameLength(text.replace(/\s+/g, ''));
}

/** 소문자로. 길이가 바뀌는 드문 글자(İ 등)는 그 글자만 그대로 둬 위치가 어긋나지 않게 한다. */
function lowerSameLength(text) {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = '';
  for (const ch of text) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

/**
 * 요소 안의 글자를 공백을 빼고 이어 붙인 글과, 그 글의 글자마다 원래 노드·위치(공백을 빼면 노드 안 위치가
 * 달라지므로 글자 단위로 기억한다).
 */
function textIndex(root) {
  const nodes = [];
  let text = '';
  let at = new Uint32Array(1024); // 글자 i → (노드 번호, 노드 안 위치)를 번갈아
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // HWP 선택용 글자 층은 그림 글자와 겹치므로 빼고 그림 글자에 표시한다.
    acceptNode: (node) => (node.parentElement?.closest('style, script, .search-bar, .hwp-text-layer') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = node.data;
    const lower = lowerSameLength(data);
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);
      if (code <= 32 || code === 0xa0 || code === 0x3000 || (code >= 0x2000 && code <= 0x200b)) continue;
      if (text.length * 2 + 2 > at.length) {
        const grown = new Uint32Array(at.length * 2);
        grown.set(at);
        at = grown;
      }
      at[text.length * 2] = nodes.length;
      at[text.length * 2 + 1] = i;
      text += lower[i];
    }
    nodes.push(node);
  }
  return { text, nodes, at };
}

/** 이어 붙인 글의 [start, end) 위치를 실제 노드 범위로 바꾼다(여러 노드에 걸칠 수 있다). */
function rangeAt({ nodes, at }, start, end) {
  const range = new Range();
  range.setStart(nodes[at[start * 2]], at[start * 2 + 1]);
  range.setEnd(nodes[at[(end - 1) * 2]], at[(end - 1) * 2 + 1] + 1);
  return range;
}

/** 결과가 화면 가운데쯤 오도록 스크롤한다(가로로 넘치는 표·확대한 쪽도). */
function scrollToRange(range) {
  const rect = range.getBoundingClientRect();
  const target = range.startContainer.parentElement;
  if (!target) return;
  if (rect.top < 60 || rect.bottom > innerHeight - 40 || rect.left < 0 || rect.right > innerWidth) {
    target.scrollIntoView({ block: 'center', inline: 'center' });
  }
}
