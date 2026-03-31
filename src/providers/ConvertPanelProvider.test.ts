import * as vscode from 'vscode';
import { Uri, clearMockConfig, setMockConfig } from '../__mocks__/vscode';
import { ConvertPanelProvider } from './ConvertPanelProvider';
import { ConversionService } from '../services/ConversionService';

// Mock ConversionService
jest.mock('../services/ConversionService');

const mockConvertFiles = jest.fn().mockResolvedValue({ results: [], errors: [] });
const mockFindImagesInFolder = jest.fn().mockResolvedValue([]);
const mockIsSupportedImage = jest.fn().mockReturnValue(true);
const mockGetImageInfo = jest.fn().mockResolvedValue({ width: 800, height: 600, size: 10000, format: 'png' });
const mockGetImageBase64 = jest.fn().mockResolvedValue('data:image/png;base64,abc123');
const mockGetExifData = jest.fn().mockResolvedValue({ make: 'Canon', model: 'EOS R5', iso: 400 });
const mockEstimateWebpSize = jest.fn().mockResolvedValue(5000);
const mockEstimateOutputSize = jest.fn().mockResolvedValue(5000);

(ConversionService.getInstance as jest.Mock).mockReturnValue({
  convertFiles: mockConvertFiles,
  findImagesInFolder: mockFindImagesInFolder,
  isSupportedImage: mockIsSupportedImage,
  getImageInfo: mockGetImageInfo,
  getExifData: mockGetExifData,
  estimateWebpSize: mockEstimateWebpSize,
  estimateOutputSize: mockEstimateOutputSize,
  getImageBase64: mockGetImageBase64,
});

