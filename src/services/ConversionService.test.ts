import * as path from 'path';
import { ConversionService, SUPPORTED_EXTENSIONS, OutputFormat } from './ConversionService';

// Mock sharp
const mockToFile = jest.fn().mockResolvedValue({ size: 5000 });
const mockToBuffer = jest.fn().mockResolvedValue(Buffer.from('fake-image-data'));
const mockWebp = jest.fn().mockReturnValue({ toFile: mockToFile, toBuffer: mockToBuffer });
const mockJpeg = jest.fn().mockReturnValue({ toFile: mockToFile, toBuffer: mockToBuffer });
const mockPng = jest.fn().mockReturnValue({ toFile: mockToFile, toBuffer: mockToBuffer });
const mockExtract = jest.fn();
const mockResize = jest.fn();
const mockRotate = jest.fn();
const mockMetadata = jest.fn().mockResolvedValue({ width: 800, height: 600, format: 'png', exif: Buffer.from('fake-exif') });

const createMockPipeline = () => {
  const pipeline: Record<string, jest.Mock> = {
    webp: mockWebp,
    jpeg: mockJpeg,
    png: mockPng,
    extract: mockExtract,
    resize: mockResize,
    rotate: mockRotate,
    metadata: mockMetadata,
    toBuffer: mockToBuffer,
  };
  // Each chainable method returns the pipeline
  mockExtract.mockReturnValue(pipeline);
  mockResize.mockReturnValue(pipeline);
  mockRotate.mockReturnValue(pipeline);
  return pipeline;
};

const mockSharp = jest.fn().mockImplementation(() => createMockPipeline());
jest.mock('sharp', () => ({ default: mockSharp, __esModule: true }));

// Mock exif-reader
jest.mock('exif-reader', () => {
  return jest.fn().mockReturnValue({
    Image: { Make: 'Canon', Model: 'EOS R5' },
    Photo: { DateTimeOriginal: '2024:01:15 10:30:00', FNumber: 2.8, ISO: 400, FocalLength: 50, ExposureTime: 0.008 },
    GPSInfo: {},
  });
}, { virtual: true });

// Mock heic-convert
jest.mock('heic-convert', () => ({
  default: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
  __esModule: true,
}));

