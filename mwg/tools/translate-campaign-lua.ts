/** Offline review aid: translate real campaign Lua with MWG 0.36's luaToJs.
 * Output is a candidate for manual porting, never substituted into the game.
 * Even warning-free output needs parity checks for numeric and table semantics.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { luaToJs } from 'mwg/mwl/pyroeis';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
if (outIndex >= 0 && !args[outIndex + 1]) throw new Error('--out requires a directory');
const input = path.resolve(args[0] && args[0] !== '--out' ? args[0] : '../data/campaigns/World_Conquest/lua');
const out = path.resolve(outIndex >= 0 ? args[outIndex + 1] : '.lua-translated');
if (out === input || out.startsWith(input + path.sep)) throw new Error('Output must be outside the source tree');

function luaFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return luaFiles(full);
    return entry.name.endsWith('.lua') ? [full] : [];
  });
}

const inputs = fs.statSync(input).isDirectory() ? luaFiles(input) : [input];
const base = fs.statSync(input).isDirectory() ? input : path.dirname(input);
const report = [];
for (const file of inputs) {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(base, file).split(path.sep).join('/');
  const provenance = { source: relative, sha256: createHash('sha256').update(source).digest('hex') };
  try {
    const result = luaToJs(source, { format: 'esm' });
    const target = path.join(out, relative.replace(/\.lua$/, '.js'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `// GPL-2.0-or-later. Source: ${relative}\n// SHA-256: ${provenance.sha256}\n// Review candidate, not runtime code.\n${result.code}`);
    report.push({ ...provenance, output: path.relative(out, target).split(path.sep).join('/'), warnings: result.warnings, freeGlobals: result.freeGlobals, exports: result.exports });
  } catch (error) {
    report.push({ ...provenance, error: error instanceof Error ? error.message : String(error) });
  }
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ input, note: 'All output requires semantic review and parity tests before adoption.', files: report }, null, 2) + '\n');
const errors = report.filter((entry) => 'error' in entry).length;
const warnings = report.reduce((sum, entry) => sum + ('warnings' in entry ? entry.warnings!.length : 0), 0);
console.log(`Lua translation: ${inputs.length} files, ${errors} failures, ${warnings} review warnings -> ${out}`);
if (errors) process.exitCode = 1;
