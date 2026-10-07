import { openLazyAsync, renderAsync } from 'docx-preview';
import { readZip } from '../containers.js';
import { placePage } from '../fit-page.js';
import { HTML_PRINT_LIMIT, createPager, fillPages, loadPage } from '../paginate.js';
import { PagedViewer } from '../paged-viewer.js';
import { t } from '../strings.js';

const OPTIONS = {
  inWrapper: false,
  breakPages: true,
  ignoreLastRenderedPageBreak: true,
  experimental: true,
  renderHeaders: true,
  renderFooters: true,
  renderFootnotes: true,
  renderEndnotes: true,
  useBase64URL: true,
};

export async function render(bytes, container, ctx) {
  // 화면 밖에서 쪽(구역·쪽 나누기 단위)을 그려 용지 높이로 나누고(자동 쪽 나눔, paginate.js), 쪽 뷰어에 넘긴다.
  const holder = document.createElement('div');
  holder.className = 'offscreen';
  document.body.appendChild(holder);
  const opened = (await openByPage(bytes, holder)) ?? (await openWhole(bytes, holder));
  const pager = createPager(pageElements(opened.sections, holder));
  const sizes = [];
  const sync = () => {
    for (let index = sizes.length; index < pager.pages.length; index++) sizes.push(pager.pages[index].size);
  };
  // 첫 쪽(이어보기면 그 쪽까지)만 먼저 나눈다. 나머지는 첫 쪽을 보인 뒤 쉬는 틈에 나눈다.
  await pager.fill((ctx.startPage ?? 0) + 1);
  sync();

  let viewer = null;
  const doc = {
    get count() {
      return sizes.length;
    },
    get complete() {
      return pager.done;
    },
    paginated: pager.finished,
    printLimit: HTML_PRINT_LIMIT,
    sizes,
    measure: (index) => sizes[index],
    renderInto: async (index, el) => placePage(loadPage(pager.pages[index].saved), index, el, sizes, viewer),
  };
  viewer = new PagedViewer(container, doc, { mode: ctx.mode, fit: ctx.fit });
  ctx.setViewer(viewer);
  // 검색: 보관한 쪽의 글자(template 안에서는 그림을 불러오지 않는다).
  const template = document.createElement('template');
  ctx.setTextSource(async (index) => {
    template.innerHTML = pager.pages[index].saved;
    return template.content.textContent;
  });
  // 목차: 문서에 쓰인 제목 스타일의 문단. 목차를 열 때 쪽마다 찾는다. 화면의 쪽과 같은 구조여야 몇 번째 제목인지
  // 맞으므로 쪽을 그릴 때처럼 되살린다.
  headingClasses(bytes)
    .then((classes) => {
      if (classes.size) ctx.setOutline(() => headingOutline(pager, (index) => loadPage(pager.pages[index].saved), classes, viewer));
    })
    .catch(() => {});
  await viewer.render();
  ctx.markFirstPage();
  pager.background(() => {
    sync();
    viewer.grow();
    if (pager.done) opened.dispose?.(); // 쪽 HTML을 다 만들었으니 원본 쪽 정보는 버린다(holder의 스타일은 남긴다)
  });
  addEventListener('pagehide', () => opened.dispose?.(), { once: true });
  return { pages: sizes.length, extra: { docxByPage: opened.byPage } };
}

/**
 * 쪽(구역·쪽 나누기) 단위로 필요할 때 파싱·렌더한다. 문서 전체를 한꺼번에 그리지 않으므로 첫 쪽이 빠르다.
 * 한 쪽짜리·작은 문서 등 이득이 없거나 원본과 달라질 수 있으면(또는 첫 쪽부터 실패하면) null을 돌려주고,
 * 호출한 쪽이 문서 전체를 한 번에 그리는 방식을 쓴다.
 */
async function openByPage(bytes, holder) {
  let lazy;
  try {
    lazy = await openLazyAsync(bytes, OPTIONS);
  } catch (error) {
    console.warn('docx 쪽 단위 열기에 실패해 한 번에 그립니다:', error);
    return null;
  }
  if (!lazy) return null;
  holder.append(...lazy.styleNodes);
  let first;
  try {
    first = lazy.renderPage(0);
  } catch (error) {
    console.warn('docx 첫 쪽을 쪽 단위로 그리지 못해 한 번에 그립니다:', error);
    holder.replaceChildren();
    lazy.dispose();
    return null;
  }
  async function* sections() {
    for (let index = 0; index < lazy.pageCount; index++) {
      let page;
      try {
        page = index === 0 ? first : lazy.renderPage(index);
      } catch (error) {
        console.warn(`docx ${index + 1}쪽을 그리지 못했습니다:`, error);
        yield failedPage(holder, lazy.estimatedSize(index));
        continue;
      }
      holder.appendChild(page.element);
      // 탭 간격과 쪽 나눔은 글자 크기에 따라 달라지므로, 이미지·글꼴이 자리 잡은 뒤 화면 밖 원래 크기에서 잰다.
      await Promise.all([page.settled, loadFonts()]);
      page.refreshTabs();
      yield page.element;
    }
  }
  return { byPage: true, sections: sections(), dispose: () => lazy.dispose() };
}

