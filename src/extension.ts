import * as vscode from 'vscode';
import { ConversionService } from './services/ConversionService';
import { ConvertPanelProvider } from './providers/ConvertPanelProvider';
import { ImageEditorProvider } from './providers/ImageEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  const service = ConversionService.getInstance();

  // Register sidebar webview panel
  const panelProvider = new ConvertPanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ConvertPanelProvider.viewType, panelProvider),
  );

  // Register custom editor for image files
  const editorProvider = new ImageEditorProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(ImageEditorProvider.viewType, editorProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Sync theme from panel to all editor panels
  panelProvider.onThemeChanged((theme) => editorProvider.setTheme(theme));

  // Convert single or multiple selected files
  const convertFile = vscode.commands.registerCommand(
    'lwebp.convertFile',
    async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const filesToConvert = resolveUris(uri, uris);
      if (filesToConvert.length === 0) {
        vscode.window.showWarningMessage('No image files selected.');
        return;
      }

      const config = vscode.workspace.getConfiguration('lwebp');
      const quality = config.get<number>('quality', 80);
      const deleteOriginal = config.get<boolean>('deleteOriginal', false);
      const outputDir = config.get<string>('outputDirectory', '') || undefined;

      await runConversion(service, filesToConvert, quality, deleteOriginal, outputDir);
    },
  );

  // Convert all images in a folder
  const convertFolder = vscode.commands.registerCommand(
    'lwebp.convertFolder',
    async (uri?: vscode.Uri) => {
      if (!uri) {
        vscode.window.showWarningMessage('No folder selected.');
        return;
      }

      const images = await service.findImagesInFolder(uri.fsPath);
      if (images.length === 0) {
        vscode.window.showInformationMessage('No supported images found in folder.');
        return;
      }

      const config = vscode.workspace.getConfiguration('lwebp');
      const quality = config.get<number>('quality', 80);
      const deleteOriginal = config.get<boolean>('deleteOriginal', false);
      const outputDir = config.get<string>('outputDirectory', '') || undefined;

      await runConversion(service, images, quality, deleteOriginal, outputDir);
    },
  );

  // Convert with custom quality (shows input box)
  const convertFileWithQuality = vscode.commands.registerCommand(
    'lwebp.convertFileWithQuality',
    async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const filesToConvert = resolveUris(uri, uris);
      if (filesToConvert.length === 0) {
        vscode.window.showWarningMessage('No image files selected.');
        return;
      }

      const config = vscode.workspace.getConfiguration('lwebp');
      const defaultQuality = config.get<number>('quality', 80);

      const input = await vscode.window.showInputBox({
        prompt: 'Enter WebP quality (0-100)',
        value: String(defaultQuality),
        validateInput: (value) => {
          const num = Number(value);
          if (isNaN(num) || num < 0 || num > 100 || !Number.isInteger(num)) {
            return 'Please enter an integer between 0 and 100';
          }
          return null;
        },
      });

      if (input === undefined) {
        return; // User cancelled
      }

      const quality = Number(input);
      const deleteOriginal = config.get<boolean>('deleteOriginal', false);
      const outputDir = config.get<string>('outputDirectory', '') || undefined;

      await runConversion(service, filesToConvert, quality, deleteOriginal, outputDir);
    },
  );

  context.subscriptions.push(convertFile, convertFolder, convertFileWithQuality);
}

function resolveUris(uri?: vscode.Uri, uris?: vscode.Uri[]): string[] {
  if (uris && uris.length > 0) {
    return uris.map(u => u.fsPath);
  }
  if (uri) {
    return [uri.fsPath];
  }
  return [];
}

async function runConversion(
  service: ConversionService,
  filePaths: string[],
  quality: number,
  deleteOriginal: boolean,
  outputDir?: string,
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Converting to WebP',
      cancellable: true,
    },
    async (progress, token) => {
      const filteredPaths = filePaths.filter(fp => {
        if (!service.isSupportedImage(fp)) {
          return false;
        }
        return true;
      });

      if (filteredPaths.length === 0) {
        vscode.window.showWarningMessage('No supported image files found.');
        return;
      }

      const { results, errors } = await service.convertFiles(
        filteredPaths,
        quality,
        outputDir,
        (current, total, fileName) => {
          if (token.isCancellationRequested) {
            return;
          }
          progress.report({
            increment: (1 / total) * 100,
            message: `(${current}/${total}) ${fileName}`,
          });
        },
      );

      // Delete originals if configured
      if (deleteOriginal && results.length > 0) {
        for (const result of results) {
          await vscode.workspace.fs.delete(vscode.Uri.file(result.inputPath));
        }
      }

      // Show summary
      if (results.length > 0) {
        const avgSavings = Math.round(
          results.reduce((sum, r) => sum + r.savings, 0) / results.length,
        );
        const msg = `Converted ${results.length} file(s) to WebP (avg ${avgSavings}% savings, quality: ${quality})`;

        if (errors.length > 0) {
          vscode.window.showWarningMessage(`${msg}. ${errors.length} file(s) failed.`);
        } else {
          vscode.window.showInformationMessage(msg);
        }
      } else if (errors.length > 0) {
        vscode.window.showErrorMessage(`All ${errors.length} conversion(s) failed.`);
      }
    },
  );
}

export function deactivate(): void {
  // No cleanup needed
}
