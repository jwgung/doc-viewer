export type BinaryInput = ArrayBuffer | Uint8Array | ArrayBufferView;

export interface MsDocWarning {
  message: string;
  [key: string]: unknown;
}

export interface BinaryInputLike {
  byteLength: number;
}

export interface CFBEntry {
  id: number;
  name: string;
  objectType: number;
  colorFlag: number;
  leftSiblingId: number;
  rightSiblingId: number;
  childId: number;
  clsid: Uint8Array;
  stateBits: number;
  creationTime: number;
  modifiedTime: number;
  startSector: number;
  streamSize: number;
  children: number[];
  parentId: number | null;
  path?: string;
}

export interface ParsedCFB {
  bytes: Uint8Array;
  majorVersion: number;
  sectorSize: number;
  miniSectorSize: number;
  numDirSectors: number;
  numFatSectors: number;
  firstDirSector: number;
  transactionSignature: number;
  miniStreamCutoffSize: number;
  warnings: MsDocWarning[];
  entries: CFBEntry[];
  root: CFBEntry;
  pathMap: Map<string, CFBEntry>;
  getEntry(path: string): CFBEntry | null;
  getStream(identifier: string | CFBEntry): Uint8Array | null;
  listChildren(path: string | CFBEntry): CFBEntry[];
  findByName(name: string, startPath?: string): CFBEntry | null;
}

export interface FibBase {
  wIdent: number;
  nFib: number;
  lid: number;
  pnNext: number;
  flags: number;
  envFlags: number;
  fDot: boolean;
  fGlsy: boolean;
  fComplex: boolean;
  fHasPic: boolean;
  cQuickSaves: number;
  fEncrypted: boolean;
  fWhichTblStm: number;
  fReadOnlyRecommended: boolean;
  fWriteReservation: boolean;
  fExtChar: boolean;
  fLoadOverride: boolean;
  fFarEast: boolean;
  fObfuscated: boolean;
  nFibBack: number;
  lKey: number;
  envr: number;
  fMac: boolean;
  fEmptySpecial: boolean;
  fLoadOverridePage: boolean;
}

export interface FibRgLw {
  raw: number[];
  cbMac: number;
  ccpText: number;
  ccpFtn: number;
  ccpHdd: number;
  ccpMcr: number;
  ccpAtn: number;
  ccpEdn: number;
  ccpTxbx: number;
  ccpHdrTxbx: number;
}

export interface FibFcLcbPair {
  name: string;
  fc: number;
  lcb: number;
  index: number;
}

export interface FibRgFcLcb {
  _pairs: FibFcLcbPair[];
  [key: string]: number | FibFcLcbPair[] | undefined;
}

export interface ParsedFib {
  base: FibBase;
  csw: number;
  cslw: number;
  cbRgFcLcb: number;
  cswNew: number;
  nFibNew: number;
  fibRgWBytes: Uint8Array;
  fibRgLwBytes: Uint8Array;
  fibRgFcLcbBytes: Uint8Array;
  fibRgCswNewBytes: Uint8Array;
  fibRgLw: FibRgLw;
  fibRgFcLcb: FibRgFcLcb;
  /** doc-viewer: 파일 형식 세대. 8 = Word 97 이상, 6 = Word 6.0/95, 2 = Word 2.0 */
  version?: 2 | 6 | 8;
  /** 본문 글자가 시작·끝나는 WordDocument 스트림 위치(Word 6 이하의 단순 저장 문서는 여기서 글자를 읽는다) */
  fcMin?: number;
  fcMac?: number;
  /** 문서 문자 집합(0 = Windows ANSI, 256 = Macintosh) */
  chse?: number;
  /** Word 6 이하: FKP 페이지가 BTE 표보다 많을 때 이어지는 페이지를 찾는 기준 */
  pnChpFirst?: number;
  pnPapFirst?: number;
  cpnBteChp?: number;
  cpnBtePap?: number;
}

export interface PieceDescriptor {
  index: number;
  descriptor: number;
  fNoParaLast: boolean;
  fRaw: boolean;
  prm: number;
  compressed: boolean;
  fcRaw: number;
  fc: number;
  cpStart: number;
  cpEnd: number;
  actualByteStart: number;
  byteLength: number;
  actualByteEnd: number;
}

export interface PieceTable {
  cps: number[];
  pieces: PieceDescriptor[];
}

export interface ParsedClx {
  prcs: Array<{ type: number; cbGrpprl: number; bytes: Uint8Array }>;
  pcdt: { lcb: number; pieceTable: PieceTable };
}

