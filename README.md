# lwebp - Image Converter for VS Code

Convert images to **WebP**, **JPEG**, or **PNG** directly from VS Code with pixel-art styled UI, sidebar panel, and custom image editor.

<img src="https://raw.githubusercontent.com/luongwnv/lwebp/master/media/screenshots/sidebar-panel.webp" width="350" />

## Features

### Sidebar Panel

- **Multi-file & multi-folder selection** — pick files or scan multiple folders at once
- **Multi-select** — checkbox to select which files to convert, with Select All / None
- **Image preview** with zoom (scroll wheel or +/- buttons), rotate, and crop
- **Quality slider** with real-time estimated output size
- **Output format selector** — WebP, JPEG, or PNG
- **Visual crop tool** — draw a crop region or enter exact pixel coordinates
- **EXIF viewer** — camera, lens, exposure, ISO, GPS, and more
- **Batch conversion** with progress tracking

### Custom Image Editor

Open any image with **"Reopen Editor With..." > lwebp Image Editor** to get a full editing UI.

<img src="https://raw.githubusercontent.com/luongwnv/lwebp/master/media/screenshots/image-editor.webp" width="600" />

- **Rotate** left/right with continuous rotation support
- **Zoom** in/out with buttons or scroll wheel (25%-400%)
- **Crop** — draw region on preview or enter exact coordinates
- **File navigation** — browse other images in the same folder
- **EXIF data** display
- **Convert** with format, quality, and crop options

### Context Menu

Right-click any image in Explorer or editor tab:

<img src="https://raw.githubusercontent.com/luongwnv/lwebp/master/media/screenshots/context-menu.webp" width="350" />

- **Convert to WebP** — instant conversion
- **Convert to WebP (Select Quality...)** — choose quality first
- **Convert All Images in Folder** — batch convert entire folder

## Supported Formats

| Input | Output |
|-------|--------|
| PNG, JPG, GIF, BMP, TIFF, AVIF, HEIC/HEIF | WebP, JPEG, PNG |

HEIC/HEIF works on all platforms — native sharp on macOS, automatic fallback to `heic-convert` on Windows/Linux.

## Usage

### Sidebar
1. Click the **lwebp** icon in the Activity Bar
2. Select files or folders
3. Check/uncheck files you want to convert
4. Choose format, quality, and optionally crop
5. Click **Convert**

### Image Editor
1. Open an image file
2. **"Reopen Editor With..." > lwebp Image Editor**
3. Rotate, zoom, crop as needed
4. Click **Convert**

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `lwebp.quality` | `80` | Output quality (0-100) |
| `lwebp.deleteOriginal` | `false` | Delete original after conversion |
| `lwebp.outputDirectory` | `""` | Output directory (empty = same as original) |

## Platform Support

Published as platform-specific packages for optimal size:
- macOS (Apple Silicon & Intel)
- Linux (x64 & ARM64)
- Windows (x64)

## License

MIT
