// doc-viewer: 번호 매기기·글머리 기호(Word 97 이상).
// [MS-DOC] 2.9.188 PlfLst / 2.9.147 LSTF / 2.9.150 LVL / 2.9.151 LVLF / 2.9.183 PlfLfo / 2.9.131 LFO / 2.9.133 LFOLVL
// 번호 형식은 [MS-OSHARED] 2.2.1.3 MSONFC를 따른다.
//
// 문단의 sprmPIlfo(1부터 시작하는 LFO 번호)와 sprmPIlvl(수준)로 목록과 수준을 찾고,
// 문서 순서대로 수준별 번호를 세어 LVL의 번호 문자열(xst)에 채운다. xst 안의 0~8 문자는 그 수준 번호 자리다.
import { BinaryReader } from '../core/binary.js';
import { decodeGrpprl } from './sprm.js';
import type { DecodedProperty, FibRgFcLcb } from '../types.js';

export interface ListLevel {
  startAt: number;
  nfc: number;
  legal: boolean;
  noRestart: boolean;
  follow: 'tab' | 'space' | 'none';
  restartLimit: number;
  paraProps: DecodedProperty[];
  charProps: DecodedProperty[];
  text: string;
}

interface ListDefinition {
  lsid: number;
  simple: boolean;
  levels: ListLevel[];
}

interface ListOverride {
  lsid: number;
  levels: Map<number, { startAt?: number; level?: ListLevel }>;
}

export interface ListTables {
  lists: Map<number, ListDefinition>;
  overrides: ListOverride[];
}

function readLvl(reader: BinaryReader, offset: number): { level: ListLevel; next: number } | null {
  if (!reader.ensure(offset, 28)) return null;
  const startAt = reader.i32(offset);
  const nfc = reader.u8(offset + 4);
  const flags = reader.u8(offset + 5);
  const ixchFollow = reader.u8(offset + 15);
  const cbGrpprlChpx = reader.u8(offset + 24);
  const cbGrpprlPapx = reader.u8(offset + 25);
  const restartLimit = reader.u8(offset + 26);
  let cursor = offset + 28;
  const papxBytes = reader.slice(cursor, cbGrpprlPapx);
  cursor += cbGrpprlPapx;
  const chpxBytes = reader.slice(cursor, cbGrpprlChpx);
  cursor += cbGrpprlChpx;
  const cch = reader.u16(cursor);
  cursor += 2;
  if (cch > 0x100 || !reader.ensure(cursor, cch * 2)) return null;
  const text = reader.utf16le(cursor, cch * 2);
  cursor += cch * 2;
  return {
    level: {
      startAt,
      nfc,
      legal: Boolean(flags & 0x04),
      noRestart: Boolean(flags & 0x08),
      follow: ixchFollow === 1 ? 'space' : ixchFollow === 2 ? 'none' : 'tab',
      restartLimit,
      paraProps: decodeGrpprl(papxBytes, 0, papxBytes.length),
      charProps: decodeGrpprl(chpxBytes, 0, chpxBytes.length),
      text,
    },
    next: cursor,
  };
}

