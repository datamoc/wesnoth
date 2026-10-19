/**
 * WML string values: `$` interpolation and the `$(...)` formula language.
 *
 * Wesnoth reads a WML attribute through `vconfig::expand`, which runs
 * `utils::interpolate_variables_into_string` (`src/formula/string_utils.cpp`):
 * `$name` substitutes a variable (an unset one is the empty string),
 * `$name?default|` supplies a fallback, `$name|` ends the name, `$|` is a literal
 * `$`, and `$(...)` evaluates a WFL formula and substitutes its result. A formula
 * that fails to evaluate substitutes the empty string rather than raising.
 *
 * MWL's own `[set_variable] value=` is not this. It guesses whether the text is
 * arithmetic, and its expression evaluator raises on an unset variable and cannot
 * spell `min(5,($turns))` or a literal like `Raise Walking Corpse (8 Gold)`.
 * Ported scenarios therefore hand the raw WML text to the port's
 * `command:set_variable_dynamic` hook, which evaluates it here.
 *
 * Known simplification: WFL keeps a fixed-point decimal type that stays decimal
 * through later arithmetic (`1.0 / 2` is `0.500`, while `1 / 2` is `0`). Here a
 * decimal literal is an ordinary number, so an integral literal written with a
 * decimal point divides as an integer. The port's campaigns only use decimal
 * literals inside `min`/`max`/`floor`/`ceil`, where the two agree.
 *
 * `..` concatenates (lists or strings, `src/formula/variant.cpp:635`), while the
 * integer range builder is `~` (`variant.cpp:648`, `1~3` is `[1, 2, 3]`). `in`
 * tests membership (`variant.cpp:654`), `.+`/`.-`/`.*`/`./` zip two equal-length
 * lists element-wise (`variant.cpp:576-595`), `d` rolls dice, and `where`
 * binds local names (`src/formula/formula.cpp:789-858`). Maps are not ported:
 * the hook scope carries no map values (`asWmlValue` drops them), so there is
 * nothing for map lookup to read. Dice use `Math.random`, not the scenario's
 * seeded stream, since formula evaluation takes no rng. `+` also concatenates
 * strings here (the engine spells that `..`); kept so scenario text that
 * already relies on it keeps working.
 */

/** A WFL/attribute value: what a variable path or a formula can hold. */
export type WmlValue = string | number | boolean | readonly WmlValue[];

/** Resolve a WML variable path (`stored_naga.max_hitpoints`, `zombies[0].side`). */
export type WmlValueScope = (path: string) => WmlValue | undefined;

/** Wesnoth's decimal variants keep three fractional digits. */
const DECIMAL_SCALE = 1000;

/** Interpolate every `$` reference in one WML attribute value. */
export function interpolateWml(raw: string, scope: WmlValueScope): string {
  let result = raw;
  let from = result.length;
  while (from >= 0) {
    const start = result.lastIndexOf('$', from);
    if (start < 0) break;
    from = start - 1;
    const marker = result[start + 1];
    if (marker === undefined) continue;
    if (marker === '(') {
      const close = formulaClose(result, start + 1);
      if (close < 0) {
        result = result.slice(0, start);
        continue;
      }
      const value = evaluateWmlFormula(result.slice(start + 2, close), scope);
      result = result.slice(0, start) + value + result.slice(close + 1);
      continue;
    }
    result = replaceReference(result, start, scope);
  }
  return result;
}

/** Evaluate one `$(...)` body, substituting the empty string when it cannot be evaluated. */
export function evaluateWmlFormula(source: string, scope: WmlValueScope): string {
  try {
    return formulaToString(evaluateFormula(source, scope));
  } catch {
    return '';
  }
}

/** Evaluate one `$(...)` body to a value; throws when the formula is unknown. */
export function evaluateFormula(source: string, scope: WmlValueScope): WmlValue {
  const parser = new FormulaParser(tokenize(source), scope);
  const value = parser.expression();
  if (!parser.atEnd()) throw new Error(`unexpected token in WML formula: ${parser.rest()}`);
  return value;
}

/** Wesnoth's `variant::string_cast`, as `do_interpolation` uses it. */
export function formulaToString(value: WmlValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    return (Math.round(value * DECIMAL_SCALE) / DECIMAL_SCALE).toFixed(3);
  }
  return value.map(formulaToString).join(', ');
}

