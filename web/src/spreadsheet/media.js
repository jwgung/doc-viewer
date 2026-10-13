// 시트 그림 바이트를 화면이 그릴 수 있는 모양으로 바꾼다(xlsx·xls 공통).
// WebView가 그대로 그리는 형식은 바이트째 넘기고, EMF·WMF·PICT는 SVG로, TIFF는 PNG로 바꾼다(변환기는 필요할 때만 불러온다).
const IMAGE_TYPES = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
  [[0x42, 0x4d], 'image/bmp'],
  [[0x52, 0x49, 0x46, 0x46], 'image/webp'],
];

/** { type, data } | { type, svg } | null. svgFile은 확장자로 SVG임을 안 경우다. */
export async function toMedia(data, { svgFile = false } = {}) {
  if (!data?.length) return null;
  for (const [magic, type] of IMAGE_TYPES) if (magic.every((b, i) => data[i] === b)) return { type, data };
  if (svgFile) return { type: 'image/svg+xml', data };
  const { metafileToSvg, isTiff, tiffToPng } = await import('@web-ppt/core/image');
  if (isTiff(data)) {
    const png = tiffToPng(data);
    return png ? { type: 'image/png', data: png } : null;
  }
  const svg = metafileToSvg(data);
  return svg ? { type: 'image/svg+xml', svg } : null;
}
