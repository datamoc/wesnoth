import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImagePath } from 'mwg/two-d/render';
import { MWG_SPRITE_MODIFIER_SKIPS, mwgSpritePath, replacementColour, resolveNamedColour } from '../src/simulation/image-modifiers.ts';

test('parses named Wesnoth RC colours', () => {
  assert.equal(replacementColour(['magenta>red']), 0xff0000);
  assert.equal(replacementColour(['magenta>darkblue']), 0x0e2270);
  assert.equal(replacementColour(['magenta>wesred']), 0xff0000);
});

test('parses hexadecimal RC colours and rejects malformed values', () => {
  assert.equal(replacementColour(['FF00AA>12abef']), 0x12abef);
  assert.equal(replacementColour([]), undefined);
  assert.equal(replacementColour(['magenta>unknown']), undefined);
  assert.equal(replacementColour(['red']), undefined);
});

test('mwgSpritePath drops the modifiers MWG models differently', () => {
  assert.deepEqual([...MWG_SPRITE_MODIFIER_SKIPS].sort(), ['BLEND', 'CHAN', 'ROTATE']);
  const parsed = parseImagePath('a.png~FL(horizontal)~CHAN(red*1.2)~BLEND(ff0000,0.5)~ROTATE(90)~O(50%)');
  const filtered = mwgSpritePath(parsed);
  assert.deepEqual(filtered.modifiers.map((modifier) => modifier.name), ['FL', 'O']);
  assert.equal(filtered.path, 'a.png');
  // The input is not mutated, and a path with nothing to drop is returned unchanged.
  assert.equal(parsed.modifiers.length, 5);
  const clean = parseImagePath('b.png~GS');
  assert.equal(mwgSpritePath(clean), clean);
});

test('resolveNamedColour supplies MWG pixel-modifier probe names', () => {
  assert.equal(resolveNamedColour('red'), 0xff0000);
  assert.equal(resolveNamedColour('darkblue'), 0x0e2270);
  assert.equal(resolveNamedColour('12abef'), 0x12abef);
  assert.equal(resolveNamedColour('#12abef'), 0x12abef);
  assert.equal(resolveNamedColour('unknown'), undefined);
});

