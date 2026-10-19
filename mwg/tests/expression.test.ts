import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateFormula } from '../src/simulation/expression.ts';

test('formula evaluator handles Wesnoth arithmetic and properties', () => {
  assert.equal(evaluateFormula('level < other.level', { values: { level: 1, other: { level: 2 } } }), true);
  assert.equal(evaluateFormula('25 * (level - other.level)', { values: { level: 4, other: { level: 2 } } }), 50);
});

test('formula evaluator supports where bindings and named helpers', () => {
  const unit = { side: 2, petrified: false };
  assert.equal(
    evaluateFormula('enemy_of(self, flanker) and not flanker.petrified where flanker = unit_at(loc)', {
      values: { self: { side: 1 }, loc: { x: 4, y: 2 } },
      functions: {
        unit_at: () => unit,
        enemy_of: (a, b) => (a as { side: number }).side !== (b as { side: number }).side,
      },
    }),
    true,
  );
});

test('formula evaluator does not execute unknown functions or malformed input', () => {
  assert.throws(() => evaluateFormula('process(1)', { functions: {} }), /unknown formula function/);
  assert.throws(() => evaluateFormula('1 +'), /expected formula value/);
});
