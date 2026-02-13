#!/usr/bin/env node
/**
 * Generate all app icons from moraya-logo-concept.svg
 * Requires: pngquant, oxipng (brew install pngquant oxipng)
 * Usage: node scripts/generate-icons.mjs
 */
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const ICONS_DIR = join(import.meta.dirname, '..', 'src-tauri', 'icons');
const STATIC_DIR = join(import.meta.dirname, '..', 'static');
const SVG_PATH = join(ICONS_DIR, 'moraya-logo-concept.svg');
const svgData = readFileSync(SVG_PATH, 'utf-8');

/** Render SVG to PNG buffer at given size */
function renderPng(size) {
  const resvg = new Resvg(svgData, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  });
  const pngData = resvg.render();
  return pngData.asPng();
}

/**
 * Optimize PNG. Tauri requires RGBA PNGs for bundle icons, so pngquant
 * (which converts to 8-bit indexed color) must be skipped for those files.
 * @param {string} filePath
 * @param {boolean} keepRGBA - if true, skip pngquant (lossy palette conversion)
 */
function optimizePng(filePath, keepRGBA = false) {
  if (!keepRGBA) {
    try { execSync(`pngquant 64 --quality=65-95 --speed 1 --strip --force --output "${filePath}" "${filePath}"`); } catch { /* quality floor not met, keep original */ }
  }
  try { execSync(`oxipng -o max --strip all "${filePath}" 2>/dev/null`); } catch { /* oxipng not available */ }
}

/** Render, save, and optimize a PNG */
function savePng(filename, size, keepRGBA = false) {
  const buf = renderPng(size);
  const out = join(ICONS_DIR, filename);
  writeFileSync(out, buf);
  optimizePng(out, keepRGBA);
  const finalSize = readFileSync(out).length;
  console.log(`  ${filename} (${size}x${size}) → ${(finalSize / 1024).toFixed(1)} KB`);
}

// ── 1. Tauri standard PNGs (must stay RGBA for Tauri generate_context!) ──
console.log('\nGenerating PNGs...');
savePng('icon.png', 512, true);
savePng('32x32.png', 32, true);
savePng('128x128.png', 128, true);
savePng('128x128@2x.png', 256, true);

// ── 2. Windows Square logos ──
console.log('\nGenerating Windows Square logos...');
const squareSizes = [30, 44, 71, 89, 107, 142, 150, 284, 310];
for (const s of squareSizes) {
  savePng(`Square${s}x${s}Logo.png`, s);
}
savePng('StoreLogo.png', 50);

// ── 3. macOS .icns via iconutil ──
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
  const buf = renderPng(size);
  const out = join(iconsetDir, name);
  writeFileSync(out, buf);
  optimizePng(out);
}
execSync(`iconutil -c icns -o "${join(ICONS_DIR, 'icon.icns')}" "${iconsetDir}"`);
rmSync(iconsetDir, { recursive: true });
console.log(`  icon.icns → ${(readFileSync(join(ICONS_DIR, 'icon.icns')).length / 1024).toFixed(0)} KB`);

// ── 4. Windows .ico ──
console.log('\nGenerating icon.ico...');
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoPngs = icoSizes.map((s) => renderPng(s));
const icoBuf = await pngToIco(icoPngs);
writeFileSync(join(ICONS_DIR, 'icon.ico'), icoBuf);
console.log(`  icon.ico → ${(readFileSync(join(ICONS_DIR, 'icon.ico')).length / 1024).toFixed(0)} KB`);

// ── 5. Static favicon ──
console.log('\nGenerating static/favicon.png...');
const faviconBuf = renderPng(128);
const faviconPath = join(STATIC_DIR, 'favicon.png');
writeFileSync(faviconPath, faviconBuf);
optimizePng(faviconPath);
console.log(`  favicon.png → ${(readFileSync(faviconPath).length / 1024).toFixed(1)} KB`);

console.log('\nAll icons generated and optimized.\n');