/**
 * Number of a value used by `value=` consumers. Wesnoth's `tonumber` reads a
 * numeric string and turns anything else (including an unset variable) into `nil`,
 * which the arithmetic then treats as 0.
 */
export function wmlNumber(value: WmlValue | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Apply one WML `[set_variable]` arithmetic operation, in Wesnoth's own order. */
export function applyWmlOperation(mode: string, current: number, operand: number): number {
  switch (mode) {
    case 'add': return current + operand;
    case 'sub': return current - operand;
    case 'multiply': return current * operand;
    case 'divide': return operand === 0 ? 0 : current / operand;
    case 'modulo': return operand === 0 ? 0 : current % operand;
    default: return current;
  }
}

/** `$name`, `$name?default|`, `$name|`, and the `$|` escape, per `do_interpolation`. */
function replaceReference(source: string, start: number, scope: WmlValueScope): string {
  const end = referenceEnd(source, start + 1);
  const name = source.slice(start + 1, end);
  const fallback = source[end] === '?';
  if (!fallback) {
    const stop = source[end] === '|' ? end + 1 : end;
    const text = name === '' ? '$' : valueToString(scope(name));
    return source.slice(0, start) + text + source.slice(stop);
  }
  let defaultEnd = end + 1;
  while (defaultEnd < source.length && source[defaultEnd] !== '|') defaultEnd++;
  const hasBar = defaultEnd < source.length;
  const stop = hasBar ? defaultEnd + 1 : defaultEnd;
  const value = scope(name);
  if (value !== undefined && !isUnset(value)) {
    return source.slice(0, start) + valueToString(value) + source.slice(stop);
  }
  if (!hasBar) {
    // `$name?default` without the closing `|` leaves the `?default` text in place; Wesnoth
    // only consumes the default when it is `|`-terminated.
    return source.slice(0, start) + valueToString(value) + source.slice(end);
  }
  return source.slice(0, start) + source.slice(end + 1, defaultEnd) + source.slice(stop);
}

function isUnset(value: WmlValue): boolean {
  return value === '' || value === false;
}

function valueToString(value: WmlValue | undefined): string {
  return value === undefined ? '' : formulaToString(value);
}

/** Index of the last name character after `from`; names are `[\w.]` plus `[...]` sections. */
function referenceEnd(source: string, from: number): number {
  let end = from;
  let brackets = 0;
  for (; end < source.length; end++) {
    const character = source[end];
    if (character === '[') brackets++;
    else if (character === ']') {
      if (--brackets < 0) break;
    } else if (!/[A-Za-z0-9_.]/.test(character)) break;
  }
  // Two dots in a row never belong to one name (`$x..$y`).
  const pair = source.indexOf('..', from);
  if (pair >= 0 && pair < end) end = pair;
  // A trailing `.` is punctuation, unless it follows an index.
  if (end > from && source[end - 1] === '.' && source[end - 2] !== ']') end--;
  return end;
}

/** Index of the `)` closing the `(` at `open`, or -1 when it never closes. */
function formulaClose(source: string, open: number): number {
  let depth = 0;
  let inString = false;
  let inComment = false;
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    if (character === '(') { if (!inString && !inComment) depth++; }
    else if (character === ')') { if (!inString && !inComment) depth--; }
    else if (character === '#') { if (!inString) inComment = !inComment; }
    else if (character === "'") { if (!inComment) inString = !inString; }
    if (depth === 0) return index;
  }
  return -1;
}

type Token =
  | { readonly kind: 'number'; readonly value: number; readonly integer: boolean }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'operator'; readonly value: string };

