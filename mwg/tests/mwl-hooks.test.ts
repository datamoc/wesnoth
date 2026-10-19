import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

/**
 * Integration test for the framework's esbuild hook-bundling path (`mwl hooks`
 * in `mwg/tools/mwl.mjs`). It runs from this port because the port is a game
 * project with esbuild installed, which is exactly where the tool resolves the
 * bundler from. The framework itself does not depend on esbuild.
 */
test('mwl hook bundling resolves a manifest and bundles hooks with esbuild', () => {
  const root = process.cwd();
  // Keep the scratch tree outside the repository: esbuild resolves imports by
  // walking parent directories, and the restricted test sandbox rejects that
  // walk when the scratch tree is nested under the workspace.
  const dir = mkdtempSync(join(tmpdir(), 'mwl-hooks-test-'));
  try {
    writeFileSync(
      join(dir, 'game.mwl'),
      '[\n  {\n    tag: "game",\n    schema: 0.1,\n    children: [\n      {\n        tag: "event",\n        id: "e",\n        on: "start",\n        children: [\n          { tag: "hook", name: "command:haunted_ruin", intensity: 3 },\n        ],\n      },\n    ],\n  },\n]\n',
    );
    writeFileSync(
      join(dir, 'quests.ts'),
      'export const haunted_ruin = (_world: unknown, emit: { message: (speaker: string, text: string) => void }, context: Record<string, string>) => { emit.message("narrator", "the ruin stirs " + context.intensity); };\n',
    );
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ 'command:haunted_ruin': 'quests.ts#haunted_ruin' }));

    const tool = join(root, 'node_modules', 'mwg', 'tools', 'mwl.mjs');
    const output = join(dir, 'hooks.mjs');
    execFileSync(process.execPath, [tool, 'hooks', join(dir, 'game.mwl'), '--manifest', join(dir, 'hooks.json'), '-o', output], {
      cwd: root,
      encoding: 'utf8',
    });

    const bundle = readFileSync(output, 'utf8');
    assert.match(bundle, /the ruin stirs/);
    assert.match(bundle, /"command:haunted_ruin"/);
    assert.match(readFileSync(`${output}.d.ts`, 'utf8'), /'command:haunted_ruin': CommandHook;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