/** docx-preview가 문서 전체를 한 번에 그린다(구역·쪽 나누기마다 section 하나). */
async function openWhole(bytes, holder) {
  await renderAsync(bytes, holder, undefined, OPTIONS);
  await loadFonts(); // 문서에 담긴 글꼴이 자리 잡은 뒤에 쪽을 나눈다
  const all = [...holder.querySelectorAll('section.docx')];
  async function* sections() {
    yield* all;
  }
  return { byPage: false, sections: sections() };
}

/**
 * 문서에 담긴 글꼴(docx-preview가 @font-face로 넣는다)을 받는다. 글꼴은 보통 배치할 때 받기 시작하므로, 쪽을
 * 재기 전에 직접 불러 둔다(쪽 전체를 한 번 배치해 받게 하면 저사양 기기에서 4초가 더 들었다).
 */
function loadFonts() {
  return Promise.all([...document.fonts].filter((font) => font.status === 'unloaded').map((font) => font.load().catch(() => {})));
}

/** 그리지 못한 쪽 자리: 용지 크기에 안내 문구만. */
function failedPage(holder, size) {
  const page = document.createElement('section');
  page.className = 'docx';
  page.style.width = `${size.width}px`;
  page.style.minHeight = `${size.height}px`;
  page.style.padding = '32px';
  page.textContent = t.renderFailed;
  holder.appendChild(page);
  return page;
}

/**
 * 쪽(section.docx)마다 본문(article)의 블록을 용지 높이로 채워 쪽 요소를 차례로 내놓는다.
 * 나눈 쪽마다 머리말·꼬리말(header·footer)만 복사하고, 본문 뒤에 붙는 각주·미주 목록(ol)은 본문 끝에 이어
 * 흐르게 한다(쪽마다 복사하면 쪽마다 각주가 자리를 차지한다). 본문이 없는 쪽은 그대로 한 쪽이다.
 */
async function* pageElements(sections, holder) {
  for await (const section of sections) {
    const body = section.querySelector(':scope > article');
    if (!body) {
      yield section;
      continue;
    }
    const repeated = (node) => node.nodeName === 'HEADER' || node.nodeName === 'FOOTER';
    const parts = [...section.childNodes].filter((node) => node === body || repeated(node));
    const notes = [...section.childNodes].filter((node) => node !== body && !repeated(node));
    const blocks = [...body.childNodes, ...notes];
    section.remove();
    const shell = () => {
      const page = section.cloneNode(false);
      let target = null;
      for (const part of parts) page.appendChild(part === body ? (target = body.cloneNode(false)) : part.cloneNode(true));
      holder.appendChild(page);
      return { page, body: target };
    };
    yield* fillPages(blocks, shell);
  }
}

/**
 * 문서에 실제로 쓰인 제목 문단 스타일 → { docx-preview가 붙이는 클래스 이름: 단계(0부터) }.
 * 이름이 'heading N'·'title'이거나 개요 수준(outlineLvl)이 있는 문단 스타일을 제목으로 본다
 * (한국어 Word는 스타일 id가 '1'처럼 지역화돼 있어 이름으로 찾는다).
 */
async function headingClasses(bytes) {
  const zip = readZip(bytes);
  const [styles, body] = await Promise.all([zip.text('word/styles.xml'), zip.text('word/document.xml')]);
  const used = new Set([...(body ?? '').matchAll(/<w:pStyle w:val="([^"]+)"/g)].map((m) => m[1]));
  const classes = new Map();
  for (const [, attrs, inner] of (styles ?? '').matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    if (!/w:type="paragraph"/.test(attrs)) continue;
    const id = /w:styleId="([^"]+)"/.exec(attrs)?.[1];
    if (!id || !used.has(id)) continue;
    const name = (/<w:name w:val="([^"]+)"/.exec(inner)?.[1] ?? '').toLowerCase();
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(inner)?.[1];
    const level = name === 'title' ? 0 : /^heading (\d)$/.test(name) ? Number(name.slice(8)) - 1 : outline !== undefined ? Number(outline) : null;
    // docx-preview의 클래스 이름 규칙(escapeClassName)과 같게 만든다.
    if (level !== null && level < 9) classes.set(`docx_${id.replace(/[ .]+/g, '-').replace(/[&]+/g, 'and').toLowerCase()}`, level);
  }
  return classes;
}

async function headingOutline(pager, pageContent, classes, viewer) {
  await pager.finished; // 쪽을 다 나눈 뒤에 쪽 번호를 매긴다
  const selector = [...classes.keys()].map((name) => `p.${CSS.escape(name)}`).join(',');
  const items = [];
  for (let index = 0; index < pager.pages.length; index++) {
    // 쪽 안에서 몇 번째 제목인지 기억해 두었다가, 그 쪽을 그린 뒤 같은 순서의 제목으로 스크롤한다.
    [...pageContent(index).querySelectorAll(selector)].forEach((p, nth) => {
      const title = p.textContent.trim().replace(/\s+/g, ' ');
      if (!title) return;
      const level = classes.get([...p.classList].find((name) => classes.has(name)));
      const go = async () => {
        viewer.goTo(index);
        await viewer.whenRendered(index);
        viewer.pageElement(index)?.querySelectorAll(selector)[nth]?.scrollIntoView({ block: 'start' });
      };
      items.push({ title: title.slice(0, 120), level, page: index + 1, go });
    });
  }
  return items;
}

