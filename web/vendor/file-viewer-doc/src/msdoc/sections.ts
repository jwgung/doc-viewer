// doc-viewer: 구역(Section) 정보. PlcfSed가 구역 경계(CP)를, 각 구역의 SEPX가 구역 속성을 담는다.
// [MS-DOC] 2.8.26 PlcfSed, 2.8.? Sed, 2.9.253 Sepx. Word 6/95는 SEPX의 sprm이 1바이트 체계다.
import { BinaryReader } from '../core/binary.js';
import { decodeGrpprl } from './sprm.js';
import { decodeGrpprl6 } from './sprm6.js';
import type { DecodedProperty, ParsedFib, SectionInfo } from '../types.js';

// Word 97 이후 구역 sprm(2바이트). sprm.ts의 decodeSprm은 구역 sprm을 이름 없이 돌려주므로 여기서 이름을 붙인다.
const SECTION_SPRMS_97: Record<number, string> = {
  0x3009: 'breakType',
  0x300a: 'titlePage',
  0x500b: 'columns',
  0x300e: 'pageNumberFormat',
  0x3011: 'pageNumberRestart',
  0x501c: 'pageNumberStart',
  0x301d: 'orientation',
  0xb01f: 'pageWidth',
  0xb020: 'pageHeight',
  0xb021: 'marginLeft',
  0xb022: 'marginRight',
  0x9023: 'marginTop',
  0x9024: 'marginBottom',
  0xb017: 'headerTop',
  0xb018: 'footerBottom',
  0x3014: 'headerFlags',
};

function sectionPropsFromGrpprl(bytes: Uint8Array, start: number, end: number, version: number): Record<string, number> {
  const out: Record<string, number> = {};
  const props: DecodedProperty[] = version === 8
    ? decodeGrpprl(bytes, start, end)
    : decodeGrpprl6(bytes, start, end, { version: version === 2 ? 2 : 6 });
  for (const prop of props) {
    if (version === 8) {
      const name = typeof prop.raw === 'number' ? SECTION_SPRMS_97[prop.raw] : undefined;
      if (!name || !prop.operandBytes) continue;
      const op = prop.operandBytes;
      const value = op.length >= 2 ? (op[0] ?? 0) | ((op[1] ?? 0) << 8) : op[0] ?? 0;
      // 0x9xxx(부호 있는 2바이트) 여백은 음수일 수 있다(머리말과 겹치게 하는 값). 크기만 쓴다.
      out[name] = name === 'columns' ? value + 1 : value > 0x7fff ? value - 0x10000 : value;
      continue;
    }
    if (prop.kind !== 'section') continue;
    out[prop.name] = typeof prop.value === 'boolean' ? (prop.value ? 1 : 0) : Number(prop.value);
  }
  return out;
}

export function parseSections(
  wordBytes: Uint8Array,
  tableBytes: Uint8Array,
  fib: ParsedFib,
  mainTextLength: number,
): SectionInfo[] {
  const version = fib.version ?? 8;
  const fc = fib.fibRgFcLcb.fcPlcfSed as number | undefined;
  const lcb = fib.fibRgFcLcb.lcbPlcfSed as number | undefined;
  const sections: SectionInfo[] = [];
  // SED는 Word 6 이상 12바이트, Word 2는 6바이트(fn 2 + fcSepx 4)다(LibreOffice WW8PLCFx_SEPX).
  const sedSize = version === 2 ? 6 : 12;
  if (fc != null && lcb != null && lcb >= 4 + sedSize && fc + lcb <= tableBytes.length) {
    const reader = new BinaryReader(tableBytes.subarray(fc, fc + lcb));
    const count = Math.floor((lcb - 4) / (4 + sedSize));
    const cps: number[] = [];
    for (let i = 0; i <= count; i += 1) cps.push(reader.i32(i * 4));
    const sedStart = (count + 1) * 4;
    for (let i = 0; i < count; i += 1) {
      const cpStart = Math.max(0, cps[i] ?? 0);
      const cpEnd = Math.min(mainTextLength, Math.max(cpStart, cps[i + 1] ?? mainTextLength));
      const fcSepx = reader.u32(sedStart + i * sedSize + 2);
      let props: Record<string, number> = {};
      if (fcSepx !== 0xffffffff && fcSepx + 2 <= wordBytes.length) {
        const cb = version === 2 ? wordBytes[fcSepx] ?? 0 : new BinaryReader(wordBytes).u16(fcSepx);
        const start = fcSepx + (version === 2 ? 1 : 2);
        if (cb > 0 && cb < 0x8000) props = sectionPropsFromGrpprl(wordBytes, start, Math.min(wordBytes.length, start + cb), version);
      }
      sections.push(toSection(sections.length, cpStart, cpEnd, props));
    }
  }
  if (!sections.length) sections.push(toSection(0, 0, mainTextLength, {}));
  // 마지막 구역은 본문 끝까지 이어 붙인다(PlcfSed의 마지막 CP가 본문 끝 +1인 경우가 있다).
  const last = sections[sections.length - 1]!;
  last.cpEnd = Math.max(last.cpEnd, mainTextLength);
  return sections;
}

function toSection(index: number, cpStart: number, cpEnd: number, props: Record<string, number>): SectionInfo {
  const positive = (value: number | undefined) => (value != null && value > 0 ? value : undefined);
  return {
    index,
    cpStart,
    cpEnd,
    // bkc 기본값은 '새 쪽'(2)이다.
    breakType: props.breakType ?? 2,
    titlePage: Boolean(props.titlePage),
    pageWidthTwips: positive(props.pageWidth),
    pageHeightTwips: positive(props.pageHeight),
    marginLeftTwips: positive(props.marginLeft),
    marginRightTwips: positive(props.marginRight),
    marginTopTwips: props.marginTop != null ? Math.abs(props.marginTop) : undefined,
    marginBottomTwips: props.marginBottom != null ? Math.abs(props.marginBottom) : undefined,
    columns: positive(props.columns),
    pageNumberStart: positive(props.pageNumberStart),
    pageNumberRestart: Boolean(props.pageNumberRestart),
    pageNumberFormat: props.pageNumberFormat,
    headerFlags: props.headerFlags,
    headers: {},
    footers: {},
  };
}
