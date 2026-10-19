import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import replace from '@rollup/plugin-replace';
import nodePolyfills from 'rollup-plugin-polyfill-node';

const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as { version: string };

/**
 * Same file:// constraint as mwg's own examples and mwg-pixel-dungeon: no server,
 * no <script type="module">, and every image/audio asset inlined as a data: URI.
 */
export default defineConfig({
  base: './',
  publicDir: false,
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve: {
    // Same dedupe as mwg-pixel-dungeon: mwg and this project must share one pixi.js
    // copy, or Pixi extension registration (registerColorTransform) lands in the
    // wrong copy's registry and the first frame throws in production builds.
    dedupe: ['pixi.js'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      output: { format: 'iife', entryFileNames: 'game.js' },
    },
    cssCodeSplit: false,
    // Real Wesnoth PNGs are imported explicitly and inlined as base64 data: URIs;
    // the built page must run from file://, which blocks fetch() entirely.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
  },
});
