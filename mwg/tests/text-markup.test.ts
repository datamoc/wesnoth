import assert from 'node:assert/strict';
import test from 'node:test';
import {
  substituteVariables,
  wesnothAccessibilityText,
  wesnothMarkup,
  wesnothToSpans,
  wrapWesnothMarkup,
} from '../src/ui/text-markup.ts';

test('Wesnoth inline markup becomes Pixi rich-text tags', () => {
  const result = wesnothMarkup('<b>Warning</b> <i>at night</i> <span color="red">danger</span>');
  assert.equal(result.text, '<b>Warning</b> <i>at night</i> <color_red>danger</color_red>');
  assert.deepEqual(result.tagStyles.b, { fontWeight: 'bold' });
  assert.deepEqual(result.tagStyles.i, { fontStyle: 'italic' });
  assert.equal(result.tagStyles.color_red.fill, 0xff7777);
});

test('$variables substitute, dotted paths resolve, unknown names stay', () => {
  const variables = { hero_name: 'Konrad', side: { gold: 120 }, flag: true };
  assert.equal(substituteVariables('$hero_name has ${side.gold} gold', variables), 'Konrad has 120 gold');
  assert.equal(substituteVariables('$missing stays', variables), '$missing stays');
  const result = wesnothMarkup('<b>$hero_name</b> <u>under</u> ${side.gold}', variables);
  assert.equal(result.text, '<b>Konrad</b> under 120');
});

test('unstyleable tags keep their text and are stripped', () => {
  const result = wesnothMarkup('a <u>link</u> <ref dst="x">here</ref> <span background="blue">b</span>');
  assert.equal(result.text, 'a link here b');
});

test('Wesnoth tags map onto MWG spans and wrap after styling', () => {
  const spans = wesnothToSpans('Take <b>two small</b> coins, <span color="red">now</span>');
  assert.equal(spans.map((span) => span.text).join(''), 'Take two small coins, now');
  assert.ok(spans.some((span) => span.bold));
  assert.ok(spans.some((span) => span.color === 'red'));

  // A character-count measure stands in for a canvas metric in a headless test.
  const measure = (piece: { text?: string; image?: string }): number => (piece.image ? 8 : (piece.text ?? '').length * 8);
  const plain = wrapWesnothMarkup('Take two small coins', {}, measure, 40);
  assert.deepEqual(plain.text.split('\n'), ['Take', 'two', 'small', 'coins']);

  const bold = wrapWesnothMarkup('Take <b>two small</b> coins', {}, measure, 40);
  assert.ok(bold.text.includes('\n'), bold.text);
  assert.ok(bold.text.includes('<b>two</b>'), bold.text);
  assert.equal(bold.tagStyles.b.fontWeight, 'bold');

  assert.equal(wesnothAccessibilityText('Pay <b>10</b> gold<img>coin.png</img>'), 'Pay 10 gold[image]');
});
