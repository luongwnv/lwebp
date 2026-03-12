# lwebp - VS Code Extension

## Overview
VS Code extension that converts images (PNG, JPG, GIF, BMP, TIFF, AVIF, HEIC) to WebP format with configurable quality, crop, preview, and EXIF display.

## Commands
```bash
npm run compile    # Build TypeScript to out/
npm run watch      # Watch mode
npm test           # Run all tests (Jest)
npm run test:watch # Watch tests
npm run test:coverage # Coverage report
```

## Architecture
- **Singleton services** (`getInstance()` pattern) — follows SSHLite structure
- **Co-located tests** — `*.test.ts` next to source files
- **VS Code mock** at `src/__mocks__/vscode.ts` — mapped via `jest.config.js`
- **sharp** for image processing, **exif-reader** for EXIF parsing
- Compiled to `out/` via `tsc`, entry point `out/extension.js`

## Key Files
- `src/extension.ts` — Command registration (3 commands + webview provider)
- `src/services/ConversionService.ts` — Core: convert, crop, EXIF, estimate, image info
- `src/providers/ConvertPanelProvider.ts` — Sidebar webview UI with preview, crop, EXIF
- `src/__mocks__/vscode.ts` — Test mock for VS Code API

## Testing
- Mock `sharp` module (never calls real sharp in tests)
- Mock `fs/promises` for file operations
- Mock `exif-reader` for EXIF parsing
- Mock `ConversionService` in extension/provider tests
- Use `setMockConfig()` / `clearMockConfig()` for VS Code settings

## Debugging
Press F5 to launch Extension Development Host. The extension adds:
- Activity Bar icon (sidebar panel with full UI)
- Context menu on image files/folders in Explorer
- Editor title bar buttons on image files