const FORMULA_OPERATORS = ['!=', '<=', '>=', '..', '->', '.+', '.-', '.*', './', '~', '+', '-', '*', '/', '%', '^', '=', '<', '>', '.'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) { index++; continue; }
    if (character === '#') {
      // A `#` starts a formula comment and runs to the end of the line.
      while (index < source.length && source[index] !== '\n') index++;
      continue;
    }
    const number = /^(?:\d+\.\d*|\.\d+|\d+)/.exec(source.slice(index));
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]), integer: !number[0].includes('.') });
      index += number[0].length;
      continue;
    }
    if (character === "'") {
      const close = source.indexOf("'", index + 1);
      if (close < 0) throw new Error('unterminated WML formula string');
      tokens.push({ kind: 'string', value: source.slice(index + 1, close) });
      index = close + 1;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
    if (name) {
      // The engine lexes `d` as an operator and digits separately, so `2d6` is
      // `2`, `d`, `6`; without this split the port would read one name `d6`.
      const diceSplit = /^d[0-9]+$/.exec(name[0]);
      if (diceSplit) {
        tokens.push({ kind: 'name', value: 'd' });
        tokens.push({ kind: 'number', value: Number(name[0].slice(1)), integer: true });
        index += name[0].length;
        continue;
      }
      tokens.push({ kind: 'name', value: name[0] });
      index += name[0].length;
      continue;
    }
    const operator = FORMULA_OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      tokens.push({ kind: 'operator', value: operator });
      index += operator.length;
      continue;
    }
    if (character === '(' || character === ')' || character === '[' || character === ']' || character === ',') {
      tokens.push({ kind: 'operator', value: character });
      index++;
      continue;
    }
    throw new Error(`unexpected character in WML formula: ${character}`);
  }
  return tokens;
}

const COMPARISONS = new Set(['=', '!=', '<', '<=', '>', '>=']);

/** Precedence and associativity of the WFL operators the campaigns use. */
class FormulaParser {
  private index = 0;
  private readonly tokens: readonly Token[];
  private readonly scope: WmlValueScope;
  constructor(tokens: readonly Token[], scope: WmlValueScope) {
    this.tokens = tokens;
    this.scope = scope;
  }

  expression(): WmlValue {
    // WFL gives `not` the lowest precedence, so it wraps the whole expression that follows;
    // `a and not b` is not valid WFL (write `a and (not b)`). `where` binds next loosest.
    if (this.consumeName('not')) return !truthy(this.expression());
    return this.where();
  }

  atEnd(): boolean {
    return this.index >= this.tokens.length;
  }

  rest(): string {
    return this.tokens.slice(this.index).map((token) => (token.kind === 'name' ? token.value : String(token.value))).join(' ');
  }

  private disjunction(): WmlValue {
    let left = this.conjunction();
    while (this.consumeName('or')) left = truthy(left) || truthy(this.conjunction());
    return left;
  }

  /**
   * `body where name=expr, ...` (`src/formula/formula.cpp:789-858`): each clause
   * is evaluated in the outer scope (clauses cannot see each other) and the body
   * reads them first, falling back to the outer scope.
   */
  private where(): WmlValue {
    const start = this.index;
    // The body is everything up to a depth-0 `where`; a comma ends the search
    // because this call parses one argument or list item, not a clause list.
    let depth = 0;
    let split = -1;
    for (let i = start; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (token.kind === 'operator' && (token.value === '(' || token.value === '[')) depth++;
      else if (token.kind === 'operator' && (token.value === ')' || token.value === ']')) depth--;
      else if (depth === 0 && token.kind === 'operator' && token.value === ',') break;
      else if (depth === 0 && token.kind === 'name' && token.value === 'where') { split = i; break; }
    }
    if (split < 0) return this.disjunction();
    const outer = this.scope;
    const bodyTokens = this.tokens.slice(start, split);
    this.index = split + 1;
    const bound = new Map<string, WmlValue>();
    for (;;) {
      const name = this.tokens[this.index];
      if (!name || name.kind !== 'name') throw new Error('expected "where name=<expression>" in WML formula');
      this.index++;
      this.expectOperator('=');
      bound.set(name.value, this.disjunction());
      if (!this.consumeOperator(',')) break;
    }
    const extended: WmlValueScope = (path) => (bound.has(path) ? bound.get(path) : outer(path));
    const body = new FormulaParser(bodyTokens, extended);
    const value = body.expression();
    if (!body.atEnd()) throw new Error(`unexpected token in WML formula: ${body.rest()}`);
    return value;
  }

  private conjunction(): WmlValue {
    let left = this.comparison();
    while (this.consumeName('and')) left = truthy(left) && truthy(this.comparison());
    return left;
  }

  private comparison(): WmlValue {
    let left = this.tilde();
    for (;;) {
      const operator = this.peekOperator();
      if (operator !== undefined && COMPARISONS.has(operator)) {
        this.index++;
        const right = this.tilde();
        if (operator === '=') left = equalValues(left, right);
        else if (operator === '!=') left = !equalValues(left, right);
        else left = orderValues(left, right, operator);
        continue;
      }
      // `in` lives at comparison precedence (`formula.cpp:1069`).
      if (this.peekName() === 'in') {
        this.index++;
        left = inValues(left, this.tilde());
        continue;
      }
      return left;
    }
  }

