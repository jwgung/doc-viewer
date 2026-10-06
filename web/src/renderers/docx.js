import { renderAsync } from 'docx-preview';

export async function render(bytes, container, ctx) {
  await renderAsync(bytes, container, undefined, {
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    experimental: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    useBase64URL: true,
  });
  // docx-preview는 원래 쪽 너비(px)로 그리므로 화면 너비에 맞게 줄인다.
  const sections = container.querySelectorAll('section.docx');
  const available = container.clientWidth - 16;
  for (const section of sections) {
    const width = section.offsetWidth;
    if (width > available) section.style.zoom = String(available / width);
  }
  ctx.markFirstPage();
  return { pages: sections.length };
}
