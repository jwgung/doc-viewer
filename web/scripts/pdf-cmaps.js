// pdf.js가 글꼴을 내장하지 않은 한글 PDF를 그릴 때 쓰는 CMap만 골라 cmaps/로 내보낸다(약 160KB).
// 전체 CMap(1.7MB)은 중국어·일본어용이 대부분이라 넣지 않는다.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const KOREAN = /^(Adobe-Korea1-.+|KSC.+|UniKS-.+)\.bcmap$/;

export function pdfCmaps() {
  return {
    name: 'pdf-cmaps',
    generateBundle() {
      const dir = join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'cmaps');
      for (const name of readdirSync(dir).filter((f) => KOREAN.test(f))) {
        this.emitFile({ type: 'asset', fileName: `cmaps/${name}`, source: readFileSync(join(dir, name)) });
      }
    },
  };
}
