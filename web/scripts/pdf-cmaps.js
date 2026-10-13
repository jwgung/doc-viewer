// pdf.js가 글꼴을 내장하지 않은 PDF를 그릴 때 쓰는 CMap만 골라 cmaps/로 내보낸다.
// 한글은 전부(약 230KB), 일본어·중국어는 자주 쓰는 인코딩만(약 390KB: 유니코드 UCS2·UTF16, 윈도 코드페이지
// 932·936·950과 EUC·JIS, 글자 번호 → 유니코드 표, 가로·세로). 없으면 그 글자가 빈칸으로 나온다. 전체(1.7MB)는 넣지 않는다.
// JPEG 2000(JPX)·JBIG2 그림 디코더 wasm도 pdf-wasm/으로 내보낸다(약 350KB). 없으면 그 그림이 빈칸으로 나온다
// (스캔·인쇄용으로 만든 PDF에 흔하다). 색 관리(qcms)와 wasm 없는 환경용 JS 대체본은 넣지 않는다.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const KOREAN = /^(Adobe-Korea1-.+|KSC.+|UniKS-.+)\.bcmap$/;
// 다른 표를 끌어 쓰는(usecmap) 것까지 이 목록 안에서 닫혀 있다. 이름 없는 ''은 JIS(ISO-2022-JP)의 H·V다.
const CJK = new Set([
  ...['UniJIS-UCS2', 'UniJIS-UTF16', '90ms-RKSJ', '90msp-RKSJ', 'EUC', ''],
  ...['UniGB-UCS2', 'UniGB-UTF16', 'GBK-EUC', 'GBKp-EUC', 'GB-EUC'],
  ...['UniCNS-UCS2', 'UniCNS-UTF16', 'ETen-B5', 'B5pc'],
].flatMap((name) => (name ? [`${name}-H.bcmap`, `${name}-V.bcmap`] : ['H.bcmap', 'V.bcmap'])).concat(['Adobe-Japan1-UCS2.bcmap', 'Adobe-GB1-UCS2.bcmap', 'Adobe-CNS1-UCS2.bcmap']));
const WASM = ['openjpeg.wasm', 'jbig2.wasm'];

export function pdfCmaps() {
  return {
    name: 'pdf-cmaps',
    generateBundle() {
      const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
      const dir = join(root, 'cmaps');
      for (const name of readdirSync(dir).filter((f) => KOREAN.test(f) || CJK.has(f))) {
        this.emitFile({ type: 'asset', fileName: `cmaps/${name}`, source: readFileSync(join(dir, name)) });
      }
      for (const name of WASM) {
        this.emitFile({ type: 'asset', fileName: `pdf-wasm/${name}`, source: readFileSync(join(root, 'wasm', name)) });
      }
    },
  };
}