export interface CpFileOffsetInfo {
  piece: PieceDescriptor;
  offset: number;
  compressed: boolean;
}

export type PropertyKind = 'char' | 'para' | 'table' | 'section' | 'unknown';

export interface DecodedProperty<TValue = unknown> {
  kind: PropertyKind;
  name: string;
  value: TValue;
  code?: number;
  operandBytes?: Uint8Array;
  raw?: number | Uint8Array;
}

export interface StyleBase {
  sti?: number;
  flags1?: number;
  stk: number;
  istdBase: number;
  cupx: number;
  istdNext: number;
  bchUpe?: number;
  grfstd?: number;
}

export interface StyleDefinition {
  istd: number;
  name: string;
  stdfBase: StyleBase;
  paraProps: DecodedProperty[];
  charProps: DecodedProperty[];
  tableProps: DecodedProperty[];
  empty: boolean;
}

export interface ResolvedStyle {
  styleIds: number[];
  paraProps: DecodedProperty[];
  charProps: DecodedProperty[];
  tableProps: DecodedProperty[];
}

export interface StyleCollection {
  header: {
    cbStshi: number;
    cstd: number;
    cbSTDBaseInFile: number;
    ftcAsci: number;
    ftcFE: number;
    ftcOther: number;
  } | null;
  styles: Map<number, StyleDefinition>;
  resolveStyle(istd: number | null | undefined): ResolvedStyle;
}

export interface FontInfo {
  index: number;
  cbFfnM1: number;
  ffid: number;
  weight: number;
  charset: number;
  ixchSzAlt: number;
  panose: Uint8Array;
  fontSignature: Uint8Array;
  name: string;
  altName: string;
}

export interface FontsCollection {
  header: { cData: number; cbExtra: number } | null;
  fonts: FontInfo[];
  byIndex(index: number | null | undefined): FontInfo | null;
}

export interface BorderSpec {
  borderType?: number;
  lineWidth?: number;
  color?: number;
  colorRef?: number;
  frame?: boolean;
  nil?: boolean;
  shadow?: boolean;
  space?: number;
  [key: string]: unknown;
}

export interface TableBorders {
  top?: BorderSpec;
  left?: BorderSpec;
  bottom?: BorderSpec;
  right?: BorderSpec;
  horizontalInside?: BorderSpec;
  verticalInside?: BorderSpec;
}

export interface ShadingSpec {
  foregroundColorIndex?: number;
  backgroundColorIndex?: number;
  foregroundColorRef?: number;
  backgroundColorRef?: number;
  pattern: number;
  auto?: boolean;
  nil?: boolean;
  legacy?: boolean;
}

export interface HighlightInfo {
  index: number;
  color?: string;
}

export interface SymbolInfo {
  fontId?: number;
  charCode?: number;
  [key: string]: unknown;
}

export interface CharState {
  revisionDeleted?: boolean;
  revisionInserted?: boolean;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  underline: number;
  fontSizeHalfPoints?: number;
  fontFamilyId?: number;
  fontFamily?: string;
  fontFamilyEastAsiaId?: number;
  fontFamilyEastAsia?: string;
  fontFamilyOtherId?: number;
  fontFamilyOther?: string;
  fontFamilyBiId?: number;
  fontFamilyBi?: string;
  colorIndex?: number;
  highlight?: HighlightInfo | number;
  spacing: number;
  positionHalfPoints: number;
  scale: number;
  hidden: boolean;
  smallCaps: boolean;
  caps: boolean;
  outline: boolean;
  shadow: boolean;
  emboss: boolean;
  imprint: boolean;
  rtl: boolean;
  pictureOffset?: number;
  data: boolean;
  ole2: boolean;
  object: boolean;
  special: boolean;
  plain?: boolean;
  charStyleId?: number;
  boldBi?: boolean;
  italicBi?: boolean;
  doubleStrike?: boolean;
  symbol?: SymbolInfo;
  /** doc-viewer: 위첨자(1)·아래첨자(2) */
  iss?: number;
  [key: string]: unknown;
}

export interface ParaBorders {
  top?: BorderSpec;
  left?: BorderSpec;
  bottom?: BorderSpec;
  right?: BorderSpec;
  between?: BorderSpec;
  bar?: BorderSpec;
}

