import * as vscode from 'vscode';
import * as path from 'path';
import { ConversionService, OUTPUT_FORMATS, OutputFormat } from '../services/ConversionService';

export class ImageEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'lwebp.imageEditor';

  private _service: ConversionService;

  constructor(private readonly _extensionUri: vscode.Uri) {
    this._service = ConversionService.getInstance();
  }

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    const filePath = document.uri.fsPath;
    const fileName = path.basename(filePath);

    // Find all images in the same folder
    const folderPath = path.dirname(filePath);
    let siblingImages: string[] = [];
    try {
      const files = await vscode.workspace.fs.readDirectory(vscode.Uri.file(folderPath));
      siblingImages = files
        .filter(([name, type]) => type === vscode.FileType.File && this._service.isSupportedImage(name))
        .map(([name]) => path.join(folderPath, name))
        .sort();
    } catch {
      // Folder read failed, will just show current image
    }

    const currentIndex = siblingImages.indexOf(filePath);
    const hasMultipleImages = siblingImages.length > 1;

    // Load image data
    let base64 = '';
    let info = { width: 0, height: 0, size: 0, format: '' };
    let exif = {};

    try {
      [base64, info] = await Promise.all([
        this._service.getImageBase64(filePath, 800),
        this._service.getImageInfo(filePath),
      ]);
    } catch {
      // Will show error state in webview
    }

    try {
      exif = await this._service.getExifData(filePath);
    } catch {
      // EXIF not available
    }

    const fontUri = webviewPanel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'fonts', 'FSPixelSansUnicode-Regular.ttf'));
    webviewPanel.webview.html = this._getHtml(fileName, base64, info, exif, fontUri, hasMultipleImages, currentIndex, siblingImages.length);

    const postMessage = (msg: unknown) => webviewPanel.webview.postMessage(msg);

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'navigateImage': {
          if (message.newIndex !== undefined && siblingImages[message.newIndex]) {
            const newFilePath = siblingImages[message.newIndex];
            const newFileName = path.basename(newFilePath);
            try {
              const [newBase64, newInfo, newExif] = await Promise.all([
                this._service.getImageBase64(newFilePath, 800),
                this._service.getImageInfo(newFilePath),
                this._service.getExifData(newFilePath).catch(() => ({})),
              ]);
              postMessage({
                type: 'imageLoaded',
                fileName: newFileName,
                base64: newBase64,
                info: newInfo,
                exif: newExif,
                index: message.newIndex,
                total: siblingImages.length,
              });
              // Update internal tracking for the new image
              siblingImages[message.newIndex];
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              postMessage({ type: 'error', message: `Failed to load ${newFileName}: ${errorMsg}` });
            }
          }
          break;
        }

        case 'convert': {
          const config = vscode.workspace.getConfiguration('lwebp');
          const quality = message.quality ?? config.get<number>('quality', 80);
          const format: OutputFormat = message.format ?? 'webp';
          const outputDir = config.get<string>('outputDirectory', '') || undefined;
          const crop = message.crop;

          try {
            const result = await this._service.convertFile(filePath, quality, outputDir, crop, format);
            const formatLabel = OUTPUT_FORMATS.find(f => f.value === format)?.label ?? format;
            postMessage({
              type: 'convertDone',
              outputPath: result.outputPath,
              outputSize: result.outputSize,
              savings: result.savings,
              formatLabel,
            });

            const deleteOriginal = config.get<boolean>('deleteOriginal', false);
            if (deleteOriginal) {
              await vscode.workspace.fs.delete(document.uri);
            }

            vscode.window.showInformationMessage(
              `Converted to ${formatLabel}: ${path.basename(result.outputPath)} (${result.savings}% savings)`,
            );
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            postMessage({ type: 'error', message: errorMsg });
            vscode.window.showErrorMessage(`Conversion failed: ${errorMsg}`);
          }
          break;
        }

        case 'navigateImage': {
          if (message.newIndex !== undefined && siblingImages[message.newIndex]) {
            const newFilePath = siblingImages[message.newIndex];
            const newFileName = path.basename(newFilePath);
            try {
              const [newBase64, newInfo, newExif] = await Promise.all([
                this._service.getImageBase64(newFilePath, 800),
                this._service.getImageInfo(newFilePath),
                this._service.getExifData(newFilePath).catch(() => ({})),
              ]);
              postMessage({
                type: 'imageLoaded',
                fileName: newFileName,
                base64: newBase64,
                info: newInfo,
                exif: newExif,
                index: message.newIndex,
                total: siblingImages.length,
              });
              // Update internal tracking for the new image
              siblingImages[message.newIndex];
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              postMessage({ type: 'error', message: `Failed to load ${newFileName}: ${errorMsg}` });
            }
          }
          break;
        }

        case 'getThumbnail': {
          if (message.index !== undefined && siblingImages[message.index]) {
            try {
              const thumbPath = siblingImages[message.index];
              const thumbBase64 = await this._service.getImageBase64(thumbPath, 60);
              postMessage({
                type: 'thumbnailLoaded',
                index: message.index,
                base64: thumbBase64,
              });
            } catch {
              // Ignore thumbnail errors
            }
          }
          break;
        }

        case 'convertMultiple': {
          if (!message.selectedIndices || message.selectedIndices.length === 0) { return; }
          const config = vscode.workspace.getConfiguration('lwebp');
          const quality = message.quality ?? config.get<number>('quality', 80);
          const format: OutputFormat = message.format ?? 'webp';
          const outputDir = config.get<string>('outputDirectory', '') || undefined;
          const crop = message.crop;
          const deleteOriginal = config.get<boolean>('deleteOriginal', false);

          const filesToConvert = message.selectedIndices.map((idx: number) => siblingImages[idx]).filter(Boolean);
          
          try {
            const results = [];
            for (const fileToConvert of filesToConvert) {
              try {
                const result = await this._service.convertFile(fileToConvert, quality, outputDir, crop, format);
                results.push({
                  inputName: path.basename(fileToConvert),
                  outputName: path.basename(result.outputPath),
                  inputSize: result.inputSize,
                  outputSize: result.outputSize,
                  savings: result.savings,
                  success: true,
                });
                if (deleteOriginal) {
                  await vscode.workspace.fs.delete(vscode.Uri.file(fileToConvert));
                }
              } catch (err) {
                results.push({
                  inputName: path.basename(fileToConvert),
                  error: err instanceof Error ? err.message : String(err),
                  success: false,
                });
              }
            }
            const formatLabel = OUTPUT_FORMATS.find(f => f.value === format)?.label ?? format;
            postMessage({
              type: 'convertMultipleDone',
              results,
              formatLabel,
            });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            postMessage({ type: 'error', message: errorMsg });
          }
          break;
        }

        case 'estimateSize': {
          if (message.quality === undefined) { return; }
          try {
            const format: OutputFormat = message.format ?? 'webp';
            const estimatedSize = await this._service.estimateOutputSize(filePath, message.quality, format);
            postMessage({ type: 'estimatedSize', estimatedSize, originalSize: info.size });
          } catch {
            // Ignore estimation errors
          }
          break;
        }

        case 'rotateImage': {
          if (!message.angle) { return; }
          try {
            await this._service.rotateImage(filePath, message.angle);
            const newBase64 = await this._service.getImageBase64(filePath, 800);
            const newInfo = await this._service.getImageInfo(filePath);
            info = newInfo;
            postMessage({ type: 'imageRotated', base64: newBase64, info: newInfo });
          } catch {
            postMessage({ type: 'error', message: 'Failed to rotate image.' });
          }
          break;
        }

        case 'refreshPreview': {
          try {
            const newBase64 = await this._service.getImageBase64(filePath, 800);
            const newInfo = await this._service.getImageInfo(filePath);
            info = newInfo;
            postMessage({ type: 'previewRefreshed', base64: newBase64, info: newInfo });
          } catch {
            // Ignore
          }
          break;
        }
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _getHtml(fileName: string, base64: string, info: any, exif: any, fontUri: vscode.Uri, hasMultipleImages: boolean, currentIndex: number, totalImages: number): string {
    const formatSize = (bytes: number) => {
      if (bytes < 1024) { return bytes + ' B'; }
      if (bytes < 1024 * 1024) { return (bytes / 1024).toFixed(1) + ' KB'; }
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    };

    const exifLabels: Record<string, string> = {
      make: 'Camera', model: 'Model', dateTime: 'Date',
      exposureTime: 'Exposure', fNumber: 'Aperture', iso: 'ISO',
      focalLength: 'Focal Length', lensModel: 'Lens',
      orientation: 'Orientation', colorSpace: 'Color Space',
      whiteBalance: 'White Balance',
    };

    let exifHtml = '';
    for (const [key, label] of Object.entries(exifLabels)) {
      const val = (exif as Record<string, unknown>)[key];
      if (val !== undefined && val !== null && val !== '') {
        let display = String(val);
        if (key === 'fNumber') { display = 'f/' + val; }
        if (key === 'focalLength') { display = val + 'mm'; }
        exifHtml += `<tr><td class="exif-key">${label}</td><td>${display}</td></tr>`;
      }
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${fileName}</title>
  <style>
    @font-face {
      font-family: 'FS Pixel Sans';
      font-style: normal; font-weight: 400; font-display: swap;
      src: url('${fontUri}') format('truetype');
    }
    :root {
      --pixel-bg: #f0f0f0; --pixel-panel: #ffffff; --pixel-border: #888899;
      --pixel-border-light: #bb7733; --pixel-accent: #cc6600; --pixel-green: #cc4400;
      --pixel-text: #1a1a2e; --pixel-text-dim: #666688;
      --pixel-btn-bg: #f0e4d8; --pixel-shadow: 2px 2px 0px #aaaabb;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'FS Pixel Sans', monospace; font-size: 22px; color: var(--pixel-text); background: var(--pixel-bg); padding: 20px; }
    .container { max-width: 900px; margin: 0 auto; }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 8px; }
    .header h1 { font-size: 26px; color: var(--pixel-accent); text-shadow: 1px 1px 0px rgba(0,0,0,0.1); }
    .header .file-info { font-size: 20px; color: var(--pixel-text-dim); }
    
    /* Carousel Navigation - Editor Header */
    .carousel-nav { display: none; align-items: center; gap: 6px; }
    .carousel-nav.active { display: flex; }
    .carousel-nav button {
      padding: 4px 6px; font-size: 18px; min-width: 28px; height: 28px;
      background: var(--pixel-btn-bg); color: var(--pixel-text);
      border: 2px solid var(--pixel-border); border-radius: 0;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      box-shadow: 1px 1px 0px rgba(0,0,0,0.1); transition: background 0.1s;
      font-family: 'FS Pixel Sans', monospace;
    }
    .carousel-nav button:hover { background: var(--pixel-btn-hover); border-color: var(--pixel-border-light); }
    .carousel-nav button:disabled { opacity: 0.35; cursor: not-allowed; }
    .carousel-counter { font-size: 18px; color: var(--pixel-text-dim); min-width: 60px; text-align: center; font-family: 'FS Pixel Sans', monospace; }
    
    #infoText { font-size: 20px; color: var(--pixel-text-dim); }

    /* Preview */
    .preview-wrapper { margin-bottom: 16px; }
    .preview {
      background: #e8e8f0; border: 2px solid var(--pixel-border); border-radius: 0;
      padding: 0; box-shadow: var(--pixel-shadow);
      position: relative; overflow: auto; height: 500px;
      display: grid; place-items: center;
    }
    .preview img { display: block; transition: transform 0.15s; }
    .preview .no-preview { padding: 40px; color: var(--pixel-text-dim); }
    .zoom-controls {
      position: absolute; top: 8px; right: 8px; z-index: 10;
      display: flex; gap: 2px;
    }
    .zoom-controls button {
      padding: 4px 8px; font-size: 18px; min-width: 32px;
      background: rgba(255,255,255,0.9); border: 2px solid var(--pixel-border);
      box-shadow: 1px 1px 0px rgba(0,0,0,0.15);
    }
    .zoom-controls button:hover { background: #fff; }

    /* Crop overlay */
    .crop-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; cursor: crosshair; display: none; }
    .crop-overlay.active { display: block; }
    .crop-box { position: absolute; border: 2px dashed var(--pixel-accent); box-shadow: 0 0 0 9999px rgba(0,0,0,0.5); min-width: 10px; min-height: 10px; }

    /* Toolbar */
    .toolbar { display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
    .toolbar-group { display: flex; gap: 4px; align-items: center; }
    .toolbar-sep { width: 2px; height: 28px; background: var(--pixel-border); margin: 0 4px; }
    button {
      display: flex; align-items: center; justify-content: center; gap: 4px;
      padding: 5px 10px; border: 2px solid #cc9955; border-radius: 0;
      font-size: 20px; font-family: 'FS Pixel Sans', monospace;
      cursor: pointer; background: var(--pixel-btn-bg); color: #2a2a50;
      box-shadow: var(--pixel-shadow); transition: background 0.1s;
    }
    button:hover { background: #f0cc9f; border-color: var(--pixel-border-light); }
    button:disabled { opacity: 0.35; cursor: not-allowed; }
    .btn-crop { background: #ffe0b0; color: #884400; border-color: #cc8833; }
    .btn-crop:hover { background: #ffd090; }
    .btn-crop.active { background: #cc6600; color: #fff; border-color: #aa4400; }
    .btn-danger { background: #dd2222; border-color: #aa1111; color: #fff; text-shadow: 1px 1px 0px rgba(0,0,0,0.2); }
    .btn-danger:hover { background: #bb1111; }

    /* Crop inputs */
    .crop-inputs { display: none; margin-top: 8px; }
    .crop-inputs.active { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 6px; }
    .crop-inputs label { font-size: 16px; margin-bottom: 2px; display: block; }
    .crop-inputs input {
      width: 100%; padding: 4px 6px; font-size: 18px;
      font-family: 'FS Pixel Sans', monospace;
      background: var(--pixel-panel); color: var(--pixel-text);
      border: 2px solid var(--pixel-border); border-radius: 0;
    }

    /* Panels */
    .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    @media (max-width: 600px) { .panels { grid-template-columns: 1fr; } }
    .panel { background: var(--pixel-panel); border: 2px solid var(--pixel-border); border-radius: 0; padding: 14px; box-shadow: var(--pixel-shadow); }
    .panel h2 { font-size: 22px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; color: var(--pixel-accent); }
    .info-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 20px; }
    .info-grid .key { color: var(--pixel-text-dim); }
    table { width: 100%; font-size: 20px; border-collapse: collapse; }
    table td { padding: 4px 0; }
    .exif-key { color: var(--pixel-text-dim); padding-right: 12px; white-space: nowrap; }

    /* Convert */
    .convert-section { background: var(--pixel-panel); border: 2px solid var(--pixel-border); border-radius: 0; padding: 14px; box-shadow: var(--pixel-shadow); }
    .convert-section h2 { font-size: 22px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; color: var(--pixel-accent); }
    .convert-controls { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
    .control-group { display: flex; flex-direction: column; gap: 4px; }
    .control-group label { font-size: 20px; }
    .control-group.format-control { position: relative; }
    .format-select-btn {
      padding: 6px 10px; font-size: 20px; font-family: 'FS Pixel Sans', monospace;
      background: #f5dcc0; color: var(--pixel-text);
      border: 2px solid var(--pixel-border); border-radius: 0; box-shadow: var(--pixel-shadow);
      width: 100%; display: flex; align-items: center; justify-content: space-between;
      cursor: pointer;
    }
    .format-select-btn:hover { background: #efc0a0; }
    .format-dropdown-menu {
      position: absolute; top: 100%; left: 0; right: 0; z-index: 100;
      display: none; background: #f5dcc0; border: 2px solid var(--pixel-border);
      border-top: none; box-shadow: var(--pixel-shadow);
    }
    .format-dropdown-menu.active { display: block; }
    .format-dropdown-item {
      padding: 4px 10px; font-size: 22px; font-family: 'FS Pixel Sans', monospace;
      cursor: pointer; border-bottom: 1px solid rgba(0,0,0,0.1);
      color: var(--pixel-text);
    }
    .format-dropdown-item:last-child { border-bottom: none; }
    .format-dropdown-item:hover { background: #f0b090; }
    .format-dropdown-item.active { background: #dd6600; color: #fff; }
    .control-group select {
      padding: 6px 10px; font-size: 20px; font-family: 'FS Pixel Sans', monospace;
      background: #f5dcc0; color: var(--pixel-text);
      border: 2px solid var(--pixel-border); border-radius: 0; box-shadow: var(--pixel-shadow);
    }
    .quality-row { display: flex; align-items: center; gap: 8px; }
    .quality-row input[type="range"] { width: 140px; height: 14px; accent-color: var(--pixel-accent); font-size: 20px; }
    .quality-val {
      display: flex; align-items: center; min-width: 60px;
    }
    .quality-val input[type="number"] {
      width: 50px; padding: 2px 4px; font-size: 24px; font-family: 'FS Pixel Sans', monospace;
      background: #f5dcc0; color: var(--pixel-accent); border: 1px solid var(--pixel-border);
      text-align: right; -moz-appearance: textfield;
    }
    .quality-val input[type="number"]::-webkit-outer-spin-button,
    .quality-val input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .estimate { font-size: 20px; color: var(--pixel-text-dim); margin-top: 10px; }
    .est-savings { color: #228855; }
    .est-increase { color: #dd2222; }
    .est-savings { color: #228855; }
    .est-increase { color: #dd2222; }
    button.convert-btn {
      padding: 8px 20px; border: 2px solid #aa4400; border-radius: 0;
      background: #dd6600; color: #fff; font-size: 22px; font-family: 'FS Pixel Sans', monospace;
      cursor: pointer; box-shadow: var(--pixel-shadow); text-shadow: 1px 1px 0px rgba(0,0,0,0.2);
    }
    button.convert-btn:hover { background: #c45500; }
    button.convert-btn:disabled { opacity: 0.35; cursor: not-allowed; }
    .result { margin-top: 10px; padding: 8px 12px; font-size: 20px; background: var(--pixel-panel); border: 2px solid var(--pixel-border); border-radius: 0; }
    .result.success { border-left: 3px solid #228855; }
    .result.error { border-left: 3px solid #dd2222; }

    /* Preview Carousel - Thumbnails at bottom */
    .preview-footer { display: ${hasMultipleImages ? 'flex' : 'none'}; gap: 8px; margin-top: 16px; align-items: center; background: var(--pixel-panel); border: 2px solid var(--pixel-border); padding: 8px; box-shadow: var(--pixel-shadow); flex-wrap: wrap; }
    .carousel-thumb-nav { padding: 6px 10px; font-size: 20px; min-width: 36px; height: 36px; background: var(--pixel-btn-bg); color: var(--pixel-text); border: 2px solid var(--pixel-border); cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 1px 1px 0px rgba(0,0,0,0.1); transition: background 0.1s; font-family: 'FS Pixel Sans', monospace; flex-shrink: 0; }
    .carousel-thumb-nav:hover { background: #f0cc9f; border-color: var(--pixel-border-light); }
    .carousel-thumb-nav:disabled { opacity: 0.35; cursor: not-allowed; }
    .thumbnail-carousel { display: flex; gap: 8px; flex: 1; overflow-x: auto; align-items: center; min-height: 110px; padding: 4px; scrollbar-width: thin; basis: 100%; }
    .thumbnail-carousel::-webkit-scrollbar { height: 6px; }
    .thumbnail-carousel::-webkit-scrollbar-track { background: #e0e0e0; }
    .thumbnail-carousel::-webkit-scrollbar-thumb { background: #999; border-radius: 3px; }
    .thumbnail-item { position: relative; min-width: 96px; width: 96px; height: 96px; border: 2px solid var(--pixel-border); cursor: pointer; background: #f5f5f5; background-size: cover; background-position: center; transition: all 0.1s; flex-shrink: 0; }
    .thumbnail-item:hover { border-color: var(--pixel-border-light); transform: scale(1.03); }
    .thumbnail-item.active { border-color: var(--pixel-accent); box-shadow: 0 0 4px var(--pixel-accent), inset 0 0 4px var(--pixel-accent); }
    .thumbnail-item.selected { background-color: rgba(204, 102, 0, 0.2); border: 3px solid var(--pixel-accent); }
    .thumbnail-checkbox { position: absolute; top: 4px; left: 4px; width: 24px; height: 24px; background: rgba(255,255,255,0.95); border: 2px solid var(--pixel-accent); cursor: pointer; display: flex; align-items: center; justify-content: center; font-weight: bold; color: var(--pixel-accent); font-size: 18px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${fileName}</h1>
      <div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
        <div class="carousel-nav ${hasMultipleImages ? 'active' : ''}" id="carouselNav">
          <button id="btnCarouselPrev" title="Previous image">&#x25C0;</button>
          <div class="carousel-counter" id="carouselCounter">${currentIndex + 1} / ${totalImages}</div>
          <button id="btnCarouselNext" title="Next image">&#x25B6;</button>
        </div>
        <span id="infoText">${info.width} x ${info.height} · ${info.format.toUpperCase()} · ${formatSize(info.size)}</span>
      </div>
    </div>

    <div class="preview-wrapper">
      <div class="preview" id="previewBox">
        <div class="zoom-controls">
          <button id="btnZoomOut" title="Zoom Out">&#x2212;</button>
          <button id="btnZoomReset" title="Reset Zoom" style="font-size:16px;">100%</button>
          <button id="btnZoomIn" title="Zoom In">+</button>
        </div>
        ${base64 ? `<img id="previewImg" src="${base64}" alt="${fileName}" />` : '<div class="no-preview">Preview not available</div>'}
        <div class="crop-overlay" id="cropOverlay">
          <div class="crop-box" id="cropBox" style="display:none;"></div>
        </div>
      </div>
      <div class="toolbar">
        <div class="toolbar-group">
          <button id="btnRotateLeft" title="Rotate Left">&#x21BA;</button>
          <button id="btnRotateRight" title="Rotate Right">&#x21BB;</button>
        </div>
        <div class="toolbar-sep"></div>
        <div class="toolbar-group">
          <button class="btn-crop" id="btnCropToggle">&#x2702; Crop</button>
          <button class="btn-danger" id="btnCropClear" style="display:none;">&#x2716;</button>
        </div>
      </div>
      <div class="crop-inputs" id="cropInputs">
        <div><label>X</label><input type="number" id="cropX" min="0" value="0"></div>
        <div><label>Y</label><input type="number" id="cropY" min="0" value="0"></div>
        <div><label>W</label><input type="number" id="cropW" min="1" value="100"></div>
        <div><label>H</label><input type="number" id="cropH" min="1" value="100"></div>
      </div>
    </div>

    <div class="panels">
      <div class="panel">
        <h2>Image Info</h2>
        <div class="info-grid" id="infoGrid">
          <span class="key">Dimensions</span><span id="infoDims">${info.width} x ${info.height}</span>
          <span class="key">Format</span><span>${info.format.toUpperCase()}</span>
          <span class="key">File Size</span><span id="infoSize">${formatSize(info.size)}</span>
        </div>
      </div>
      <div class="panel" id="exifPanel" ${exifHtml ? '' : 'style="display:none;"'}>
        <h2>EXIF Data</h2>
        <table>${exifHtml}</table>
      </div>
    </div>

    <div class="convert-section">
      <h2>Convert</h2>
      <div class="convert-controls">
        <div class="control-group format-control">
          <label>Format</label>
          <button class="format-select-btn" id="formatSelectBtn" type="button">
            <span id="formatLabel">WebP</span>
            <span style="font-size: 18px;">&#x25BC;</span>
          </button>
          <div class="format-dropdown-menu" id="formatDropdown">
            <div class="format-dropdown-item active" data-value="webp">WebP</div>
            <div class="format-dropdown-item" data-value="jpg">JPEG</div>
            <div class="format-dropdown-item" data-value="png">PNG</div>
          </div>
          <input type="hidden" id="format" value="webp">
        </div>
        <div class="control-group">
          <label>Quality</label>
          <div class="quality-row">
            <input type="range" id="quality" min="0" max="100" value="80">
            <div class="quality-val">
              <input type="number" id="qualityVal" min="0" max="100" value="80">
            </div>
          </div>
        </div>
        <button class="convert-btn" id="convertBtn">&#x25B6; Convert</button>
      </div>
      <div class="estimate" id="estimate" style="display:none;"></div>
      <div id="resultArea"></div>
    </div>

    <div class="preview-footer" id="previewFooter">
      <button class="carousel-thumb-nav" id="btnThumbPrev" title="Previous">&#x25C0;</button>
      <div class="thumbnail-carousel" id="thumbnailCarousel"></div>
      <button class="carousel-thumb-nav" id="btnThumbNext" title="Next">&#x25B6;</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const previewImg = document.getElementById('previewImg');
    const infoText = document.getElementById('infoText');
    const infoDims = document.getElementById('infoDims');
    const infoSize = document.getElementById('infoSize');
    const qualitySlider = document.getElementById('quality');
    const qualityVal = document.getElementById('qualityVal');
    const formatSelect = document.getElementById('format');
    const formatSelectBtn = document.getElementById('formatSelectBtn');
    const formatDropdown = document.getElementById('formatDropdown');
    const formatLabel = document.getElementById('formatLabel');
    const formatDropdownItems = document.querySelectorAll('.format-dropdown-item');
    const convertBtn = document.getElementById('convertBtn');
    const estimate = document.getElementById('estimate');
    const resultArea = document.getElementById('resultArea');
    const cropOverlay = document.getElementById('cropOverlay');
    const cropBox = document.getElementById('cropBox');
    const btnCropToggle = document.getElementById('btnCropToggle');
    const btnCropClear = document.getElementById('btnCropClear');
    const cropInputs = document.getElementById('cropInputs');
    const cropX = document.getElementById('cropX');
    const cropY = document.getElementById('cropY');
    const cropW = document.getElementById('cropW');
    const cropH = document.getElementById('cropH');
    const btnZoomReset = document.getElementById('btnZoomReset');
    const btnCarouselPrev = document.getElementById('btnCarouselPrev');
    const btnCarouselNext = document.getElementById('btnCarouselNext');
    const carouselCounter = document.getElementById('carouselCounter');

    // Custom dropdown handler
    formatSelectBtn.addEventListener('click', function() {
      formatDropdown.classList.toggle('active');
    });

    formatDropdownItems.forEach(function(item) {
      item.addEventListener('click', function() {
        const value = this.dataset.value;
        formatSelect.value = value;
        formatLabel.textContent = this.textContent;
        formatDropdown.classList.remove('active');
        formatDropdownItems.forEach(function(i) { i.classList.remove('active'); });
        this.classList.add('active');
        // Trigger change event for listeners
        formatSelect.dispatchEvent(new Event('change'));
      });
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', function(e) {
      if (!formatSelectBtn.contains(e.target) && !formatDropdown.contains(e.target)) {
        formatDropdown.classList.remove('active');
      }
    });

    var imageInfo = { width: ${info.width}, height: ${info.height}, size: ${info.size}, format: '${info.format}' };
    var cropEnabled = false;
    var cropData = null;
    var zoomLevel = 100;
    var currentImageIndex = ${currentIndex};
    var totalImages = ${totalImages};
    let estimateTimer = null;

    function navigateCarousel(direction) {
      var newIndex = currentImageIndex + direction;
      if (newIndex >= 0 && newIndex < totalImages) {
        vscode.postMessage({ type: 'navigateImage', newIndex: newIndex });
      }
    }

    function updateCarouselUI() {
      if (btnCarouselPrev) btnCarouselPrev.disabled = currentImageIndex === 0;
      if (btnCarouselNext) btnCarouselNext.disabled = currentImageIndex === totalImages - 1;
      if (carouselCounter) carouselCounter.textContent = (currentImageIndex + 1) + ' / ' + totalImages;
      renderThumbnailCarousel();
    }

    // Thumbnail carousel
    const thumbnailCarousel = document.getElementById('thumbnailCarousel');
    const btnThumbPrev = document.getElementById('btnThumbPrev');
    const btnThumbNext = document.getElementById('btnThumbNext');
    const previewFooter = document.getElementById('previewFooter');

    var selectedThumbnails = new Set();

    function renderThumbnailCarousel() {
      if (!previewFooter || totalImages <= 1) return;
      thumbnailCarousel.innerHTML = '';
      for (let i = 0; i < totalImages; i++) {
        const thumb = document.createElement('div');
        thumb.className = 'thumbnail-item' + (i === currentImageIndex ? ' active' : '') + (selectedThumbnails.has(i) ? ' selected' : '');
        thumb.dataset.index = String(i);
        thumb.style.backgroundImage = 'linear-gradient(135deg, #f0e4d8, #e8e8f0)';
        
        // Create checkbox overlay
        const checkbox = document.createElement('div');
        checkbox.className = 'thumbnail-checkbox';
        checkbox.textContent = selectedThumbnails.has(i) ? '✓' : '';
        checkbox.addEventListener('click', (e) => {
          e.stopPropagation();
          if (selectedThumbnails.has(i)) {
            selectedThumbnails.delete(i);
          } else {
            selectedThumbnails.add(i);
          }
          renderThumbnailCarousel();
        });
        thumb.appendChild(checkbox);
        
        thumb.addEventListener('click', () => navigateCarousel(i - currentImageIndex));
        thumbnailCarousel.appendChild(thumb);
        // Load thumbnail
        vscode.postMessage({ type: 'getThumbnail', index: i });
      }
      // Update thumbnail nav buttons
      if (btnThumbPrev && btnThumbNext) {
        const hasScroll = thumbnailCarousel.scrollWidth > thumbnailCarousel.clientWidth;
        btnThumbPrev.style.display = hasScroll ? 'flex' : 'none';
        btnThumbNext.style.display = hasScroll ? 'flex' : 'none';
      }
      updateConvertButton();
    }

    function updateConvertButton() {
      if (selectedThumbnails.size > 0) {
        convertBtn.textContent = '\u25B6 Convert ' + selectedThumbnails.size + ' files';
      } else {
        convertBtn.textContent = '\u25B6 Convert';
      }
    }

    if (btnThumbPrev && btnThumbNext) {
      btnThumbPrev.addEventListener('click', () => {
        thumbnailCarousel.scrollBy({ left: -60, behavior: 'smooth' });
      });
      btnThumbNext.addEventListener('click', () => {
        thumbnailCarousel.scrollBy({ left: 60, behavior: 'smooth' });
      });
    }

    // Zoom — dùng pixel size để scroll cả ngang + dọc
    var baseWidth = 0;
    function initBaseWidth() {
      if (previewImg && previewImg.naturalWidth) {
        baseWidth = document.getElementById('previewBox').clientWidth;
      }
    }
    function applyZoom() {
      if (!previewImg) return;
      if (!baseWidth) initBaseWidth();
      var w = Math.round(baseWidth * zoomLevel / 100);
      previewImg.style.width = w + 'px';
      previewImg.style.height = 'auto';
      previewImg.style.maxWidth = 'none';
      previewImg.style.maxHeight = 'none';
      btnZoomReset.textContent = zoomLevel + '%';
    }
    function resetZoom() {
      zoomLevel = 100;
      if (previewImg) {
        previewImg.style.width = '';
        previewImg.style.height = '';
        previewImg.style.maxWidth = '100%';
        previewImg.style.maxHeight = '100%';
      }
      btnZoomReset.textContent = '100%';
    }
    document.getElementById('btnZoomIn').addEventListener('click', function() {
      zoomLevel = Math.min(400, zoomLevel + 25); applyZoom();
    });
    document.getElementById('btnZoomOut').addEventListener('click', function() {
      zoomLevel = Math.max(25, zoomLevel - 25); applyZoom();
    });
    btnZoomReset.addEventListener('click', resetZoom);
    document.getElementById('previewBox').addEventListener('wheel', function(e) {
      e.preventDefault();
      if (e.deltaY < 0) zoomLevel = Math.min(400, zoomLevel + 10);
      else zoomLevel = Math.max(25, zoomLevel - 10);
      applyZoom();
    }, { passive: false });
    if (previewImg) previewImg.addEventListener('load', function() { baseWidth = 0; });

    // Rotate
    var pendingRotation = 0;
    var rotateTimer = null;
    var isRotating = false;
    document.getElementById('btnRotateLeft').addEventListener('click', function() { queueRotation(-90); });
    document.getElementById('btnRotateRight').addEventListener('click', function() { queueRotation(90); });

    // Carousel navigation
    if (btnCarouselPrev && btnCarouselNext) {
      btnCarouselPrev.addEventListener('click', function() { navigateCarousel(-1); });
      btnCarouselNext.addEventListener('click', function() { navigateCarousel(1); });
    }

    // Keyboard navigation for carousel
    document.addEventListener('keydown', function(e) {
      if (totalImages > 1) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); navigateCarousel(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); navigateCarousel(1); }
      }
    });

    function queueRotation(angle) {
      pendingRotation = (pendingRotation + angle) % 360;
      if (pendingRotation < 0) pendingRotation += 360;
      if (previewImg) previewImg.style.transform = 'rotate(' + pendingRotation + 'deg)';
      if (rotateTimer) clearTimeout(rotateTimer);
      rotateTimer = setTimeout(flushRotation, 400);
    }
    function flushRotation() {
      if (pendingRotation === 0 || isRotating) return;
      isRotating = true;
      var angle = pendingRotation;
      pendingRotation = 0;
      vscode.postMessage({ type: 'rotateImage', angle: angle });
    }

    // Crop
    btnCropToggle.addEventListener('click', function() {
      cropEnabled = !cropEnabled;
      btnCropToggle.classList.toggle('active', cropEnabled);
      btnCropToggle.textContent = cropEnabled ? '\u2716 Crop Off' : '\u2702 Crop';
      cropOverlay.classList.toggle('active', cropEnabled);
      cropInputs.classList.toggle('active', cropEnabled);
      if (!cropEnabled) clearCrop();
    });
    btnCropClear.addEventListener('click', clearCrop);

    function clearCrop() {
      cropData = null;
      cropBox.style.display = 'none';
      btnCropClear.style.display = 'none';
      cropX.value = 0; cropY.value = 0; cropW.value = 100; cropH.value = 100;
    }

    var cropStartX = 0, cropStartY = 0, isCropping = false;
    cropOverlay.addEventListener('mousedown', function(e) {
      if (!cropEnabled) return;
      var rect = cropOverlay.getBoundingClientRect();
      cropStartX = e.clientX - rect.left; cropStartY = e.clientY - rect.top;
      isCropping = true;
      cropBox.style.display = 'block';
      cropBox.style.left = cropStartX + 'px'; cropBox.style.top = cropStartY + 'px';
      cropBox.style.width = '0px'; cropBox.style.height = '0px';
    });
    cropOverlay.addEventListener('mousemove', function(e) {
      if (!isCropping) return;
      var rect = cropOverlay.getBoundingClientRect();
      var curX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      var curY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
      cropBox.style.left = Math.min(cropStartX, curX) + 'px';
      cropBox.style.top = Math.min(cropStartY, curY) + 'px';
      cropBox.style.width = Math.abs(curX - cropStartX) + 'px';
      cropBox.style.height = Math.abs(curY - cropStartY) + 'px';
    });
    cropOverlay.addEventListener('mouseup', function() {
      if (!isCropping) return;
      isCropping = false;
      updateCropFromBox();
    });

    function updateCropFromBox() {
      if (!previewImg || !imageInfo.width) return;
      var imgRect = previewImg.getBoundingClientRect();
      var overlayRect = cropOverlay.getBoundingClientRect();
      var scaleX = imageInfo.width / imgRect.width;
      var scaleY = imageInfo.height / imgRect.height;
      var offsetX = imgRect.left - overlayRect.left;
      var offsetY = imgRect.top - overlayRect.top;
      var bx = parseFloat(cropBox.style.left) - offsetX;
      var by = parseFloat(cropBox.style.top) - offsetY;
      var bw = parseFloat(cropBox.style.width);
      var bh = parseFloat(cropBox.style.height);
      var rx = Math.max(0, Math.round(bx * scaleX));
      var ry = Math.max(0, Math.round(by * scaleY));
      var rw = Math.min(imageInfo.width - rx, Math.round(bw * scaleX));
      var rh = Math.min(imageInfo.height - ry, Math.round(bh * scaleY));
      if (rw > 0 && rh > 0) {
        cropData = { left: rx, top: ry, width: rw, height: rh };
        cropX.value = rx; cropY.value = ry; cropW.value = rw; cropH.value = rh;
        btnCropClear.style.display = '';
      }
    }

    [cropX, cropY, cropW, cropH].forEach(function(input) {
      input.addEventListener('change', function() {
        cropData = { left: parseInt(cropX.value)||0, top: parseInt(cropY.value)||0, width: parseInt(cropW.value)||100, height: parseInt(cropH.value)||100 };
        btnCropClear.style.display = '';
        if (previewImg && imageInfo.width) {
          var imgRect = previewImg.getBoundingClientRect();
          var overlayRect = cropOverlay.getBoundingClientRect();
          var sx = imgRect.width / imageInfo.width; var sy = imgRect.height / imageInfo.height;
          var ox = imgRect.left - overlayRect.left; var oy = imgRect.top - overlayRect.top;
          cropBox.style.display = 'block';
          cropBox.style.left = (cropData.left * sx + ox) + 'px';
          cropBox.style.top = (cropData.top * sy + oy) + 'px';
          cropBox.style.width = (cropData.width * sx) + 'px';
          cropBox.style.height = (cropData.height * sy) + 'px';
        }
      });
    });

    // Quality & Format
    qualitySlider.addEventListener('input', function() {
      const val = Math.max(0, Math.min(100, parseInt(qualitySlider.value) || 80));
      qualitySlider.value = val;
      qualityVal.value = val;
      requestEstimate();
    });
    qualityVal.addEventListener('change', function() {
      const val = Math.max(0, Math.min(100, parseInt(qualityVal.value) || 80));
      qualitySlider.value = val;
      qualityVal.value = val;
      requestEstimate();
    });
    formatSelect.addEventListener('change', function() { requestEstimate(); });

    // Convert
    convertBtn.addEventListener('click', function() {
      convertBtn.disabled = true;
      convertBtn.textContent = '\u25FC Converting...';
      resultArea.innerHTML = '';
      var msg = { type: 'convert', quality: parseInt(qualitySlider.value), format: formatSelect.value };
      if (cropData) msg.crop = cropData;
      if (selectedThumbnails.size > 0) {
        msg.type = 'convertMultiple';
        msg.selectedIndices = Array.from(selectedThumbnails);
      }
      vscode.postMessage(msg);
    });

    function requestEstimate() {
      if (estimateTimer) clearTimeout(estimateTimer);
      estimateTimer = setTimeout(function() {
        vscode.postMessage({ type: 'estimateSize', quality: parseInt(qualitySlider.value), format: formatSelect.value });
      }, 300);
    }

    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function updateInfo(info) {
      imageInfo = info;
      infoText.textContent = info.width + ' x ' + info.height + ' \\u00B7 ' + info.format.toUpperCase() + ' \\u00B7 ' + formatSize(info.size);
      infoDims.textContent = info.width + ' x ' + info.height;
      infoSize.textContent = formatSize(info.size);
    }

    window.addEventListener('message', function(event) {
      var msg = event.data;
      switch (msg.type) {
        case 'imageLoaded': {
          currentImageIndex = msg.index;
          totalImages = msg.total;
          if (previewImg) { previewImg.src = msg.base64; previewImg.style.transform = ''; }
          updateInfo(msg.info);
          document.querySelector('.container h1').textContent = msg.fileName;
          clearCrop();
          resetZoom();
          updateCarouselUI();
          requestEstimate();
          break;
        }
        case 'thumbnailLoaded': {
          const thumbEl = thumbnailCarousel.querySelector('[data-index="' + msg.index + '"]');
          if (thumbEl) {
            thumbEl.style.backgroundImage = 'url(' + msg.base64 + ')';
          }
          break;
        }
        case 'estimatedSize': {
          var origSize = msg.originalSize; var estSize = msg.estimatedSize;
          var saved = origSize > 0 ? Math.round((1 - estSize / origSize) * 100) : 0;
          var cls = saved > 0 ? 'est-savings' : 'est-increase';
          var label = saved > 0 ? saved + '% smaller' : Math.abs(saved) + '% larger';
          estimate.style.display = '';
          estimate.innerHTML = 'Estimated: <strong>' + formatSize(estSize) + '</strong> (<span class="' + cls + '">' + label + '</span>)';
          break;
        }
        case 'imageRotated':
          isRotating = false;
          if (previewImg) { previewImg.style.transform = ''; previewImg.src = msg.base64; }
          updateInfo(msg.info);
          clearCrop();
          requestEstimate();
          if (pendingRotation !== 0) flushRotation();
          break;
        case 'previewRefreshed':
          if (previewImg) previewImg.src = msg.base64;
          updateInfo(msg.info);
          break;
        case 'convertDone':
          convertBtn.disabled = false;
          convertBtn.textContent = '\u25B6 Convert';
          resultArea.innerHTML = '<div class="result success">Converted to ' + msg.formatLabel + ': <strong>' +
            msg.outputPath.split('/').pop().split('\\\\').pop() +
            '</strong> (' + formatSize(msg.outputSize) + ', ' + msg.savings + '% savings)</div>';
          break;
        case 'convertMultipleDone':
          convertBtn.disabled = false;
          convertBtn.textContent = '\u25B6 Convert';
          var html = '<div style="background: #f5f5f5; padding: 10px; margin-top: 8px;">';
          html += '<div style="font-weight: bold; margin-bottom: 8px; color: var(--pixel-accent);">' + msg.formatLabel + ' - Batch Convert Results</div>';
          msg.results.forEach(function(r) {
            if (r.success) {
              html += '<div class="result success">' + r.inputName + ' &#8594; ' + r.outputName + ' (' + r.savings + '% saved)</div>';
            } else {
              html += '<div class="result error">' + r.inputName + ' - Error: ' + r.error + '</div>';
            }
          });
          html += '</div>';
          resultArea.innerHTML = html;
          selectedThumbnails.clear();
          renderThumbnailCarousel();
          break;
        case 'error':
          convertBtn.disabled = false;
          convertBtn.textContent = '\u25B6 Convert';
          resultArea.innerHTML = '<div class="result error">Error: ' + msg.message + '</div>';
          break;
      }
    });

    updateCarouselUI();
    requestEstimate();
  </script>
</body>
</html>`;
  }
}