export function parseListTables(tableBytes: Uint8Array, fibRgFcLcb: FibRgFcLcb): ListTables {
  const lists = new Map<number, ListDefinition>();
  const overrides: ListOverride[] = [];
  const fcLst = fibRgFcLcb.fcPlfLst as number | undefined;
  const lcbLst = fibRgFcLcb.lcbPlfLst as number | undefined;
  if (fcLst != null && lcbLst && fcLst + 2 <= tableBytes.length) {
    const reader = new BinaryReader(tableBytes);
    const cLst = reader.i16(fcLst);
    const defs: ListDefinition[] = [];
    for (let i = 0; i < cLst && i < 4096; i += 1) {
      const at = fcLst + 2 + i * 28;
      if (!reader.ensure(at, 28)) break;
      defs.push({ lsid: reader.i32(at), simple: Boolean(reader.u8(at + 26) & 0x01), levels: [] });
    }
    // LVL 배열은 PlfLst 바로 뒤에 목록 순서대로 이어진다(단순 목록은 1개, 아니면 9개).
    let cursor = fcLst + 2 + defs.length * 28;
    outer: for (const def of defs) {
      const count = def.simple ? 1 : 9;
      for (let k = 0; k < count; k += 1) {
        const lvl = readLvl(reader, cursor);
        if (!lvl) break outer;
        def.levels.push(lvl.level);
        cursor = lvl.next;
      }
      lists.set(def.lsid, def);
    }
  }

  const fcLfo = fibRgFcLcb.fcPlfLfo as number | undefined;
  const lcbLfo = fibRgFcLcb.lcbPlfLfo as number | undefined;
  if (fcLfo != null && lcbLfo && fcLfo + 4 <= tableBytes.length) {
    const reader = new BinaryReader(tableBytes);
    const lfoMac = reader.i32(fcLfo);
    const counts: number[] = [];
    for (let i = 0; i < lfoMac && i < 8192; i += 1) {
      const at = fcLfo + 4 + i * 16;
      if (!reader.ensure(at, 16)) break;
      overrides.push({ lsid: reader.i32(at), levels: new Map() });
      counts.push(reader.u8(at + 12));
    }
    // LFOData: cp(4) + LFOLVL(8 바이트 + fFormatting이면 LVL)이 LFO 순서대로 이어진다.
    let cursor = fcLfo + 4 + overrides.length * 16;
    for (let i = 0; i < overrides.length; i += 1) {
      const clfolvl = counts[i] ?? 0;
      // 덮어쓰기가 있는 LFO만 LFOData가 있다. 앞의 4바이트(cp) 뒤에 0xFFFFFFFF가 더 붙은 파일도 있다
      // (LibreOffice WW8ListManager와 같은 처리).
      if (!clfolvl) continue;
      if (!reader.ensure(cursor, 4)) break;
      cursor += 4;
      while (reader.ensure(cursor, 4) && reader.u32(cursor) === 0xffffffff) cursor += 4;
      for (let k = 0; k < clfolvl; k += 1) {
        if (!reader.ensure(cursor, 8)) break;
        const iStartAt = reader.i32(cursor);
        const flags = reader.u32(cursor + 4);
        cursor += 8;
        const ilvl = flags & 0x0f;
        const fStartAt = Boolean(flags & 0x10);
        const fFormatting = Boolean(flags & 0x20);
        const entry: { startAt?: number; level?: ListLevel } = {};
        if (fStartAt) entry.startAt = iStartAt;
        if (fFormatting) {
          const lvl = readLvl(reader, cursor);
          if (!lvl) break;
          entry.level = lvl.level;
          cursor = lvl.next;
        }
        overrides[i]!.levels.set(ilvl, entry);
      }
    }
  }
  return { lists, overrides };
}

const ROMAN: Array<[number, string]> = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];

function toRoman(value: number): string {
  let n = Math.max(1, Math.min(3999, value));
  let out = '';
  for (const [v, s] of ROMAN) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return out;
}

function toLetters(value: number, alphabet: string): string {
  // Word의 알파벳 번호는 a..z 다음에 aa, bb, ... 처럼 같은 글자를 반복한다.
  const n = Math.max(1, value);
  const ch = alphabet[(n - 1) % alphabet.length] ?? '';
  return ch.repeat(Math.floor((n - 1) / alphabet.length) + 1);
}

function cycle(value: number, items: string[]): string {
  return items[(Math.max(1, value) - 1) % items.length] ?? String(value);
}

function enclosed(value: number, base: number, max: number): string {
  return value >= 1 && value <= max ? String.fromCodePoint(base + value - 1) : String(value);
}

const KOREAN_DIGITS = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const HAN_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

function sinoNumber(value: number, digits: string[], ten: string, hundred: string, thousand: string): string {
  if (value <= 0 || value >= 10000) return String(value);
  const parts: string[] = [];
  const units: Array<[number, string]> = [[1000, thousand], [100, hundred], [10, ten]];
  let n = value;
  for (const [unit, name] of units) {
    const d = Math.floor(n / unit);
    if (d) parts.push((d > 1 ? digits[d] : '') + name);
    n %= unit;
  }
  if (n) parts.push(digits[n] ?? '');
  return parts.join('');
}