  /** `a~b`: the integer range builder (`variant.cpp:648`, `1~3` is `[1, 2, 3]`). */
  private tilde(): WmlValue {
    let left = this.additive();
    while (this.peekOperator() === '~') {
      this.index++;
      left = rangeValues(left, this.additive());
    }
    return left;
  }

  private additive(): WmlValue {
    let left = this.multiplicative();
    for (;;) {
      const operator = this.peekOperator();
      if (operator === '.+') { this.index++; left = elementWise(left, this.multiplicative(), addValues); continue; }
      if (operator === '.-') { this.index++; left = elementWise(left, this.multiplicative(), subtractValues); continue; }
      // `..` concatenates lists or strings (`variant.cpp:635`); the range builder is `~`.
      if (operator === '..') { this.index++; left = concatenateValues(left, this.multiplicative()); continue; }
      if (operator !== '+' && operator !== '-') return left;
      this.index++;
      const right = this.multiplicative();
      left = operator === '+' ? addValues(left, right) : subtractValues(left, right);
    }
  }

  private multiplicative(): WmlValue {
    let left = this.modulo();
    for (;;) {
      const operator = this.peekOperator();
      if (operator === '.*') { this.index++; left = elementWise(left, this.modulo(), (a, b) => multiplyValues('*', a, b)); continue; }
      if (operator === './') { this.index++; left = elementWise(left, this.modulo(), (a, b) => multiplyValues('/', a, b)); continue; }
      if (operator !== '*' && operator !== '/') return left;
      this.index++;
      const right = this.modulo();
      left = multiplyValues(operator, left, right);
    }
  }

  private modulo(): WmlValue {
    let left = this.power();
    while (this.peekOperator() === '%') {
      this.index++;
      left = moduloValues(left, this.power());
    }
    return left;
  }

  private power(): WmlValue {
    const left = this.dice();
    if (this.peekOperator() === '^') {
      this.index++;
      return powerValues(left, this.power());
    }
    return left;
  }

  /**
   * `rolls d faces` (`formula.cpp:762-778`): the engine draws from its synced
   * RNG; the port rolls with `Math.random` (see the module header).
   */
  private dice(): WmlValue {
    let left = this.unary();
    while (this.peekName() === 'd' && this.startsUnary(1)) {
      this.index++;
      left = diceValues(left, this.unary());
    }
    return left;
  }

  private unary(): WmlValue {
    if (this.consumeOperator('-')) return negate(this.unary());
    if (this.consumeOperator('+')) return this.unary();
    return this.postfix();
  }

  private postfix(): WmlValue {
    let value = this.primary();
    for (;;) {
      if (this.peekOperator() === '.') {
        this.index++;
        const field = this.tokens[this.index++];
        if (!field || field.kind !== 'name') throw new Error('expected a field name after "." in WML formula');
        value = memberValue(value, field.value);
        continue;
      }
      if (this.peekOperator() === '[') {
        this.index++;
        const key = this.expression();
        this.expectOperator(']');
        value = indexValue(value, key);
        continue;
      }
      return value;
    }
  }

  private primary(): WmlValue {
    const token = this.tokens[this.index];
    if (!token) throw new Error('unexpected end of WML formula');
    if (token.kind === 'number') { this.index++; return token.value; }
    if (token.kind === 'string') { this.index++; return token.value; }
    if (token.kind === 'name') {
      if (this.peekOperatorAt(1) === '(') return this.call(token.value);
      this.index++;
      const value = this.scope(token.value);
      if (value === undefined) throw new Error(`unknown variable ${token.value} in WML formula`);
      return value;
    }
    if (token.value === '(') {
      this.index++;
      const value = this.expression();
      this.expectOperator(')');
      return value;
    }
    if (token.value === '[') {
      this.index++;
      const items: WmlValue[] = [];
      if (this.peekOperator() !== ']') {
        items.push(this.expression());
        while (this.consumeOperator(',')) items.push(this.expression());
      }
      this.expectOperator(']');
      return items;
    }
    throw new Error(`unexpected token in WML formula: ${String(token.value)}`);
  }

