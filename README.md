# Doc Viewer

PDF·한글(hwp·hwpx)·Word·Excel·PowerPoint 문서를 인터넷 없이 보는 데스크톱 문서 뷰어입니다. Windows·macOS·Linux에서 씁니다.
문서는 컴퓨터 밖으로 나가지 않습니다. 서버 변환이나 상용 엔진을 쓰지 않고, 앱 안의 웹 렌더러가 직접 그립니다.

Android 앱은 [doc-viewer-mobile](https://github.com/jwgung/doc-viewer-mobile)에 있습니다. 두 앱은 같은 웹 렌더러(`web/`)를 씁니다.

## 내려받기

[Releases](https://github.com/jwgung/doc-viewer/releases)에서 운영체제에 맞는 파일을 받습니다.

| 운영체제 | 파일 | 처음 열 때 |
|---|---|---|
| Windows 10·11 | `…-windows-setup.exe` 또는 `…-windows.msi` | 서명이 없어 SmartScreen이 막으면 '추가 정보 → 실행' |
| macOS 11 이상 | `…-macos.dmg` (Apple 실리콘·Intel 공용) | 서명이 없어 경고가 뜨면 앱을 우클릭 → '열기' |
| Linux (Ubuntu 22.04 이상 등) | `…-linux-amd64.deb` 또는 `…-linux-amd64.AppImage` | AppImage는 실행 권한을 주고 실행 |

Windows에 WebView2가 없으면(구형 Windows 10) 설치할 때 한 번 내려받으므로 그때만 인터넷이 필요합니다.
macOS·Linux 판은 아직 사용자 확인 전입니다. 문제가 있으면 Issues에 알려 주세요.

## 여는 문서

- pdf, hwp, hwpx, doc, docx, xls, xlsx, csv, ppt, pptx
- 매크로 포함·서식·슬라이드 쇼 파일(docm·dotx·xlsm·ppsx 등), 한글 서식(hwt), tsv, txt, md, 로그, json·xml·toml·yaml
- 그 밖의 글자 파일(설정·소스 코드·자막·diff)은 텍스트로
- 확장자가 실제 형식과 달라도 내용으로 형식을 가립니다.
- pptx 안 동영상·소리는 누르면 그 자리에서 재생합니다(mp4·mp3처럼 WebView가 푸는 형식).

## 쓰는 법

- 왼쪽 폴더 탐색기에서 폴더를 열고 파일을 누르면 탭으로 열립니다. 파일을 창에 끌어다 놓아도 됩니다.
- 화면 나누기(최대 4칸): 탭이나 파일을 문서의 위·아래·왼쪽·오른쪽 가장자리로 끌어 놓습니다. 칸 사이 경계선을 끌어 크기를 바꿉니다.
- 같은 문서를 여러 탭에: 탭 우클릭 '탭 복제', 또는 Ctrl(macOS는 Option)을 누른 채 탭을 끌어 놓기.
- 닫은 탭 다시 열기: Ctrl+Shift+T.
- 확대·축소: Ctrl+휠, Ctrl+= / Ctrl+-, Ctrl+0. 한 쪽씩·두 쪽씩 보기에서는 휠로 쪽을 넘깁니다.
- 탐색기 우클릭으로 이름 바꾸기(F2)·휴지통(Del)·위치 열기·경로 복사.
- 다시 켜면 열려 있던 탭·보던 쪽·확대·나눈 화면이 되살아납니다.

## 직접 빌드하기

필요한 것: Node.js 24, pnpm 10, Rust(stable). Linux는 `libwebkit2gtk-4.1-dev librsvg2-dev patchelf`도 필요합니다.

```bash
pnpm --dir web install
pnpm --dir desktop install
cd desktop
pnpm tauri dev      # 개발 실행
pnpm tauri build    # 설치 파일
```

## 구조

- `web/`: 공용 웹 렌더러(pdf.js, rhwp, web-ppt 사본 등). Android 앱과 같은 코드입니다.
- `desktop/`: Tauri 셸. 탭·폴더 탐색기·분할 화면 같은 화면은 `desktop/src/`, 파일 읽기·형식 판별·문서 내주기(`doc` 스킴)는 `desktop/src-tauri/`.
- 배포: `v*` 태그를 올리면 Release 워크플로가 세 운영체제 설치 파일을 만들어 Release에 붙입니다.

라이선스와 고지는 [NOTICE.md](NOTICE.md)를 보세요.
