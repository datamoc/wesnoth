import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateWmlFormula, formulaToString, interpolateWml, wmlNumber, type WmlValue } from '../src/scenarios/wml-value.ts';

/** A scope over a plain object, like the engine hook builds from `world.variables`. */
function scope(variables: Record<string, WmlValue>) {
  return (path: string) => variables[path];
}

test('an unset `$name` reads as the empty string', () => {
  assert.equal(interpolateWml('$missing!', scope({})), '!');
  assert.equal(interpolateWml('$known!', scope({ known: 'x' })), 'x!');
  assert.equal(interpolateWml('$known!', scope({ known: 7 })), '7!');
});

test('`$name|` ends a name and `$|` is a literal dollar', () => {
  // The `|` lets one `$` produce the name of another: `$$target|.x` reads `thing.x`.
  assert.equal(interpolateWml('$$target|.x', scope({ target: 'thing', 'thing.x': 'found' })), 'found');
  assert.equal(interpolateWml('costs $|5', scope({})), 'costs $5');
});

test('`$name?default|` falls back only when the variable is unset or empty', () => {
  assert.equal(interpolateWml('$turns?0|', scope({})), '0');
  assert.equal(interpolateWml('$turns?0|', scope({ turns: '' })), '0');
  assert.equal(interpolateWml('$turns?0|', scope({ turns: 3 })), '3');
  // Wesnoth only consumes the default when the `|` is present.
  assert.equal(interpolateWml('$turns?0', scope({})), '?0');
});

test('a `$(...)` formula substitutes its result', () => {
  assert.equal(interpolateWml('$(1 + 2 * 3)', scope({})), '7');
  assert.equal(interpolateWml('$(7 % 3)', scope({})), '1');
  assert.equal(interpolateWml('$(7 / 2)', scope({})), '3');
  assert.equal(interpolateWml('$(2 ^ 10)', scope({})), '1024');
});

test('a formula resolves `$name` and nested formulas before it is evaluated', () => {
  assert.equal(interpolateWml('$(min(7,($S7_turns)))', scope({ S7_turns: 3 })), '3');
  assert.equal(interpolateWml('$(ceil($($max_ghosts / 3.0)))', scope({ max_ghosts: 6 })), '2');
  // The `?default|` belongs to the interpolation pass, not the formula grammar.
  assert.equal(interpolateWml('$(((4 - $killed?0|) * 7) / 4)', scope({})), '7');
  assert.equal(interpolateWml('$(((4 - $killed?0|) * 7) / 4)', scope({ killed: 2 })), '3');
});

test('a formula that cannot be evaluated substitutes the empty string', () => {
  assert.equal(interpolateWml('$(nonsense(1))', scope({})), '');
  assert.equal(interpolateWml('$(1 +)', scope({})), '');
  assert.equal(interpolateWml('$(missing_variable + 1)', scope({})), '');
  // A missing unit field is an empty string, so the rest of the formula still runs.
  assert.equal(interpolateWml('$( $stored_naga.max_hitpoints - 13 )', scope({ 'stored_naga.id': 'leader4' })), '-13');
});

test('min, max, floor, ceil and round read WFL lists', () => {
  assert.equal(interpolateWml('$(min([4, $moves]))', scope({ moves: 5 })), '4');
  assert.equal(interpolateWml('$(max([0, (turn_number - 60) / 2]))', scope({ turn_number: 40 })), '0');
  assert.equal(interpolateWml('$(floor($a))', scope({ a: 2.7 })), '2');
  assert.equal(interpolateWml('$(ceil($a))', scope({ a: 2.1 })), '3');
  assert.equal(interpolateWml('$(round($a))', scope({ a: 2.5 })), '3');
});

test('`.length` and list indexing work on variables', () => {
  assert.equal(interpolateWml('$(liches.length)', scope({ liches: ['a', 'b', 'c'] })), '3');
  assert.equal(interpolateWml('$(liches[1])', scope({ liches: ['a', 'b'] })), 'b');
});

