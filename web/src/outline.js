// 목차: 렌더러가 준 항목을 아래에서 올라오는 목록 시트로 보이고, 누르면 그곳으로 간다.
// 항목: { title, level(0부터), page?(1부터, 쪽 있는 문서), go() }
import { t } from './strings.js';

export function openOutline(items) {
  document.querySelector('.sheet-backdrop')?.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = '<div class="sheet outline-sheet" role="dialog"><h2></h2><ol class="outline-list"></ol></div>';
  backdrop.querySelector('h2').textContent = t.outlineTitle;
  const list = backdrop.querySelector('ol');
  const close = () => backdrop.remove();
  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'outline-empty';
    empty.textContent = t.outlineEmpty;
    list.appendChild(empty);
  }
  for (const item of items) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.style.paddingLeft = `${12 + Math.min(item.level, 5) * 16}px`;
    const title = document.createElement('span');
    title.textContent = item.title;
    button.appendChild(title);
    if (item.page) {
      const page = document.createElement('span');
      page.className = 'outline-page';
      page.textContent = String(item.page);
      button.appendChild(page);
    }
    button.addEventListener('click', () => {
      close();
      item.go();
    });
    li.appendChild(button);
    list.appendChild(li);
  }
  backdrop.addEventListener('click', (event) => event.target === backdrop && close());
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('open'));
}

/** 쪽 없는 문서(마크다운·doc·최후 대안 등): 그려진 제목(h1~h4)으로 목차를 만든다. */
export function headingOutline(container) {
  return [...container.querySelectorAll('h1, h2, h3, h4')]
    .filter((el) => el.textContent.trim())
    .map((el) => ({
      title: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 120),
      level: Number(el.tagName[1]) - 1,
      go: () => el.scrollIntoView({ block: 'start' }),
    }));
}
