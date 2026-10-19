import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWml, parseWmlValue, preprocessWmlText } from '../src/simulation/wml.ts';

const opts = { dataDir: '/nonexistent' };

test('preprocessor expands a no-arg macro and substitutes arguments', () => {
  const text = `
#define TRAIT_STRONG
[trait]
    id=strong
    [effect]
        apply_to=hitpoints
        increase_total=1
    [/effect]
[/trait]
#enddef
[units]
    {TRAIT_STRONG}
[/units]
`;
  const flat = preprocessWmlText(text, opts);
  assert.ok(flat.includes('[trait]'));
  assert.ok(flat.includes('id=strong'));
  assert.ok(!flat.includes('{TRAIT_STRONG}'));

  const nodes = parseWml(flat);
  const units = nodes.find((node) => node.tag === 'units')!;
  const trait = units.children.find((node) => node.tag === 'trait')!;
  assert.equal(trait.attributes.id, 'strong');
  const effect = trait.children.find((node) => node.tag === 'effect')!;
  assert.equal(effect.attributes.apply_to, 'hitpoints');
});

test('#undef forgets a macro for later calls', () => {
  const text = `
#define ANSWER
first
#enddef
a={ANSWER}
#undef ANSWER
b={ANSWER}
`;
  const flat = preprocessWmlText(text, opts);
  assert.ok(flat.includes('a=first'), flat);
  assert.ok(!flat.includes('{ANSWER}'), flat);
  assert.ok(/^b=$/m.test(flat), 'the call after #undef expands to nothing');
});

test('preprocessor expands macro arguments including nested calls', () => {
  const text = `
#define GREET WHO
hello= _ "{WHO}"
#enddef
#define NAME
world
#enddef
msg={GREET world}
nested={GREET {NAME}}
`;
  const flat = preprocessWmlText(text, opts);
  assert.ok(flat.includes('hello= _ "world"'), flat);
  // Macro bodies include their trailing newline, so a macro substituted inside a
  // string carries it along; the real preprocessor behaves the same way.
  assert.ok(flat.includes('hello= _ "world\n"'), flat);
});

test('preprocessor expands parenthesized macro calls', () => {
  const text = preprocessWmlText(
    '#define WRAP BODY\n[tag]\n{BODY}\n[/tag]\n#enddef\n{WRAP( value=ok )}',
    { dataDir: process.cwd() },
  );
  assert.match(text, /\[tag\][\s\S]*value=ok[\s\S]*\[\/tag\]/);
});

test('preprocessor keeps grouped keyword-looking macro arguments positional', () => {
  const output = preprocessWmlText([
    '#define STORE X Y MAX FILTER VAR_NAME',
    'variable={VAR_NAME}.length',
    'filter={FILTER}',
    'x={X}',
    'y={Y}',
    '#enddef',
    '{STORE $this_item.x $this_item.y 99 (terrain=Qx*) chasm_hex}',
  ].join('\n'), { dataDir: '.', onFile: () => {} });
  assert.match(output, /variable=chasm_hex\.length/);
  assert.match(output, /filter=terrain=Qx\*/);
  assert.match(output, /x=\$this_item\.x/);
});

test('unknown macro calls expand to the empty string', () => {
  const flat = preprocessWmlText('before {ANIMATION_MACRO "x" ()} after', opts);
  assert.equal(flat.trim(), 'before  after');
});

test('conditional blocks honour defined symbols', () => {
  const text = `
#ifdef HAVE_X
a=1
#else
a=2
#endif
#ifndef HAVE_Y
b=3
#endif
`;
  const flat = preprocessWmlText(text, { ...opts, defines: ['HAVE_X'] });
  assert.ok(flat.includes('a=1'));
  assert.ok(!flat.includes('a=2'));
  assert.ok(flat.includes('b=3'));
});

test('nested conditionals work', () => {
  const text = `
#ifdef OUTER
#ifdef INNER
a=1
#else
a=2
#endif
#endif
`;
  const flat = preprocessWmlText(text, { ...opts, defines: ['OUTER'] });
  assert.ok(flat.includes('a=2'));
  const none = preprocessWmlText(text, opts);
  assert.ok(!none.includes('a='));
});

test('parseWmlValue strips gettext markers and unescapes doubled quotes', () => {
  assert.equal(parseWmlValue('"Spearman"'), 'Spearman');
  assert.equal(parseWmlValue(' _ "Spearman"'), 'Spearman');
  assert.equal(parseWmlValue('"a ""quoted"" word"'), 'a "quoted" word');
  // A quoted macro argument followed by an image modifier: Wesnoth concatenates
  // the quoted segment with the trailing text, so the quotes are not literal.
  assert.equal(parseWmlValue('"portraits/x.webp"~SCALE(93,93)'), 'portraits/x.webp~SCALE(93,93)');
  // `+` is the string-concatenation operator, with or without spaces.
  assert.equal(parseWmlValue('_ "a" + "b"'), 'ab');
  assert.equal(parseWmlValue('"a"+"b"'), 'ab');
  // No quotes and no `+` means the value is untouched, `+` included.
  assert.equal(parseWmlValue('1-5,8'), '1-5,8');
  assert.equal(parseWmlValue('a+b'), 'a+b');
});

