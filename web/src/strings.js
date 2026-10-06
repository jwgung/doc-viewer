// 웹 렌더러가 화면에 띄우는 문구. 다국어를 지원할 때 여기에 언어별 묶음을 더한다.
// WebView의 navigator.language는 기기 언어를 따른다.
const STRINGS = {
  ko: {
    renderFailed: '이 문서를 표시하지 못했습니다.',
    rowsLimited: (shown, total) => `처음 ${shown}행만 표시합니다 (전체 ${total}행).`,
    passwordPrompt: '암호가 걸린 문서입니다. 암호를 입력하세요.',
    passwordWrong: '암호가 맞지 않습니다. 다시 입력하세요.',
    goToPage: (count) => `이동할 쪽 번호 (1-${count})`,
    go: '이동',
    ok: '확인',
    cancel: '취소',
  },
};

export const t = STRINGS[navigator.language?.slice(0, 2)] ?? STRINGS.ko;
