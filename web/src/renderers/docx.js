import { renderAsync } from 'docx-preview';
import { PagedViewer } from '../paged-viewer.js';

export async function render(bytes, container, ctx) {
  // docx-preview는 문서 전체를 한 번에 그린다. 화면 밖에서 그려 두고 쪽(section)을 보기 방식에 맞춰 옮겨 단다.
  const holder = document.createElement('div');
  holder.className = 'offscreen';
  document.body.appendChild(holder);
  await renderAsync(bytes, holder, undefined, {
    inWrapper: false,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    experimental: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    useBase64URL: true,
  });
  const sections = [...holder.querySelectorAll('section.docx')];
  const sizes = sections.map((s) => ({ width: s.offsetWidth, height: s.offsetHeight }));
  const renderInto = async (index, el) => {
    sections[index].style.zoom = String(el.clientWidth / sizes[index].width);
    el.replaceChildren(sections[index]);
  };
  const viewer = new PagedViewer(container, { count: sections.length, sizes, renderInto }, { mode: ctx.mode });
  ctx.setViewer(viewer);
  await viewer.render();
  ctx.markFirstPage();
  return { pages: sections.length };
}
