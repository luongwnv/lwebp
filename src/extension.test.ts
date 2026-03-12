import * as vscode from 'vscode';
import { createMockExtensionContext, setMockConfig, clearMockConfig, Uri } from './__mocks__/vscode';
import { activate } from './extension';
import { ConversionService } from './services/ConversionService';

// Mock ConversionService and ConvertPanelProvider
jest.mock('./services/ConversionService');
jest.mock('./providers/ConvertPanelProvider');
jest.mock('./providers/ImageEditorProvider');

const mockConvertFile = jest.fn();
const mockConvertFiles = jest.fn().mockResolvedValue({ results: [], errors: [] });
const mockFindImagesInFolder = jest.fn().mockResolvedValue([]);
const mockIsSupportedImage = jest.fn().mockReturnValue(true);

(ConversionService.getInstance as jest.Mock).mockReturnValue({
  convertFile: mockConvertFile,
  convertFiles: mockConvertFiles,
  findImagesInFolder: mockFindImagesInFolder,
  isSupportedImage: mockIsSupportedImage,
});

describe('Extension', () => {
  let context: ReturnType<typeof createMockExtensionContext>;
  let registeredCommands: Map<string, (...args: unknown[]) => Promise<void>>;

  beforeEach(() => {
    jest.clearAllMocks();
    clearMockConfig();
    context = createMockExtensionContext();
    registeredCommands = new Map();

    (vscode.commands.registerCommand as jest.Mock).mockImplementation(
      (command: string, handler: (...args: unknown[]) => Promise<void>) => {
        registeredCommands.set(command, handler);
        return { dispose: jest.fn() };
      },
    );

    mockConvertFiles.mockResolvedValue({
      results: [
        { inputPath: '/photos/a.png', outputPath: '/photos/a.webp', inputSize: 10000, outputSize: 5000, savings: 50 },
      ],
      errors: [],
    });

    mockIsSupportedImage.mockReturnValue(true);

    activate(context as unknown as vscode.ExtensionContext);
  });

  describe('activate', () => {
    it('should register all three commands', () => {
      expect(vscode.commands.registerCommand).toHaveBeenCalledTimes(3);
      expect(registeredCommands.has('lwebp.convertFile')).toBe(true);
      expect(registeredCommands.has('lwebp.convertFolder')).toBe(true);
      expect(registeredCommands.has('lwebp.convertFileWithQuality')).toBe(true);
    });

    it('should register webview view provider', () => {
      expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledWith(
        'lwebp.convertPanel',
        expect.any(Object),
      );
    });

    it('should register custom editor provider', () => {
      expect(vscode.window.registerCustomEditorProvider).toHaveBeenCalledWith(
        'lwebp.imageEditor',
        expect.any(Object),
        expect.objectContaining({ webviewOptions: { retainContextWhenHidden: true } }),
      );
    });

    it('should push disposables to subscriptions', () => {
      // 3 commands + 1 webview provider + 1 custom editor = 5
      expect(context.subscriptions).toHaveLength(5);
    });
  });

  describe('lwebp.convertFile', () => {
    it('should convert a single file with default quality', async () => {
      const handler = registeredCommands.get('lwebp.convertFile')!;
      const uri = Uri.file('/photos/image.png');

      await handler(uri);

      expect(mockConvertFiles).toHaveBeenCalledWith(
        ['/photos/image.png'],
        80,
        undefined,
        expect.any(Function),
      );
    });

    it('should convert multiple selected files', async () => {
      const handler = registeredCommands.get('lwebp.convertFile')!;
      const uri = Uri.file('/photos/a.png');
      const uris = [Uri.file('/photos/a.png'), Uri.file('/photos/b.jpg')];

      await handler(uri, uris);

      expect(mockConvertFiles).toHaveBeenCalledWith(
        ['/photos/a.png', '/photos/b.jpg'],
        80,
        undefined,
        expect.any(Function),
      );
    });

    it('should use configured quality', async () => {
      setMockConfig('lwebp.quality', 50);
      const handler = registeredCommands.get('lwebp.convertFile')!;
      await handler(Uri.file('/photos/image.png'));

      expect(mockConvertFiles).toHaveBeenCalledWith(
        ['/photos/image.png'],
        50,
        undefined,
        expect.any(Function),
      );
    });

    it('should use configured output directory', async () => {
      setMockConfig('lwebp.outputDirectory', '/output');
      const handler = registeredCommands.get('lwebp.convertFile')!;
      await handler(Uri.file('/photos/image.png'));

      expect(mockConvertFiles).toHaveBeenCalledWith(
        ['/photos/image.png'],
        80,
        '/output',
        expect.any(Function),
      );
    });

    it('should show warning when no files selected', async () => {
      const handler = registeredCommands.get('lwebp.convertFile')!;
      await handler();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No image files selected.');
      expect(mockConvertFiles).not.toHaveBeenCalled();
    });

    it('should show success message after conversion', async () => {
      const handler = registeredCommands.get('lwebp.convertFile')!;
      await handler(Uri.file('/photos/image.png'));

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Converted 1 file(s) to WebP (avg 50% savings, quality: 80)',
      );
    });

    it('should show warning when conversion has errors', async () => {
      mockConvertFiles.mockResolvedValue({
        results: [{ inputPath: '/a.png', outputPath: '/a.webp', inputSize: 10000, outputSize: 5000, savings: 50 }],
        errors: [{ path: '/b.jpg', error: 'Failed' }],
      });

      const handler = registeredCommands.get('lwebp.convertFile')!;
      await handler(Uri.file('/photos/a.png'), [Uri.file('/photos/a.png'), Uri.file('/photos/b.jpg')]);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Converted 1 file(s) to WebP (avg 50% savings, quality: 80). 1 file(s) failed.',
      );
    });

    it('should show error when all conversions fail', async () => {
      mockConvertFiles.mockResolvedValue({
        results: [],
        errors: [{ path: '/a.png', error: 'Failed' }],
      });

      const handler = registeredCommands.get('lwebp.convertFile')!;
      await handler(Uri.file('/photos/a.png'));

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'All 1 conversion(s) failed.',
      );
    });

    it('should delete originals when deleteOriginal is true', async () => {
      setMockConfig('lwebp.deleteOriginal', true);
      const handler = registeredCommands.get('lwebp.convertFile')!;
      await handler(Uri.file('/photos/image.png'));

      expect(vscode.workspace.fs.delete).toHaveBeenCalled();
    });

    it('should not delete originals by default', async () => {
      const handler = registeredCommands.get('lwebp.convertFile')!;
      await handler(Uri.file('/photos/image.png'));

      expect(vscode.workspace.fs.delete).not.toHaveBeenCalled();
    });
  });

  describe('lwebp.convertFolder', () => {
    it('should scan folder and convert found images', async () => {
      mockFindImagesInFolder.mockResolvedValue(['/photos/a.png', '/photos/b.jpg']);
      const handler = registeredCommands.get('lwebp.convertFolder')!;
      await handler(Uri.file('/photos'));

      expect(mockFindImagesInFolder).toHaveBeenCalledWith('/photos');
      expect(mockConvertFiles).toHaveBeenCalledWith(
        ['/photos/a.png', '/photos/b.jpg'],
        80,
        undefined,
        expect.any(Function),
      );
    });

    it('should show message when no images found in folder', async () => {
      mockFindImagesInFolder.mockResolvedValue([]);
      const handler = registeredCommands.get('lwebp.convertFolder')!;
      await handler(Uri.file('/empty'));

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'No supported images found in folder.',
      );
      expect(mockConvertFiles).not.toHaveBeenCalled();
    });

    it('should show warning when no folder selected', async () => {
      const handler = registeredCommands.get('lwebp.convertFolder')!;
      await handler();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No folder selected.');
    });
  });

  describe('lwebp.convertFileWithQuality', () => {
    it('should prompt for quality and convert', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('60');
      const handler = registeredCommands.get('lwebp.convertFileWithQuality')!;
      await handler(Uri.file('/photos/image.png'));

      expect(vscode.window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Enter WebP quality (0-100)',
          value: '80',
        }),
      );
      expect(mockConvertFiles).toHaveBeenCalledWith(
        ['/photos/image.png'],
        60,
        undefined,
        expect.any(Function),
      );
    });

    it('should cancel when user dismisses input box', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);
      const handler = registeredCommands.get('lwebp.convertFileWithQuality')!;
      await handler(Uri.file('/photos/image.png'));

      expect(mockConvertFiles).not.toHaveBeenCalled();
    });

    it('should validate quality input', async () => {
      (vscode.window.showInputBox as jest.Mock).mockImplementation(async (options: { validateInput?: (v: string) => string | null }) => {
        const validate = options.validateInput!;
        expect(validate('abc')).toBe('Please enter an integer between 0 and 100');
        expect(validate('-1')).toBe('Please enter an integer between 0 and 100');
        expect(validate('101')).toBe('Please enter an integer between 0 and 100');
        expect(validate('50.5')).toBe('Please enter an integer between 0 and 100');
        expect(validate('0')).toBeNull();
        expect(validate('100')).toBeNull();
        expect(validate('50')).toBeNull();
        return '50';
      });

      const handler = registeredCommands.get('lwebp.convertFileWithQuality')!;
      await handler(Uri.file('/photos/image.png'));
    });

    it('should show warning when no files selected', async () => {
      const handler = registeredCommands.get('lwebp.convertFileWithQuality')!;
      await handler();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No image files selected.');
      expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    });
  });
});