export interface ParaState {
  styleId: number;
  alignment: number;
  spacingBefore: number;
  spacingAfter: number;
  lineSpacing: number;
  lineSpacingRule?: 'auto' | 'atLeast' | 'exact';
  leftIndent: number;
  rightIndent: number;
  firstLineIndent: number;
  keepLines: boolean;
  keepNext: boolean;
  pageBreakBefore: boolean;
  widowControl: boolean;
  inTable: boolean;
  tableRowEnd: boolean;
  innerTableCell: boolean;
  innerTableRowEnd: boolean;
  itap: number;
  dtap: number;
  listLevel?: number;
  listId?: number;
  rtlPara: boolean;
  adjustRight: boolean;
  frameLeft?: number;
  frameTop?: number;
  frameWidth?: number;
  frameHeight?: number;
  framePosition?: number;
  frameWrap?: number;
  borders: ParaBorders;
  shading?: unknown;
  [key: string]: unknown;
}

export interface Tcgrf {
  horzMerge?: number;
  vertMerge?: number;
  vertAlign?: number;
  fitText?: boolean;
  noWrap?: boolean;
  hideMark?: boolean;
  textFlow?: number;
  ftsWidth?: number;
  [key: string]: unknown;
}

export interface TableCellDefinition {
  wWidth?: number;
  tcgrf?: Tcgrf;
  borders?: Record<string, BorderSpec>;
  [key: string]: unknown;
}

export interface TDefTableOperand {
  rgdxaCenter?: number[];
  cells: TableCellDefinition[];
  [key: string]: unknown;
}

export interface ItcRange {
  first: number;
  lim: number;
}

export interface RangeWidthOperand {
  cb?: number;
  range: ItcRange;
  sides?: number;
  width?: number;
  wWidth?: number;
  ftsWidth?: number;
}

export interface RangeBorderOperand {
  cb?: number;
  range: ItcRange;
  border: BorderSpec;
  bordersToApply: number;
  extra?: Uint8Array;
}

export interface RangeValueOperand {
  cb?: number;
  range: ItcRange;
  value: number | boolean | unknown;
  extra?: Uint8Array;
}

export interface TableWidthOperand {
  ftsWidth?: number;
  width?: number;
  wWidth?: number;
}

export interface TInsertOperand {
  itcFirst?: number;
  ctc?: number;
  dxaCol?: number;
  [key: string]: unknown;
}

export interface TableState {
  styleId?: number;
  alignment: number;
  leftIndent: number;
  gapHalf: number;
  cantSplit: boolean;
  header: boolean;
  rowHeight: number;
  rtl: boolean;
  positionCode?: number;
  absLeft?: number;
  absTop?: number;
  distanceLeft?: number;
  distanceTop?: number;
  tableWidth?: TableWidthOperand;
  autoFit?: unknown;
  widthBefore?: unknown;
  widthAfter?: unknown;
  borders: TableBorders;
  defTable?: TDefTableOperand;
  operations: DecodedProperty[];
  [key: string]: unknown;
}

export interface TableCellMeta {
  index: number;
  width?: number;
  ftsWidth?: number;
  borders?: Record<string, BorderSpec>;
  merge?: number;
  vertMerge?: number;
  vertAlign?: number;
  fitText?: boolean;
  noWrap?: boolean;
  hideMark?: boolean;
  textFlow?: number;
  rightBoundary?: number;
  leftBoundary?: number;
  shading?: ShadingSpec;
  paddingTwips?: Partial<Record<'top' | 'left' | 'bottom' | 'right', number>>;
  spacingTwips?: Partial<Record<'top' | 'left' | 'bottom' | 'right', number>>;
}

export interface CharSegment {
  cpStart: number;
  cpEnd: number;
  text: string;
  state: CharState;
}

export interface ParagraphRange {
  cpStart: number;
  cpEnd: number;
  terminator: string;
  styleId: number;
  properties: DecodedProperty[];
}

export interface FieldInstructionHyperlink {
  type: 'hyperlink';
  href: string;
}

export interface FieldInstructionIncludePicture {
  type: 'includePicture';
  target: string;
}

export interface FieldInstructionRaw {
  type: 'embed' | 'link' | 'unknown';
  raw: string;
}

/** doc-viewer: 쪽 번호 필드 */
export interface FieldInstructionPage {
  type: 'page' | 'numpages';
}

export type FieldInstruction = FieldInstructionHyperlink | FieldInstructionIncludePicture | FieldInstructionRaw | FieldInstructionPage;