  private call(name: string): WmlValue {
    this.index += 2;
    const args: WmlValue[] = [];
    if (this.peekOperator() !== ')') {
      args.push(this.expression());
      while (this.consumeOperator(',')) args.push(this.expression());
    }
    this.expectOperator(')');
    return callFunction(name, args);
  }

  private peekOperator(): string | undefined {
    return this.peekOperatorAt(0);
  }

  private peekOperatorAt(offset: number): string | undefined {
    const token = this.tokens[this.index + offset];
    return token?.kind === 'operator' ? token.value : undefined;
  }

  private peekName(): string | undefined {
    const token = this.tokens[this.index];
    return token?.kind === 'name' ? token.value : undefined;
  }

  /** Whether the token at `index + offset` can start a unary expression. */
  private startsUnary(offset: number): boolean {
    const token = this.tokens[this.index + offset];
    if (!token) return false;
    if (token.kind === 'number' || token.kind === 'string' || token.kind === 'name') return true;
    return token.kind === 'operator' && (token.value === '(' || token.value === '[' || token.value === '+' || token.value === '-');
  }

  private consumeOperator(value: string): boolean {
    if (this.peekOperator() !== value) return false;
    this.index++;
    return true;
  }

  private expectOperator(value: string): void {
    if (!this.consumeOperator(value)) throw new Error(`expected "${value}" in WML formula`);
  }

  private consumeName(value: string): boolean {
    const token = this.tokens[this.index];
    if (token?.kind !== 'name' || token.value !== value) return false;
    this.index++;
    return true;
  }
}

function callFunction(name: string, args: readonly WmlValue[]): WmlValue {
  switch (name) {
    case 'abs': return Math.abs(number(args[0]));
    case 'min': return reduceList(args, Math.min);
    case 'max': return reduceList(args, Math.max);
    case 'floor': return Math.floor(number(args[0]));
    case 'ceil': return Math.ceil(number(args[0]));
    case 'round': {
      const value = number(args[0]);
      return value < 0 ? -Math.round(-value) : Math.round(value);
    }
    case 'trunc': return Math.trunc(number(args[0]));
    case 'sqrt': return Math.sqrt(number(args[0]));
    case 'sum': return args.flat().reduce<number>((total, value) => total + number(value), 0);
    case 'size':
    case 'length': return lengthOf(args[0]);
    case 'if': return truthy(args[0]) ? args[1] : args[2] ?? '';
    case 'debug':
    case 'debug_print': return args[args.length - 1] ?? '';
    case 'string_length': return String(args[0] ?? '').length;
    default: throw new Error(`unknown function ${name} in WML formula`);
  }
}

/** `min`/`max` accept either one list or several scalars, each list contributing its extreme. */
function reduceList(args: readonly WmlValue[], pick: (a: number, b: number) => number): number {
  const values = args.flatMap((argument) => (Array.isArray(argument) ? argument.map(number) : [number(argument)]));
  if (!values.length) throw new Error('min/max of an empty WML formula list');
  return values.reduce((accumulator, value) => pick(accumulator, value));
}

function number(value: WmlValue | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function truthy(value: WmlValue): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return /^(yes|true)$/i.test(value);
  return value.length > 0;
}

function lengthOf(value: WmlValue | undefined): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return value.length;
  return 0;
}

function memberValue(value: WmlValue, field: string): WmlValue {
  if (field === 'length' || field === 'size') return lengthOf(value);
  throw new Error(`unknown WML formula member ".${field}"`);
}

function indexValue(value: WmlValue, key: WmlValue): WmlValue {
  if (Array.isArray(value)) {
    const index = Math.trunc(number(key));
    const item = value[index < 0 ? value.length + index : index];
    if (item === undefined) throw new Error('WML formula list index out of range');
    return item;
  }
  if (typeof value === 'string') return value[Math.trunc(number(key))] ?? '';
  throw new Error('cannot index a non-list in a WML formula');
}

function addValues(left: WmlValue, right: WmlValue): WmlValue {
  if (typeof left === 'string' || typeof right === 'string') return valueToString(left) + valueToString(right);
  if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
  return decimalAware(left, right, (a, b) => a + b);
}

function subtractValues(left: WmlValue, right: WmlValue): WmlValue {
  return decimalAware(left, right, (a, b) => a - b);
}

