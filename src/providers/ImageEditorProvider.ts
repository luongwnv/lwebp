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

    webviewPanel.webview.html = this._getHtml(fileName, base64, info, exif);

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'convert': {
          const config = vscode.workspace.getConfiguration('lwebp');
          const quality = message.quality ?? config.get<number>('quality', 80);
          const format: OutputFormat = message.format ?? 'webp';
          const outputDir = config.get<string>('outputDirectory', '') || undefined;

          try {
            const result = await this._service.convertFile(filePath, quality, outputDir, undefined, format);
            const formatLabel = OUTPUT_FORMATS.find(f => f.value === format)?.label ?? format;
            webviewPanel.webview.postMessage({
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
            webviewPanel.webview.postMessage({ type: 'error', message: errorMsg });
            vscode.window.showErrorMessage(`Conversion failed: ${errorMsg}`);
          }
          break;
        }

        case 'estimateSize': {
          if (message.quality === undefined) { return; }
          try {
            const format: OutputFormat = message.format ?? 'webp';
            const estimatedSize = await this._service.estimateOutputSize(filePath, message.quality, format);
            webviewPanel.webview.postMessage({
              type: 'estimatedSize',
              estimatedSize,
              originalSize: info.size,
            });
          } catch {
            // Ignore estimation errors
          }
          break;
        }
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _getHtml(fileName: string, base64: string, info: any, exif: any): string {
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
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
    }
    .container { max-width: 900px; margin: 0 auto; }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .header h1 { font-size: 16px; font-weight: 600; }
    .header .file-info { font-size: 12px; color: var(--vscode-descriptionForeground); }

    .preview {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
      border-radius: 6px; padding: 16px; margin-bottom: 16px;
      text-align: center;
    }
    .preview img { max-width: 100%; max-height: 500px; border-radius: 4px; }
    .preview .no-preview { padding: 40px; color: var(--vscode-descriptionForeground); font-style: italic; }

    .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    @media (max-width: 600px) { .panels { grid-template-columns: 1fr; } }

    .panel {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
      border-radius: 6px; padding: 14px;
    }
    .panel h2 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; color: var(--vscode-sideBarSectionHeader-foreground); }

    .info-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12px; }
    .info-grid .key { color: var(--vscode-descriptionForeground); font-weight: 600; }

    table { width: 100%; font-size: 12px; border-collapse: collapse; }
    table td { padding: 3px 0; }
    .exif-key { color: var(--vscode-descriptionForeground); font-weight: 600; padding-right: 12px; white-space: nowrap; }

    .convert-section {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
      border-radius: 6px; padding: 14px;
    }
    .convert-section h2 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; color: var(--vscode-sideBarSectionHeader-foreground); }

    .convert-controls { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
    .control-group { display: flex; flex-direction: column; gap: 4px; }
    .control-group label { font-size: 11px; font-weight: 600; }
    .control-group select, .control-group input[type="range"] { font-size: 12px; }
    .control-group select {
      padding: 5px 8px;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
      border-radius: 4px;
    }
    .quality-row { display: flex; align-items: center; gap: 8px; }
    .quality-row input[type="range"] { width: 120px; accent-color: var(--vscode-button-background); }
    .quality-val { font-size: 13px; font-weight: 600; min-width: 28px; }

    .estimate { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 10px; }
    .est-savings { color: #16a34a; font-weight: 600; }
    .est-increase { color: var(--vscode-errorForeground); font-weight: 600; }

    button.convert-btn {
      padding: 8px 20px; border: none; border-radius: 4px;
      background: #16a34a; color: #fff; font-size: 13px; font-weight: 600;
      cursor: pointer; transition: opacity 0.15s;
    }
    button.convert-btn:hover { opacity: 0.85; }
    button.convert-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .result { margin-top: 10px; padding: 8px 12px; border-radius: 4px; font-size: 12px; background: var(--vscode-editor-background); }
    .result.success { border-left: 3px solid #16a34a; }
    .result.error { border-left: 3px solid var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${fileName}</h1>
      <span class="file-info">${info.width} × ${info.height} · ${info.format.toUpperCase()} · ${formatSize(info.size)}</span>
    </div>

    <div class="preview">
      ${base64 ? `<img src="${base64}" alt="${fileName}" />` : '<div class="no-preview">Preview not available</div>'}
    </div>

    <div class="panels">
      <div class="panel">
        <h2>Image Info</h2>
        <div class="info-grid">
          <span class="key">Dimensions</span><span>${info.width} × ${info.height}</span>
          <span class="key">Format</span><span>${info.format.toUpperCase()}</span>
          <span class="key">File Size</span><span>${formatSize(info.size)}</span>
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
        <div class="control-group">
          <label for="format">Format</label>
          <select id="format">
            <option value="webp" selected>WebP</option>
            <option value="jpg">JPEG</option>
            <option value="png">PNG</option>
          </select>
        </div>
        <div class="control-group">
          <label>Quality</label>
          <div class="quality-row">
            <input type="range" id="quality" min="0" max="100" value="80">
            <span class="quality-val" id="qualityVal">80</span>
          </div>
        </div>
        <button class="convert-btn" id="convertBtn">Convert</button>
      </div>
      <div class="estimate" id="estimate" style="display:none;"></div>
      <div id="resultArea"></div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const qualitySlider = document.getElementById('quality');
    const qualityVal = document.getElementById('qualityVal');
    const formatSelect = document.getElementById('format');
    const convertBtn = document.getElementById('convertBtn');
    const estimate = document.getElementById('estimate');
    const resultArea = document.getElementById('resultArea');

    let estimateTimer = null;

    qualitySlider.addEventListener('input', () => {
      qualityVal.textContent = qualitySlider.value;
      requestEstimate();
    });

    formatSelect.addEventListener('change', () => {
      requestEstimate();
    });

    convertBtn.addEventListener('click', () => {
      convertBtn.disabled = true;
      convertBtn.textContent = 'Converting...';
      resultArea.innerHTML = '';
      vscode.postMessage({
        type: 'convert',
        quality: parseInt(qualitySlider.value),
        format: formatSelect.value,
      });
    });

    function requestEstimate() {
      if (estimateTimer) clearTimeout(estimateTimer);
      estimateTimer = setTimeout(() => {
        vscode.postMessage({
          type: 'estimateSize',
          quality: parseInt(qualitySlider.value),
          format: formatSelect.value,
        });
      }, 300);
    }

    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'estimatedSize': {
          var origSize = msg.originalSize;
          var estSize = msg.estimatedSize;
          var saved = origSize > 0 ? Math.round((1 - estSize / origSize) * 100) : 0;
          var cls = saved > 0 ? 'est-savings' : 'est-increase';
          var label = saved > 0 ? saved + '% smaller' : Math.abs(saved) + '% larger';
          estimate.style.display = '';
          estimate.innerHTML = 'Estimated: <strong>' + formatSize(estSize) + '</strong> (<span class="' + cls + '">' + label + '</span>)';
          break;
        }
        case 'convertDone': {
          convertBtn.disabled = false;
          convertBtn.textContent = 'Convert';
          resultArea.innerHTML = '<div class="result success">Converted to ' + msg.formatLabel + ': <strong>' +
            msg.outputPath.split('/').pop().split('\\\\').pop() +
            '</strong> (' + formatSize(msg.outputSize) + ', ' + msg.savings + '% savings)</div>';
          break;
        }
        case 'error': {
          convertBtn.disabled = false;
          convertBtn.textContent = 'Convert';
          resultArea.innerHTML = '<div class="result error">Error: ' + msg.message + '</div>';
          break;
        }
      }
    });

    // Request initial estimate
    requestEstimate();
  </script>
</body>
</html>`;
  }
}
