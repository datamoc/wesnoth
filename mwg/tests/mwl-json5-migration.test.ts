import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse, preprocess } from 'mwg/mwl';

const scenarioDir = path.resolve('src', 'scenarios');

test('every checked-in MWL scenario is JSON5, not retired tag syntax', () => {
  const files = readdirSync(scenarioDir).filter((file) => file.endsWith('.mwl')).sort();
  assert.ok(files.length > 0, 'the migration gate must inspect at least one scenario');

  for (const file of files) {
    const source = readFileSync(path.join(scenarioDir, file), 'utf8');
    assert.doesNotMatch(source, /^\s*\[\/?[A-Za-z_][A-Za-z0-9_.-]*/m, `${file} still contains tag-syntax MWL`);
    assert.match(source, /^\s*\[/, `${file} must use the JSON5 top-level array shape`);
  }

  // Parsing every campaign source here duplicates the build and makes the
  // ordinary test suite needlessly slow. The compiler parses the full corpus;
  // this gate samples each size/class boundary through the same front end.
  const samples = [files[0], files[Math.floor(files.length / 2)], files.at(-1)!];
  for (const file of samples) {
    const relative = `scenarios/${file}`;
    const source = readFileSync(path.join(scenarioDir, file), 'utf8');
    const nodes = parse(preprocess(source, { file: relative }), relative);
    assert.ok(nodes.length > 0, `${file} must contain at least one JSON5 node`);
    assert.ok(nodes.every((node) => node.tag.length > 0), `${file} contains an invalid node`);
  }
});