describe('ConvertPanelProvider', () => {
  let provider: ConvertPanelProvider;
  let mockWebviewView: {
    webview: {
      options: unknown;
      html: string;
      onDidReceiveMessage: jest.Mock;
      postMessage: jest.Mock;
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let messageHandler: (message: any) => Promise<void>;

  beforeEach(() => {
    jest.clearAllMocks();
    clearMockConfig();

    provider = new ConvertPanelProvider(Uri.file('/extension'));

    mockWebviewView = {
      webview: {
        options: {},
        html: '',
        onDidReceiveMessage: jest.fn().mockImplementation((handler) => {
          messageHandler = handler;
          return { dispose: jest.fn() };
        }),
        postMessage: jest.fn().mockResolvedValue(true),
      },
    };

    provider.resolveWebviewView(
      mockWebviewView as unknown as vscode.WebviewView,
      {} as vscode.WebviewViewResolveContext,
      { isCancellationRequested: false, onCancellationRequested: jest.fn() } as unknown as vscode.CancellationToken,
    );
  });

  it('should set webview HTML content', () => {
    expect(mockWebviewView.webview.html).toContain('<!DOCTYPE html>');
    expect(mockWebviewView.webview.html).toContain('Preview');
    expect(mockWebviewView.webview.html).toContain('Enable Crop');
    expect(mockWebviewView.webview.html).toContain('Output Format');
    expect(mockWebviewView.webview.html).toContain('outputFormat');
  });

  it('should enable scripts in webview', () => {
    expect((mockWebviewView.webview.options as { enableScripts: boolean }).enableScripts).toBe(true);
  });

  describe('message: getConfig', () => {
    it('should return default config', async () => {
      await messageHandler({ type: 'getConfig' });
      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
        type: 'config', quality: 80, deleteOriginal: false,
      });
    });

    it('should return custom config', async () => {
      setMockConfig('lwebp.quality', 50);
      setMockConfig('lwebp.deleteOriginal', true);
      await messageHandler({ type: 'getConfig' });
      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
        type: 'config', quality: 50, deleteOriginal: true,
      });
    });
  });

  describe('message: selectFiles', () => {
    it('should open file dialog and post files with info', async () => {
      (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([
        Uri.file('/photos/a.png'),
        Uri.file('/photos/b.jpg'),
      ]);

      await messageHandler({ type: 'selectFiles' });

      expect(vscode.window.showOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({ canSelectMany: true, canSelectFolders: false }),
      );
      expect(mockGetImageInfo).toHaveBeenCalledTimes(2);
      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'filesSelected',
          files: expect.arrayContaining([
            expect.objectContaining({ path: '/photos/a.png', name: 'a.png', size: 10000 }),
          ]),
        }),
      );
    });

    it('should not post if dialog cancelled', async () => {
      (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue(undefined);
      await messageHandler({ type: 'selectFiles' });
      expect(mockWebviewView.webview.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('message: selectFolder', () => {
    it('should open folder dialog, scan folder, and post files with info', async () => {
      (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([Uri.file('/photos')]);
      mockFindImagesInFolder.mockResolvedValue(['/photos/a.png', '/photos/b.jpg']);

      await messageHandler({ type: 'selectFolder' });

      expect(mockFindImagesInFolder).toHaveBeenCalledWith('/photos');
      expect(mockGetImageInfo).toHaveBeenCalledTimes(2);
      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'filesSelected',
          files: expect.arrayContaining([
            expect.objectContaining({ path: '/photos/a.png' }),
          ]),
          folder: '/photos',
        }),
      );
    });
  });

  describe('message: previewFile', () => {
    it('should return base64 preview and image info', async () => {
      await messageHandler({ type: 'previewFile', filePath: '/photos/a.png' });

      expect(mockGetImageBase64).toHaveBeenCalledWith('/photos/a.png');
      expect(mockGetImageInfo).toHaveBeenCalledWith('/photos/a.png');
      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
        type: 'previewData',
        filePath: '/photos/a.png',
        base64: 'data:image/png;base64,abc123',
        info: { width: 800, height: 600, size: 10000, format: 'png' },
      });
    });

    it('should post error on preview failure', async () => {
      mockGetImageBase64.mockRejectedValueOnce(new Error('fail'));
      await messageHandler({ type: 'previewFile', filePath: '/bad.png' });

      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
        type: 'previewError',
        filePath: '/bad.png',
        error: 'fail',
      });
    });

    it('should ignore if no filePath', async () => {
      await messageHandler({ type: 'previewFile' });
      expect(mockGetImageBase64).not.toHaveBeenCalled();
    });
  });

  describe('message: getFileInfo', () => {
    it('should return file info', async () => {
      await messageHandler({ type: 'getFileInfo', filePath: '/photos/a.png' });

      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
        type: 'fileInfo',
        filePath: '/photos/a.png',
        info: { width: 800, height: 600, size: 10000, format: 'png' },
      });
    });
  });

  describe('message: getExif', () => {
    it('should return EXIF data', async () => {
      await messageHandler({ type: 'getExif', filePath: '/photos/a.jpg' });

      expect(mockGetExifData).toHaveBeenCalledWith('/photos/a.jpg');
      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
        type: 'exifData',
        filePath: '/photos/a.jpg',
        exif: { make: 'Canon', model: 'EOS R5', iso: 400 },
      });
    });

    it('should return empty exif on error', async () => {
      mockGetExifData.mockRejectedValueOnce(new Error('no exif'));
      await messageHandler({ type: 'getExif', filePath: '/photos/a.png' });

      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
        type: 'exifData',
        filePath: '/photos/a.png',
        exif: {},
      });
    });

    it('should ignore if no filePath', async () => {
      await messageHandler({ type: 'getExif' });
      expect(mockGetExifData).not.toHaveBeenCalled();
    });
  });

  describe('message: estimateSize', () => {
    it('should return estimated size', async () => {
      await messageHandler({ type: 'estimateSize', filePath: '/photos/a.png', quality: 60 });

      expect(mockEstimateOutputSize).toHaveBeenCalledWith('/photos/a.png', 60, 'webp');
      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
        type: 'estimatedSize',
        filePath: '/photos/a.png',
        quality: 60,
        estimatedSize: 5000,
      });
    });

    it('should pass format to estimateOutputSize', async () => {
      await messageHandler({ type: 'estimateSize', filePath: '/photos/a.png', quality: 80, format: 'jpg' });

      expect(mockEstimateOutputSize).toHaveBeenCalledWith('/photos/a.png', 80, 'jpg');
    });

    it('should ignore if no filePath', async () => {
      await messageHandler({ type: 'estimateSize', quality: 80 });
      expect(mockEstimateOutputSize).not.toHaveBeenCalled();
    });

    it('should ignore if no quality', async () => {
      await messageHandler({ type: 'estimateSize', filePath: '/a.png' });
      expect(mockEstimateOutputSize).not.toHaveBeenCalled();
    });
  });

  describe('message: convert', () => {
    it('should post error when no files provided', async () => {
      await messageHandler({ type: 'convert', files: [] });
      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
        type: 'error', message: 'No files selected.',
      });
    });

    it('should convert files and post results', async () => {
      mockConvertFiles.mockResolvedValue({
        results: [{ inputPath: '/a.png', outputPath: '/a.webp', inputSize: 10000, outputSize: 5000, savings: 50 }],
        errors: [],
      });

      await messageHandler({ type: 'convert', files: ['/photos/a.png'], quality: 75, deleteOriginal: false });

      expect(mockConvertFiles).toHaveBeenCalledWith(
        ['/photos/a.png'], 75, undefined, expect.any(Function), undefined, 'webp',
      );
      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({ type: 'convertStart', total: 1 });
      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'convertDone', results: expect.any(Array) }),
      );
    });

    it('should pass crop data when provided', async () => {
      mockConvertFiles.mockResolvedValue({ results: [], errors: [] });
      const crop = { left: 10, top: 20, width: 100, height: 200 };

      await messageHandler({ type: 'convert', files: ['/a.png'], quality: 80, crop });

      expect(mockConvertFiles).toHaveBeenCalledWith(
        ['/a.png'], 80, undefined, expect.any(Function), crop, 'webp',
      );
    });

    it('should pass format when provided', async () => {
      mockConvertFiles.mockResolvedValue({ results: [], errors: [] });

      await messageHandler({ type: 'convert', files: ['/a.png'], quality: 80, format: 'jpg' });

      expect(mockConvertFiles).toHaveBeenCalledWith(
        ['/a.png'], 80, undefined, expect.any(Function), undefined, 'jpg',
      );
    });

    it('should handle file objects with path property', async () => {
      mockConvertFiles.mockResolvedValue({ results: [], errors: [] });

      await messageHandler({
        type: 'convert',
        files: [{ path: '/a.png', name: 'a.png' }],
        quality: 80,
      });

      expect(mockConvertFiles).toHaveBeenCalledWith(
        ['/a.png'], 80, undefined, expect.any(Function), undefined, 'webp',
      );
    });

    it('should delete originals when deleteOriginal is true', async () => {
      mockConvertFiles.mockResolvedValue({
        results: [{ inputPath: '/a.png', outputPath: '/a.webp', inputSize: 10000, outputSize: 5000, savings: 50 }],
        errors: [],
      });

      await messageHandler({ type: 'convert', files: ['/a.png'], quality: 80, deleteOriginal: true });
      expect(vscode.workspace.fs.delete).toHaveBeenCalled();
    });

    it('should report progress during conversion', async () => {
      mockConvertFiles.mockImplementation(async (_f: string[], _q: number, _d: string | undefined, progress: (c: number, t: number, f: string) => void) => {
        progress(1, 2, 'a.png');
        progress(2, 2, 'b.jpg');
        return { results: [], errors: [] };
      });

      await messageHandler({ type: 'convert', files: ['/a.png', '/b.jpg'], quality: 80 });

      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith({
        type: 'convertProgress', current: 1, total: 2, fileName: 'a.png',
      });
    });
  });
});
