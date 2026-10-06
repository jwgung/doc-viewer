// 쪽이 있는 문서(hwp·ppt·pdf·docx)를 세 가지 방식으로 보여준다.
//   scroll: 쪽을 세로로 이어 붙이고 화면 근처의 쪽만 그린다.
//   page:   한 쪽을 화면에 맞춰 보여주고 스와이프나 좌우 탭으로 넘긴다.
//   spread: 두 쪽을 나란히 보여주고 두 쪽씩 넘긴다.
// 맞춤(fit)은 두 가지다.
//   width: 쪽 너비를 화면 너비에 맞춘다(화면 가득). 쪽이 화면보다 길면 세로로 스크롤한다.
//   page:  쪽 전체가 한 화면에 들어오게 줄인다(용지 맞춤).
// doc은 { count, sizes: [{width, height}], renderInto(index, element) } 형태다.
// renderInto는 element 크기에 맞춰 그 쪽을 그리고, 끝나면 resolve한다.
import { t } from './strings.js';

const KEEP_RENDERED = 8;
const SWIPE_MIN_PX = 50;
const EDGE_TAP_RATIO = 0.3;

export class PagedViewer {
  constructor(container, doc, { mode = 'scroll', fit, onPageChange } = {}) {
    this.container = container;
    this.doc = doc;
    this.mode = mode;
    this.fit = fit ?? (mode === 'scroll' ? 'width' : 'page');
    this.onPageChange = onPageChange;
    this.current = 0;
    // 쪽 번호는 늘 보여주고, 누르면 쪽 번호를 입력해 바로 이동한다.
    this.indicator = document.createElement('button');
    this.indicator.type = 'button';
    this.indicator.className = 'page-indicator';
    this.indicator.addEventListener('click', () => this.askPage());
    document.body.appendChild(this.indicator);
    // 화면 크기가 바뀌면(회전 등) 쪽 크기를 다시 맞춘다. 연속 스크롤·화면 가득은 CSS 비율로 따라간다.
    addEventListener('resize', debounce(() => (this.mode !== 'scroll' || this.fit === 'page') && this.render(), 200));
    this.bindGestures();
  }

  /** 첫 쪽이 그려지면 resolve한다. */
  render() {
    this.observer?.disconnect();
    this.container.replaceChildren();
    this.container.dataset.mode = this.mode;
    this.container.dataset.fit = this.fit;
    return this.mode === 'scroll' ? this.renderScroll() : this.renderFlip();
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    return this.render();
  }

  /** 맞춤을 적용한다. 같은 맞춤이어도 다시 배치해, 앱이 확대 비율을 되돌린 뒤 원래 모양으로 돌아오게 한다. */
  applyFit(fit) {
    this.fit = fit;
    return this.render();
  }