test('parseWml splits comma-separated names and values (`x,y=5,3`)', () => {
  const unit = parseWml(`
[unit]
    x,y=5,3
    range,type=melee,blade
    a,b=1,2,3
    recruit=A,B,C
    name=SotA Flying Corpse
[/unit]
`)[0];
  assert.deepEqual(unit.attributes, {
    x: '5',
    y: '3',
    range: 'melee',
    type: 'blade',
    // The parser gives the last name the remaining commas, `parse_variable`.
    a: '1',
    b: '2,3',
    // A single name keeps its commas: a recruit list is not a name group.
    recruit: 'A,B,C',
    name: 'SotA Flying Corpse',
  });
});

test('a parenthesized multi-word macro argument stays one arg through a nested call', () => {
  const text = `
#define INNER SIDE TYPE
[unit]
    side={SIDE}
    type={TYPE}
[/unit]
#enddef
#define OUTER TYPE
{INNER 1 {TYPE}}
#enddef
{OUTER (Elvish Shyde)}
`;
  const unit = parseWml(preprocessWmlText(text, opts)).find((node) => node.tag === 'unit')!;
  assert.equal(unit.attributes.side, '1');
  assert.equal(unit.attributes.type, 'Elvish Shyde');
});

test('a parenthesized block of tags is substituted verbatim, not re-grouped', () => {
  const text = `
#define WRAP WML
[outer]
    {WML}
[/outer]
#enddef
{WRAP (
    [inner]
    x=1
    [/inner]
)}
`;
  const outer = parseWml(preprocessWmlText(text, opts))[0];
  assert.equal(outer.tag, 'outer');
  assert.equal(outer.children[0].tag, 'inner');
  assert.equal(outer.children[0].attributes.x, '1');
});

test('parseWmlValue strips macro grouping parentheses', () => {
  assert.equal(parseWmlValue('(Elvish Shyde)'), 'Elvish Shyde');
  assert.equal(parseWmlValue('(a) (b)'), '(a) (b)');
});

test('parseWml splits inline tags and tolerates whitespace inside brackets', () => {
  const nodes = parseWml([
    '[if]',
    '[condition]',
    'variable=x',
    '[/condition]',
    '[then]',
    '[redraw][/redraw][delay]',
    'time=1',
    '[/delay]',
    '[/then]',
    '[elseif]',
    '[/ elseif]',
    '[/if]',
  ].join('\n'));
  const ifNode = nodes[0];
  assert.equal(ifNode.tag, 'if');
  const then = ifNode.children.find((node) => node.tag === 'then')!;
  assert.deepEqual(then.children.map((node) => node.tag), ['redraw', 'delay']);
  assert.equal(then.children[1].attributes.time, '1');
  assert.equal(ifNode.children.filter((node) => node.tag === 'elseif').length, 1);
});

test('a `(` directly after a word starts a separate macro argument', () => {
  const flat = preprocessWmlText([
    '#define WRAP APPLY_TO WML',
    '[effect]',
    'apply_to={APPLY_TO}',
    '{WML}',
    '[/effect]',
    '#enddef',
    '{WRAP new_animation([standing_anim]',
    'base_score=1',
    '[/standing_anim])}',
  ].join('\n'), opts);
  assert.match(flat, /apply_to=new_animation\b/);
  assert.match(flat, /\[standing_anim\]/);
});

test('a grouped NAME=value fills an `#arg` optional parameter', () => {
  const flat = preprocessWmlText([
    '#define SIDE N',
    '#arg RECRUIT',
    'default',
    '#endarg',
    'side={N}',
    'recruit={RECRUIT}',
    '#enddef',
    '{SIDE 2 (RECRUIT=Elite Heavy Infantryman)}',
  ].join('\n'), opts);
  assert.match(flat, /recruit=Elite Heavy Infantryman/);
});

test('a macro name may contain a slash (`/IF`)', () => {
  const flat = preprocessWmlText([
    '#define IF',
    '[if]',
    '#enddef',
    '#define /IF',
    '[/if]',
    '#enddef',
    '{IF}',
    '[variable]',
    'name=x',
    '[/variable]',
    '{/IF}',
  ].join('\n'), opts);
  assert.match(flat, /\[if\]/);
  assert.match(flat, /\[\/if\]/);
});

test('parseWml builds nested trees and reports mismatched tags', () => {
  const nodes = parseWml('[a]\nkey=value\n[b]\nx=1\n[/b]\n[/a]');
  const a = nodes[0];
  assert.equal(a.attributes.key, 'value');
  assert.equal(a.children[0].tag, 'b');
  assert.throws(() => parseWml('[a]\n[/b]'), /mismatched/);
});

test('`# define` with a space is a comment, `#define` is a directive', () => {
  const text = `
# define resource here
[resource]
    id=kept
[/resource]
#define REAL_MACRO
value=1
#enddef
out={REAL_MACRO}
`;
  const flat = preprocessWmlText(text, opts);
  // The comment must not be read as a macro body (which used to fail with
  // `missing #enddef`), and the real directive must still expand.
  assert.ok(flat.includes('[resource]'), flat);
  assert.ok(flat.includes('id=kept'), flat);
  assert.ok(flat.includes('out=value=1'), flat);
});

test('comments are dropped but #textdomain is tolerated', () => {
  const flat = preprocessWmlText('#textdomain wesnoth\n# a comment\nx=1 # trailing comment\ny=2', opts);
  assert.ok(flat.includes('x=1'));
  assert.ok(flat.includes('y=2'));
  assert.ok(!flat.includes('comment'));
});
