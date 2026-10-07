// 쪽이 있는 문서(hwp·ppt·pdf·docx·doc)를 세 가지 방식으로 보여준다.
//   scroll: 쪽을 세로로 이어 붙이고 화면 근처의 쪽만 그린다.
//   page:   한 쪽을 화면에 맞춰 보여주고 스와이프나 좌우 탭으로 넘긴다.
//   spread: 두 쪽을 나란히 보여주고 두 쪽씩 넘긴다.
// 맞춤(fit)은 두 가지다.
//   width: 쪽 너비를 화면 너비에 맞춘다(화면 가득). 쪽이 화면보다 길면 세로로 스크롤한다.
//   page:  쪽 전체가 한 화면에 들어오게 줄인다(용지 맞춤).
// doc은 { count, sizes: [{width, height}], renderInto(index, element) } 형태다.
// renderInto는 element 크기에 맞춰 그 쪽을 그리고, 끝나면 resolve한다.
// 쪽 크기를 그려 봐야 아는 렌더러(docx·doc)는 sizes에 추정값을 주고, 한 쪽씩·두 쪽씩 보기가 크기를 읽기 전에
// doc.measure(index)(선택)로 정확한 크기를 돌려주며, 연속 스크롤에서는 그린 뒤 resizePage로 자리를 바로잡는다.
import { openSheet } from './sheet.js';
import { t } from './strings.js';

const KEEP_RENDERED = 8;
const SWIPE_MIN_PX = 50;
const EDGE_TAP_RATIO = 0.3;
const THUMB_PX = 44;
// 높이가 너비의 이 배를 넘는 쪽은 용지 한 장이 아니라 쪽 나누기 없이 길게 이어진 문서(doc·docx)다.
// 용지 맞춤으로 한 화면에 줄이면 읽을 수 없으므로 너비에 맞추고 세로로 스크롤한다.
const LONG_PAGE_RATIO = 2;
// 이 요소 위에서 시작한 터치는 쪽 넘기기 제스처로 보지 않는다.
const UI_SELECTOR = '.scrubber, .page-indicator, .sheet-backdrop';

/**
 * 연속 스크롤에서 지금 쪽: 화면에 가장 많이 보이는 쪽(같으면 위쪽). 가로 슬라이드처럼 짧은 쪽이 여러 장 보일 때
 * 맨 위 쪽이 다 보이는데도 화면 1/3 지점의 다음 쪽을 지금 쪽으로 잡던 문제를 피한다.
 */
function mostVisible(pages) {
  let best = -1;
  let bestHeight = 0;
  for (let i = 0; i < pages.length; i++) {
    const rect = pages[i].getBoundingClientRect();
    if (rect.bottom <= 0) continue;
    if (rect.top >= innerHeight) break;
    const height = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
    if (height > bestHeight + 1) {
      best = i;
      bestHeight = height;
    }
  }
  return best;
}

export class PagedViewer {
  /** 마지막으로 탭·스와이프로 쪽을 넘긴 시각. 같은 탭을 읽기 모드 전환으로 다시 쓰지 않게 한다. */
  static lastFlipAt = 0;

