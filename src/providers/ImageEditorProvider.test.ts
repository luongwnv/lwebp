import * as vscode from 'vscode';
import { Uri, setMockConfig, clearMockConfig } from '../__mocks__/vscode';
import { ImageEditorProvider } from './ImageEditorProvider';
import { ConversionService } from '../services/ConversionService';

jest.mock('../services/ConversionService');

const mockGetImageBase64 = jest.fn().mockResolvedValue('data:image/png;base64,abc123');
const mockGetImageInfo = jest.fn().mockResolvedValue({ width: 800, height: 600, size: 10000, format: 'png' });
const mockGetExifData = jest.fn().mockResolvedValue({ make: 'Canon', model: 'EOS R5' });
const mockConvertFile = jest.fn().mockResolvedValue({ inputPath: '/a.png', outputPath: '/a.webp', inputSize: 10000, outputSize: 5000, savings: 50 });
const mockEstimateOutputSize = jest.fn().mockResolvedValue(5000);

(ConversionService.getInstance as jest.Mock).mockReturnValue({
  getImageBase64: mockGetImageBase64,
  getImageInfo: mockGetImageInfo,
  getExifData: mockGetExifData,
  convertFile: mockConvertFile,
  estimateOutputSize: mockEstimateOutputSize,
});

describe('ImageEditorProvider', () => {
  let provider: ImageEditorProvider;
  let mockWebviewPanel: {
    webview: {
      options: unknown;
      html: string;
      onDidReceiveMessage: jest.Mock;
      postMessage: jest.Mock;
      asWebviewUri: jest.Mock;
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let messageHandler: (message: any) => Promise<void>;

  beforeEach(() => {
    jest.clearAllMocks();
    clearMockConfig();

    provider = new ImageEditorProvider(Uri.file('/extension'));

    mockWebviewPanel = {
      webview: {
        options: {},
        html: '',
        onDidReceiveMessage: jest.fn().mockImplementation((handler) => {
          messageHandler = handler;
          return { dispose: jest.fn() };
        }),
        postMessage: jest.fn().mockResolvedValue(true),
        asWebviewUri: jest.fn().mockImplementation((uri: unknown) => uri),
      },
    };
  });

  async function resolveEditor(filePath = '/photos/image.png') {
    const document = { uri: Uri.file(filePath), dispose: jest.fn() };
    await provider.resolveCustomEditor(
      document as unknown as vscode.CustomDocument,
      mockWebviewPanel as unknown as vscode.WebviewPanel,
      { isCancellationRequested: false, onCancellationRequested: jest.fn() } as unknown as vscode.CancellationToken,
    );
  }

  it('should set webview HTML with image info', async () => {
    await resolveEditor();

    expect(mockWebviewPanel.webview.html).toContain('<!DOCTYPE html>');
    expect(mockWebviewPanel.webview.html).toContain('image.png');
    expect(mockWebviewPanel.webview.html).toContain('800');
    expect(mockWebviewPanel.webview.html).toContain('600');
    expect(mockWebviewPanel.webview.html).toContain('data:image/png;base64,abc123');
  });

  it('should contain format selector', async () => {
    await resolveEditor();

    expect(mockWebviewPanel.webview.html).toContain('value="webp"');
    expect(mockWebviewPanel.webview.html).toContain('value="jpg"');
    expect(mockWebviewPanel.webview.html).toContain('value="png"');
  });

  it('should enable scripts in webview', async () => {
    await resolveEditor();

    expect((mockWebviewPanel.webview.options as { enableScripts: boolean }).enableScripts).toBe(true);
  });

  it('should open custom document', async () => {
    const uri = Uri.file('/photos/test.png');
    const doc = await provider.openCustomDocument(
      uri as unknown as vscode.Uri,
      {} as vscode.CustomDocumentOpenContext,
      { isCancellationRequested: false, onCancellationRequested: jest.fn() } as unknown as vscode.CancellationToken,
    );

    expect(doc.uri).toBe(uri);
  });

  describe('message: convert', () => {
    it('should convert file with default format', async () => {
      await resolveEditor();
      await messageHandler({ type: 'convert', quality: 75, format: 'webp' });

      expect(mockConvertFile).toHaveBeenCalledWith('/photos/image.png', 75, undefined, undefined, 'webp');
      expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'convertDone', savings: 50 }),
      );
    });

    it('should convert with jpg format', async () => {
      await resolveEditor();
      await messageHandler({ type: 'convert', quality: 80, format: 'jpg' });

      expect(mockConvertFile).toHaveBeenCalledWith('/photos/image.png', 80, undefined, undefined, 'jpg');
    });

    it('should post error on failure', async () => {
      mockConvertFile.mockRejectedValueOnce(new Error('Sharp error'));
      await resolveEditor();
      await messageHandler({ type: 'convert', quality: 80, format: 'webp' });

      expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Sharp error' }),
      );
    });

    it('should delete original when configured', async () => {
      setMockConfig('lwebp.deleteOriginal', true);
      await resolveEditor();
      await messageHandler({ type: 'convert', quality: 80, format: 'webp' });

      expect(vscode.workspace.fs.delete).toHaveBeenCalled();
    });
  });

  describe('message: estimateSize', () => {
    it('should return estimated size', async () => {
      await resolveEditor();
      await messageHandler({ type: 'estimateSize', quality: 60, format: 'webp' });

      expect(mockEstimateOutputSize).toHaveBeenCalledWith('/photos/image.png', 60, 'webp');
      expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'estimatedSize',
          estimatedSize: 5000,
          originalSize: 10000,
        }),
      );
    });

    it('should ignore if no quality', async () => {
      await resolveEditor();
      await messageHandler({ type: 'estimateSize', format: 'webp' });
      expect(mockEstimateOutputSize).not.toHaveBeenCalled();
    });
  });
});
