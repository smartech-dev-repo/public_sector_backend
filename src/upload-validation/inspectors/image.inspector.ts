import { sharp, SharpMetadata } from '../sharp';
import { InspectionFailure } from './inspection-failure';

/**
 * Decodes the whole image (a valid header on a broken or disguised body fails here), caps the pixel
 * count, and re-encodes it. Re-encoding applies the EXIF rotation, then drops all metadata (GPS,
 * camera, comments) and anything hidden after the image data.
 */
const DAMAGED =
  "The image couldn't be read. It may be damaged; take or export it again.";
const tooLarge = (maxPixels: number) =>
  `The image is too large: at most ${Math.round(maxPixels / 1_000_000)} megapixels.`;

/** sharp reports a decompression bomb as "exceeds pixel limit", from metadata() or from decoding. */
const failureFrom = (error: unknown, maxPixels: number) =>
  error instanceof Error && /pixel limit/i.test(error.message)
    ? new InspectionFailure('too-large', tooLarge(maxPixels))
    : new InspectionFailure('undecodable', DAMAGED);

export async function inspectImage(
  buffer: Buffer,
  format: 'jpeg' | 'png',
  maxPixels: number,
  outputFormat: 'jpeg' | 'png' = format,
): Promise<Buffer> {
  // failOn 'error' rejects corrupt and truncated data but not the harmless warnings many cameras produce.
  const image = sharp(buffer, {
    limitInputPixels: maxPixels,
    failOn: 'error',
    animated: false,
  });

  let metadata: SharpMetadata;
  try {
    metadata = await image.metadata();
  } catch (error) {
    throw failureFrom(error, maxPixels);
  }
  if (metadata.format !== format)
    throw new InspectionFailure('undecodable', DAMAGED);
  if ((metadata.width ?? 0) * (metadata.height ?? 0) > maxPixels)
    throw new InspectionFailure('too-large', tooLarge(maxPixels));
  if ((metadata.pages ?? 1) > 1) {
    throw new InspectionFailure(
      'dangerous-content',
      'Animated or multi-page images are not accepted. Upload a single photo.',
    );
  }

  try {
    const pipeline = image.rotate();
    return outputFormat === 'jpeg'
      ? await pipeline.jpeg({ quality: 90, mozjpeg: true }).toBuffer()
      : await pipeline.png({ compressionLevel: 9 }).toBuffer();
  } catch (error) {
    throw failureFrom(error, maxPixels);
  }
}
