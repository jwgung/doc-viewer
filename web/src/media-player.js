// 문서 안 동영상·소리 재생기. 렌더러는 그린 쪽 안에 매체 자리만 표시하고, 재생은 이 모듈이 맡는다.
//   렌더러가 할 일: 매체 자리 요소에 data-media='{"kind":"video"|"audio","mime":…,"external":…, …}'를 달고
//   (요소 크기 = 화면에서 매체가 차지하는 자리), 쪽을 그린 뒤 attachMediaPlayers(쪽 요소, resolveUrl)를 부른다.
//   resolveUrl(info)는 data-media 정보를 받아 재생할 주소(blob: 등)를 돌려준다. 누를 때만 부르므로 매체 데이터는 그때 만든다.
// 자리는 쪽 요소 기준 백분율로 얹어, 쪽 칸 크기가 바뀌어도(줄이기·키우기·창 크기) 다시 재지 않고 따라간다.
// 쪽을 다시 그리거나 화면에서 뺄 때(replaceChildren·innerHTML) 재생기도 함께 사라진다. 문서에서 빠진 매체 요소는
// 브라우저가 멈춘다(HTML 표준의 media element 제거 규칙).
import { t } from './strings.js';

// 쪽 뷰어(paged-viewer.js)와 앱(main.js)은 window에서 탭·스와이프·휠·키를 받아 쪽을 넘기거나 상단바를 토글한다.
// 재생 단추·재생기를 만지는 것은 문서 탭이 아니므로 window까지 올라가지 않게 막는다.
const STOP_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchmove', 'touchend', 'wheel', 'keydown'];

/** 쪽 요소 안의 매체 자리마다 재생 단추를 얹는다. 같은 쪽에 다시 부르면 앞 단추를 지우고 새로 얹는다. */
export function attachMediaPlayers(pageEl, resolveUrl) {
  pageEl.querySelector(':scope > .media-layer')?.remove();
  const spots = [...pageEl.querySelectorAll('[data-media]')];
  if (!spots.length) return;
  const layer = document.createElement('div');
  layer.className = 'media-layer';
  pageEl.appendChild(layer);
  // 쪽 칸이 아직 배치 전이면(크기 0) 다음 프레임에 잰다.
  const place = (tries) => {
    const page = pageEl.getBoundingClientRect();
    if (!pageEl.isConnected || !layer.isConnected) return;
    if (!page.width || !page.height) {
      if (tries > 0) requestAnimationFrame(() => place(tries - 1));
      return;
    }
    for (const spot of spots) {
      let info;
      try {
        info = JSON.parse(spot.dataset.media);
      } catch {
        continue;
      }
      if (info?.kind !== 'video' && info?.kind !== 'audio') continue;
      const box = (spot.querySelector('rect') ?? spot).getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const slot = document.createElement('div');
      slot.className = 'media-slot';
      slot.dataset.kind = info.kind;
      Object.assign(slot.style, {
        left: `${((box.left - page.left) / page.width) * 100}%`,
        top: `${((box.top - page.top) / page.height) * 100}%`,
        width: `${(box.width / page.width) * 100}%`,
        height: `${(box.height / page.height) * 100}%`,
      });
      layer.appendChild(slot);
      showButton(slot, info, resolveUrl);
    }
  };
  place(10);
}

function guard(el) {
  for (const type of STOP_EVENTS) el.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
}

function showButton(slot, info, resolveUrl) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'media-play';
  button.setAttribute('aria-label', info.kind === 'audio' ? t.mediaPlayAudio : t.mediaPlayVideo);
  guard(button);
  button.addEventListener('click', () => play(slot, info, resolveUrl));
  slot.replaceChildren(button);
}

function showNotice(slot, info, resolveUrl, message) {
  const notice = document.createElement('button');
  notice.type = 'button';
  notice.className = 'media-notice';
  notice.textContent = message;
  guard(notice);
  // 안내를 누르면 닫고 재생 단추로 돌아간다.
  notice.addEventListener('click', () => showButton(slot, info, resolveUrl));
  slot.replaceChildren(notice);
}

function play(slot, info, resolveUrl) {
  // 오프라인 앱이라 인터넷 주소의 매체는 CSP(media-src)가 막는다.
  if (info.external) return showNotice(slot, info, resolveUrl, t.mediaExternal);
  const media = document.createElement(info.kind === 'audio' ? 'audio' : 'video');
  // WMV·AVI 같은 형식은 브라우저가 풀지 못한다(canPlayType이 빈 문자열).
  if (info.mime && !media.canPlayType(info.mime)) return showNotice(slot, info, resolveUrl, t.mediaUnsupported);
  let url = null;
  try {
    url = resolveUrl(info);
  } catch {
    url = null;
  }
  if (!url) return showNotice(slot, info, resolveUrl, t.mediaMissing);
  // 한 번에 하나만 소리 낸다.
  for (const other of document.querySelectorAll('.media-slot video, .media-slot audio')) other.pause();
  media.controls = true;
  media.autoplay = true;
  media.playsInline = true;
  media.setAttribute('playsinline', '');
  media.preload = 'auto';
  // Android 앱의 WebView는 전체 화면(WebChromeClient.onShowCustomView)을 열지 않아 전체 화면 단추가 듣지 않는다. 숨긴다.
  media.setAttribute('controlslist', 'nofullscreen nodownload');
  media.disablePictureInPicture = true;
  media.addEventListener('error', () => showNotice(slot, info, resolveUrl, t.mediaFailed), { once: true });
  guard(media);
  media.src = url;
  slot.replaceChildren(media);
  // Android WebView는 사용자 동작으로 부른 play()만 소리 있는 재생을 허락한다(autoplay 속성만으로는 멈춘 채 뜬다).
  // 누른 처리기 안에서 바로 부른다. 막히면 재생기 단추로 다시 누르면 된다.
  media.play()?.catch(() => {});
}
