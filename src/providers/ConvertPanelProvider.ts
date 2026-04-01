import * as vscode from 'vscode';
import * as path from 'path';
import { ConversionService, CropOptions, OutputFormat } from '../services/ConversionService';

interface WebviewMessage {
  type: 'selectFiles' | 'selectFolder' | 'convert' | 'getConfig' | 'previewFile' | 'getFileInfo' | 'getExif' | 'estimateSize' | 'rotateImage';
  quality?: number;
  deleteOriginal?: boolean;
  files?: string[];
  folder?: string;
  filePath?: string;
  crop?: CropOptions;
  format?: OutputFormat;
  angle?: number;
}

export class ConvertPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'lwebp.convertPanel';

  private _view?: vscode.WebviewView;
  private _service: ConversionService;

  constructor(private readonly _extensionUri: vscode.Uri) {
    this._service = ConversionService.getInstance();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case 'getConfig': {
          const config = vscode.workspace.getConfiguration('lwebp');
          this._postMessage({
            type: 'config',
            quality: config.get<number>('quality', 80),
            deleteOriginal: config.get<boolean>('deleteOriginal', false),
          });
          break;
        }

        case 'selectFiles': {
          const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFolders: false,
            filters: {
              'Images': ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif'],
            },
          });
          if (uris && uris.length > 0) {
            const filesWithInfo = await this._getFilesInfo(uris.map(u => u.fsPath));
            this._postMessage({
              type: 'filesSelected',
              files: filesWithInfo,
            });
          }
          break;
        }

        case 'selectFolder': {
          const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFolders: true,
            canSelectFiles: false,
          });
          if (uris && uris.length > 0) {
            const allImages: string[] = [];
            for (const uri of uris) {
              const images = await this._service.findImagesInFolder(uri.fsPath);
              allImages.push(...images);
            }
            const filesWithInfo = await this._getFilesInfo(allImages);
            this._postMessage({
              type: 'filesSelected',
              files: filesWithInfo,
              folder: uris.map(u => u.fsPath).join(', '),
            });
          }
          break;
        }

        case 'previewFile': {
          if (!message.filePath) { return; }
          try {
            const base64 = await this._service.getImageBase64(message.filePath);
            const info = await this._service.getImageInfo(message.filePath);
            this._postMessage({
              type: 'previewData',
              filePath: message.filePath,
              base64,
              info,
            });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            this._postMessage({
              type: 'previewError',
              filePath: message.filePath,
              error: errorMsg,
            });
          }
          break;
        }

        case 'getFileInfo': {
          if (!message.filePath) { return; }
          try {
            const info = await this._service.getImageInfo(message.filePath);
            this._postMessage({
              type: 'fileInfo',
              filePath: message.filePath,
              info,
            });
          } catch {
            // Ignore errors for file info
          }
          break;
        }

        case 'getExif': {
          if (!message.filePath) { return; }
          try {
            const exif = await this._service.getExifData(message.filePath);
            this._postMessage({
              type: 'exifData',
              filePath: message.filePath,
              exif,
            });
          } catch {
            this._postMessage({ type: 'exifData', filePath: message.filePath, exif: {} });
          }
          break;
        }

        case 'estimateSize': {
          if (!message.filePath || message.quality === undefined) { return; }
          try {
            const format = message.format ?? 'webp';
            const estimatedSize = await this._service.estimateOutputSize(message.filePath, message.quality, format);
            this._postMessage({
              type: 'estimatedSize',
              filePath: message.filePath,
              quality: message.quality,
              estimatedSize,
            });
          } catch {
            // Ignore estimation errors
          }
          break;
        }

        case 'rotateImage': {
          if (!message.filePath || !message.angle) { return; }
          try {
            await this._service.rotateImage(message.filePath, message.angle);
            const base64 = await this._service.getImageBase64(message.filePath);
            const info = await this._service.getImageInfo(message.filePath);
            // Update file info in the list
            this._postMessage({
              type: 'imageRotated',
              filePath: message.filePath,
              base64,
              info,
            });
          } catch {
            this._postMessage({ type: 'error', message: 'Failed to rotate image.' });
          }
          break;
        }

        case 'convert': {
          if (!message.files || message.files.length === 0) {
            this._postMessage({ type: 'error', message: 'No files selected.' });
            return;
          }

          const quality = message.quality ?? 80;
          const deleteOriginal = message.deleteOriginal ?? false;
          const format = message.format ?? 'webp';
          const config = vscode.workspace.getConfiguration('lwebp');
          const outputDir = config.get<string>('outputDirectory', '') || undefined;
          const crop = message.crop;

          const filePaths = message.files.map((f: string | { path: string }) =>
            typeof f === 'string' ? f : f.path,
          );

          this._postMessage({ type: 'convertStart', total: filePaths.length });

          const { results, errors } = await this._service.convertFiles(
            filePaths,
            quality,
            outputDir,
            (current, total, fileName) => {
              this._postMessage({
                type: 'convertProgress',
                current,
                total,
                fileName,
              });
            },
            crop,
            format,
          );

          if (deleteOriginal) {
            for (const result of results) {
              await vscode.workspace.fs.delete(vscode.Uri.file(result.inputPath));
            }
          }

          this._postMessage({
            type: 'convertDone',
            results: results.map(r => ({
              inputName: path.basename(r.inputPath),
              outputName: path.basename(r.outputPath),
              inputSize: r.inputSize,
              outputSize: r.outputSize,
              savings: r.savings,
            })),
            errors: errors.map(e => ({
              fileName: path.basename(e.path),
              error: e.error,
            })),
          });
          break;
        }
      }
    });
  }

  private async _getFilesInfo(filePaths: string[]): Promise<{ path: string; name: string; size: number; width: number; height: number; format: string }[]> {
    const results = [];
    for (const filePath of filePaths) {
      try {
        const info = await this._service.getImageInfo(filePath);
        results.push({
          path: filePath,
          name: path.basename(filePath),
          size: info.size,
          width: info.width,
          height: info.height,
          format: info.format,
        });
      } catch {
        results.push({
          path: filePath,
          name: path.basename(filePath),
          size: 0,
          width: 0,
          height: 0,
          format: path.extname(filePath).slice(1),
        });
      }
    }
    return results;
  }

  private _postMessage(message: unknown): void {
    this._view?.webview.postMessage(message);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const fontUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'fonts', 'FSPixelSansUnicode-Regular.ttf'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>lwebp</title>
  <style>
    @font-face {
      font-family: 'FS Pixel Sans';
      font-style: normal;
      font-weight: 400;
      font-display: swap;
      src: url('${fontUri}') format('truetype');
    }
    :root {
      --pixel-bg: #f0f0f0;
      --pixel-panel: #ffffff;
      --pixel-border: #888899;
      --pixel-border-light: #6666aa;
      --pixel-accent: #cc6600;
      --pixel-green: #cc4400;
      --pixel-text: #1a1a2e;
      --pixel-text-dim: #666688;
      --pixel-btn-bg: #f0e4d8;
      --pixel-btn-hover: #d0d0e0;
      --pixel-active-bg: rgba(204, 102, 0, 0.15);
      --pixel-shadow: 2px 2px 0px #aaaabb;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'FS Pixel Sans', monospace;
      font-size: 22px;
      color: var(--pixel-text);
      background: var(--pixel-bg);
      padding: 10px;
    }
    h2 {
      font-size: 24px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 10px;
      color: var(--pixel-accent);
      text-shadow: 1px 1px 0px rgba(0,0,0,0.1);
    }
    .section { margin-bottom: 14px; }

    .btn-group { display: flex; gap: 4px; margin-bottom: 10px; }

    button {
      display: flex; align-items: center; justify-content: center; gap: 6px;
      padding: 6px 10px;
      border: 2px solid var(--pixel-border); border-radius: 0;
      font-size: 22px; font-family: 'FS Pixel Sans', monospace;
      cursor: pointer; width: 100%;
      background: var(--pixel-btn-bg); color: var(--pixel-text);
      box-shadow: var(--pixel-shadow);
      transition: background 0.1s, border-color 0.1s;
    }
    button:hover { background: var(--pixel-btn-hover); border-color: var(--pixel-border-light); }
    button:disabled { opacity: 0.35; cursor: not-allowed; }
    .btn-secondary { background: #f5dcc0; color: #553300; border-color: #cc9955; }
    .btn-secondary:hover { background: #f0cc9f; border-color: #bb7733; }
    .btn-convert {
      background: #dd6600; color: #ffffff;
      border-color: #aa4400; padding: 8px 10px; font-size: 24px;
      text-shadow: 1px 1px 0px rgba(0,0,0,0.2);
    }
    .btn-convert:hover { background: #c45500; }
    .btn-small { padding: 4px 8px; font-size: 20px; width: auto; }
    .btn-crop { background: #ffe0b0; color: #884400; border-color: #cc8833; }
    .btn-crop:hover { background: #ffd090; }
    .btn-danger { background: #dd2222; border-color: #aa1111; color: #ffffff; text-shadow: 1px 1px 0px rgba(0,0,0,0.2); }
    .btn-danger:hover { background: #bb1111; }

    .file-list {
      background: var(--pixel-panel);
      border: 2px solid var(--pixel-border); border-radius: 0;
      padding: 6px; margin-bottom: 10px;
      max-height: 200px; overflow-y: auto; font-size: 20px;
      box-shadow: var(--pixel-shadow);
    }
    .file-list.empty {
      color: var(--pixel-text-dim);
      text-align: center; padding: 14px 6px;
    }
    .file-item {
      padding: 4px 6px; display: flex; justify-content: space-between; align-items: center;
      cursor: pointer; border: 2px solid transparent;
    }
    .file-item:hover { background: var(--pixel-btn-hover); }
    .file-item.selected { background: var(--pixel-active-bg); border-color: var(--pixel-accent); }
    .file-item .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .file-item .file-size { color: var(--pixel-text-dim); font-size: 18px; margin-left: 8px; white-space: nowrap; }
    .file-item .file-dims { color: var(--pixel-text-dim); font-size: 18px; margin-left: 6px; white-space: nowrap; }
    .file-item .remove { cursor: pointer; opacity: 0.6; margin-left: 6px; font-size: 22px; }
    .file-item .remove:hover { opacity: 1; color: #cc3333; }

    .file-count { font-size: 20px; color: var(--pixel-text-dim); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
    .select-actions { display: flex; gap: 4px; }
    .btn-link {
      background: none; border: none; box-shadow: none; width: auto;
      padding: 0 4px; font-size: 16px; color: var(--pixel-accent);
      text-decoration: underline; cursor: pointer;
    }
    .btn-link:hover { opacity: 0.7; }
    .file-item .check {
      width: 16px; height: 16px; border: 2px solid var(--pixel-border); border-radius: 0;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 12px; margin-right: 6px; flex-shrink: 0; cursor: pointer;
      background: var(--pixel-panel);
    }
    .file-item.checked .check { background: var(--pixel-accent); color: #fff; border-color: var(--pixel-accent); }

    label { display: block; font-size: 20px; margin-bottom: 4px; color: var(--pixel-text); }

    .quality-control { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .quality-control input[type="range"] { flex: 1; height: 14px; accent-color: var(--pixel-accent); }
    .quality-value { display: flex; align-items: center; }
    .quality-value input[type="number"] {
      width: 50px; padding: 2px 4px; font-size: 24px; font-family: 'FS Pixel Sans', monospace;
      background: var(--pixel-panel); color: var(--pixel-accent); border: 1px solid var(--pixel-border);
      text-align: right; -moz-appearance: textfield;
    }
    .quality-value input[type="number"]::-webkit-outer-spin-button,
    .quality-value input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

    .checkbox-control { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; font-size: 20px; }
    .checkbox-control input[type="checkbox"] { accent-color: var(--pixel-accent); width: 16px; height: 16px; }

    .format-control { margin-bottom: 10px; position: relative; }
    .format-select {
      width: 100%; padding: 6px 8px; font-size: 22px;
      font-family: 'FS Pixel Sans', monospace;
      background: var(--pixel-panel); color: var(--pixel-text);
      border: 2px solid var(--pixel-border); border-radius: 0;
      cursor: pointer; box-shadow: var(--pixel-shadow);
      display: flex; align-items: center; justify-content: space-between;
    }
    .format-select-label { flex: 1; }
    .format-select.open .dropdown-icon { transform: rotate(180deg); }
    .dropdown-icon { transition: transform 0.2s; }
    .format-dropdown {
      position: absolute; top: 100%; left: 0; right: 0; z-index: 100;
      display: none; background: var(--pixel-panel);
      border: 2px solid var(--pixel-border); border-top: none;
      box-shadow: var(--pixel-shadow);
    }
    .format-dropdown.active { display: block; }
    .format-option {
      padding: 4px 8px; font-size: 22px; cursor: pointer;
      border-bottom: 1px solid rgba(136, 136, 153, 0.2);
      font-family: 'FS Pixel Sans', monospace; color: var(--pixel-text);
    }
    .format-option:last-child { border-bottom: none; }
    .format-option:hover { background: var(--pixel-btn-hover); }
    .format-option.selected { background: var(--pixel-active-bg); color: var(--pixel-accent); }

    /* Preview section */
    .preview-section { display: none; margin-bottom: 14px; }
    .preview-section.active { display: block; }
    .preview-container {
      position: relative; background: #e8e8f0;
      border: 2px solid var(--pixel-border); border-radius: 0;
      overflow: auto; margin-bottom: 8px;
      height: 300px; box-shadow: var(--pixel-shadow);
      display: grid; place-items: center;
    }
    .preview-container img {
      max-width: 100%; max-height: 100%; display: block;
      user-select: none; -webkit-user-drag: none;
      image-rendering: auto;
    }
    .zoom-controls {
      position: absolute; top: 4px; right: 4px; z-index: 10;
      display: flex; gap: 2px;
    }
    .zoom-controls button {
      padding: 2px 6px; font-size: 16px; min-width: 26px;
      background: rgba(255,255,255,0.9); border: 2px solid var(--pixel-border);
      box-shadow: 1px 1px 0px rgba(0,0,0,0.15); width: auto;
    }
    .zoom-controls button:hover { background: #fff; }
    .preview-info {
      font-size: 20px; color: var(--pixel-text-dim);
      display: flex; justify-content: space-between; margin-bottom: 8px;
    }
    .preview-loading {
      padding: 24px; text-align: center; font-size: 20px;
      color: var(--pixel-text-dim);
    }

    /* Crop overlay */
    .crop-overlay {
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      cursor: crosshair; display: none;
    }
    .crop-overlay.active { display: block; }
    .crop-box {
      position: absolute; border: 2px dashed var(--pixel-accent);
      box-shadow: 0 0 0 9999px rgba(0,0,0,0.6);
      min-width: 10px; min-height: 10px;
    }
    .crop-controls { display: flex; gap: 4px; margin-bottom: 8px; flex-wrap: wrap; }
    .crop-inputs { display: none; margin-bottom: 8px; }
    .crop-inputs.active { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .crop-inputs label { font-size: 18px; margin-bottom: 2px; }
    .crop-inputs input {
      width: 100%; padding: 4px 6px; font-size: 20px;
      font-family: 'FS Pixel Sans', monospace;
      background: var(--pixel-panel); color: var(--pixel-text);
      border: 2px solid var(--pixel-border); border-radius: 0;
    }

    /* EXIF */
    .exif-section { margin-top: 8px; }
    .exif-toggle {
      font-size: 20px; cursor: pointer;
      color: var(--pixel-accent); padding: 4px 0;
      text-transform: uppercase; letter-spacing: 1px;
      font-family: 'FS Pixel Sans', monospace;
    }
    .exif-table {
      font-size: 19px; margin-top: 6px;
      background: var(--pixel-panel);
      border: 2px solid var(--pixel-border); border-radius: 0;
      padding: 6px; max-height: 200px; overflow-y: auto;
    }
    .exif-row { display: flex; padding: 3px 0; border-bottom: 1px solid rgba(136, 136, 153, 0.3); }
    .exif-row:last-child { border-bottom: none; }
    .exif-key { min-width: 90px; color: var(--pixel-text-dim); }
    .exif-val { flex: 1; word-break: break-all; }

    /* Estimate */
    .estimate-box {
      background: var(--pixel-panel);
      border: 2px solid var(--pixel-border); border-radius: 0;
      padding: 8px; margin-bottom: 10px;
      font-size: 20px; text-align: center;
      box-shadow: var(--pixel-shadow);
    }
    .estimate-box .est-size { font-size: 24px; color: var(--pixel-accent); }
    .estimate-box .est-savings { color: #228855; }
    .estimate-box .est-increase { color: #dd2222; }

    /* Progress */
    .progress-section { display: none; margin-bottom: 10px; }
    .progress-section.active { display: block; }
    .progress-bar-bg { width: 100%; height: 10px; background: #e0e0ee; border: 2px solid var(--pixel-border); border-radius: 0; overflow: hidden; margin-bottom: 6px; }
    .progress-bar { height: 100%; background: var(--pixel-green); border-radius: 0; transition: width 0.2s; width: 0%; }
    .progress-text { font-size: 19px; color: var(--pixel-text-dim); }

    /* Results */
    .results-section { display: none; margin-top: 10px; }
    .results-section.active { display: block; }
    .result-item {
      padding: 6px 8px; margin-bottom: 4px; font-size: 19px;
      background: var(--pixel-panel); border: 2px solid var(--pixel-border); border-radius: 0;
    }
    .result-item .result-name { margin-bottom: 2px; }
    .result-item .result-detail { color: var(--pixel-text-dim); }
    .result-item.success .result-savings { color: #228855; }
    .result-item.error { border-left: 3px solid #dd2222; }
    .result-item.error .result-detail { color: #dd2222; }

    .summary {
      padding: 8px; background: var(--pixel-panel);
      border: 2px solid var(--pixel-border); border-radius: 0;
      font-size: 20px; margin-bottom: 8px; text-align: center;
      box-shadow: var(--pixel-shadow);
    }
    .summary .big-number { font-size: 32px; color: var(--pixel-green); text-shadow: 1px 1px 0px rgba(0,0,0,0.1); }

    .divider { border: none; border-top: 2px solid var(--pixel-border); margin: 10px 0; }
  </style>
</head>
<body>
  <!-- FILE SELECTION -->
  <div class="section">
    <h2>Select Images</h2>
    <div class="btn-group">
      <button class="btn-secondary" id="btnSelectFiles">&#x25A3; Files</button>
      <button class="btn-secondary" id="btnSelectFolder">&#x25A8; Folder</button>
    </div>
    <div id="fileCount" class="file-count" style="display:none;">
      <span id="fileCountText"></span>
      <span class="select-actions">
        <button class="btn-link" id="btnSelectAll">All</button>
        <button class="btn-link" id="btnDeselectAll">None</button>
      </span>
    </div>
    <div id="fileList" class="file-list empty">No files selected</div>
  </div>

  <!-- PREVIEW -->
  <div class="preview-section" id="previewSection">
    <hr class="divider">
    <h2>Preview</h2>
    <div class="preview-info" id="previewInfo"></div>
    <div class="preview-container" id="previewContainer">
      <div class="zoom-controls">
        <button class="btn-small" id="btnZoomOut" title="Zoom Out">&#x2212;</button>
        <button class="btn-small" id="btnZoomReset" title="Reset" style="font-size:14px;">100%</button>
        <button class="btn-small" id="btnZoomIn" title="Zoom In">+</button>
      </div>
      <div class="preview-loading" id="previewLoading">Select a file to preview</div>
      <img id="previewImage" style="display:none;" />
      <div class="crop-overlay" id="cropOverlay">
        <div class="crop-box" id="cropBox" style="display:none;"></div>
      </div>
    </div>
    <div class="crop-controls">
      <button class="btn-secondary btn-small" id="btnRotateLeft" title="Rotate 90° Left">&#x21BA;</button>
      <button class="btn-secondary btn-small" id="btnRotateRight" title="Rotate 90° Right">&#x21BB;</button>
      <button class="btn-secondary btn-small btn-crop" id="btnCropToggle">&#x2702; Crop</button>
      <button class="btn-secondary btn-small btn-danger" id="btnCropClear" style="display:none;">&#x2716; Clear</button>
    </div>
    <div class="crop-inputs" id="cropInputs">
      <div><label>X</label><input type="number" id="cropX" min="0" value="0"></div>
      <div><label>Y</label><input type="number" id="cropY" min="0" value="0"></div>
      <div><label>Width</label><input type="number" id="cropW" min="1" value="100"></div>
      <div><label>Height</label><input type="number" id="cropH" min="1" value="100"></div>
    </div>

    <!-- EXIF -->
    <details class="exif-section" id="exifSection" style="display:none;">
      <summary class="exif-toggle">EXIF Data</summary>
      <div class="exif-table" id="exifTable"></div>
    </details>
  </div>

  <hr class="divider">

  <!-- SETTINGS -->
  <div class="section">
    <h2>Settings</h2>
    <label>Output Format</label>
    <div class="format-control">
      <div class="format-select" id="formatSelect">
        <span class="format-select-label" id="formatLabel">WebP</span>
        <span class="dropdown-icon">▼</span>
      </div>
      <div class="format-dropdown" id="formatDropdown">
        <div class="format-option" data-value="webp" data-label="WebP">WebP</div>
        <div class="format-option" data-value="jpg" data-label="JPEG">JPEG</div>
        <div class="format-option" data-value="png" data-label="PNG">PNG</div>
      </div>
      <input type="hidden" id="outputFormat" value="webp">
    </div>
    <label for="quality">Quality</label>
    <div class="quality-control">
      <input type="range" id="quality" min="0" max="100" value="80">
      <div class="quality-value">
        <input type="number" id="qualityValue" min="0" max="100" value="80">
      </div>
    </div>
    <div class="estimate-box" id="estimateBox" style="display:none;">
      <span id="estimateText"></span>
    </div>
    <div class="checkbox-control">
      <input type="checkbox" id="deleteOriginal">
      <label for="deleteOriginal" style="margin:0;font-weight:normal;">Delete original after conversion</label>
    </div>
  </div>

  <button class="btn-convert" id="btnConvert" disabled>&#x25B6; Convert to WebP</button>

  <!-- PROGRESS -->
  <div class="progress-section" id="progressSection">
    <hr class="divider">
    <div class="progress-bar-bg"><div class="progress-bar" id="progressBar"></div></div>
    <div class="progress-text" id="progressText"></div>
  </div>

  <!-- RESULTS -->
  <div class="results-section" id="resultsSection">
    <hr class="divider">
    <h2>Results</h2>
    <div id="summary" class="summary"></div>
    <div id="resultsList"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const state = {
      files: [],        // { path, name, size, width, height, format }
      selectedIndices: new Set(),  // multi-select indices
      previewIndex: -1,  // which file is previewed
      converting: false,
      cropEnabled: false,
      cropData: null,    // { left, top, width, height } in real image coords
      previewInfo: null,  // { width, height, size, format }
    };

    // Elements
    const btnSelectFiles = document.getElementById('btnSelectFiles');
    const btnSelectFolder = document.getElementById('btnSelectFolder');
    const btnConvert = document.getElementById('btnConvert');
    const fileList = document.getElementById('fileList');
    const fileCount = document.getElementById('fileCount');
    const fileCountText = document.getElementById('fileCountText');
    const btnSelectAll = document.getElementById('btnSelectAll');
    const btnDeselectAll = document.getElementById('btnDeselectAll');
    const qualitySlider = document.getElementById('quality');
    const qualityValue = document.getElementById('qualityValue');
    const deleteOriginal = document.getElementById('deleteOriginal');
    const progressSection = document.getElementById('progressSection');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const resultsSection = document.getElementById('resultsSection');
    const summary = document.getElementById('summary');
    const resultsList = document.getElementById('resultsList');
    const previewSection = document.getElementById('previewSection');
    const previewContainer = document.getElementById('previewContainer');
    const previewImage = document.getElementById('previewImage');
    const previewLoading = document.getElementById('previewLoading');
    const previewInfo = document.getElementById('previewInfo');
    const cropOverlay = document.getElementById('cropOverlay');
    const cropBox = document.getElementById('cropBox');
    const btnCropToggle = document.getElementById('btnCropToggle');
    const btnCropClear = document.getElementById('btnCropClear');
    const btnRotateLeft = document.getElementById('btnRotateLeft');
    const btnRotateRight = document.getElementById('btnRotateRight');
    const btnZoomIn = document.getElementById('btnZoomIn');
    const btnZoomOut = document.getElementById('btnZoomOut');
    const btnZoomReset = document.getElementById('btnZoomReset');
    const cropInputs = document.getElementById('cropInputs');
    const cropX = document.getElementById('cropX');
    const cropY = document.getElementById('cropY');
    const cropW = document.getElementById('cropW');
    const cropH = document.getElementById('cropH');
    const exifSection = document.getElementById('exifSection');
    const exifTable = document.getElementById('exifTable');
    const estimateBox = document.getElementById('estimateBox');
    const estimateText = document.getElementById('estimateText');
    const outputFormat = document.getElementById('outputFormat');
    const formatSelect = document.getElementById('formatSelect');
    const formatDropdown = document.getElementById('formatDropdown');
    const formatLabel = document.getElementById('formatLabel');
    const formatOptions = document.querySelectorAll('.format-option');

    // Custom dropdown handler
    formatSelect.addEventListener('click', function() {
      formatDropdown.classList.toggle('active');
    });

    formatOptions.forEach(function(option) {
      option.addEventListener('click', function() {
        const value = this.dataset.value;
        const label = this.dataset.label;
        outputFormat.value = value;
        formatLabel.textContent = label;
        formatDropdown.classList.remove('active');
        formatOptions.forEach(function(opt) { opt.classList.remove('selected'); });
        this.classList.add('selected');
        updateUI(); // Trigger re-render
      });
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', function(e) {
      if (!formatSelect.contains(e.target) && !formatDropdown.contains(e.target)) {
        formatDropdown.classList.remove('active');
      }
    });

    // Initialize selected format option
    formatOptions.forEach(function(option) {
      if (option.dataset.value === outputFormat.value) {
        option.classList.add('selected');
      }
    });

    // Zoom — pixel size để scroll cả ngang + dọc
    var sidebarZoom = 100;
    var sidebarBaseW = 0;
    function initSidebarBase() {
      if (previewImage && previewImage.naturalWidth) {
        sidebarBaseW = previewContainer.clientWidth;
      }
    }
    function applySidebarZoom() {
      if (previewImage.style.display === 'none') return;
      if (!sidebarBaseW) initSidebarBase();
      var w = Math.round(sidebarBaseW * sidebarZoom / 100);
      previewImage.style.width = w + 'px';
      previewImage.style.height = 'auto';
      previewImage.style.maxWidth = 'none';
      previewImage.style.maxHeight = 'none';
      btnZoomReset.textContent = sidebarZoom + '%';
    }
    function resetSidebarZoom() {
      sidebarZoom = 100;
      sidebarBaseW = 0;
      previewImage.style.width = '';
      previewImage.style.height = '';
      previewImage.style.maxWidth = '100%';
      previewImage.style.maxHeight = '100%';
      btnZoomReset.textContent = '100%';
    }
    btnZoomIn.addEventListener('click', function() { sidebarZoom = Math.min(400, sidebarZoom + 25); applySidebarZoom(); });
    btnZoomOut.addEventListener('click', function() { sidebarZoom = Math.max(25, sidebarZoom - 25); applySidebarZoom(); });
    btnZoomReset.addEventListener('click', resetSidebarZoom);
    previewContainer.addEventListener('wheel', function(e) {
      e.preventDefault();
      if (e.deltaY < 0) sidebarZoom = Math.min(400, sidebarZoom + 10);
      else sidebarZoom = Math.max(25, sidebarZoom - 10);
      applySidebarZoom();
    }, { passive: false });

    let estimateTimer = null;

    vscode.postMessage({ type: 'getConfig' });

    // Select All / Deselect All
    btnSelectAll.addEventListener('click', function() {
      state.selectedIndices.clear();
      state.files.forEach(function(_, i) { state.selectedIndices.add(i); });
      renderFileList(); updateUI();
    });
    btnDeselectAll.addEventListener('click', function() {
      state.selectedIndices.clear();
      renderFileList(); updateUI();
    });

    // Format selector
    outputFormat.addEventListener('change', () => {
      updateUI();
      requestEstimate();
    });

    // Quality slider and input
    qualitySlider.addEventListener('input', () => {
      const val = Math.max(0, Math.min(100, parseInt(qualitySlider.value) || 80));
      qualitySlider.value = val;
      qualityValue.value = val;
      requestEstimate();
    });
    qualityValue.addEventListener('change', () => {
      const val = Math.max(0, Math.min(100, parseInt(qualityValue.value) || 80));
      qualitySlider.value = val;
      qualityValue.value = val;
      requestEstimate();
    });

    // Select buttons
    btnSelectFiles.addEventListener('click', () => { if (!state.converting) vscode.postMessage({ type: 'selectFiles' }); });
    btnSelectFolder.addEventListener('click', () => { if (!state.converting) vscode.postMessage({ type: 'selectFolder' }); });

    // Convert
    btnConvert.addEventListener('click', () => {
      var filesToConvert = getSelectedFiles();
      if (filesToConvert.length === 0 || state.converting) return;
      state.converting = true;
      updateUI();
      resultsSection.classList.remove('active');

      const msg = {
        type: 'convert',
        files: filesToConvert.map(f => f.path),
        quality: parseInt(qualitySlider.value),
        deleteOriginal: deleteOriginal.checked,
        format: outputFormat.value,
      };
      if (state.cropData) { msg.crop = state.cropData; }
      vscode.postMessage(msg);
    });

    function getSelectedFiles() {
      if (state.selectedIndices.size === 0) return state.files;
      return state.files.filter(function(_, i) { return state.selectedIndices.has(i); });
    }

    // Crop toggle
    btnCropToggle.addEventListener('click', () => {
      state.cropEnabled = !state.cropEnabled;
      btnCropToggle.textContent = state.cropEnabled ? '\u2716 Crop Off' : '\u2702 Crop';
      cropOverlay.classList.toggle('active', state.cropEnabled);
      cropInputs.classList.toggle('active', state.cropEnabled);
      if (!state.cropEnabled) {
        clearCrop();
      }
    });

    btnCropClear.addEventListener('click', clearCrop);

    // Rotate buttons with accumulated angle + debounce
    let pendingRotation = 0;
    let rotateTimer = null;
    let isRotating = false;

    btnRotateLeft.addEventListener('click', () => queueRotation(-90));
    btnRotateRight.addEventListener('click', () => queueRotation(90));

    function queueRotation(angle) {
      if (state.previewIndex < 0 || state.converting) return;
      pendingRotation = (pendingRotation + angle) % 360;
      if (pendingRotation < 0) pendingRotation += 360;
      // Instant visual feedback
      previewImage.style.transform = 'rotate(' + pendingRotation + 'deg)';
      if (rotateTimer) clearTimeout(rotateTimer);
      rotateTimer = setTimeout(flushRotation, 400);
    }

    function flushRotation() {
      if (pendingRotation === 0 || isRotating) return;
      const file = state.files[state.previewIndex];
      if (!file) return;
      isRotating = true;
      var angle = pendingRotation;
      pendingRotation = 0;
      vscode.postMessage({ type: 'rotateImage', filePath: file.path, angle: angle });
    }

    function clearCrop() {
      state.cropData = null;
      cropBox.style.display = 'none';
      btnCropClear.style.display = 'none';
      cropX.value = 0; cropY.value = 0; cropW.value = 100; cropH.value = 100;
    }

    // Crop drawing
    let cropStartX = 0, cropStartY = 0, isCropping = false;
    cropOverlay.addEventListener('mousedown', (e) => {
      if (!state.cropEnabled) return;
      const rect = cropOverlay.getBoundingClientRect();
      cropStartX = e.clientX - rect.left;
      cropStartY = e.clientY - rect.top;
      isCropping = true;
      cropBox.style.display = 'block';
      cropBox.style.left = cropStartX + 'px';
      cropBox.style.top = cropStartY + 'px';
      cropBox.style.width = '0px';
      cropBox.style.height = '0px';
    });

    cropOverlay.addEventListener('mousemove', (e) => {
      if (!isCropping) return;
      const rect = cropOverlay.getBoundingClientRect();
      const curX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const curY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
      const x = Math.min(cropStartX, curX);
      const y = Math.min(cropStartY, curY);
      const w = Math.abs(curX - cropStartX);
      const h = Math.abs(curY - cropStartY);
      cropBox.style.left = x + 'px'; cropBox.style.top = y + 'px';
      cropBox.style.width = w + 'px'; cropBox.style.height = h + 'px';
    });

    cropOverlay.addEventListener('mouseup', (e) => {
      if (!isCropping) return;
      isCropping = false;
      updateCropFromBox();
    });

    function updateCropFromBox() {
      if (!state.previewInfo || !previewImage.naturalWidth) return;
      const imgRect = previewImage.getBoundingClientRect();
      const overlayRect = cropOverlay.getBoundingClientRect();

      const scaleX = state.previewInfo.width / imgRect.width;
      const scaleY = state.previewInfo.height / imgRect.height;

      const offsetX = imgRect.left - overlayRect.left;
      const offsetY = imgRect.top - overlayRect.top;

      const boxLeft = parseFloat(cropBox.style.left) - offsetX;
      const boxTop = parseFloat(cropBox.style.top) - offsetY;
      const boxWidth = parseFloat(cropBox.style.width);
      const boxHeight = parseFloat(cropBox.style.height);

      const realX = Math.max(0, Math.round(boxLeft * scaleX));
      const realY = Math.max(0, Math.round(boxTop * scaleY));
      const realW = Math.min(state.previewInfo.width - realX, Math.round(boxWidth * scaleX));
      const realH = Math.min(state.previewInfo.height - realY, Math.round(boxHeight * scaleY));

      if (realW > 0 && realH > 0) {
        state.cropData = { left: realX, top: realY, width: realW, height: realH };
        cropX.value = realX; cropY.value = realY; cropW.value = realW; cropH.value = realH;
        btnCropClear.style.display = '';
      }
    }

    // Manual crop input
    [cropX, cropY, cropW, cropH].forEach(input => {
      input.addEventListener('change', () => {
        const left = parseInt(cropX.value) || 0;
        const top = parseInt(cropY.value) || 0;
        const width = parseInt(cropW.value) || 100;
        const height = parseInt(cropH.value) || 100;
        state.cropData = { left, top, width, height };
        btnCropClear.style.display = '';
        // Update visual crop box on preview
        if (state.previewInfo && previewImage.naturalWidth) {
          const imgRect = previewImage.getBoundingClientRect();
          const overlayRect = cropOverlay.getBoundingClientRect();
          const scaleX = imgRect.width / state.previewInfo.width;
          const scaleY = imgRect.height / state.previewInfo.height;
          const offsetX = imgRect.left - overlayRect.left;
          const offsetY = imgRect.top - overlayRect.top;
          cropBox.style.display = 'block';
          cropBox.style.left = (left * scaleX + offsetX) + 'px';
          cropBox.style.top = (top * scaleY + offsetY) + 'px';
          cropBox.style.width = (width * scaleX) + 'px';
          cropBox.style.height = (height * scaleY) + 'px';
        }
      });
    });

    // Messages from extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'config':
          qualitySlider.value = msg.quality;
          qualityValue.value = msg.quality;
          deleteOriginal.checked = msg.deleteOriginal;
          break;

        case 'filesSelected':
          state.files = msg.files || [];
          state.previewIndex = -1;
          state.selectedIndices.clear();
          state.files.forEach(function(_, i) { state.selectedIndices.add(i); });
          renderFileList();
          updateUI();
          previewSection.classList.toggle('active', state.files.length > 0);
          if (state.files.length > 0) { previewFile(0); }
          break;

        case 'previewData':
          previewLoading.style.display = 'none';
          previewImage.src = msg.base64;
          previewImage.style.display = 'block';
          state.previewInfo = msg.info;
          previewInfo.innerHTML =
            '<span>' + msg.info.width + ' x ' + msg.info.height + '</span>' +
            '<span>' + msg.info.format.toUpperCase() + ' &bull; ' + formatSize(msg.info.size) + '</span>';
          break;

        case 'imageRotated':
          isRotating = false;
          previewImage.style.transform = '';
          previewImage.src = msg.base64;
          state.previewInfo = msg.info;
          previewInfo.innerHTML =
            '<span>' + msg.info.width + ' x ' + msg.info.height + '</span>' +
            '<span>' + msg.info.format.toUpperCase() + ' &bull; ' + formatSize(msg.info.size) + '</span>';
          if (state.previewIndex >= 0 && state.files[state.previewIndex]) {
            state.files[state.previewIndex].width = msg.info.width;
            state.files[state.previewIndex].height = msg.info.height;
            state.files[state.previewIndex].size = msg.info.size;
            renderFileList();
          }
          clearCrop();
          requestEstimate();
          // Flush any pending rotation queued while rotating
          if (pendingRotation !== 0) flushRotation();
          break;

        case 'previewError':
          previewLoading.style.display = 'block';
          previewLoading.textContent = 'Failed to load preview' + (msg.error ? ': ' + msg.error : '');
          previewImage.style.display = 'none';
          break;

        case 'exifData':
          renderExif(msg.exif || {});
          break;

        case 'estimatedSize':
          if (state.previewIndex >= 0 && state.files[state.previewIndex]) {
            var origSize = state.files[state.previewIndex].size;
            var estSize = msg.estimatedSize;
            var saved = origSize > 0 ? Math.round((1 - estSize / origSize) * 100) : 0;
            var savingsClass = saved > 0 ? 'est-savings' : 'est-increase';
            var savingsLabel = saved > 0 ? saved + '% smaller' : Math.abs(saved) + '% larger';
            estimateBox.style.display = '';
            var fmtLabel = outputFormat.options[outputFormat.selectedIndex].text;
            estimateText.innerHTML =
              'Estimated ' + fmtLabel + ': <span class="est-size">' + formatSize(estSize) + '</span>' +
              ' (<span class="' + savingsClass + '">' + savingsLabel + '</span>)';
          }
          break;

        case 'convertStart':
          progressSection.classList.add('active');
          progressBar.style.width = '0%';
          progressText.textContent = 'Starting...';
          break;

        case 'convertProgress':
          var pct = Math.round((msg.current / msg.total) * 100);
          progressBar.style.width = pct + '%';
          progressText.textContent = '(' + msg.current + '/' + msg.total + ') ' + msg.fileName;
          break;

        case 'convertDone':
          state.converting = false;
          progressSection.classList.remove('active');
          updateUI();
          renderResults(msg.results, msg.errors);
          break;

        case 'error':
          state.converting = false;
          updateUI();
          break;
      }
    });

    function toggleSelect(index) {
      if (state.selectedIndices.has(index)) {
        state.selectedIndices.delete(index);
      } else {
        state.selectedIndices.add(index);
      }
      renderFileList();
      updateUI();
    }

    function previewFile(index) {
      state.previewIndex = index;
      renderFileList();
      const file = state.files[index];
      if (!file) return;

      resetSidebarZoom();
      previewImage.style.display = 'none';
      previewLoading.style.display = 'block';
      previewLoading.textContent = 'Loading preview...';
      previewInfo.innerHTML =
        '<span>' + (file.width ? file.width + ' x ' + file.height : '...') + '</span>' +
        '<span>' + file.format.toUpperCase() + ' &bull; ' + formatSize(file.size) + '</span>';

      vscode.postMessage({ type: 'previewFile', filePath: file.path });
      vscode.postMessage({ type: 'getExif', filePath: file.path });
      requestEstimate();
    }

    function requestEstimate() {
      if (state.previewIndex < 0 || !state.files[state.previewIndex]) return;
      if (estimateTimer) clearTimeout(estimateTimer);
      estimateTimer = setTimeout(function() {
        var file = state.files[state.previewIndex];
        if (file) {
          vscode.postMessage({
            type: 'estimateSize',
            filePath: file.path,
            quality: parseInt(qualitySlider.value),
            format: outputFormat.value,
          });
        }
      }, 300);
    }

    function renderExif(exif) {
      var labels = {
        make: 'Camera', model: 'Model', dateTime: 'Date',
        exposureTime: 'Exposure', fNumber: 'Aperture', iso: 'ISO',
        focalLength: 'Focal Length', lensModel: 'Lens',
        orientation: 'Orientation', colorSpace: 'Color Space',
        whiteBalance: 'White Balance',
        gpsLatitude: 'GPS Lat', gpsLongitude: 'GPS Lng',
      };
      var html = '';
      var hasData = false;
      Object.keys(labels).forEach(function(key) {
        var val = exif[key];
        if (val !== undefined && val !== null && val !== '') {
          hasData = true;
          var display = val;
          if (key === 'fNumber') display = 'f/' + val;
          if (key === 'focalLength') display = val + 'mm';
          html += '<div class="exif-row"><span class="exif-key">' + labels[key] + '</span><span class="exif-val">' + display + '</span></div>';
        }
      });
      if (hasData) {
        exifSection.style.display = '';
        exifTable.innerHTML = html;
      } else {
        exifSection.style.display = 'none';
      }
    }

    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function renderFileList() {
      if (state.files.length === 0) {
        fileList.className = 'file-list empty';
        fileList.innerHTML = 'No files selected';
        fileCount.style.display = 'none';
        return;
      }

      fileList.className = 'file-list';
      fileCount.style.display = '';

      var selCount = state.selectedIndices.size;
      const totalSize = state.files.reduce(function(s, f) { return s + (f.size || 0); }, 0);
      fileCountText.innerHTML = state.files.length + ' file(s) &bull; ' + formatSize(totalSize) +
        (selCount > 0 && selCount < state.files.length ? ' &bull; <strong>' + selCount + ' selected</strong>' : '');

      fileList.innerHTML = state.files.map(function(f, i) {
        var previewing = i === state.previewIndex ? ' selected' : '';
        var checked = state.selectedIndices.has(i) ? ' checked' : '';
        return '<div class="file-item' + previewing + checked + '" data-index="' + i + '">' +
          '<span class="check" data-index="' + i + '">' + (state.selectedIndices.has(i) ? '\u2714' : '') + '</span>' +
          '<span class="name" title="' + f.path + '">' + f.name + '</span>' +
          (f.width ? '<span class="file-dims">' + f.width + 'x' + f.height + '</span>' : '') +
          '<span class="file-size">' + formatSize(f.size) + '</span>' +
          '<span class="remove" data-index="' + i + '" title="Remove">&times;</span>' +
        '</div>';
      }).join('');

      // Click on check = toggle select, click on name = preview
      fileList.querySelectorAll('.file-item').forEach(function(el) {
        el.addEventListener('click', function(e) {
          if (e.target.classList.contains('remove')) return;
          var idx = parseInt(el.dataset.index);
          if (e.target.classList.contains('check')) {
            toggleSelect(idx);
          } else {
            previewFile(idx);
          }
        });
      });

      fileList.querySelectorAll('.remove').forEach(function(el) {
        el.addEventListener('click', function(e) {
          e.stopPropagation();
          var idx = parseInt(el.dataset.index);
          state.selectedIndices.delete(idx);
          state.files.splice(idx, 1);
          // Re-index selectedIndices
          var newSet = new Set();
          state.selectedIndices.forEach(function(i) { if (i < idx) newSet.add(i); else if (i > idx) newSet.add(i - 1); });
          state.selectedIndices = newSet;
          if (state.previewIndex === idx) state.previewIndex = -1;
          else if (state.previewIndex > idx) state.previewIndex--;
          renderFileList();
          updateUI();
          if (state.files.length === 0) {
            previewSection.classList.remove('active');
          } else if (state.previewIndex >= 0) {
            previewFile(state.previewIndex);
          }
        });
      });
    }

    function updateUI() {
      var filesToConvert = getSelectedFiles();
      btnConvert.disabled = filesToConvert.length === 0 || state.converting;
      btnSelectFiles.disabled = state.converting;
      btnSelectFolder.disabled = state.converting;
      qualitySlider.disabled = state.converting;
      deleteOriginal.disabled = state.converting;

      if (state.converting) {
        btnConvert.textContent = '\u25FC Converting...';
      } else {
        var cropLabel = state.cropData ? ' (cropped)' : '';
        var fmtName = outputFormat.options[outputFormat.selectedIndex].text;
        var count = filesToConvert.length;
        btnConvert.textContent = count > 0
          ? '\u25B6 Convert ' + count + ' file(s) to ' + fmtName + cropLabel
          : '\u25B6 Convert to ' + fmtName;
      }
    }

    function renderResults(results, errors) {
      resultsSection.classList.add('active');

      if (results.length > 0) {
        var totalInputSize = results.reduce(function(s, r) { return s + r.inputSize; }, 0);
        var totalOutputSize = results.reduce(function(s, r) { return s + r.outputSize; }, 0);
        var avgSavings = Math.round(results.reduce(function(s, r) { return s + r.savings; }, 0) / results.length);
        var totalSaved = totalInputSize - totalOutputSize;
        summary.innerHTML =
          '<div class="big-number">' + avgSavings + '% saved</div>' +
          '<div>' + results.length + ' file(s) converted &bull; ' + formatSize(totalSaved) + ' saved</div>' +
          '<div>' + formatSize(totalInputSize) + ' &rarr; ' + formatSize(totalOutputSize) + '</div>';
      } else {
        summary.innerHTML = '<div>No files converted</div>';
      }

      var html = '';
      results.forEach(function(r) {
        html += '<div class="result-item success">' +
          '<div class="result-name">' + r.inputName + ' &rarr; ' + r.outputName + '</div>' +
          '<div class="result-detail">' + formatSize(r.inputSize) + ' &rarr; ' + formatSize(r.outputSize) +
            ' <span class="result-savings">(' + r.savings + '% saved)</span></div></div>';
      });
      errors.forEach(function(e) {
        html += '<div class="result-item error">' +
          '<div class="result-name">' + e.fileName + '</div>' +
          '<div class="result-detail">' + e.error + '</div></div>';
      });
      resultsList.innerHTML = html;
    }
  </script>
</body>
</html>`;
  }
}
