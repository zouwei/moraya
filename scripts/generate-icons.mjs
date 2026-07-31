#!/usr/bin/env node
/**
 * Generate all app icons from the Moraya logo sources (see docs/specs/moraya-logo.md).
 *
 * Sources (src-tauri/icons/):
 *   moraya-logo-master.svg — full-bleed 512 square (NO baked corner radius)
 *   moraya-logo-small.svg  — simplified 16–32px variant (transparent, flat color)
 *   moraya-logo.svg        — transparent glyph for in-UI use
 *
 * Per-platform shaping happens HERE, not in the sources:
 *   - macOS .icns: master inset to 824/1024 rounded-rect (rx 185) with transparent
 *     margins, per Big Sur icon grid; ≤32px frames use the small variant's M.
 *   - Windows .ico: 16/24/32 frames from small (transparent), 48+ from master.
 *   - Everything else: full-bleed master (host OS applies its own mask).
 *
 * Requires: pngquant, oxipng (brew install pngquant oxipng), iconutil (macOS).
 * Usage: node scripts/generate-icons.mjs
 */
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const ICONS_DIR = join(import.meta.dirname, '..', 'src-tauri', 'icons');
const STATIC_DIR = join(import.meta.dirname, '..', 'static');

const masterSvg = readFileSync(join(ICONS_DIR, 'moraya-logo-master.svg'), 'utf-8');
const smallSvg = readFileSync(join(ICONS_DIR, 'moraya-logo-small.svg'), 'utf-8');
const glyphSvg = readFileSync(join(ICONS_DIR, 'moraya-logo.svg'), 'utf-8');

const innerOf = (svg) => svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1];

/** macOS Big Sur style: 1024 canvas, 824×824 rounded-rect content, transparent margin. */
function macosWrap(inner512) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs><clipPath id="macClip"><rect x="100" y="100" width="824" height="824" rx="185" ry="185"/></clipPath></defs>
  <g clip-path="url(#macClip)"><g transform="translate(100 100) scale(1.609375)">${inner512}</g></g>
</svg>`;
}

const macMasterSvg = macosWrap(innerOf(masterSvg));
// Small-frame macOS variant: flat paper chip + simplified M (gradients are invisible ≤32px).
const macSmallSvg = macosWrap(`<rect width="512" height="512" fill="#f7f4ec"/>${innerOf(smallSvg)}`);

function renderPng(svgData, size) {
  const resvg = new Resvg(svgData, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  });
  return resvg.render().asPng();
}

/**
 * Optimize PNG. Tauri requires RGBA PNGs for bundle icons, so pngquant
 * (which converts to 8-bit indexed color) must be skipped for those files.
 */
function optimizePng(filePath, keepRGBA = false) {
  if (!keepRGBA) {
    try { execSync(`pngquant 64 --quality=65-95 --speed 1 --strip --force --output "${filePath}" "${filePath}"`); } catch { /* quality floor not met, keep original */ }
  }
  try { execSync(`oxipng -o max --strip all "${filePath}" 2>/dev/null`); } catch { /* oxipng not available */ }
}

function savePng(svgData, filename, size, keepRGBA = false) {
  const out = join(ICONS_DIR, filename);
  writeFileSync(out, renderPng(svgData, size));
  optimizePng(out, keepRGBA);
  console.log(`  ${filename} (${size}x${size}) → ${(readFileSync(out).length / 1024).toFixed(1)} KB`);
}

// ── 1. Tauri standard PNGs (must stay RGBA for Tauri generate_context!) ──
console.log('\nGenerating PNGs...');
savePng(masterSvg, 'icon.png', 512, true);
savePng(masterSvg, '32x32.png', 32, true);
savePng(masterSvg, '128x128.png', 128, true);
savePng(masterSvg, '128x128@2x.png', 256, true);

// ── 2. Windows Square logos ──
console.log('\nGenerating Windows Square logos...');
const squareSizes = [30, 44, 71, 89, 107, 142, 150, 284, 310];
for (const s of squareSizes) {
  savePng(masterSvg, `Square${s}x${s}Logo.png`, s);
}
savePng(masterSvg, 'StoreLogo.png', 50);

// ── 3. macOS .icns via iconutil (inset rounded-rect variant) ──
console.log('\nGenerating icon.icns...');
const iconsetDir = join(ICONS_DIR, 'icon.iconset');
if (existsSync(iconsetDir)) rmSync(iconsetDir, { recursive: true });
mkdirSync(iconsetDir);

const icnsSizes = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];
for (const [name, size] of icnsSizes) {
  const src = size <= 32 ? macSmallSvg : macMasterSvg;
  const out = join(iconsetDir, name);
  writeFileSync(out, renderPng(src, size));
  optimizePng(out);
}
execSync(`iconutil -c icns -o "${join(ICONS_DIR, 'icon.icns')}" "${iconsetDir}"`);
rmSync(iconsetDir, { recursive: true });
console.log(`  icon.icns → ${(readFileSync(join(ICONS_DIR, 'icon.icns')).length / 1024).toFixed(0)} KB`);

// ── 4. Windows .ico (small frames from the small variant) ──
console.log('\nGenerating icon.ico...');
const icoPngs = [
  ...[16, 24, 32].map((s) => renderPng(smallSvg, s)),
  ...[48, 64, 128, 256].map((s) => renderPng(masterSvg, s)),
];
writeFileSync(join(ICONS_DIR, 'icon.ico'), await pngToIco(icoPngs));
console.log(`  icon.ico → ${(readFileSync(join(ICONS_DIR, 'icon.ico')).length / 1024).toFixed(0)} KB`);

// ── 5. Static favicon (transparent glyph — visible on light AND dark tabs) ──
console.log('\nGenerating static/favicon.png...');
const faviconPath = join(STATIC_DIR, 'favicon.png');
writeFileSync(faviconPath, renderPng(glyphSvg, 128));
optimizePng(faviconPath);
console.log(`  favicon.png → ${(readFileSync(faviconPath).length / 1024).toFixed(1)} KB`);

console.log('\nAll icons generated and optimized.\n');
