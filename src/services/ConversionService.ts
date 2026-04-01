import * as fs from 'fs/promises';
import * as path from 'path';

export const SUPPORTED_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif',
  '.avif', '.heic', '.heif', '.webp', '.svg',
  '.ico', '.jxl',
  '.raw', '.cr2', '.nef', '.arw',
];

const HEIF_EXTENSIONS = ['.heic', '.heif'];
const RAW_EXTENSIONS = ['.raw', '.cr2', '.nef', '.arw'];
const ICO_EXTENSION = '.ico';

export type OutputFormat = 'webp' | 'jpg' | 'png';

// Cache converted HEIC buffers to avoid re-converting for multiple operations
const heicCache = new Map<string, { buffer: Buffer; mtime: number }>();
const heicThumbCache = new Map<string, { buffer: Buffer; mtime: number }>();

function isHeif(filePath: string): boolean {
  return HEIF_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

function isRaw(filePath: string): boolean {
  return RAW_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

function isIco(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ICO_EXTENSION;
}

/** Decode ICO: pick largest image, return PNG buffer */
async function decodeIcoToBuffer(fileBuffer: Buffer): Promise<Buffer> {
  const { parseICO } = await import('icojs');
  const images = await parseICO(fileBuffer);
  if (!images || images.length === 0) {
    throw new Error('No images found in ICO file');
  }
  // Pick the largest image
  const largest = images.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  return Buffer.from(largest.buffer);
}

/** Decode camera RAW to TIFF buffer via dcraw */
async function decodeRawToBuffer(fileBuffer: Buffer): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dcraw = require('dcraw') as (buf: Buffer, opts?: { exportAsTiff?: boolean }) => Buffer;
  const tiffBuffer = dcraw(fileBuffer, { exportAsTiff: true });
  if (!tiffBuffer || tiffBuffer.length === 0) {
    throw new Error('Failed to decode RAW image');
  }
  return Buffer.from(tiffBuffer);
}

/** Convert HEIC for metadata operations (lower quality to be faster) */
async function convertHeicToBuffer(fileBuffer: Buffer, quality = 0.8): Promise<Buffer> {
  const convert = (await import('heic-convert')).default;
  const result = await convert({ buffer: fileBuffer, format: 'JPEG', quality });
  return Buffer.from(result);
}

async function readImageInput(filePath: string): Promise<Buffer> {
  const fileBuffer = await fs.readFile(filePath);

  if (isIco(filePath)) {
    return decodeIcoToBuffer(fileBuffer);
  }

  if (isRaw(filePath)) {
    return decodeRawToBuffer(fileBuffer);
  }

  if (!isHeif(filePath)) {
    return fileBuffer;
  }

  // Check cache validity
  const stat = await fs.stat(filePath);
  const cached = heicCache.get(filePath);
  if (cached && cached.mtime === stat.mtime.getTime()) {
    return cached.buffer;
  }

  // Convert HEIC to JPEG with high quality for actual conversion
  const convertedBuffer = await convertHeicToBuffer(fileBuffer, 1);
  heicCache.set(filePath, { buffer: convertedBuffer, mtime: stat.mtime.getTime() });
  return convertedBuffer;
}

/** Try reading HEIC metadata without full pixel conversion */
async function tryReadHeicMetadataOnly(filePath: string): Promise<Buffer | null> {
  try {
    const fileBuffer = await fs.readFile(filePath);
    // Sharp sometimes can extract metadata headers without full decode
    const sharp = (await import('sharp')).default;
    await sharp(fileBuffer).metadata();
    // If metadata read succeeded, convert with lower quality (we only need dimensions)
    const stat = await fs.stat(filePath);
    const stat_mtime = stat.mtime.getTime();
    const cached = heicCache.get(filePath);
    if (cached && cached.mtime === stat_mtime) {
      return cached.buffer;
    }
    const converted = await convertHeicToBuffer(fileBuffer, 0.6);
    heicCache.set(filePath, { buffer: converted, mtime: stat_mtime });
    return converted;
  } catch {
    return null;
  }
}

export const OUTPUT_FORMATS: { value: OutputFormat; label: string; ext: string }[] = [
  { value: 'webp', label: 'WebP', ext: '.webp' },
  { value: 'jpg', label: 'JPEG', ext: '.jpg' },
  { value: 'png', label: 'PNG', ext: '.png' },
];

export interface CropOptions {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ImageInfo {
  width: number;
  height: number;
  size: number;
  format: string;
}

export interface ExifData {
  make?: string;
  model?: string;
  dateTime?: string;
  exposureTime?: string;
  fNumber?: number;
  iso?: number;
  focalLength?: number;
  lensModel?: string;
  gpsLatitude?: number;
  gpsLongitude?: number;
  orientation?: number;
  colorSpace?: string;
  whiteBalance?: string;
}

export interface ConversionResult {
  inputPath: string;
  outputPath: string;
  inputSize: number;
  outputSize: number;
  savings: number;
}

export type ProgressCallback = (current: number, total: number, fileName: string) => void;

export class ConversionService {
  private static _instance: ConversionService;

  private constructor() {}

  static getInstance(): ConversionService {
    if (!ConversionService._instance) {
      ConversionService._instance = new ConversionService();
    }
    return ConversionService._instance;
  }

  /** Reset singleton for testing */
  static resetInstance(): void {
    ConversionService._instance = undefined as unknown as ConversionService;
  }

  isSupportedImage(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return SUPPORTED_EXTENSIONS.includes(ext);
  }

  buildOutputPath(inputPath: string, outputDir?: string, format: OutputFormat = 'webp'): string {
    const parsed = path.parse(inputPath);
    const formatInfo = OUTPUT_FORMATS.find(f => f.value === format) ?? OUTPUT_FORMATS[0];
    const dir = outputDir ?? parsed.dir;

    // Avoid same input/output path by adding suffix when extension matches
    let outputName = `${parsed.name}${formatInfo.ext}`;
    if (!outputDir && parsed.ext.toLowerCase() === formatInfo.ext) {
      outputName = `${parsed.name}_converted${formatInfo.ext}`;
    }

    return path.join(dir, outputName);
  }

  async getImageInfo(filePath: string): Promise<ImageInfo> {
    const sharp = (await import('sharp')).default;
    // For HEIC, try metadata-only path first (faster, lower quality needed)
    let input: Buffer;
    if (isHeif(filePath)) {
      const metadataOnly = await tryReadHeicMetadataOnly(filePath);
      input = metadataOnly || (await readImageInput(filePath));
    } else {
      input = await readImageInput(filePath);
    }
    const metadata = await sharp(input).metadata();
    const stat = await fs.stat(filePath);

    return {
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      size: stat.size,
      format: metadata.format ?? path.extname(filePath).slice(1),
    };
  }

  async getExifData(filePath: string): Promise<ExifData> {
    const sharp = (await import('sharp')).default;
    // Read EXIF from original file — not the converted buffer, which loses EXIF
    const rawBuffer = await fs.readFile(filePath);
    let metadata;
    try {
      metadata = await sharp(rawBuffer).metadata();
    } catch {
      // If sharp can't read metadata from original (e.g. HEIC on Windows)
      // Try metadata-only conversion for HEIC first (faster)
      let input: Buffer;
      if (isHeif(filePath)) {
        const metadataOnly = await tryReadHeicMetadataOnly(filePath);
        input = metadataOnly || (await readImageInput(filePath));
      } else {
        input = await readImageInput(filePath);
      }
      metadata = await sharp(input).metadata();
    }
    const exif = metadata.exif ? this._parseExifBuffer(metadata.exif) : {};

    return {
      make: exif.Make,
      model: exif.Model,
      dateTime: exif.DateTimeOriginal || exif.DateTime,
      exposureTime: exif.ExposureTime ? `1/${Math.round(1 / exif.ExposureTime)}` : undefined,
      fNumber: exif.FNumber,
      iso: exif.ISO || exif.ISOSpeedRatings,
      focalLength: exif.FocalLength,
      lensModel: exif.LensModel,
      gpsLatitude: exif.GPSLatitude,
      gpsLongitude: exif.GPSLongitude,
      orientation: metadata.orientation,
      colorSpace: metadata.space,
      whiteBalance: exif.WhiteBalance === 0 ? 'Auto' : exif.WhiteBalance === 1 ? 'Manual' : undefined,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _parseExifBuffer(exifBuffer: Buffer): Record<string, any> {
    // Sharp provides raw EXIF as a buffer. We use sharp's metadata which
    // already extracts some EXIF fields, but for full EXIF we parse the IFD0/EXIF tags.
    // For simplicity, we rely on the EXIF data that sharp exposes through metadata.
    // If exif-reader is available, use it; otherwise return empty.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const exifReader = require('exif-reader');
      const parsed = exifReader(exifBuffer);
      return { ...parsed?.Image, ...parsed?.Photo, ...parsed?.GPSInfo };
    } catch {
      return {};
    }
  }

  async estimateOutputSize(filePath: string, quality: number, format: OutputFormat = 'webp'): Promise<number> {
    const sharp = (await import('sharp')).default;
    const input = await readImageInput(filePath);
    let pipeline = sharp(input).rotate();
    pipeline = this._applyOutputFormat(pipeline, format, quality);
    const buffer = await pipeline.toBuffer();
    return buffer.length;
  }

  /** @deprecated Use estimateOutputSize instead */
  async estimateWebpSize(filePath: string, quality: number): Promise<number> {
    return this.estimateOutputSize(filePath, quality, 'webp');
  }

  async getImageBase64(filePath: string, maxWidth = 400): Promise<string> {
    const sharp = (await import('sharp')).default;
    // Check thumbnail cache first
    const stat = await fs.stat(filePath);
    const stat_mtime = stat.mtime?.getTime?.() ?? 0;
    const cachedThumb = heicThumbCache.get(filePath);
    if (stat_mtime > 0 && cachedThumb && cachedThumb.mtime === stat_mtime) {
      return `data:image/png;base64,${cachedThumb.buffer.toString('base64')}`;
    }
    
    // For HEIC, use lower quality intermediate buffer (metadata-only path)
    const input = isHeif(filePath) 
      ? (await tryReadHeicMetadataOnly(filePath)) || (await readImageInput(filePath))
      : await readImageInput(filePath);
    const buffer = await sharp(input)
      .rotate() // auto-rotate based on EXIF orientation
      .resize({ width: maxWidth, withoutEnlargement: true })
      .png({ compressionLevel: 6 }) // Compress thumbnail
      .toBuffer();
    heicThumbCache.set(filePath, { buffer, mtime: stat_mtime });
    return `data:image/png;base64,${buffer.toString('base64')}`;
  }

  async convertFile(inputPath: string, quality: number, outputDir?: string, crop?: CropOptions, format: OutputFormat = 'webp'): Promise<ConversionResult> {
    if (!this.isSupportedImage(inputPath)) {
      throw new Error(`Unsupported image format: ${path.extname(inputPath)}`);
    }

    const sharp = (await import('sharp')).default;
    const outputPath = this.buildOutputPath(inputPath, outputDir, format);

    const inputStat = await fs.stat(inputPath);
    const inputSize = inputStat.size;

    const ext = path.extname(inputPath).toLowerCase();
    const input = await readImageInput(inputPath);
    let pipeline = sharp(input, ext === '.gif' ? { animated: true } : undefined)
      .rotate(); // auto-rotate based on EXIF orientation

    if (crop) {
      pipeline = pipeline.extract({
        left: Math.round(crop.left),
        top: Math.round(crop.top),
        width: Math.round(crop.width),
        height: Math.round(crop.height),
      });
    }

    pipeline = this._applyOutputFormat(pipeline, format, quality);
    const outputInfo = await pipeline.toFile(outputPath);

    const savings = inputSize > 0
      ? Math.round((1 - outputInfo.size / inputSize) * 100)
      : 0;

    return {
      inputPath,
      outputPath,
      inputSize,
      outputSize: outputInfo.size,
      savings,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _applyOutputFormat(pipeline: any, format: OutputFormat, quality: number): any {
    switch (format) {
      case 'jpg':
        return pipeline.jpeg({ quality });
      case 'png':
        return pipeline.png({ quality });
      case 'webp':
      default:
        return pipeline.webp({ quality });
    }
  }

  async convertFiles(
    inputPaths: string[],
    quality: number,
    outputDir?: string,
    progress?: ProgressCallback,
    crop?: CropOptions,
    format: OutputFormat = 'webp',
  ): Promise<{ results: ConversionResult[]; errors: { path: string; error: string }[] }> {
    const results: ConversionResult[] = [];
    const errors: { path: string; error: string }[] = [];

    for (let i = 0; i < inputPaths.length; i++) {
      const filePath = inputPaths[i];
      const fileName = path.basename(filePath);

      if (progress) {
        progress(i + 1, inputPaths.length, fileName);
      }

      try {
        const result = await this.convertFile(filePath, quality, outputDir, crop, format);
        results.push(result);
      } catch (err) {
        errors.push({
          path: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { results, errors };
  }

  async rotateImage(filePath: string, angle: number): Promise<void> {
    const sharp = (await import('sharp')).default;
    const input = await readImageInput(filePath);
    const buffer = await sharp(input)
      .rotate(angle)
      .toBuffer();
    await fs.writeFile(filePath, buffer);
  }

  async findImagesInFolder(folderPath: string): Promise<string[]> {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const images: string[] = [];

    for (const entry of entries) {
      if (entry.isFile() && this.isSupportedImage(entry.name)) {
        images.push(path.join(folderPath, entry.name));
      }
    }

    return images;
  }
}
