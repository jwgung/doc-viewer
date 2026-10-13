// 쪽이 있는 문서(hwp·ppt·pdf·docx·doc)를 세 가지 방식으로 보여준다.
//   scroll: 쪽을 세로로 이어 붙이고 화면 근처의 쪽만 그린다.
//   page:   한 쪽을 화면에 맞춰 보여주고 스와이프나 좌우 탭으로 넘긴다.
//   spread: 두 쪽을 나란히 보여주고 두 쪽씩 넘긴다.
// 연속 스크롤은 처음 크기보다 작게 오므려(줄이기) 여러 쪽을 한 화면에 볼 수 있다. WebView 확대는 쪽이 화면 너비에
// 맞은 처음 크기 밑으로 줄지 않으므로, 처음 크기에서 더 오므리면 쪽 칸을 직접 줄여 한 줄에 여러 쪽을 놓는다.
// 맞춤(fit)은 두 가지다.
//   width: 쪽 너비를 화면 너비에 맞춘다(화면 가득). 쪽이 화면보다 길면 세로로 스크롤한다.
//   page:  쪽 전체가 한 화면에 들어오게 줄인다(용지 맞춤).
// doc은 { count, sizes: [{width, height}], renderInto(index, element) } 형태다.
// renderInto는 element 크기에 맞춰 그 쪽을 그리고, 끝나면 resolve한다.
// 쪽 크기를 그려 봐야 아는 렌더러(docx·doc)는 sizes에 추정값을 주고, 한 쪽씩·두 쪽씩 보기가 크기를 읽기 전에
// doc.measure(index)(선택)로 정확한 크기를 돌려주며, 연속 스크롤에서는 그린 뒤 resizePage로 자리를 바로잡는다.
// 뒤에서 쪽을 나누는 렌더러(docx·doc)는 다 셀 때까지 doc.complete가 false이고(쪽 번호는 '1 / …'), 쪽이 늘면
// sizes에 더한 뒤 grow()를 부른다. doc.paginated는 다 나누면 풀리는 약속이다(검색·인쇄가 기다린다).
import { openSheet } from './sheet.js';
import { t } from './strings.js';

