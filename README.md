# lwebp - Image Converter for VS Code

Convert images to **WebP**, **JPEG**, or **PNG** directly from VS Code with a full-featured sidebar panel and custom image editor.

## Features

### Multi-Format Conversion
Convert between image formats with a single click. Supports input from **PNG, JPG, GIF, BMP, TIFF, AVIF, HEIC/HEIF** and output to **WebP, JPEG, PNG**.

### Sidebar Panel
A dedicated sidebar in the Activity Bar with:
- **File & folder selection** — pick individual files or scan entire folders
- **Image preview** with dimensions and file size
- **Quality slider** with real-time estimated output size
- **Output format selector** — choose WebP, JPEG, or PNG
- **Visual crop tool** — draw a crop region or enter exact coordinates
- **EXIF viewer** — camera, lens, exposure, ISO, GPS, and more
- **Batch conversion** with progress tracking

### Custom Image Editor
Open any supported image with **"Reopen Editor With..."** to get:
- Full image preview with metadata
- EXIF data display
- One-click conversion with format and quality options
- Estimated output size before converting

### Context Menu Integration
Right-click any image in the Explorer or editor tab:
- **Convert to WebP** — instant conversion with configured quality
- **Convert to WebP (Select Quality...)** — choose quality before converting
- **Convert All Images in Folder to WebP** — batch convert from folder context menu

### Smart Output Naming
When converting to the same format (e.g., PNG to PNG), the output file is automatically named with a `_converted` suffix to avoid conflicts.

## Usage

### From the Sidebar
1. Click the **lwebp** icon in the Activity Bar
2. Select files or a folder
3. Choose output format and quality
4. Optionally enable crop and draw a region
5. Click **Convert**

### From Context Menu
1. Right-click an image file in the Explorer
2. Select **Convert to WebP** or **Convert to WebP (Select Quality...)**

### From the Image Editor
1. Open an image file
2. Use **"Reopen Editor With..." > lwebp Image Editor**
3. Adjust format and quality, then click **Convert**

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `lwebp.quality` | `80` | Output quality (0-100). Higher values = larger, better quality files. |
| `lwebp.deleteOriginal` | `false` | Delete the original file after successful conversion. |
| `lwebp.outputDirectory` | `""` | Output directory for converted files. Empty = same directory as original. |

## Supported Formats

**Input:** PNG, JPG/JPEG, GIF (animated), BMP, TIFF/TIF, AVIF, HEIC/HEIF

**Output:** WebP, JPEG, PNG

## Requirements

This extension uses [sharp](https://sharp.pixelplumbing.com/) for image processing. Sharp includes prebuilt binaries for most platforms (macOS, Linux, Windows on x64 and arm64).

## License

MIT
