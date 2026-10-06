# @rhwp/core 성능 패치판 (doc-viewer A1)

npm `@rhwp/core` 0.8.7 대신 쓰는 같은 API의 빌드다. 조판·렌더 결과는 바꾸지 않고 큰 표가 있는 HWP의 계산 낭비만 없앴다.

- 업스트림: https://github.com/edwardkim/rhwp `v0.8.7` (커밋 `1a76570e833917d15817415a53c09ad61ab3203f`, MIT)
- 포크 소스: `/home/capalace/Git/rhwp-fork` 브랜치 `perf/a1-hwp-large-docs` (커밋 `e9b04c5`, `a3dcc43`). 원격에는 올리지 않았다.
- 업스트림 대비 변경: 같은 디렉터리의 `rhwp.patch` (`git diff v0.8.7 HEAD`)

## 원인

314쪽 통계 보고서(`hwp-rhwp-021`, 2017년 기준 시장구조조사)에는 2,195~2,196행짜리 표가 둘 있고 각각 68~69쪽에 걸친다. rhwp는 표를 쪽 단위 조각으로 나누며, 조각마다·행마다 "이 행의 셀"을 찾으려고 표의 **모든 셀**을 다시 훑었다. 행 R·셀 C인 표에서 조각 하나가 O(R×C), 표 하나가 O(쪽×R×C)가 되어 셀 1만 개대 표에서 수억 번 비교했다.

네이티브 프로파일(pprof) 기준 열기 시간(26~28초)의 내역:

| 위치 | 비중 | 내용 |
|---|---|---|
| `typeset/table/continuation/fragment/budget.rs` `stored_row_heights` | 76% | 조각마다 행×셀로 저장 행 높이를 다시 계산 |
| `typeset.rs` `rowbreak_table_has_internal_saved_vpos_reset` | 수정 1 뒤 60% | 스캔마다 행×셀로 "표 안 저장 vpos 되감김" 판정 |
| `layout/table_layout.rs` `native_saved_two_line_row_frame` 등 행별 술어 | 수정 2 뒤 30~40% | 행마다 전체 행 높이 계산·전체 셀 필터 |
| `model/raw_provenance.rs` 본문 봉인 | 수정 3 뒤 약 30% | 열 때 본문 전체를 JSON 직렬화·해시하는 일을 두 번 함 |

렌더(쪽 SVG)에서는 `layout/table_partial.rs`가 부분 표를 그릴 때 **셀마다** `leading_header_rows()`(표 전체 훑기)를 불러 큰 표 쪽 하나에 0.6초가 들었다.

## 바꾼 것

모두 결과가 같은 변환이다(순수 술어의 평가 순서 변경, 같은 값을 한 번만 계산, 같은 순서를 지키는 색인).

1. 저장 행 높이·저장 vpos 되감김·행 선언 높이(`height_measurer.rs`)·선언 폭 초과 행(`model/table.rs`)을 셀 한 번 훑기로 계산
2. `LayoutEngine`에 표 포인터 키 행→셀 색인(`TableRowCells`)을 두고 `cells_in_row()`로 행 셀을 원래 순서대로 돌려준다. 행별 술어(`native_saved_two_line_row_frame`, `row_cut_cell_order`, `whole_fragment_row_uses_measured_height`, `row_uses_reflow_physical_frame`, `row_stored_terminal_zero_origin_cut`, `row_has_declared_stored_frame`, 조판 스캔의 행 판정 등)가 이를 쓴다. 셀 구성만 담고 기존 포인터 키 캐시와 같은 경계(`clear_layout_caches`)에서 비운다
3. 걸친 셀(row_span > 1)이 없는 표는 병합 관련 계산(축소량, 걸침 수요, rowspan 행 표시)을 건너뜀
4. 표 조각 스캔의 "표 안 저장 vpos 되감김" 판정을 표 조판용 엔진에 표 단위로 메모(`memo_table_flag`)
5. 부분 표 렌더에서 제목행 수를 한 번만 구함
6. `DocumentCore::from_bytes` 경로에서 파서 단계의 본문 봉인을 건너뜀. 로드 픽스업 뒤 같은 봉인을 다시 계산해 덮어쓰던 것이라 최종 봉인 값은 같다(DocInfo 봉인은 그대로)