export interface PicfSummary {
  pictureOffset: number;
  lcb: number;
  cbHeader: number;
  mm?: number;
  xExt?: number;
  yExt?: number;
  dxaGoalTwips?: number;
  dyaGoalTwips?: number;
  scaleXPermille?: number;
  scaleYPermille?: number;
  displayWidthTwips?: number;
  displayHeightTwips?: number;
}

export interface OfficeArtBlipMeta {
  recType?: number;
  recInstance?: number;
  fbseBlipType?: number;
  fbseMime?: string | null;
  fbseTag?: number;
  fbseSize?: number;
  fbseRefCount?: number;
  fbseDelayOffset?: number;
  fbseName?: string;
  fbseDelayStream?: string;
  blipIndex?: number;
  sourceShapeId?: number;
}

/** PICF / OfficeArt BLIP / linked-picture metadata used by the HTML renderer. */
export interface ImageAssetMeta extends PicfSummary, OfficeArtBlipMeta {
  linkedPath?: string;
  sourceKind?: 'embedded' | 'linked' | 'fallback';
  localExternal?: boolean;
  browserRenderable?: boolean;
  metafileCompressed?: boolean;
  metafileCompression?: number;
  metafileFilter?: number;
  metafileUncompressedSize?: number;
  metafileCompressedSize?: number;
  metafileOriginalByteLength?: number;
  metafileDecompressed?: boolean;
  vectorConverted?: boolean;
  vectorSourceMime?: string;
  vectorWidth?: number;
  vectorHeight?: number;
  vectorRecordCount?: number;
  fbseIndex?: number;
  dggOffset?: number;
  blipIndex?: number;
  sourceShapeId?: number;
}

export interface AttachmentAssetMeta {
  stream?: string;
  label?: string;
  originalPath?: string;
  tempPath?: string;
  dataSize?: number;
  sourceKind?: 'ole10-native' | 'package' | 'content' | 'unknown';
  [key: string]: unknown;
}

export interface ImageAsset {
  id: string;
  type: 'image';
  mime: string;
  bytes: Uint8Array;
  dataUrl: string;
  sourceUrl?: string;
  displayable?: boolean;
  meta?: ImageAssetMeta;
}

export interface AttachmentAsset {
  id: string;
  type: 'attachment';
  name: string;
  mime: string;
  bytes: Uint8Array;
  dataUrl: string;
  meta?: AttachmentAssetMeta;
}

export type MsDocAsset = ImageAsset | AttachmentAsset;

export interface ObjectPoolInfo {
  entry: CFBEntry;
  streams: CFBEntry[];
  displayName: string;
  attachment: AttachmentAsset | null;
  objectData: Uint8Array | null;
}

export interface TextInlineNode {
  type: 'text';
  text: string;
  style: CharState;
  href?: string;
}

export interface ImageInlineNode {
  type: 'image';
  asset: ImageAsset;
  style: CharState;
  href?: string;
}

export interface AttachmentInlineNode {
  type: 'attachment';
  asset: AttachmentAsset;
  style: CharState;
  href?: string;
}

export interface LineBreakInlineNode {
  type: 'lineBreak';
  style?: CharState;
}

export interface PageBreakInlineNode {
  type: 'pageBreak';
  style?: CharState;
}

/** doc-viewer: 각주·미주 참조 표시(본문의 위첨자 번호) */
export interface NoteRefInlineNode {
  type: 'noteRef';
  kind: 'footnote' | 'endnote';
  noteId: string;
  label: string;
  style: CharState;
  href?: string;
}

/** doc-viewer: 쪽 번호 필드(PAGE·NUMPAGES). 렌더러가 쪽을 나눈 뒤 번호를 채운다. text는 문서에 저장된 결과다. */
export interface FieldInlineNode {
  type: 'field';
  field: 'page' | 'numpages';
  text: string;
  style: CharState;
  href?: string;
}

export type InlineNode =
  | TextInlineNode
  | ImageInlineNode
  | AttachmentInlineNode
  | LineBreakInlineNode
  | PageBreakInlineNode
  | NoteRefInlineNode
  | FieldInlineNode;

/** doc-viewer: 번호 매기기·글머리 기호. 렌더러가 문단 앞에 붙인다. */
export interface ListLabel {
  text: string;
  style?: CharState;
  follow: 'tab' | 'space' | 'none';
}