// Mock fs/promises
jest.mock('fs/promises', () => ({
  stat: jest.fn().mockResolvedValue({ size: 10000 }),
  readFile: jest.fn().mockResolvedValue(Buffer.from('fake-image')),
  readdir: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

import * as fs from 'fs/promises';

describe('ConversionService', () => {
  let service: ConversionService;

  beforeEach(() => {
    ConversionService.resetInstance();
    service = ConversionService.getInstance();
    jest.clearAllMocks();
    mockToFile.mockResolvedValue({ size: 5000 });
    (fs.stat as jest.Mock).mockResolvedValue({ size: 10000 });
  });

  describe('getInstance', () => {
    it('should return the same instance', () => {
      const instance1 = ConversionService.getInstance();
      const instance2 = ConversionService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('isSupportedImage', () => {
    it.each(SUPPORTED_EXTENSIONS)('should return true for %s', (ext) => {
      expect(service.isSupportedImage(`image${ext}`)).toBe(true);
    });

    it('should be case insensitive', () => {
      expect(service.isSupportedImage('image.PNG')).toBe(true);
      expect(service.isSupportedImage('image.JpG')).toBe(true);
    });

    it('should return false for unsupported formats', () => {
      expect(service.isSupportedImage('file.txt')).toBe(false);
      expect(service.isSupportedImage('file.webp')).toBe(false);
      expect(service.isSupportedImage('file.pdf')).toBe(false);
      expect(service.isSupportedImage('file.svg')).toBe(false);
    });

    it('should return false for files without extension', () => {
      expect(service.isSupportedImage('noextension')).toBe(false);
    });
  });

  describe('buildOutputPath', () => {
    it('should replace extension with .webp', () => {
      const result = service.buildOutputPath('/photos/image.png');
      expect(result).toBe(path.join('/photos', 'image.webp'));
    });

    it('should handle different extensions', () => {
      expect(service.buildOutputPath('/dir/photo.jpg')).toBe(path.join('/dir', 'photo.webp'));
      expect(service.buildOutputPath('/dir/photo.jpeg')).toBe(path.join('/dir', 'photo.webp'));
      expect(service.buildOutputPath('/dir/anim.gif')).toBe(path.join('/dir', 'anim.webp'));
    });

    it('should handle filenames with dots', () => {
      const result = service.buildOutputPath('/photos/my.photo.name.png');
      expect(result).toBe(path.join('/photos', 'my.photo.name.webp'));
    });

    it('should use outputDir when provided', () => {
      const result = service.buildOutputPath('/photos/image.png', '/output');
      expect(result).toBe(path.join('/output', 'image.webp'));
    });

    it('should use jpg extension for jpg format', () => {
      const result = service.buildOutputPath('/photos/image.png', undefined, 'jpg');
      expect(result).toBe(path.join('/photos', 'image.jpg'));
    });

    it('should use png extension for png format', () => {
      const result = service.buildOutputPath('/photos/image.bmp', undefined, 'png');
      expect(result).toBe(path.join('/photos', 'image.png'));
    });

    it('should add _converted suffix when input and output extensions match', () => {
      const result = service.buildOutputPath('/photos/image.png', undefined, 'png');
      expect(result).toBe(path.join('/photos', 'image_converted.png'));
    });

    it('should not add suffix when outputDir is provided even if extensions match', () => {
      const result = service.buildOutputPath('/photos/image.png', '/output', 'png');
      expect(result).toBe(path.join('/output', 'image.png'));
    });

    it('should add _converted suffix for jpg to jpg', () => {
      const result = service.buildOutputPath('/photos/image.jpg', undefined, 'jpg');
      expect(result).toBe(path.join('/photos', 'image_converted.jpg'));
    });
  });

  describe('convertFile', () => {
    it('should convert file with specified quality', async () => {
      const result = await service.convertFile('/photos/image.png', 80);

      expect(mockSharp).toHaveBeenCalledWith(expect.any(Buffer), undefined);
      expect(mockWebp).toHaveBeenCalledWith({ quality: 80 });
      expect(mockToFile).toHaveBeenCalledWith(path.join('/photos', 'image.webp'));
      expect(result.inputPath).toBe('/photos/image.png');
      expect(result.outputPath).toBe(path.join('/photos', 'image.webp'));
      expect(result.inputSize).toBe(10000);
      expect(result.outputSize).toBe(5000);
      expect(result.savings).toBe(50);
    });

    it('should use animated option for GIF files', async () => {
      await service.convertFile('/photos/anim.gif', 80);

      expect(mockSharp).toHaveBeenCalledWith(expect.any(Buffer), { animated: true });
    });

    it('should apply crop when provided', async () => {
      const crop = { left: 10, top: 20, width: 100, height: 200 };
      await service.convertFile('/photos/image.png', 80, undefined, crop);

      expect(mockExtract).toHaveBeenCalledWith({
        left: 10,
        top: 20,
        width: 100,
        height: 200,
      });
    });

    it('should not apply crop when not provided', async () => {
      await service.convertFile('/photos/image.png', 80);
      expect(mockExtract).not.toHaveBeenCalled();
    });

    it('should use outputDir when provided', async () => {
      await service.convertFile('/photos/image.png', 80, '/output');

      expect(mockToFile).toHaveBeenCalledWith(path.join('/output', 'image.webp'));
    });

    it('should throw for unsupported format', async () => {
      await expect(service.convertFile('/files/doc.txt', 80))
        .rejects.toThrow('Unsupported image format: .txt');
    });

    it('should calculate savings correctly', async () => {
      mockToFile.mockResolvedValue({ size: 8000 });
      const result = await service.convertFile('/photos/image.png', 80);
      expect(result.savings).toBe(20);
    });

    it('should handle zero-size input', async () => {
      (fs.stat as jest.Mock).mockResolvedValue({ size: 0 });
      const result = await service.convertFile('/photos/image.png', 80);
      expect(result.savings).toBe(0);
    });

    it('should use jpeg format when specified', async () => {
      const result = await service.convertFile('/photos/image.png', 80, undefined, undefined, 'jpg');
      expect(mockJpeg).toHaveBeenCalledWith({ quality: 80 });
      expect(result.outputPath).toBe(path.join('/photos', 'image.jpg'));
    });

    it('should use png format when specified', async () => {
      const result = await service.convertFile('/photos/image.png', 80, undefined, undefined, 'png');
      expect(mockPng).toHaveBeenCalledWith({ quality: 80 });
      expect(result.outputPath).toBe(path.join('/photos', 'image_converted.png'));
    });
  });

  describe('convertFiles', () => {
    it('should convert multiple files', async () => {
      const paths = ['/photos/a.png', '/photos/b.jpg'];
      const { results, errors } = await service.convertFiles(paths, 80);

      expect(results).toHaveLength(2);
      expect(errors).toHaveLength(0);
    });

    it('should report progress', async () => {
      const progress = jest.fn();
      const paths = ['/photos/a.png', '/photos/b.jpg'];
      await service.convertFiles(paths, 80, undefined, progress);

      expect(progress).toHaveBeenCalledTimes(2);
      expect(progress).toHaveBeenCalledWith(1, 2, 'a.png');
      expect(progress).toHaveBeenCalledWith(2, 2, 'b.jpg');
    });

    it('should collect errors without stopping', async () => {
      mockToFile
        .mockResolvedValueOnce({ size: 5000 })
        .mockRejectedValueOnce(new Error('Sharp error'))
        .mockResolvedValueOnce({ size: 5000 });

      const paths = ['/photos/a.png', '/photos/b.jpg', '/photos/c.png'];
      const { results, errors } = await service.convertFiles(paths, 80);

      expect(results).toHaveLength(2);
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('/photos/b.jpg');
      expect(errors[0].error).toBe('Sharp error');
    });

    it('should handle empty input array', async () => {
      const { results, errors } = await service.convertFiles([], 80);
      expect(results).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });
  });

  describe('getImageInfo', () => {
    it('should return image metadata and file size', async () => {
      const info = await service.getImageInfo('/photos/image.png');

      expect(info).toEqual({
        width: 800,
        height: 600,
        size: 10000,
        format: 'png',
      });
    });

    it('should default to extension when format is missing', async () => {
      mockMetadata.mockResolvedValueOnce({ width: 100, height: 100 });
      const info = await service.getImageInfo('/photos/image.jpg');

      expect(info.format).toBe('jpg');
    });
  });

  describe('getImageBase64', () => {
    it('should return base64 data URI', async () => {
      const result = await service.getImageBase64('/photos/image.png');

      expect(result).toMatch(/^data:image\/png;base64,/);
      expect(mockResize).toHaveBeenCalledWith({ width: 400, withoutEnlargement: true });
    });

    it('should use custom maxWidth', async () => {
      await service.getImageBase64('/photos/image.png', 200);

      expect(mockResize).toHaveBeenCalledWith({ width: 200, withoutEnlargement: true });
    });

    it('should always use png MIME type for preview', async () => {
      const result1 = await service.getImageBase64('/photos/image.jpg');
      expect(result1).toMatch(/^data:image\/png;base64,/);

      const result2 = await service.getImageBase64('/photos/image.gif');
      expect(result2).toMatch(/^data:image\/png;base64,/);
    });
  });

  describe('findImagesInFolder', () => {
    it('should find image files in folder', async () => {
      (fs.readdir as jest.Mock).mockResolvedValue([
        { name: 'photo.png', isFile: () => true },
        { name: 'image.jpg', isFile: () => true },
        { name: 'document.txt', isFile: () => true },
        { name: 'subfolder', isFile: () => false },
      ]);

      const images = await service.findImagesInFolder('/photos');

      expect(images).toHaveLength(2);
      expect(images).toContain(path.join('/photos', 'photo.png'));
      expect(images).toContain(path.join('/photos', 'image.jpg'));
    });

    it('should return empty array when no images found', async () => {
      (fs.readdir as jest.Mock).mockResolvedValue([
        { name: 'readme.md', isFile: () => true },
        { name: 'subfolder', isFile: () => false },
      ]);

      const images = await service.findImagesInFolder('/docs');
      expect(images).toHaveLength(0);
    });

    it('should ignore directories', async () => {
      (fs.readdir as jest.Mock).mockResolvedValue([
        { name: 'images.png', isFile: () => false },
      ]);

      const images = await service.findImagesInFolder('/test');
      expect(images).toHaveLength(0);
    });

    it('should include .heic files', async () => {
      (fs.readdir as jest.Mock).mockResolvedValue([
        { name: 'photo.heic', isFile: () => true },
        { name: 'photo.heif', isFile: () => true },
      ]);

      const images = await service.findImagesInFolder('/photos');
      expect(images).toHaveLength(2);
    });
  });

  describe('getExifData', () => {
    it('should return parsed EXIF data', async () => {
      const exif = await service.getExifData('/photos/image.jpg');

      expect(exif.make).toBe('Canon');
      expect(exif.model).toBe('EOS R5');
      expect(exif.dateTime).toBe('2024:01:15 10:30:00');
      expect(exif.fNumber).toBe(2.8);
      expect(exif.iso).toBe(400);
      expect(exif.focalLength).toBe(50);
      expect(exif.exposureTime).toBe('1/125');
    });

    it('should handle images without EXIF', async () => {
      mockMetadata.mockResolvedValueOnce({ width: 100, height: 100, format: 'png' });
      const exif = await service.getExifData('/photos/image.png');

      expect(exif.make).toBeUndefined();
      expect(exif.model).toBeUndefined();
    });
  });

  describe('estimateWebpSize', () => {
    it('should return estimated buffer size', async () => {
      const size = await service.estimateWebpSize('/photos/image.png', 80);

      expect(mockWebp).toHaveBeenCalledWith({ quality: 80 });
      expect(size).toBe(Buffer.from('fake-image-data').length);
    });
  });

  describe('estimateOutputSize', () => {
    it('should use webp format by default', async () => {
      await service.estimateOutputSize('/photos/image.png', 80);
      expect(mockWebp).toHaveBeenCalledWith({ quality: 80 });
    });

    it('should use jpeg format when specified', async () => {
      await service.estimateOutputSize('/photos/image.png', 80, 'jpg');
      expect(mockJpeg).toHaveBeenCalledWith({ quality: 80 });
    });

    it('should use png format when specified', async () => {
      await service.estimateOutputSize('/photos/image.png', 80, 'png');
      expect(mockPng).toHaveBeenCalledWith({ quality: 80 });
    });
  });
});