test('comparisons, `and`, `or` and `not` evaluate to WML booleans', () => {
  assert.equal(interpolateWml('$($a = 2)', scope({ a: 2 })), 'yes');
  assert.equal(interpolateWml('$(not $a = 2)', scope({ a: 3 })), 'yes');
  assert.equal(interpolateWml('$(if($a > 1, 10, 20))', scope({ a: 0 })), '20');
});

test('a literal with parentheses or a dash is not treated as arithmetic', () => {
  assert.equal(interpolateWml('Raise Walking Corpse (8 Gold)', scope({})), 'Raise Walking Corpse (8 Gold)');
  assert.equal(interpolateWml('defensive', scope({ defensive: 3 })), 'defensive');
});

test('numbers keep Wesnoth string shapes', () => {
  assert.equal(formulaToString(2), '2');
  assert.equal(formulaToString(0.5), '0.500');
  assert.equal(formulaToString(true), 'yes');
  assert.equal(wmlNumber('2.500'), 2.5);
  assert.equal(wmlNumber('defensive'), 0);
  assert.equal(wmlNumber(undefined), 0);
});

test('evaluateWmlFormula never raises', () => {
  assert.equal(evaluateWmlFormula('$$$', scope({})), '');
});

test('`..` concatenates and `~` builds integer ranges', () => {
  assert.equal(interpolateWml("$('a' .. 'b')", scope({})), 'ab');
  assert.equal(interpolateWml('$([1, 2] .. [3])', scope({})), '1, 2, 3');
  assert.equal(interpolateWml('$(1 ~ 3)', scope({})), '1, 2, 3');
  assert.equal(interpolateWml('$(3 ~ 1)', scope({})), '3, 2, 1');
  // Neither operator keeps the other's old meaning.
  assert.equal(interpolateWml('$([1] .. 2)', scope({})), '');
  assert.equal(interpolateWml("$('a' ~ 'b')", scope({})), '');
});

test('`in` tests list membership', () => {
  assert.equal(interpolateWml('$($x in [1, 2, 3])', scope({ x: 2 })), 'yes');
  assert.equal(interpolateWml('$($x in [1, 2, 3])', scope({ x: 9 })), 'no');
  assert.equal(interpolateWml('$($x in 5)', scope({ x: 1 })), '');
});

test('element-wise `.+`, `.-`, `.*`, `./` zip equal-length lists', () => {
  assert.equal(interpolateWml('$([1, 2] .+ [10, 20])', scope({})), '11, 22');
  assert.equal(interpolateWml('$([1, 2] .- [10, 20])', scope({})), '-9, -18');
  assert.equal(interpolateWml('$([2, 3] .* [4, 5])', scope({})), '8, 15');
  assert.equal(interpolateWml('$([8, 9] ./ [2, 3])', scope({})), '4, 3');
  assert.equal(interpolateWml('$([1] .+ [1, 2])', scope({})), '');
  assert.equal(interpolateWml('$([1] .+ 2)', scope({})), '');
});

test('`where` binds local names over the outer scope', () => {
  assert.equal(interpolateWml('$(x * 2 where x = 21)', scope({})), '42');
  assert.equal(interpolateWml('$(x + y where x = 1, y = 2)', scope({})), '3');
  assert.equal(interpolateWml('$(x + y where x = 1, y = $outer)', scope({ outer: 4 })), '5');
  // Clauses cannot see each other; the body prefers the binding.
  assert.equal(interpolateWml('$(x where x = $x)', scope({ x: 7 })), '7');
  assert.equal(interpolateWml('$(bogus where)', scope({})), '');
});

test('dice rolls stay inside the possible range', () => {
  for (let roll = 0; roll < 20; roll++) {
    const value = Number(interpolateWml('$(2d6)', scope({})));
    assert.ok(value >= 2 && value <= 12, `2d6 rolled ${value}`);
  }
  assert.equal(interpolateWml('$(0d6)', scope({})), '0');
  assert.equal(interpolateWml('$(2d0)', scope({})), '0');
});