export interface ParagraphBlock {
  type: 'paragraph';
  id: string;
  styleId: number;
  styleName: string;
  paraState: ParaState;
  inlines: InlineNode[];
  text: string;
  paragraphMark?: Pick<CharState, 'revisionDeleted' | 'revisionInserted'>;
  storyKind?: string;
  /** doc-viewer: 본문 문단이 속한 구역 번호 */
  sectionIndex?: number;
  /** doc-viewer: 구역 나누기 문자(0x0C)로 끝나는 문단 */
  endsSection?: boolean;
  listLabel?: ListLabel;
  /** doc-viewer: 이 문단에 고정된 글상자·그림(본문 흐름에서 문단 바로 앞에 그린다) */
  anchors?: ShapeBlock[];
}

/** doc-viewer: 떠 있는 개체(글상자·그림). 위치 대신 고정 문단 자리에 블록으로 그린다. */
export interface ShapeBlock {
  type: 'shape';
  id: string;
  kind: 'textbox' | 'picture';
  blocks: MsDocBlock[];
  image?: ImageAsset;
  widthTwips?: number;
  heightTwips?: number;
  /** 0 = 위아래 배치, 1·2 = 주변에 배치, 3 = 글자 뒤·앞(본문 흐름과 겹침) */
  wrap?: number;
  behindText?: boolean;
  fillColor?: string;
  lineColor?: string;
  lineWidthPx?: number;
  /** 가로·세로 위치 힌트(twip). 같은 문단에 고정된 도형을 읽는 순서로 늘어놓을 때 쓴다. */
  leftTwips?: number;
  topTwips?: number;
}

export interface TableCellBlock {
  id: string;
  paragraphs: ParagraphBlock[];
  meta: TableCellMeta | null;
  colIndex?: number;
  colspan?: number;
  rowspan?: number;
  hidden?: boolean;
}

export interface TableRowBlock {
  id: string;
  cells: TableCellBlock[];
  state: TableState;
  gridWidthTwips: number;
}

export interface TableBlock {
  type: 'table';
  id: string;
  depth: number;
  rows: TableRowBlock[];
  state: TableState;
  gridWidthTwips: number;
  /** doc-viewer: 본문 표가 속한 구역 번호 */
  sectionIndex?: number;
}

export interface AttachmentsBlock {
  type: 'attachments';
  id: string;
  items: AttachmentAsset[];
}

export type MsDocBlock = ParagraphBlock | TableBlock | AttachmentsBlock | ShapeBlock;

/** doc-viewer: 구역. 머리말·꼬리말은 구역마다 기본·첫 쪽·짝수 쪽으로 나뉜다. */
export interface SectionInfo {
  index: number;
  cpStart: number;
  cpEnd: number;
  /** bkc: 0 이어서, 1 새 단, 2 새 쪽, 3 짝수 쪽, 4 홀수 쪽 */
  breakType: number;
  titlePage: boolean;
  pageWidthTwips?: number;
  pageHeightTwips?: number;
  marginLeftTwips?: number;
  marginRightTwips?: number;
  marginTopTwips?: number;
  marginBottomTwips?: number;
  columns?: number;
  pageNumberStart?: number;
  pageNumberRestart?: boolean;
  pageNumberFormat?: number;
  /** Word 6/95: 이 구역에 있는 머리말·꼬리말 종류(sprmSGprfIhdt) */
  headerFlags?: number;
  headers: Partial<Record<'default' | 'first' | 'even', MsDocBlock[]>>;
  footers: Partial<Record<'default' | 'first' | 'even', MsDocBlock[]>>;
}

/** doc-viewer: 각주·미주 */
export interface NoteInfo {
  kind: 'footnote' | 'endnote';
  index: number;
  id: string;
  label: string;
  refCp: number;
  blocks: MsDocBlock[];
}

export interface ParagraphModel {
  id: string;
  cpStart: number;
  cpEnd: number;
  terminator: string;
  paragraphMark?: Pick<CharState, 'revisionDeleted' | 'revisionInserted'>;
  storyKind?: string;
  text: string;
  rawProperties: DecodedProperty[];
  styleId: number;
  styleName: string;
  paraProps: DecodedProperty[];
  paraState: ParaState;
  tableProps: DecodedProperty[];
  tableState: TableState;
  segments: CharSegment[];
  inlines: InlineNode[];
  /** doc-viewer: 아래는 ParagraphBlock으로 그대로 옮긴다. */
  sectionIndex?: number;
  endsSection?: boolean;
  listLabel?: ListLabel;
  anchors?: ShapeBlock[];
  /** 고정 문자만 있어 문단은 그리지 않고 고정된 도형만 남기는 문단 */
  anchorOnly?: boolean;
}