function multiplyValues(operator: string, left: WmlValue, right: WmlValue): WmlValue {
  if (operator === '/') {
    const denominator = number(right);
    if (denominator === 0) throw new Error('division by zero in WML formula');
    const exact = decimalAware(left, right, (a, b) => a / b);
    if (typeof left === 'number' && typeof right === 'number' && Number.isInteger(left) && Number.isInteger(right)) {
      return Math.trunc(left / right);
    }
    return exact;
  }
  return Number.isInteger(number(left)) && Number.isInteger(number(right))
    ? number(left) * number(right)
    : decimalAware(left, right, (a, b) => round(a * b));
}

function moduloValues(left: WmlValue, right: WmlValue): WmlValue {
  const denominator = number(right);
  if (denominator === 0) throw new Error('division by zero in WML formula');
  return number(left) % denominator;
}

function powerValues(left: WmlValue, right: WmlValue): WmlValue {
  if (Number.isInteger(number(left)) && Number.isInteger(number(right))) {
    return Math.round(Math.pow(number(left), number(right)));
  }
  return round(Math.pow(number(left), number(right)));
}

function negate(value: WmlValue): WmlValue {
  return -number(value);
}

/** WFL keeps integers integral and rounds every decimal result to three digits. */
function decimalAware(left: WmlValue, right: WmlValue, combine: (a: number, b: number) => number): number {
  const integral = Number.isInteger(number(left)) && Number.isInteger(number(right));
  return integral ? combine(number(left), number(right)) : round(combine(number(left), number(right)));
}

function round(value: number): number {
  return Math.round(value * DECIMAL_SCALE) / DECIMAL_SCALE;
}

function rangeValues(left: WmlValue, right: WmlValue): WmlValue {
  const from = strictInt(left);
  const to = strictInt(right);
  const items: number[] = [];
  const step = from <= to ? 1 : -1;
  for (let value = from; step > 0 ? value <= to : value >= to; value += step) items.push(value);
  return items;
}

/** Range and dice bounds read numbers the way variables store them, rejecting garbage. */
function strictInt(value: WmlValue): number {
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  throw new Error('an integer bound is needed in a WML formula');
}

/** `..` concatenates two lists or two strings; anything else is a type error. */
function concatenateValues(left: WmlValue, right: WmlValue): WmlValue {
  if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
  if (typeof left === 'string' && typeof right === 'string') return left + right;
  throw new Error('.. concatenates two lists or two strings in a WML formula');
}

/** `left in right`: membership in a list; anything else is a type error. */
function inValues(left: WmlValue, right: WmlValue): boolean {
  if (Array.isArray(right)) return right.some((item) => equalValues(item, left));
  throw new Error('in tests membership in a list in a WML formula');
}

/** `.+`/`.-`/`.*`/`./`: pair-wise combine two equal-length lists. */
function elementWise(left: WmlValue, right: WmlValue, combine: (a: WmlValue, b: WmlValue) => WmlValue): WmlValue {
  if (!Array.isArray(left) || !Array.isArray(right)) throw new Error('element-wise operators need two lists in a WML formula');
  if (left.length !== right.length) throw new Error('element-wise operators need two lists of the same length in a WML formula');
  return left.map((item, index) => combine(item, right[index] as WmlValue));
}

/** `rolls d faces`: no rolls or no faces rolls nothing, like the engine's loop. */
function diceValues(left: WmlValue, right: WmlValue): number {
  const rolls = Math.trunc(number(left));
  const faces = Math.trunc(number(right));
  let total = 0;
  for (let roll = 0; roll < rolls && faces > 0; roll++) total += 1 + Math.floor(Math.random() * faces);
  return total;
}

function equalValues(left: WmlValue, right: WmlValue): boolean {
  if (typeof left === 'number' && typeof right === 'number') return left === right;
  if (Array.isArray(left) || Array.isArray(right)) return formulaToString(left) === formulaToString(right);
  if (typeof left === typeof right) return left === right;
  const leftNumber = number(left);
  const rightNumber = number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber === rightNumber;
  return formulaToString(left) === formulaToString(right);
}

function orderValues(left: WmlValue, right: WmlValue, operator: string): boolean {
  const a = typeof left === 'string' && typeof right === 'string' ? left : number(left);
  const b = typeof left === 'string' && typeof right === 'string' ? right : number(right);
  if (operator === '<') return a < b;
  if (operator === '<=') return a <= b;
  if (operator === '>') return a > b;
  return a >= b;
}
