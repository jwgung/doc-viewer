/*
 * @license
 * docx-preview <https://github.com/VolodymyrBaydalka/docxjs>
 * Released under Apache License 2.0  <https://github.com/VolodymyrBaydalka/docxjs/blob/master/LICENSE>
 * Copyright Volodymyr Baydalka
 */

export type HElement = {
    ns?: string;
    tagName: string;
    className?: string;
    style?: Record<string, string> | string;
    children?: (HElement | Node | string)[];
} & Record<string, any>;

export interface Options {
    inWrapper: boolean;
    hideWrapperOnPrint: boolean;
    ignoreWidth: boolean;
    ignoreHeight: boolean;
    ignoreFonts: boolean;
    breakPages: boolean;
    debug: boolean;
    experimental: boolean;
    className: string;
    trimXmlDeclaration: boolean;
    renderHeaders: boolean;
    renderFooters: boolean;
    renderFootnotes: boolean;
    renderEndnotes: boolean;
    ignoreLastRenderedPageBreak: boolean;
    useBase64URL: boolean;
    renderChanges: boolean;
    renderComments: boolean;
    renderAltChunks: boolean;
    h: (elemOrText: HElement | Node | string) => Node; //experimental, subject to change
}

//stub
export type WordDocument = any;
export declare const defaultOptions: Options;
export declare function parseAsync(data: Blob | any, userOptions?: Partial<Options>): Promise<WordDocument>;
export declare function renderDocument(document: WordDocument, userOptions?: Partial<Options>): Promise<Node[]>;
export declare function renderAsync(data: Blob | any, bodyContainer: HTMLElement, styleContainer?: HTMLElement, userOptions?: Partial<Options>): Promise<any>;

// ---- doc-viewer 확장: 쪽 단위 지연 렌더링 (원본에 없음) ----
export interface LazyPage {
    /** section.docx. 문서에 붙여야 크기와 탭 간격을 잴 수 있다. */
    element: HTMLElement;
    /** 이미지 등 비동기로 채워지는 것이 모두 끝나면 resolve한다. */
    settled: Promise<void>;
    /** 탭 간격을 맞춘다. 문서에 붙어 있어야 잴 수 있고, 쪽을 확대(zoom)하기 전에 불러야 원래 크기로 정확히 잰다. */
    refreshTabs(): void;
}
export interface LazyDocument {
    /** 구역·쪽 나누기 기준 쪽 수. renderAsync가 만드는 section.docx 수와 같다. */
    pageCount: number;
    /** 모든 쪽이 함께 쓰는 <style> 노드들. 문서에 한 번 넣는다. */
    styleNodes: Node[];
    /** 용지 크기(px). 내용이 용지보다 길면 실제 쪽은 더 길다. */
    estimatedSize(index: number): { width: number; height: number };
    /** index번째 쪽을 만든다(동기). 본문 조각을 그때 파싱하므로 부를 때마다 새 요소가 나온다. */
    renderPage(index: number): LazyPage;
    dispose(): void;
}
/**
 * 쪽 단위 지연 렌더링을 위한 문서 열기. 지연할 이득이 없거나(작은 본문·한 쪽짜리) 원본과 달라질 수 있는
 * 문서(미주 참조, 주석 표시, inWrapper)면 null을 돌려준다. 그때는 renderAsync를 쓴다.
 * lazyOptions.minBodyLength: 이보다 작은 본문(XML 글자 수)은 null. 기본 256K, 0이면 크기와 상관없이 지연한다.
 * lazyOptions.minPages: 이보다 쪽이 적은 문서는 null. 기본 2, 1이면 한 쪽짜리도 지연 경로로 연다(시험용).
 * lazyOptions.onSkip(이유): null을 돌려주는 이유를 알려 준다(진단용).
 */
export declare function openLazyAsync(data: Blob | any, userOptions?: Partial<Options>, lazyOptions?: { minBodyLength?: number; minPages?: number; onSkip?: (reason: string) => void }): Promise<LazyDocument | null>;
