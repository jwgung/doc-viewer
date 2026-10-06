// 웹 렌더러가 화면에 띄우는 문구. 다국어를 지원할 때 여기에 언어별 묶음을 더한다.
// WebView의 navigator.language는 기기 언어를 따른다.
const STRINGS = {
  ko: {
    renderFailed: '이 문서를 표시하지 못했습니다.',
    fallbackNotice: '원래 모양으로 표시하지 못해 본문 글자만 보여 드립니다.',
    fallbackSlide: (n) => `슬라이드 ${n}`,
    encryptedUnsupported: '암호가 걸린 문서입니다. 이 형식의 암호 문서는 아직 열 수 없습니다.',
    passwordRequired: '암호를 입력해야 볼 수 있는 문서입니다.',
    rowsLimited: (shown, total) => `처음 ${shown}행만 표시합니다 (전체 ${total}행).`,
    passwordTitle: '암호 입력',
    passwordPrompt: '암호가 걸린 문서입니다.',
    passwordWrong: '암호가 맞지 않습니다. 다시 입력하세요.',
    goToPageTitle: '쪽 이동',
    go: '이동',
    ok: '확인',
    cancel: '취소',
  },
};

export const t = STRINGS[navigator.language?.slice(0, 2)] ?? STRINGS.ko;
