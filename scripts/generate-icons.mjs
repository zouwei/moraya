#!/usr/bin/env node
/**
 * Generate all app icons from moraya-logo-concept.svg
 * Usage: node scripts/generate-icons.mjs
 */
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const ICONS_DIR = join(import.meta.dirname, '..', 'src-tauri', 'icons');
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

/** Save PNG to icons directory */
function savePng(filename, size) {
  const buf = renderPng(size);
  const out = join(ICONS_DIR, filename);
  writeFileSync(out, buf);
  console.log(`  ✓ ${filename} (${size}x${size})`);
  return buf;
}

// ── 1. Tauri standard PNGs ──
console.log('\n🎨 Generating PNGs...');
savePng('icon.png', 512);
savePng('32x32.png', 32);
savePng('128x128.png', 128);
savePng('128x128@2x.png', 256);

// ── 2. Windows Square logos ──
console.log('\n🪟 Generating Windows Square logos...');
const squareSizes = [30, 44, 71, 89, 107, 142, 150, 284, 310];
for (const s of squareSizes) {
  savePng(`Square${s}x${s}Logo.png`, s);
}
savePng('StoreLogo.png', 50);

// ── 3. macOS .icns via iconutil ──
console.log('\n🍎 Generating icon.icns...');
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
  writeFileSync(join(iconsetDir, name), buf);
}
execSync(`iconutil -c icns -o "${join(ICONS_DIR, 'icon.icns')}" "${iconsetDir}"`);
rmSync(iconsetDir, { recursive: true });
console.log('  ✓ icon.icns');

// ── 4. Windows .ico ──
console.log('\n🔷 Generating icon.ico...');
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoPngs = icoSizes.map((s) => renderPng(s));
const icoBuf = await pngToIco(icoPngs);
writeFileSync(join(ICONS_DIR, 'icon.ico'), icoBuf);
console.log('  ✓ icon.ico');

console.log('\n✅ All icons generated from moraya-logo-concept.svg\n');
