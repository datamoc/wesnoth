import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

/**
 * The asset manifest and its budget (ROADMAP: "Asset manifest, cache and
 * loading observability").
 *
 * `npm run data` writes `tests/asset-manifest.json`: every file copied into the
 * offline build with its size and a short SHA-256. These tests keep the manifest
 * honest (it must match what is on disk) and keep the payload inside its
 * documented budget, so an accidental import of the 172 MB music folder or a
 * copied-by-accident image fails here instead of silently tripling the build.
 */
const mwgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(mwgDir, 'src', 'assets', 'wesnoth');

interface Manifest {
  count: number;
  totalBytes: number;
  assets: Record<string, { bytes: number; sha256: string }>;
}

const manifest = JSON.parse(readFileSync(path.join(mwgDir, 'tests', 'asset-manifest.json'), 'utf8')) as Manifest;

/**
 * The documented payload budget, in bytes. Today's build is 64.5 MB: 27 MB of
 * portraits, ~8 MB of sound effects and ~2 MB of unit and terrain art, plus the
 * rest of the campaign art the shipped scenarios draw. The ceiling leaves room
 * for a new campaign's assets but not for a whole new asset *class* (the music
 * folders alone are 172 MB and are deliberately not inlined).
 */
const ASSET_BUDGET_BYTES = 96 * 1024 * 1024;

test('every manifest entry matches the file on disk', () => {
  assert.ok(manifest.count > 6000, `${manifest.count} assets recorded`);
  const mismatches: string[] = [];
  for (const [rel, entry] of Object.entries(manifest.assets)) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path.join(assetsDir, rel));
    } catch {
      mismatches.push(`${rel}: missing`);
      continue;
    }
    if (bytes.length !== entry.bytes) mismatches.push(`${rel}: ${entry.bytes} -> ${bytes.length} bytes`);
    else if (crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16) !== entry.sha256) mismatches.push(`${rel}: contents changed`);
  }
  assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} asset(s) drifted from the manifest; re-run \`npm run data\``);
});

test('the payload stays inside its documented budget', () => {
  assert.ok(
    manifest.totalBytes <= ASSET_BUDGET_BYTES,
    `assets are ${(manifest.totalBytes / 1048576).toFixed(1)}MB, budget ${(ASSET_BUDGET_BYTES / 1048576).toFixed(0)}MB`,
  );
  assert.ok(manifest.totalBytes > 0);
});

test('no audio or music is inlined beyond the sound effects', () => {
  // Music is 172 MB and stays out of the bundle (ROADMAP: "Asset manifest,
  // cache and loading observability" and the audio row in PORT_COVERAGE.md); a
  // music file appearing here means the collector started copying a folder it
  // must not.
  const music = Object.keys(manifest.assets).filter((rel) => /^music\//.test(rel) || /\.(mp3|flac)$/i.test(rel));
  assert.deepEqual(music, [], 'music must not be inlined into the offline build');
  const sounds = Object.keys(manifest.assets).filter((rel) => /\.(ogg|wav)$/i.test(rel));
  assert.ok(sounds.length > 200, `${sounds.length} sound effects are inlined and playable offline`);
});
