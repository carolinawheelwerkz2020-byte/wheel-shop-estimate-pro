# Wheel Shop Estimate Pro — v2.3 (personal phone copy)

This is Bobby's personal install of **Wheel Shop Estimate Pro v2.3**, served via
GitHub Pages. The Gumroad product ZIP (`Wheel-Shop-Estimate-Pro-v2.3.zip`) is the
same app, packaged for buyers with all files bundled locally.

## How this copy differs from the Gumroad ZIP

This copy is deployed through a text-only channel, so the ~18 MB of binary
assets are **not** in this repo. Instead:

- The OCR engine core loads from the pinned CDN
  `https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/` (set as `corePath`
  in `app.js`)
- The English language data loads from
  `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/`
  (set as `langPath` in `app.js`) — byte-identical to the file in the Gumroad ZIP
- The PDF library loads from
  `https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js`
  (in `index.html`)
- The app icons ship as base64 text (`icons/*.png.b64`); the service worker
  (`sw.js`) decodes them to true bytes on first request

Everything is cached by the service worker after first load, so the app keeps
working offline once opened. The VIN decoder (NHTSA lookup) needs internet,
as in the Gumroad build.

## Enable GitHub Pages

Repo Settings → Pages → Deploy from a branch → `main` / `/ (root)`.
The app will be live at `https://carolinawheelwerkz2020-byte.github.io/wheel-shop-estimate-pro/`.

On iPhone: open that URL in Safari → Share → Add to Home Screen.

## What's in v2.3

- Typed 17-character VIN decoding via the free NHTSA vPIC API (year/make/model autofill)
- Rear-camera **Scan VIN** with on-device Tesseract.js OCR (no photo leaves the phone)
- VIN check-digit validation; the scanner refuses to guess on unsafe reads
- Real on-device PDF reports (jsPDF), shareable via the iOS share sheet