export interface MsDocParseOptions {
  maxPictureBytes?: number;
  [key: string]: unknown;
}

export interface MsDocRenderOptions {
  css?: string;
  /** Preserve insertion/deletion marks by default; explicitly select final or original text. */
  reviewMode?: 'all' | 'final' | 'original';
  /** External links are blocked by default; internal document bookmarks remain active. */
  externalLinkPolicy?: 'allow' | 'block';
  /** Linked image resources are blocked by default; embedded data/blob images remain available. */
  externalResourcePolicy?: 'allow' | 'block';
}

export interface MsDocMeta {
  fib: {
    wIdent: number;
    nFib: number;
    fWhichTblStm: number;
    fComplex: boolean;
    fEncrypted: boolean;
    ccpText: number;
    /** doc-viewer: 8 = Word 97 이상, 6 = Word 6.0/95, 2 = Word 2.0, 1 = 그 밖의 옛 형식(글자만 복구) */
    version?: number;
  };
  counts: {
    paragraphs: number;
    blocks: number;
    assets: number;
    styles: number;
    fonts: number;
  };
}

export interface MsDocStyleSummary {
  istd: number;
  name: string;
  type?: number;
  basedOn?: number;
  next?: number;
}

export interface MsDocParseResult {
  kind: 'msdoc';
  version: number;
  warnings: MsDocWarning[];
  meta: MsDocMeta;
  fonts: FontInfo[];
  styles: MsDocStyleSummary[];
  blocks: MsDocBlock[];
  assets: MsDocAsset[];
  /** doc-viewer: 구역(머리말·꼬리말 포함). 없으면 구역 하나로 본다. */
  sections?: SectionInfo[];
  /** doc-viewer: 각주·미주 */
  notes?: { footnotes: NoteInfo[]; endnotes: NoteInfo[] };
}

/** doc-viewer: 쪽 나눔 결과의 한 쪽 */
export interface MsDocRenderedPage {
  html: string;
  sectionIndex: number;
}

export interface MsDocRenderResult {
  /** doc-viewer: 명시적 쪽 나누기·구역 나누기로 나눈 쪽. html은 이 쪽들을 이어 붙인 것이다. */
  pages?: MsDocRenderedPage[];
  html: string;
  css: string;
  warnings: MsDocWarning[];
  meta: MsDocMeta;
  assets: MsDocAsset[];
  parsed: MsDocParseResult;
}

export interface MsDocParseToHtmlOptions {
  workerClient?: MsDocWorkerClientLike;
  parseOptions?: MsDocParseOptions;
  renderOptions?: MsDocRenderOptions;
}

export interface MsDocViewerConfig {
  workerClient?: MsDocWorkerClientLike;
  parseOptions?: MsDocParseOptions;
  renderOptions?: MsDocRenderOptions;
}

export interface MsDocViewerLoadOptions {
  workerClient?: MsDocWorkerClientLike;
  parseOptions?: MsDocParseOptions;
  renderOptions?: MsDocRenderOptions;
}

export interface MsDocViewer {
  load(input: ViewerInput, options?: MsDocViewerLoadOptions): Promise<MsDocRenderResult>;
  mount(rendered: MsDocRenderResult): HTMLElement;
  clear(): void;
  destroy(): void;
  readonly value: MsDocRenderResult | null;
}

export type ViewerInput = ArrayBuffer | ArrayBufferView | Blob | string;

export type WorkerRequestType = 'parse' | 'render' | 'parseToHtml';

export interface WorkerRequestMap {
  parse: { buffer: ArrayBuffer; options?: MsDocParseOptions };
  render: { parsed: MsDocParseResult; options?: MsDocRenderOptions };
  parseToHtml: { buffer: ArrayBuffer; options?: MsDocParseToHtmlOptions };
}

export interface WorkerResponse<T> {
  id: number;
  ok: boolean;
  result?: T;
  error?: string;
}

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export interface MsDocWorkerClientLike {
  parse(input: ArrayBuffer | ArrayBufferView, options?: MsDocParseOptions): Promise<MsDocParseResult>;
  render(parsed: MsDocParseResult, options?: MsDocRenderOptions): Promise<MsDocRenderResult>;
  parseToHtml(input: ArrayBuffer | ArrayBufferView, options?: MsDocParseToHtmlOptions): Promise<MsDocRenderResult>;
  destroy(): void;
}

export type CssStyleObject = Record<string, string | number | undefined>;
