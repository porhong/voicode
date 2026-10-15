/**
 * Photos are shrunk on the phone before upload: a 12-megapixel photo is 3-5 MB, while
 * Claude works best with images up to about 1568 px on the long side (larger ones are
 * scaled down on its side anyway, after paying to send them). This keeps uploads small
 * and fast on mobile data, and strips the photo's metadata (location) along the way.
 */
export const MAX_SIDE = 1568;
/** Images already this small (and within MAX_SIDE) are sent as they are. */
const KEEP_BYTES = 1.5 * 1024 * 1024;
const JPEG_QUALITY = 0.85;

export function fitWithin(width: number, height: number, max = MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * The format to send: screenshots and other PNGs stay PNG (sharp text) unless large,
 * everything else becomes JPEG, which every browser can encode.
 */
export function outputType(sourceType: string, pixels: number): 'image/png' | 'image/jpeg' {
  return sourceType === 'image/png' && pixels <= 2_000_000 ? 'image/png' : 'image/jpeg';
}

export class ImageError extends Error {}

/** Returns the image to upload: the original when small enough, else a resized copy. */
export async function prepareImage(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new ImageError('This image format can’t be read here. Try a screenshot or a JPEG.');
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const keep =
      width === bitmap.width &&
      file.size <= KEEP_BYTES &&
      ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type);
    if (keep) return file;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ImageError('Could not process the image.');
    const type = outputType(file.type, width * height);
    if (type === 'image/jpeg') {
      // JPEG has no transparency: put transparent areas on white rather than black.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, type, type === 'image/jpeg' ? JPEG_QUALITY : undefined),
    );
    if (!blob) throw new ImageError('Could not process the image.');
    return blob;
  } finally {
    bitmap.close();
  }
}
