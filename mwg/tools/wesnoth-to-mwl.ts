/**
 * CLI: convert a Wesnoth `.cfg` file into MWL text.
 *
 *   npm run convert -- <file.cfg> [options]
 *     --out <file.mwl>    write to a file instead of stdout
 *     --all               generic structural conversion of every tag (default)
 *     --slice             typed slice conversion (terrain_type, movetype, trait,
 *                         unit_type); other tags are counted and reported
 *     --macros <a.cfg,b.cfg>  macro files to load before parsing
 *     --report            print conversion statistics instead of the text
 *
 * The conversion rules live in `src/adapters/wesnoth-to-mwl.ts`, which the
 * round-trip test `tests/cfg-to-mwl.test.ts` covers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLICE_TAGS } from '../src/adapters/from-mwl.ts';
import { emitMwl, genericMwlNodes, newConversionStats, sliceMwlNodes } from '../src/adapters/wesnoth-to-mwl.ts';
import { WmlPreprocessor, parseWml } from '../src/simulation/wml.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const mwgDir = path.resolve(here, '..');
const wesnothRoot = path.resolve(mwgDir, '..');
const dataDir = path.join(wesnothRoot, 'data');

interface Options {
  file: string;
  out?: string;
  mode: 'all' | 'slice';
  macros: string[];
  report: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { file: '', mode: 'all', macros: [], report: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--out') options.out = argv[++index];
    else if (arg === '--all') options.mode = 'all';
    else if (arg === '--slice') options.mode = 'slice';
    else if (arg === '--report') options.report = true;
    else if (arg === '--macros') options.macros = (argv[++index] ?? '').split(',').filter(Boolean);
    else if (!arg.startsWith('--') && !options.file) options.file = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.file)
    throw new Error('usage: npm run convert -- <file.cfg> [--out file.mwl] [--slice] [--macros a.cfg,b.cfg] [--report]');
  return options;
}

const options = parseArgs(process.argv.slice(2));
const source = path.resolve(options.file);
const relative = path.relative(wesnothRoot, source).replaceAll('\\', '/');

const wml = new WmlPreprocessor({ dataDir, onFile: () => {} });
if (options.macros.length) wml.loadMacros(options.macros.map((file) => path.resolve(file)));
const parsed = parseWml(wml.preprocessFile(source), relative);

const stats = newConversionStats();
const nodes = options.mode === 'slice' ? sliceMwlNodes(parsed, stats) : genericMwlNodes(parsed, stats);
const text = emitMwl(nodes, stats);

if (options.out) {
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  fs.writeFileSync(path.resolve(options.out), text, 'utf8');
}

if (options.report) {
  console.log(`wesnoth-to-mwl: ${relative}`);
  console.log(`  mode ${options.mode} (slice tags: ${SLICE_TAGS.join(', ')})`);
  console.log(`  ${stats.nodes} nodes, ${stats.converted} converted, ${stats.skipped} skipped`);
  console.log(`  ${stats.attributes} attributes, ${stats.gettext} gettext-marked, ${stats.quoted} quoted`);
  if (stats.skippedTags.size) {
    const skipped = [...stats.skippedTags].sort((a, b) => b[1] - a[1]).map(([tag, count]) => `${tag}:${count}`);
    console.log(`  skipped tags: ${skipped.slice(0, 12).join(' ')}${skipped.length > 12 ? ' ...' : ''}`);
  }
  if (options.out) console.log(`  wrote ${options.out}`);
} else {
  process.stdout.write(text);
}