API·JS 글루는 바꾸지 않았다. `rhwp.js`, `rhwp.d.ts`는 npm 0.8.7과 바이트 단위로 같다.

## 결과가 같은지 확인

`spike/renderer-eval/corpus`의 hwp·hwpx 171개(rhwp 표본 121, 정책브리핑 50)를 수정 전·후 네이티브 빌드로 열어 비교했다.

- 쪽 수, 쪽마다 `getPageInfo`, **모든 쪽의 SVG** SHA-256, 최종 봉인(raw provenance) 해시: 171/171 동일
- 하네스(`node scripts/run-eval.mjs --only hwp,hwpx --renderer rhwp --out out/a1-rhwp --corpus <corpus>`, wasm만 이 빌드로 바꿔 실행):
  열림 171/171(hwp 74/74, hwpx 97/97)로 같고, 기준 텍스트가 있는 59개의 본문 재현율이 문서마다 수정 전과 같다
  (재현율 p50 hwp 0.98·hwpx 0.99, ≥0.9 hwp 15/19·hwpx 37/40, 쪽 수 일치 hwp 22/22·hwpx 37/41 — 모두 수정 전과 동일)

## 수치

데스크톱 헤드리스 Chromium, `web/` 빌드의 `viewer.html?fmt=..&src=..`(워커에서 열기 → 첫 쪽 SVG), 전·후를 번갈아 6회씩 잰 중앙값(2026-10-07).

| 문서 | 수정 전 | 수정 후 |
|---|---|---|
| hwp-rhwp-021 (314쪽 통계 보고서) 첫 쪽 | 17.8초 | 2.65초 |
| hwp-rhwp-058 (178쪽 hwpspec) 첫 쪽 | 0.94초 | 0.80초 |
| hwp-korea-kr-001 (3쪽) 첫 쪽 | 0.28초 | 0.27초 (차이 없음) |
| hwpx-korea-kr-005 (4쪽) 첫 쪽 | 0.42초 | 0.41초 (차이 없음) |

하네스(앞 300쪽까지 전부 그림)에서 021은 첫 쪽 20.1초 → 3.8초, 전체 82초 → 9.1초.

네이티브(같은 머신, 열기 = 파싱+전체 조판):

| 문서 | 열기 전 | 열기 후 | 전체 쪽 SVG까지 전 | 후 |
|---|---|---|---|---|
| 021 | 26.3초 | 2.4초 | 99.4초 | 5.8초 |
| 058 | 0.87초 | 0.38초 | 3.0초 | 1.8초 |
| 171개 합계 | 33.1초 | 6.8초 | 130초 | 28초 |

- wasm 메모리: 첫 쪽 시점 021 133.6MB, 058 36.0MB, 021 300쪽을 다 그린 뒤 424MB로 전후 같다. 이번 수정은 계산량만 줄였다.
- wasm 크기: 11,841,530 바이트(npm 11,821,756), gzip -9 4,399,410 바이트(npm 4,392,924).

## 빌드 방법

```bash
cd /home/capalace/Git/rhwp-fork          # rust-toolchain.toml 이 1.93.1 을 고른다
wasm-pack build --target web --release --out-dir pkg -- --locked   # wasm-pack 0.15.0, wasm-bindgen-cli 0.2.127
cp pkg/rhwp.js pkg/rhwp_bg.wasm pkg/rhwp.d.ts pkg/rhwp_bg.wasm.d.ts pkg/LICENSE <doc-viewer>/web/vendor/rhwp-core/
```

업스트림 npm 배포와 같은 절차(`wasm-pack build --target web --release`, 기본 `wasm-opt -O`)다. `package.json`은 npm 패키지의 것을 따르되 버전만 `0.8.7-docviewer.1`로 표시했다.

포크는 샘플(수 GB)을 빼고 받았다: `git clone --filter=blob:none --depth 1 --branch v0.8.7 --no-checkout` 뒤 non-cone sparse-checkout으로 `src/ crates/ bindings/ tests/ vendor/ saved/ ...`만 꺼냈다.
