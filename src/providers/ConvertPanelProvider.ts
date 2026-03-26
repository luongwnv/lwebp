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

  private _getHtmlForWebview(_webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>lwebp</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 12px;
    }
    h2 {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
      color: var(--vscode-sideBarSectionHeader-foreground);
    }
    .section { margin-bottom: 16px; }

    .btn-group { display: flex; gap: 6px; margin-bottom: 12px; }

    button {
      display: flex; align-items: center; justify-content: center; gap: 6px;
      padding: 6px 12px; border: none; border-radius: 4px;
      font-size: 12px; font-family: var(--vscode-font-family);
      cursor: pointer; transition: opacity 0.15s; width: 100%;
    }
    button:hover { opacity: 0.85; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-convert { background: #16a34a; color: #fff; padding: 10px 12px; font-size: 13px; font-weight: 600; }
    .btn-small { padding: 4px 8px; font-size: 11px; width: auto; }
    .btn-danger { background: var(--vscode-errorForeground); color: #fff; }

    .file-list {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
      border-radius: 4px; padding: 8px; margin-bottom: 12px;
      max-height: 200px; overflow-y: auto; font-size: 11px;
    }
    .file-list.empty {
      color: var(--vscode-descriptionForeground); font-style: italic;
      text-align: center; padding: 16px 8px;
    }
    .file-item {
      padding: 4px 0; display: flex; justify-content: space-between; align-items: center;
      cursor: pointer; border-radius: 3px; padding: 4px 6px;
    }
    .file-item:hover { background: var(--vscode-list-hoverBackground); }
    .file-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .file-item .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .file-item .file-size { color: var(--vscode-descriptionForeground); font-size: 10px; margin-left: 8px; white-space: nowrap; }
    .file-item .file-dims { color: var(--vscode-descriptionForeground); font-size: 10px; margin-left: 6px; white-space: nowrap; }
    .file-item .remove { cursor: pointer; opacity: 0.6; margin-left: 6px; font-size: 14px; }
    .file-item .remove:hover { opacity: 1; }

    .file-count { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }

    label { display: block; font-size: 11px; font-weight: 600; margin-bottom: 4px; color: var(--vscode-foreground); }

    .quality-control { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .quality-control input[type="range"] { flex: 1; accent-color: var(--vscode-button-background); }
    .quality-value { font-size: 13px; font-weight: 600; min-width: 32px; text-align: right; }

    .checkbox-control { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; font-size: 12px; }
    .checkbox-control input[type="checkbox"] { accent-color: var(--vscode-button-background); }

    .format-control { margin-bottom: 12px; }
    .format-control select {
      width: 100%; padding: 5px 8px; font-size: 12px;
      font-family: var(--vscode-font-family);
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
      border-radius: 4px; cursor: pointer;
    }

    /* Preview section */
    .preview-section { display: none; margin-bottom: 16px; }
    .preview-section.active { display: block; }
    .preview-container {
      position: relative; background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
      border-radius: 4px; overflow: hidden; margin-bottom: 8px;
      display: flex; align-items: center; justify-content: center;
      min-height: 100px;
    }
    .preview-container img {
      max-width: 100%; max-height: 300px; display: block;
      user-select: none; -webkit-user-drag: none;
    }
    .preview-info {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      display: flex; justify-content: space-between; margin-bottom: 8px;
    }
    .preview-loading {
      padding: 24px; text-align: center;
      color: var(--vscode-descriptionForeground); font-style: italic;
    }

    /* Crop overlay */
    .crop-overlay {
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      cursor: crosshair; display: none;
    }
    .crop-overlay.active { display: block; }
    .crop-box {
      position: absolute; border: 2px dashed #fff;
      box-shadow: 0 0 0 9999px rgba(0,0,0,0.5);
      min-width: 10px; min-height: 10px;
    }
    .crop-controls { display: flex; gap: 6px; margin-bottom: 8px; }
    .crop-inputs { display: none; margin-bottom: 8px; }
    .crop-inputs.active { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .crop-inputs label { font-size: 10px; font-weight: normal; margin-bottom: 2px; }
    .crop-inputs input {
      width: 100%; padding: 3px 6px; font-size: 11px;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
      border-radius: 3px;
    }

    /* EXIF */
    .exif-section { margin-top: 8px; }
    .exif-toggle {
      font-size: 11px; font-weight: 600; cursor: pointer;
      color: var(--vscode-foreground); padding: 4px 0;
      text-transform: uppercase; letter-spacing: 0.3px;
    }
    .exif-table {
      font-size: 11px; margin-top: 6px;
      background: var(--vscode-input-background);
      border-radius: 4px; padding: 8px;
      max-height: 200px; overflow-y: auto;
    }
    .exif-row { display: flex; padding: 2px 0; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
    .exif-row:last-child { border-bottom: none; }
    .exif-key { font-weight: 600; min-width: 90px; color: var(--vscode-descriptionForeground); }
    .exif-val { flex: 1; word-break: break-all; }

    /* Estimate */
    .estimate-box {
      background: var(--vscode-input-background);
      border-radius: 4px; padding: 8px; margin-bottom: 12px;
      font-size: 11px; text-align: center;
    }
    .estimate-box .est-size { font-weight: 700; font-size: 13px; }
    .estimate-box .est-savings { color: #16a34a; font-weight: 600; }
    .estimate-box .est-increase { color: var(--vscode-errorForeground); font-weight: 600; }

    /* Progress */
    .progress-section { display: none; margin-bottom: 12px; }
    .progress-section.active { display: block; }
    .progress-bar-bg { width: 100%; height: 6px; background: var(--vscode-progressBar-background, #333); border-radius: 3px; overflow: hidden; margin-bottom: 6px; }
    .progress-bar { height: 100%; background: var(--vscode-button-background); border-radius: 3px; transition: width 0.2s; width: 0%; }
    .progress-text { font-size: 11px; color: var(--vscode-descriptionForeground); }

    /* Results */
    .results-section { display: none; margin-top: 12px; }
    .results-section.active { display: block; }
    .result-item { padding: 6px 8px; margin-bottom: 4px; border-radius: 4px; font-size: 11px; background: var(--vscode-input-background); }
    .result-item .result-name { font-weight: 600; margin-bottom: 2px; }
    .result-item .result-detail { color: var(--vscode-descriptionForeground); }
    .result-item.success .result-savings { color: #16a34a; font-weight: 600; }
    .result-item.error { border-left: 3px solid var(--vscode-errorForeground); }
    .result-item.error .result-detail { color: var(--vscode-errorForeground); }

    .summary { padding: 8px; border-radius: 4px; background: var(--vscode-input-background); font-size: 12px; margin-bottom: 8px; text-align: center; }
    .summary .big-number { font-size: 20px; font-weight: 700; color: #16a34a; }

    .divider { border: none; border-top: 1px solid var(--vscode-widget-border, var(--vscode-sideBarSectionHeader-border, #333)); margin: 12px 0; }
  </style>
</head>
<body>
  <!-- FILE SELECTION -->
  <div class="section">
    <h2>Select Images</h2>
    <div class="btn-group">
      <button class="btn-secondary" id="btnSelectFiles">Select Files</button>
      <button class="btn-secondary" id="btnSelectFolder">Select Folder</button>
    </div>
    <div id="fileCount" class="file-count" style="display:none;"></div>
    <div id="fileList" class="file-list empty">No files selected</div>
  </div>

  <!-- PREVIEW -->
  <div class="preview-section" id="previewSection">
    <hr class="divider">
    <h2>Preview</h2>
    <div class="preview-info" id="previewInfo"></div>
    <div class="preview-container" id="previewContainer">
      <div class="preview-loading" id="previewLoading">Select a file to preview</div>
      <img id="previewImage" style="display:none;" />
      <div class="crop-overlay" id="cropOverlay">
        <div class="crop-box" id="cropBox" style="display:none;"></div>
      </div>
    </div>
    <div class="crop-controls">
      <button class="btn-secondary btn-small" id="btnRotateLeft" title="Rotate 90° Left">&#x21BA; Left</button>
      <button class="btn-secondary btn-small" id="btnRotateRight" title="Rotate 90° Right">&#x21BB; Right</button>
      <button class="btn-secondary btn-small" id="btnCropToggle">Enable Crop</button>
      <button class="btn-secondary btn-small btn-danger" id="btnCropClear" style="display:none;">Clear Crop</button>
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
    <label for="outputFormat">Output Format</label>
    <div class="format-control">
      <select id="outputFormat">
        <option value="webp" selected>WebP</option>
        <option value="jpg">JPEG</option>
        <option value="png">PNG</option>
      </select>
    </div>
    <label for="quality">Quality</label>
    <div class="quality-control">
      <input type="range" id="quality" min="0" max="100" value="80">
      <span class="quality-value" id="qualityValue">80</span>
    </div>
    <div class="estimate-box" id="estimateBox" style="display:none;">
      <span id="estimateText"></span>
    </div>
    <div class="checkbox-control">
      <input type="checkbox" id="deleteOriginal">
      <label for="deleteOriginal" style="margin:0;font-weight:normal;">Delete original after conversion</label>
    </div>
  </div>

  <button class="btn-convert" id="btnConvert" disabled>Convert to WebP</button>

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
      selectedIndex: -1,
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

    let estimateTimer = null;

    vscode.postMessage({ type: 'getConfig' });

    // Format selector
    outputFormat.addEventListener('change', () => {
      updateUI();
      requestEstimate();
    });

    // Quality slider
    qualitySlider.addEventListener('input', () => {
      qualityValue.textContent = qualitySlider.value;
      requestEstimate();
    });

    // Select buttons
    btnSelectFiles.addEventListener('click', () => { if (!state.converting) vscode.postMessage({ type: 'selectFiles' }); });
    btnSelectFolder.addEventListener('click', () => { if (!state.converting) vscode.postMessage({ type: 'selectFolder' }); });

    // Convert
    btnConvert.addEventListener('click', () => {
      if (state.files.length === 0 || state.converting) return;
      state.converting = true;
      updateUI();
      resultsSection.classList.remove('active');

      const msg = {
        type: 'convert',
        files: state.files.map(f => f.path),
        quality: parseInt(qualitySlider.value),
        deleteOriginal: deleteOriginal.checked,
        format: outputFormat.value,
      };
      if (state.cropData) { msg.crop = state.cropData; }
      vscode.postMessage(msg);
    });

    // Crop toggle
    btnCropToggle.addEventListener('click', () => {
      state.cropEnabled = !state.cropEnabled;
      btnCropToggle.textContent = state.cropEnabled ? 'Disable Crop' : 'Enable Crop';
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
      if (state.selectedIndex < 0 || state.converting) return;
      pendingRotation = (pendingRotation + angle) % 360;
      if (pendingRotation < 0) pendingRotation += 360;
      // Instant visual feedback
      previewImage.style.transform = 'rotate(' + pendingRotation + 'deg)';
      if (rotateTimer) clearTimeout(rotateTimer);
      rotateTimer = setTimeout(flushRotation, 400);
    }

    function flushRotation() {
      if (pendingRotation === 0 || isRotating) return;
      const file = state.files[state.selectedIndex];
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
          qualityValue.textContent = msg.quality;
          deleteOriginal.checked = msg.deleteOriginal;
          break;

        case 'filesSelected':
          state.files = msg.files || [];
          state.selectedIndex = -1;
          renderFileList();
          updateUI();
          previewSection.classList.toggle('active', state.files.length > 0);
          if (state.files.length > 0) { selectFile(0); }
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
          if (state.selectedIndex >= 0 && state.files[state.selectedIndex]) {
            state.files[state.selectedIndex].width = msg.info.width;
            state.files[state.selectedIndex].height = msg.info.height;
            state.files[state.selectedIndex].size = msg.info.size;
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
          if (state.selectedIndex >= 0 && state.files[state.selectedIndex]) {
            var origSize = state.files[state.selectedIndex].size;
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

    function selectFile(index) {
      state.selectedIndex = index;
      renderFileList();
      const file = state.files[index];
      if (!file) return;

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
      if (state.selectedIndex < 0 || !state.files[state.selectedIndex]) return;
      if (estimateTimer) clearTimeout(estimateTimer);
      estimateTimer = setTimeout(function() {
        var file = state.files[state.selectedIndex];
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
      fileCount.style.display = 'block';

      const totalSize = state.files.reduce(function(s, f) { return s + (f.size || 0); }, 0);
      fileCount.textContent = state.files.length + ' file(s) &bull; ' + formatSize(totalSize);
      fileCount.innerHTML = fileCount.textContent;

      fileList.innerHTML = state.files.map(function(f, i) {
        var selected = i === state.selectedIndex ? ' selected' : '';
        return '<div class="file-item' + selected + '" data-index="' + i + '">' +
          '<span class="name" title="' + f.path + '">' + f.name + '</span>' +
          (f.width ? '<span class="file-dims">' + f.width + 'x' + f.height + '</span>' : '') +
          '<span class="file-size">' + formatSize(f.size) + '</span>' +
          '<span class="remove" data-index="' + i + '" title="Remove">&times;</span>' +
        '</div>';
      }).join('');

      fileList.querySelectorAll('.file-item').forEach(function(el) {
        el.addEventListener('click', function(e) {
          if (e.target.classList.contains('remove')) return;
          selectFile(parseInt(el.dataset.index));
        });
      });

      fileList.querySelectorAll('.remove').forEach(function(el) {
        el.addEventListener('click', function(e) {
          e.stopPropagation();
          var idx = parseInt(el.dataset.index);
          state.files.splice(idx, 1);
          if (state.selectedIndex >= state.files.length) state.selectedIndex = state.files.length - 1;
          renderFileList();
          updateUI();
          if (state.files.length === 0) {
            previewSection.classList.remove('active');
          } else if (state.selectedIndex >= 0) {
            selectFile(state.selectedIndex);
          }
        });
      });
    }

    function updateUI() {
      btnConvert.disabled = state.files.length === 0 || state.converting;
      btnSelectFiles.disabled = state.converting;
      btnSelectFolder.disabled = state.converting;
      qualitySlider.disabled = state.converting;
      deleteOriginal.disabled = state.converting;

      if (state.converting) {
        btnConvert.textContent = 'Converting...';
      } else {
        var cropLabel = state.cropData ? ' (cropped)' : '';
        var fmtName = outputFormat.options[outputFormat.selectedIndex].text;
        btnConvert.textContent = state.files.length > 0
          ? 'Convert ' + state.files.length + ' file(s) to ' + fmtName + cropLabel
          : 'Convert to ' + fmtName;
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