const KOREAN_COUNTING = ['하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];
const ORDINAL_SUFFIX = (n: number) => {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
};

/** MSONFC 번호 형식으로 숫자를 글자로 바꾼다. 지원하지 않는 형식은 아라비아 숫자로 쓴다. */
export function formatListNumber(value: number, nfc: number): string {
  switch (nfc) {
    case 0x01: return toRoman(value).toUpperCase();
    case 0x02: return toRoman(value);
    case 0x03: return toLetters(value, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    case 0x04: return toLetters(value, 'abcdefghijklmnopqrstuvwxyz');
    case 0x05: return `${value}${ORDINAL_SUFFIX(value)}`;
    case 0x08: return value.toString(16).toUpperCase();
    case 0x0a: case 0x0b: case 0x10: case 0x11: case 0x21: case 0x22: case 0x23: case 0x24:
    case 0x25: case 0x26: case 0x27: case 0x2c:
      return sinoNumber(value, HAN_DIGITS, '十', '百', '千');
    case 0x0e: case 0x13: return String(value).replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d)));
    case 0x12: return enclosed(value, 0x2460, 20);
    case 0x16: return value < 10 ? `0${value}` : String(value);
    case 0x17: return '';
    case 0x18: return cycle(value, ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카', '타', '파', '하']);
    case 0x19: return cycle(value, ['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']);
    case 0x1a: return enclosed(value, 0x2488, 20);
    case 0x1b: return enclosed(value, 0x2474, 20);
    case 0x1c: case 0x1d: return enclosed(value, 0x3220, 10);
    case 0x29: return sinoNumber(value, KOREAN_DIGITS, '십', '백', '천');
    case 0x2a: return value >= 1 && value <= 10 ? KOREAN_COUNTING[value - 1]! : String(value);
    case 0x2b: return sinoNumber(value, ['零', '壹', '貳', '參', '四', '五', '六', '七', '八', '九'], '拾', '百', '千');
    case 0x3a: return toLetters(value, 'абвгдежзиклмнопрстуфхцчшщэюя');
    case 0x3b: return toLetters(value, 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ');
    case 0xff: return '';
    default: return String(value);
  }
}

export interface ListParagraph {
  ilfo: number;
  ilvl: number;
}

export interface ResolvedListLabel {
  text: string;
  level: ListLevel;
}

/**
 * 문서 순서대로 번호를 센다. 같은 목록(lsid)을 쓰는 문단은 LFO가 달라도 번호를 이어 가고,
 * LFO가 시작 번호를 덮어쓰면 그 LFO를 따로 센다(Word 97 동작).
 */
export class ListNumberer {
  private readonly counters = new Map<string, Array<number | undefined>>();
  private readonly startedOverrides = new Set<number>();

  constructor(private readonly tables: ListTables) {}

  label(paragraph: ListParagraph): ResolvedListLabel | null {
    const { ilfo } = paragraph;
    if (ilfo <= 0 || ilfo === 0x7ff || ilfo > this.tables.overrides.length) return null;
    const override = this.tables.overrides[ilfo - 1]!;
    const list = this.tables.lists.get(override.lsid);
    if (!list || !list.levels.length) return null;
    const ilvl = Math.max(0, Math.min(list.levels.length - 1, paragraph.ilvl || 0));
    const levelAt = (k: number): ListLevel | undefined => override.levels.get(k)?.level ?? list.levels[k];
    const level = levelAt(ilvl);
    if (!level) return null;

    const hasStartOverride = Array.from(override.levels.values()).some((entry) => entry.startAt != null || entry.level);
    const key = hasStartOverride ? `${override.lsid}:${ilfo}` : String(override.lsid);
    let counters = this.counters.get(key);
    if (!counters) {
      counters = [];
      this.counters.set(key, counters);
    }
    const startOf = (k: number) => override.levels.get(k)?.startAt ?? override.levels.get(k)?.level?.startAt ?? levelAt(k)?.startAt ?? 1;
    if (hasStartOverride && !this.startedOverrides.has(ilfo)) {
      this.startedOverrides.add(ilfo);
    }
    const current = counters[ilvl];
    counters[ilvl] = current == null ? startOf(ilvl) : current + 1;
    for (let k = ilvl + 1; k < 9; k += 1) {
      if (!levelAt(k)?.noRestart) counters[k] = undefined;
    }

    if (level.nfc === 0x17) return { text: level.text, level };
    let text = '';
    for (const ch of level.text) {
      const code = ch.charCodeAt(0);
      if (code < 9) {
        const lv = levelAt(code);
        const value = counters[code] ?? startOf(code);
        text += formatListNumber(value, level.legal && lv && lv.nfc !== 0x16 ? 0 : lv?.nfc ?? 0);
      } else {
        text += ch;
      }
    }
    return { text, level };
  }
}