const KEEP_RENDERED = 8;
const SWIPE_MIN_PX = 50;
const EDGE_TAP_RATIO = 0.3;
const THUMB_PX = 44;
// 연속 스크롤에서 줄일 수 있는 가장 작은 비율(한 줄에 두 쪽)
const MIN_SHRINK = 0.5;
// 높이가 너비의 이 배를 넘는 쪽은 용지 한 장이 아니라 쪽 나누기 없이 길게 이어진 문서(doc·docx)다.
// 용지 맞춤으로 한 화면에 줄이면 읽을 수 없으므로 너비에 맞추고 세로로 스크롤한다.
const LONG_PAGE_RATIO = 2;
// 이 요소 위에서 시작한 터치는 쪽 넘기기 제스처로 보지 않는다.
const UI_SELECTOR = '.scrubber, .page-indicator, .notes-panel, .sheet-backdrop';

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
    /** 연속 스크롤에서 쪽 칸을 줄인 비율(1이면 처음 크기) */
    this.shrink = 1;
    /** 화면 아래를 가린 높이(발표자 노트 칸). 쪽을 맞출 때 그만큼 뺀다. */
    this.bottomInset = 0;
    /** 쪽 번호 → 그 쪽을 그리는 중인(또는 다 그린) 약속 */
    this.rendering = new Map();
    // 쪽 번호는 늘 보여주고, 누르면 쪽 번호를 입력해 바로 이동한다.
    this.indicator = document.createElement('button');
    this.indicator.type = 'button';
    this.indicator.className = 'page-indicator';
    this.indicator.addEventListener('click', () => this.askPage());
    document.body.appendChild(this.indicator);
    this.buildScrubber();
    // 화면 크기가 바뀌면(회전 등) 쪽 크기를 다시 맞춘다. 연속 스크롤·화면 가득은 칸 크기를 CSS 비율이 따라가므로,
    // 폭이 달라진 쪽만 그 폭으로 다시 그린다(PDF 그림 해상도·글자 층 위치가 그린 폭에 묶여 있다).
    // 검색 중 높이만 바뀐 것(키보드가 열리고 닫힘)은 무시한다: 다시 그리면 검색 강조와 스크롤 위치를 잃는다.
    let lastWidth = innerWidth;
    addEventListener(
      'resize',
      debounce(() => {
        const widthChanged = innerWidth !== lastWidth;
        lastWidth = innerWidth;
        if (!widthChanged && document.body.classList.contains('searching')) return;
        if (this.mode !== 'scroll' || this.fit === 'page') this.render();
        else this.redrawResized?.();
      }, 200),
    );
    this.bindGestures();
  }

  /** 첫 쪽이 그려지면 resolve한다. */
  render() {
    this.observer?.disconnect();
    this.slots = null;
    this.rendering.clear(); // 예전 배치의 약속을 남기면 새 배치에서 '이미 그렸다'고 잘못 알린다
    this.container.replaceChildren();
    this.container.dataset.mode = this.mode;
    this.container.dataset.fit = this.fit;
    return this.mode === 'scroll' ? this.renderScroll() : this.renderFlip();
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.setShrink(1);
    return this.render();
  }

  /** 맞춤을 적용한다. 같은 맞춤이어도 다시 배치해, 앱이 확대 비율을 되돌린 뒤 원래 모양으로 돌아오게 한다. */
  applyFit(fit) {
    this.fit = fit;
    this.setShrink(1);
    return this.render();
  }

  /** 화면 아래를 가린 높이가 바뀌었다. 화면 높이에 맞추는 배치(한 쪽씩·두 쪽씩, 용지 맞춤)만 다시 맞춘다. */
  setBottomInset(height) {
    if (height === this.bottomInset) return;
    this.bottomInset = height;
    // 아직 처음 그리기 전이면(노트 칸을 켠 채 열 때) 처음 그릴 때 이 높이로 맞춘다.
    if (this.container.dataset.mode && (this.mode !== 'scroll' || this.fit === 'page')) return this.render();
  }

  /** 쪽을 맞출 화면 높이 */
  availableHeight() {
    return innerHeight - 16 - this.bottomInset;
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
      suffix: `/ ${this.total()}`,
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
      const ratio = Math.min(1, Math.max(0, (y - rect.top - THUMB_PX / 2) / Math.max(1, rect.height - THUMB_PX)));
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
  sizeScrollPage(el, { width, height }, fitWidth = this.container.clientWidth - 16, fitHeight = this.availableHeight()) {
    el.style.aspectRatio = `${width} / ${height}`;
    // 줄인 비율(--shrink)은 CSS 변수로 곱해, 오므리는 동안 쪽마다 크기를 다시 매기지 않는다.
    if (this.fit === 'page' && height / width <= LONG_PAGE_RATIO)
      el.style.width = `calc(${Math.floor(Math.min(fitWidth, (fitHeight * width) / height))}px * var(--shrink, 1))`;
    else el.style.width = '';
  }

  /**
   * 연속 스크롤의 쪽 칸을 줄인다. 손가락 사이(focusY) 아래의 쪽 자리가 그대로 있게 화면을 옮긴다.
   * 줄인 동안에는 WebView 확대를 막아(touch-action) 벌리기를 이쪽에서 받아 처음 크기로 되돌린다.
   */
  setShrink(value, focusY = innerHeight / 2) {
    const shrink = Math.min(1, Math.max(MIN_SHRINK, value));
    if (shrink === this.shrink) return;
    const anchor = this.slots?.length ? this.pageAt(focusY) : null;
    const before = anchor?.getBoundingClientRect();
    this.shrink = shrink;
    this.container.style.setProperty('--shrink', String(shrink));
    if (shrink < 1) this.container.dataset.shrunk = '';
    else delete this.container.dataset.shrunk;
    document.documentElement.style.touchAction = shrink < 1 ? 'pan-x pan-y' : '';
    if (anchor) {
      const after = anchor.getBoundingClientRect();
      scrollBy(0, after.top + ((focusY - before.top) / before.height) * after.height - focusY);
    }
  }

  /** 화면 높이 y에 걸친 쪽 칸(없으면 가장 가까운 쪽) */
  pageAt(y) {
    let nearest = null;
    let distance = Infinity;
    for (const el of this.slots) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom < y - innerHeight) continue;
      if (rect.top > y + innerHeight) break;
      const d = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      if (d < distance) [nearest, distance] = [el, d];
      if (d === 0) break;
    }
    return nearest;
  }

  /** 렌더러가 그려 보고서야 쪽 크기를 알았을 때, 연속 스크롤 자리를 실제 크기로 바로잡는다. */
  resizePage(index, size) {
    this.doc.sizes[index] = size;
    const el = this.slots?.[index];
    if (el) this.sizeScrollPage(el, size);
  }

  /** 뒤에서 쪽을 나누는 문서의 쪽이 늘었거나 다 셌다. 연속 스크롤이면 새 쪽 자리를 붙이고, 쪽 번호·손잡이를 고친다. */
  grow() {
    if (this.slots) this.addSlots();
    // 두 쪽씩 보기에서 짝 쪽이 아직 나뉘지 않아 한 쪽만 그렸으면, 짝 쪽이 생긴 지금 다시 그린다.
    else if (this.mode === 'spread' && this.current + 1 < this.doc.count && !this.pageElement(this.current + 1)) this.renderFlip();
    if (!this.placeThumb) this.buildScrubber();
    this.showIndicator();
    if (!this.isScrubbing?.()) this.placeThumb?.(this.current);
  }

  /** 전체 쪽 수. 아직 세는 중이면 '…'. */
  total() {
    return this.doc.complete === false ? '…' : String(this.doc.count);
  }

  goTo(index) {
    const step = this.mode === 'spread' ? 2 : 1;
    const target = Math.max(0, Math.min(this.doc.count - 1, index));
    if (this.mode === 'scroll') {
      this.slots?.[target]?.scrollIntoView();
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
    this.slots = [];
    const pages = this.slots;
    const wanted = new Set();
    // 처음 보일 쪽을 먼저 다 그린 뒤에 둘레 쪽을 그린다. 같이 그리면 렌더러(pdf.js 워커·HWP 워커)를 나눠 써서
    // 첫 쪽이 늦게 뜬다(SM-P200에서 PDF 첫 쪽이 위아래 쪽까지 함께 그리느라 늦었다).
    const start = this.current;
    let first = null;
    // 쪽은 그릴 때의 칸 폭에 맞춰 그린다(PDF 그림 해상도, 글자 층 위치, docx 줄임 비율). 그린 폭을 적어 두고
    // 줄이기가 끝나면 폭이 달라진 쪽을 다시 그린다.
    // 같은 쪽을 다시 그리면 앞 그리기가 끝난 뒤에 시작한다: 늦게 끝난 옛 그리기가 새 폭의 결과를 덮지 않게.
    const draw = (index) => {
      const el = pages[index];
      const rendering = (el.drawing ?? Promise.resolve()).catch(() => {}).then(() => this.doc.renderInto(index, el));
      el.drawing = rendering;
      el.dataset.drawnWidth = String(el.clientWidth);
      this.rendering.set(index, rendering);
      return rendering;
    };
    // 화면 가까이의 쪽만 바로 다시 그리고, 먼 쪽은 지워 두어 다시 보일 때 새 폭으로 그리게 한다.
    this.redrawResized = () => {
      for (const index of wanted) {
        const el = pages[index];
        // 아직 그리기 전(앞 쪽을 기다리는 중)이면 그때의 폭으로 그려지므로 건너뛴다.
        if (!el.dataset.drawnWidth || Math.abs(el.clientWidth - Number(el.dataset.drawnWidth)) <= 2) continue;
        const rect = el.getBoundingClientRect();
        if (rect.bottom > -innerHeight && rect.top < innerHeight * 2) draw(index);
        else {
          wanted.delete(index);
          el.replaceChildren();
        }
      }
    };
    // 그리기를 기다리는 동안에도 약속을 바로 걸어 둔다: 검색·목차 이동은 goTo 직후 whenRendered로 그 쪽을 기다린다.
    const show = (index) => {
      if (wanted.has(index)) return this.rendering.get(index);
      wanted.add(index);
      const task = (async () => {
        if (index !== start && first) await first.catch(() => {});
        // 그 사이 다른 배치로 바뀌었거나(보기 방식 전환) 이 쪽을 지웠으면 그리지 않는다.
        if (!wanted.has(index) || this.slots !== pages) return;
        const rendering = draw(index);
        if (index === start && !first) first = rendering;
        await rendering;
        // 줄여서 한 화면에 쪽이 많이 보이면 그만큼 더 남겨 둔다(보이는 쪽을 지웠다 다시 그리지 않게).
        if (wanted.size <= Math.ceil(KEEP_RENDERED / this.shrink ** 2)) return;
        const farthest = [...wanted].sort((a, b) => Math.abs(b - index) - Math.abs(a - index))[0];
        wanted.delete(farthest);
        pages[farthest].replaceChildren();
      })();
      this.rendering.set(index, task);
      return task;
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
    this.addSlots();
    pages[this.current]?.scrollIntoView();
    // 시작 쪽이 곧 보이는 쪽이면 관찰자가 바뀜을 알리지 않으므로 쪽 번호를 직접 채운다.
    this.changed(this.current);
    return pages.length ? show(this.current) : Promise.resolve();
  }

  /** 연속 스크롤의 쪽 자리를 doc.count까지 붙인다(처음에, 그리고 쪽이 늘 때마다). */
  addSlots() {
    const fitWidth = this.container.clientWidth - 16;
    const fitHeight = this.availableHeight();
    for (let index = this.slots.length; index < this.doc.count; index++) {
      const el = document.createElement('div');
      el.className = 'page';
      this.sizeScrollPage(el, this.doc.sizes[index], fitWidth, fitHeight);
      el.dataset.index = String(index);
      this.container.appendChild(el);
      this.observer.observe(el);
      this.slots.push(el);
    }
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
    const availHeight = this.availableHeight();
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
    this.bindShrink();
    addEventListener('keydown', (e) => {
      if (this.mode === 'scroll') return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') this.next();
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') this.prev();
    });
  }

  /**
   * 연속 스크롤의 줄이기. WebView 확대가 처음 크기(1)일 때 두 손가락을 오므리면 쪽 칸을 줄이고, 벌리면 되돌린다.
   * WebView가 확대한 상태에서는 그쪽에 맡기고, 처음 크기로 돌아온 그 자리부터 이어서 줄인다.
   */
  bindShrink() {
    let pinch = null;
    const distance = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const focusY = (touches) => (touches[0].clientY + touches[1].clientY) / 2;
    let frame = 0;
    addEventListener(
      'touchstart',
      (e) => {
        if (this.mode !== 'scroll' || e.touches.length !== 2) return;
        pinch = { from: distance(e.touches), shrink: this.shrink };
      },
      { passive: true },
    );
    addEventListener(
      'touchmove',
      (e) => {
        if (!pinch || e.touches.length !== 2) return;
        const now = distance(e.touches);
        if ((visualViewport?.scale ?? 1) > 1.01) {
          pinch = { from: now, shrink: this.shrink };
          return;
        }
        const target = (pinch.shrink * now) / pinch.from;
        const y = focusY(e.touches);
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => this.setShrink(target, y));
        pinch.moved = true;
      },
      { passive: true },
    );
    addEventListener(
      'touchend',
      (e) => {
        if (!pinch || e.touches.length >= 2) return;
        const moved = pinch.moved;
        pinch = null;
        if (moved) requestAnimationFrame(() => this.redrawResized?.());
      },
      { passive: true },
    );
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
    this.showIndicator();
    if (!this.isScrubbing?.()) this.placeThumb?.(index);
    this.onPageChange?.(index);
  }

  showIndicator() {
    const index = this.current;
    const last = this.mode === 'spread' ? Math.min(index + 2, this.doc.count) : index + 1;
    this.indicator.textContent = last > index + 1 ? `${index + 1}-${last} / ${this.total()}` : `${index + 1} / ${this.total()}`;
  }
}

function debounce(fn, ms) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