  constructor(container, doc, { mode = 'scroll', fit, onPageChange } = {}) {
    this.container = container;
    this.doc = doc;
    this.mode = mode;
    this.fit = fit ?? (mode === 'scroll' ? 'width' : 'page');
    this.onPageChange = onPageChange;
    this.current = 0;
    /** 쪽 번호 → 그 쪽을 그리는 중인(또는 다 그린) 약속 */
    this.rendering = new Map();
    // 쪽 번호는 늘 보여주고, 누르면 쪽 번호를 입력해 바로 이동한다.
    this.indicator = document.createElement('button');
    this.indicator.type = 'button';
    this.indicator.className = 'page-indicator';
    this.indicator.addEventListener('click', () => this.askPage());
    document.body.appendChild(this.indicator);
    this.buildScrubber();
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
  async askPage() {
    const value = await openSheet({
      title: t.goToPageTitle,
      inputType: 'number',
      inputMode: 'numeric',
      value: this.current + 1,
      min: 1,
      max: this.doc.count,
      suffix: `/ ${this.doc.count}`,
      confirmLabel: t.go,
      cancelLabel: t.cancel,
    });
    const page = Number.parseInt(value ?? '', 10);
    if (Number.isFinite(page)) this.goTo(page - 1);
  }

  /**
   * 오른쪽 가장자리의 빠른 이동 손잡이. 끌면 쪽 번호 말풍선을 띄우고,
   * 연속 스크롤은 끄는 동안 따라가며 한 쪽씩·두 쪽씩은 손을 뗄 때 그 쪽으로 간다.
   */
  buildScrubber() {
    if (this.doc.count < 2) return;
    const track = document.createElement('div');
    track.className = 'scrubber';
    const thumb = document.createElement('div');
    thumb.className = 'scrubber-thumb';
    const bubble = document.createElement('div');
    bubble.className = 'scrubber-bubble';
    track.append(thumb, bubble);
    document.body.appendChild(track);

    const pageAt = (y) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (y - rect.top - THUMB_PX / 2) / (rect.height - THUMB_PX)));
      return Math.round(ratio * (this.doc.count - 1));
    };
    let dragging = false;
    let target = this.current;
    const move = (y) => {
      target = pageAt(y);
      this.placeThumb(target);
      bubble.textContent = String(target + 1);
      if (this.mode === 'scroll') this.goTo(target);
    };
    track.addEventListener('pointerdown', (e) => {
      dragging = true;
      track.setPointerCapture(e.pointerId);
      track.classList.add('active');
      move(e.clientY);
    });
    track.addEventListener('pointermove', (e) => dragging && move(e.clientY));
    const end = () => {
      if (!dragging) return;
      dragging = false;
      track.classList.remove('active');
      if (this.mode !== 'scroll') this.goTo(target);
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    this.isScrubbing = () => dragging;
    this.placeThumb = (index) => {
      const ratio = this.doc.count > 1 ? index / (this.doc.count - 1) : 0;
      const top = `calc(${ratio} * (100% - ${THUMB_PX}px))`;
      thumb.style.top = top;
      bubble.style.top = top;
    };
    this.placeThumb(this.current);
  }

  /** 연속 스크롤의 쪽 자리 크기. 용지 맞춤이면 쪽 하나가 화면 높이 안에 들어오게 너비를 줄인다(아주 긴 쪽은 빼고). */
  sizeScrollPage(el, { width, height }, fitWidth = this.container.clientWidth - 16, fitHeight = innerHeight - 16) {
    el.style.aspectRatio = `${width} / ${height}`;
    if (this.fit === 'page' && height / width <= LONG_PAGE_RATIO) el.style.width = `${Math.floor(Math.min(fitWidth, (fitHeight * width) / height))}px`;
    else el.style.width = '';
  }

  /** 렌더러가 그려 보고서야 쪽 크기를 알았을 때, 연속 스크롤 자리를 실제 크기로 바로잡는다. */
  resizePage(index, size) {
    this.doc.sizes[index] = size;
    const el = this.mode === 'scroll' ? this.container.children[index] : null;
    if (el) this.sizeScrollPage(el, size);
  }

  goTo(index) {
    const step = this.mode === 'spread' ? 2 : 1;
    const target = Math.max(0, Math.min(this.doc.count - 1, index));
    if (this.mode === 'scroll') {
      this.container.children[target]?.scrollIntoView();
      // 관찰자가 알아채기 전에 바로 그리기 시작해, 기다리는 쪽(검색 등)이 그 쪽을 곧 쓸 수 있게 한다.
      this.showPage?.(target);
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
    const pages = this.doc.sizes.map((size, index) => {
      const el = document.createElement('div');
      el.className = 'page';
      this.sizeScrollPage(el, size, fitWidth, fitHeight);
      el.dataset.index = String(index);
      this.container.appendChild(el);
      return el;
    });
    const wanted = new Set();
    const show = async (index) => {
      if (wanted.has(index)) return;
      wanted.add(index);
      const rendering = this.doc.renderInto(index, pages[index]);
      this.rendering.set(index, rendering);
      await rendering;
      if (wanted.size <= KEEP_RENDERED) return;
      const farthest = [...wanted].sort((a, b) => Math.abs(b - index) - Math.abs(a - index))[0];
      wanted.delete(farthest);
      pages[farthest].replaceChildren();
    };
    this.showPage = show;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number(entry.target.dataset.index);
          if (entry.isIntersecting) show(index);
        }
        const visible = mostVisible(pages);
        if (visible >= 0 && visible !== this.current) this.changed(visible);
      },
      { rootMargin: '100% 0px' },
    );
    pages.forEach((el) => this.observer.observe(el));
    pages[this.current]?.scrollIntoView();
    // 시작 쪽이 곧 보이는 쪽이면 관찰자가 바뀜을 알리지 않으므로 쪽 번호를 직접 채운다.
    this.changed(this.current);
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
    const sizes = indexes.map((index) => this.doc.measure?.(index) ?? this.doc.sizes[index]);
    const fitWidth = this.fit === 'width' || sizes.some(({ width, height }) => height / width > LONG_PAGE_RATIO);
    this.container.dataset.fit = fitWidth ? 'width' : this.fit; // 긴 쪽이면 세로 스크롤을 연다(CSS)
    const slots = indexes.map((index, k) => {
      const { width, height } = sizes[k];
      const scale = fitWidth ? availWidth / width : Math.min(availWidth / width, availHeight / height);
      const el = document.createElement('div');
      el.className = 'page';
      el.style.width = `${Math.floor(width * scale)}px`;
      el.style.height = `${Math.floor(height * scale)}px`;
      el.dataset.index = String(index);
      stage.appendChild(el);
      return [index, el];
    });
    this.container.replaceChildren(stage);
    this.container.scrollTop = 0;
    this.changed(this.current);
    // 다음·이전 쪽은 미리 준비할 필요가 없을 만큼 빠르므로 보이는 쪽만 그린다.
    return Promise.all(
      slots.map(([index, el]) => {
        const rendering = this.doc.renderInto(index, el);
        this.rendering.set(index, rendering);
        return rendering;
      }),
    );
  }

  /** 그 쪽이 그려질 때까지 기다린다(검색 결과로 옮겨 간 뒤 그려진 글자를 찾을 때 쓴다). */
  whenRendered(index) {
    return (this.rendering.get(index) ?? Promise.resolve()).catch(() => {});
  }

  /** 지금 화면에 있는 그 쪽의 요소(없으면 null) */
  pageElement(index) {
    return this.container.querySelector(`.page[data-index="${index}"]`);
  }

  next() {
    PagedViewer.lastFlipAt = performance.now();
    this.goTo(this.current + (this.mode === 'spread' ? 2 : 1));
  }

  prev() {
    PagedViewer.lastFlipAt = performance.now();
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
        const onUi = e.target instanceof Element && e.target.closest(UI_SELECTOR);
        start = touch && !onUi ? { x: touch.clientX, y: touch.clientY, t: performance.now() } : null;
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
    if (!this.isScrubbing?.()) this.placeThumb?.(index);
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
