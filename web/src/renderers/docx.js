import { openLazyAsync, renderAsync } from 'docx-preview';
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
// 그려 둔 쪽을 이만큼만 기억한다(한 쪽씩·두 쪽씩 보기에서 크기를 잰 쪽을 곧 이어 그리는 데 쓴다).
// 화면에서 멀어진 쪽은 PagedViewer가 떼어 내므로, 오래된 것부터 버려 보이지 않는 쪽의 DOM을 붙들고 있지 않는다.
const KEEP_BUILT = 4;

export async function render(bytes, container, ctx) {
  // 화면 밖에서 쪽을 그려 크기를 재고, 보기 방식에 맞춰 옮겨 단다.
  const holder = document.createElement('div');
  holder.className = 'offscreen';
  document.body.appendChild(holder);
  const source = (await openByPage(bytes, holder)) ?? (await openWhole(bytes, holder));
  let viewer = null;
  const doc = {
    count: source.count,
    sizes: source.sizes,
    measure: source.measure,
    renderInto: (index, el) => source.renderInto(index, el, viewer),
  };
  viewer = new PagedViewer(container, doc, { mode: ctx.mode, fit: ctx.fit });
  ctx.setViewer(viewer);
  await viewer.render();
  ctx.markFirstPage();
  addEventListener('pagehide', () => source.dispose?.(), { once: true });
  return { pages: source.count, extra: { docxByPage: source.byPage } };
}

/**
 * 쪽(구역·쪽 나누기 단위)마다 필요할 때 파싱·렌더한다. 문서 전체를 먼저 그리지 않으므로 첫 쪽이 빠르고,
 * 화면에서 멀어진 쪽의 DOM은 붙들고 있지 않는다. 한 쪽짜리·작은 문서 등 이득이 없거나 원본과 달라질 수 있으면
 * (또는 어디선가 실패하면) null을 돌려주고, 호출한 쪽이 문서 전체를 한 번에 그리는 방식을 쓴다.
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
  // 용지 크기로 추정한 값. 쪽을 그리면 실제 크기로 바꾼다(내용이 용지보다 길면 쪽도 더 길다).
  const sizes = Array.from({ length: lazy.pageCount }, (_, index) => lazy.estimatedSize(index));
  const built = new Map(); // 쪽 번호 → { page, size, tabs, busy }. 오래 안 쓴 것부터 밀려난다.

  /** 쪽을 화면 밖에서 그려 크기를 잰다. 이미 그려 둔 쪽이면 그대로 돌려준다. */
  const build = (index) => {
    let entry = built.get(index);
    if (entry) {
      built.delete(index); // 최근에 쓴 것으로 옮긴다
    } else {
      const page = lazy.renderPage(index);
      holder.appendChild(page.element);
      entry = { page, size: { width: page.element.offsetWidth, height: page.element.offsetHeight }, tabs: null, busy: 0 };
      sizes[index] = entry.size;
    }
    built.set(index, entry);
    for (const [oldIndex, old] of built) {
      if (built.size <= KEEP_BUILT) break;
      if (old === entry || old.busy > 0) continue; // 방금 쓴 쪽과, 탭 간격을 맞추고 옮겨 다는 중인 쪽은 남겨 둔다
      built.delete(oldIndex);
      if (old.page.element.parentNode === holder) old.page.element.remove();
    }
    return entry;
  };

  try {
    build(0); // 첫 쪽이 안 그려지면 원래 방식으로 되돌아간다.
  } catch (error) {
    console.warn('docx 첫 쪽을 쪽 단위로 그리지 못해 한 번에 그립니다:', error);
    holder.replaceChildren();
    lazy.dispose();
    return null;
  }

  /**
   * 탭 간격은 잰 위치에 따라 달라지므로 확대(zoom)하기 전, 화면 밖에서 원래 크기로 한 번 맞춘다
   * (원본 방식도 화면 밖에 있는 쪽은 이렇게 맞췄다). 이미지·글꼴이 자리 잡은 뒤에 한다.
   */
  const alignTabs = (entry) =>
    (entry.tabs ??= Promise.all([entry.page.settled, document.fonts.ready]).then(() => {
      if (!entry.page.element.isConnected) holder.appendChild(entry.page.element); // 떨어져 있으면 잴 수 없다
      entry.page.refreshTabs();
    }));

  return {
    byPage: true,
    count: lazy.pageCount,
    sizes,
    // 한 쪽씩·두 쪽씩 보기가 쪽 칸을 잡기 전에 실제 크기를 알려 준다. 못 그리면 추정 크기를 쓴다.
    measure: (index) => {
      try {
        return build(index).size;
      } catch {
        return sizes[index];
      }
    },
    renderInto: async (index, el, viewer) => {
      let entry;
      try {
        entry = build(index);
      } catch (error) {
        console.warn(`docx ${index + 1}쪽을 그리지 못했습니다:`, error);
        el.textContent = t.renderFailed;
        return;
      }
      entry.busy++;
      try {
        await alignTabs(entry);
        viewer?.resizePage(index, entry.size);
        entry.page.element.style.zoom = String(el.clientWidth / entry.size.width);
        el.replaceChildren(entry.page.element);
      } finally {
        entry.busy--;
      }
    },
    dispose: () => {
      built.clear();
      lazy.dispose();
    },
  };
}

/** docx-preview가 문서 전체를 한 번에 그린 뒤 쪽(section)을 보기 방식에 맞춰 옮겨 단다. */
async function openWhole(bytes, holder) {
  await renderAsync(bytes, holder, undefined, OPTIONS);
  const sections = [...holder.querySelectorAll('section.docx')];
  const sizes = sections.map((s) => ({ width: s.offsetWidth, height: s.offsetHeight }));
  return {
    byPage: false,
    count: sections.length,
    sizes,
    renderInto: async (index, el) => {
      sections[index].style.zoom = String(el.clientWidth / sizes[index].width);
      el.replaceChildren(sections[index]);
    },
  };
}