  /** 쪽 번호를 입력받아 그 쪽으로 이동한다. */
  askPage() {
    if (document.querySelector('.dialog')) return;
    const form = document.createElement('form');
    form.className = 'dialog';
    form.innerHTML = '<p></p><input type="number" inputmode="numeric" min="1"><div><button type="button"></button><button type="submit"></button></div>';
    form.querySelector('p').textContent = t.goToPage(this.doc.count);
    const input = form.querySelector('input');
    input.max = String(this.doc.count);
    input.value = String(this.current + 1);
    const [cancel, go] = form.querySelectorAll('button');
    cancel.textContent = t.cancel;
    go.textContent = t.go;
    cancel.addEventListener('click', () => form.remove());
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const page = Number.parseInt(input.value, 10);
      form.remove();
      if (Number.isFinite(page)) this.goTo(page - 1);
    });
    document.body.appendChild(form);
    input.select();
  }

  goTo(index) {
    const step = this.mode === 'spread' ? 2 : 1;
    const target = Math.max(0, Math.min(this.doc.count - 1, index));
    if (this.mode === 'scroll') {
      this.container.children[target]?.scrollIntoView();
      return;
    }
    const start = target - (target % step);
    if (start === this.current) return;
    this.current = start;
    this.renderFlip();
  }

  // ---- 연속 스크롤 -------------------------------------------------------
  renderScroll() {
    const fitWidth = this.container.clientWidth - 16;
    const fitHeight = innerHeight - 16;
    const pages = this.doc.sizes.map(({ width, height }, index) => {
      const el = document.createElement('div');
      el.className = 'page';
      el.style.aspectRatio = `${width} / ${height}`;
      // 용지 맞춤이면 쪽 하나가 화면 높이 안에 들어오게 너비를 줄인다.
      if (this.fit === 'page') el.style.width = `${Math.floor(Math.min(fitWidth, (fitHeight * width) / height))}px`;
      el.dataset.index = String(index);
      this.container.appendChild(el);
      return el;
    });
    const wanted = new Set();
    const show = async (index) => {
      if (wanted.has(index)) return;
      wanted.add(index);
      await this.doc.renderInto(index, pages[index]);
      if (wanted.size <= KEEP_RENDERED) return;
      const farthest = [...wanted].sort((a, b) => Math.abs(b - index) - Math.abs(a - index))[0];
      wanted.delete(farthest);
      pages[farthest].replaceChildren();
    };
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number(entry.target.dataset.index);
          if (entry.isIntersecting) show(index);
        }
        const visible = pages.findIndex((el) => el.getBoundingClientRect().bottom > innerHeight / 3);
        if (visible >= 0 && visible !== this.current) this.changed(visible);
      },
      { rootMargin: '100% 0px' },
    );
    pages.forEach((el) => this.observer.observe(el));
    pages[this.current]?.scrollIntoView();
    return pages.length ? show(this.current) : Promise.resolve();
  }

  // ---- 한 쪽씩 · 두 쪽씩 ----------------------------------------------------
  renderFlip() {
    const step = this.mode === 'spread' ? 2 : 1;
    this.current -= this.current % step;
    const indexes = [this.current, this.current + 1].slice(0, step).filter((i) => i < this.doc.count);
    const stage = document.createElement('div');
    stage.className = 'flip-stage';
    const gap = 8;
    const availWidth = (this.container.clientWidth - 16 - gap * (step - 1)) / step;
    const availHeight = innerHeight - 16;
    const slots = indexes.map((index) => {
      const { width, height } = this.doc.sizes[index];
      const scale = this.fit === 'width' ? availWidth / width : Math.min(availWidth / width, availHeight / height);
      const el = document.createElement('div');
      el.className = 'page';
      el.style.width = `${Math.floor(width * scale)}px`;
      el.style.height = `${Math.floor(height * scale)}px`;
      stage.appendChild(el);
      return [index, el];
    });
    this.container.replaceChildren(stage);
    this.container.scrollTop = 0;
    this.changed(this.current);
    // 다음·이전 쪽은 미리 준비할 필요가 없을 만큼 빠르므로 보이는 쪽만 그린다.
    return Promise.all(slots.map(([index, el]) => this.doc.renderInto(index, el)));
  }

  next() {
    this.goTo(this.current + (this.mode === 'spread' ? 2 : 1));
  }

  prev() {
    this.goTo(this.current - (this.mode === 'spread' ? 2 : 1));
  }

  bindGestures() {
    // pointer 이벤트는 브라우저가 화면 이동을 시작하면 pointercancel로 끊긴다.
    // 확대 상태의 화면 이동은 살려야 하므로 touch 이벤트로 시작·끝 위치만 본다.
    let start = null;
    addEventListener(
      'touchstart',
      (e) => {
        const touch = e.touches.length === 1 ? e.touches[0] : null;
        start = touch ? { x: touch.clientX, y: touch.clientY, t: performance.now() } : null;
      },
      { passive: true },
    );
    addEventListener(
      'touchend',
      (e) => {
        const touch = e.changedTouches[0];
        if (!start || !touch || e.touches.length > 0) return;
        this.handleGesture(touch.clientX - start.x, touch.clientY - start.y, performance.now() - start.t, touch.clientX);
        start = null;
      },
      { passive: true },
    );
    addEventListener('keydown', (e) => {
      if (this.mode === 'scroll') return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') this.next();
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') this.prev();
    });
  }

  handleGesture(dx, dy, ms, x) {
    if (this.mode === 'scroll') return;
    // 확대한 상태에서는 손가락 이동을 화면 이동으로 남겨 둔다.
    if ((visualViewport?.scale ?? 1) > 1.05) return;
    if (getSelection()?.toString()) return;
    if (Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      dx < 0 ? this.next() : this.prev();
    } else if (ms < 600 && Math.hypot(dx, dy) < 10) {
      const ratio = x / innerWidth;
      if (ratio < EDGE_TAP_RATIO) this.prev();
      else if (ratio > 1 - EDGE_TAP_RATIO) this.next();
    }
  }

  changed(index) {
    this.current = index;
    const last = this.mode === 'spread' ? Math.min(index + 2, this.doc.count) : index + 1;
    this.indicator.textContent = last > index + 1 ? `${index + 1}-${last} / ${this.doc.count}` : `${index + 1} / ${this.doc.count}`;
    this.onPageChange?.(index);
  }
}

function debounce(fn, ms) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
