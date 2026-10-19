/**
 * Small, deterministic evaluator for the formula subset used by Wesnoth data.
 *
 * This intentionally has no `eval` and no game knowledge.  The caller supplies
 * values and functions (for example `unit_at` or `enemy_of`), which keeps the
 * evaluator usable in build tools, tests, and the simulation alike.
 */

export interface FormulaObject { [key: string]: FormulaValue; }
export type FormulaValue = number | string | boolean | null | undefined | FormulaObject;
export type FormulaFunction = (...args: FormulaValue[]) => FormulaValue;

export interface FormulaContext {
  readonly values?: Readonly<Record<string, FormulaValue>>;
  readonly functions?: Readonly<Record<string, FormulaFunction>>;
}

type Token = { kind: 'number' | 'string' | 'name' | 'operator' | 'eof'; value: string };

/** Evaluate a Wesnoth formula, returning its native value or a boolean result. */
export function evaluateFormula(source: string, context: FormulaContext = {}): FormulaValue {
  const where = /\bwhere\b/i.exec(source);
  const expression = where ? source.slice(0, where.index).trim() : source.trim();
  const bindings = where ? source.slice(where.index + where[0].length).trim() : '';
  const values: Record<string, FormulaValue> = { ...(context.values ?? {}) };
  if (bindings) {
    for (const binding of splitBindings(bindings)) {
      const equals = binding.indexOf('=');
      if (equals <= 0) throw new Error(`invalid formula binding: ${binding}`);
      const name = binding.slice(0, equals).trim();
      values[name] = evaluateFormula(binding.slice(equals + 1), { ...context, values });
    }
  }
  return new Parser(tokenize(expression), values, context.functions ?? {}).parse();
}

function splitBindings(source: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') depth -= 1;
    else if (source[i] === ',' && depth === 0) {
      result.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (source.slice(start).trim()) result.push(source.slice(start).trim());
  return result;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i += 1; continue; }
    const number = source.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (number) { tokens.push({ kind: 'number', value: number[0] }); i += number[0].length; continue; }
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i]; let value = ''; i += 1;
      while (i < source.length && source[i] !== quote) value += source[i++];
      if (source[i] !== quote) throw new Error('unterminated formula string');
      i += 1; tokens.push({ kind: 'string', value }); continue;
    }
    const name = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (name) { tokens.push({ kind: 'name', value: name[0] }); i += name[0].length; continue; }
    const operator = source.slice(i).match(/^(===|!==|==|!=|<=|>=|&&|\|\||[()+\-*/%<>!,])/);
    if (operator) { tokens.push({ kind: 'operator', value: operator[0] }); i += operator[0].length; continue; }
    throw new Error(`unexpected formula character: ${source[i]}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];
  private readonly values: Record<string, FormulaValue>;
  private readonly functions: Readonly<Record<string, FormulaFunction>>;
  constructor(tokens: Token[], values: Record<string, FormulaValue>, functions: Readonly<Record<string, FormulaFunction>>) {
    this.tokens = tokens;
    this.values = values;
    this.functions = functions;
  }

  parse(): FormulaValue {
    const value = this.or();
    if (this.peek().kind !== 'eof') throw new Error(`unexpected formula token: ${this.peek().value}`);
    return value;
  }

  private or(): FormulaValue {
    let left = this.and();
    while (this.matchWord('or') || this.match('||')) left = truthy(left) || truthy(this.and());
    return left;
  }
  private and(): FormulaValue {
    let left = this.equality();
    while (this.matchWord('and') || this.match('&&')) left = truthy(left) && truthy(this.equality());
    return left;
  }
  private equality(): FormulaValue {
    let left = this.comparison();
    while (true) {
      if (this.match('==') || this.match('===')) left = left === this.comparison();
      else if (this.match('!=') || this.match('!==')) left = left !== this.comparison();
      else return left;
    }
  }
  private comparison(): FormulaValue {
    let left = this.term();
    while (true) {
      const op = this.peek().value;
      if (!['<', '<=', '>', '>='].includes(op)) return left;
      this.index += 1; const right = this.term();
      const a = numeric(left); const b = numeric(right);
      left = op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
    }
  }
  private term(): FormulaValue {
    let left = this.factor();
    while (this.peek().value === '+' || this.peek().value === '-') {
      const op = this.tokens[this.index++].value; const right = this.factor();
      left = op === '+' ? numeric(left) + numeric(right) : numeric(left) - numeric(right);
    }
    return left;
  }
  private factor(): FormulaValue {
    let left = this.unary();
    while (this.peek().value === '*' || this.peek().value === '/' || this.peek().value === '%') {
      const op = this.tokens[this.index++].value; const right = numeric(this.unary());
      left = op === '*' ? numeric(left) * right : op === '/' ? (right === 0 ? 0 : numeric(left) / right) : numeric(left) % right;
    }
    return left;
  }
  private unary(): FormulaValue {
    if (this.match('!') || this.matchWord('not')) return !truthy(this.unary());
    if (this.match('-')) return -numeric(this.unary());
    return this.primary();
  }
  private primary(): FormulaValue {
    const token = this.tokens[this.index++];
    if (token.kind === 'number') return Number(token.value);
    if (token.kind === 'string') return token.value;
    if (token.value === '(') { const result = this.or(); this.expect(')'); return result; }
    if (token.kind === 'name') {
      if (this.match('(')) {
        const args: FormulaValue[] = [];
        if (!this.match(')')) { do args.push(this.or()); while (this.match(',')); this.expect(')'); }
        const fn = this.functions[token.value];
        if (!fn) throw new Error(`unknown formula function: ${token.value}`);
        return fn(...args);
      }
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return resolvePath(this.values, token.value);
    }
    throw new Error(`expected formula value, got: ${token.value || '<eof>'}`);
  }
  private peek(): Token { return this.tokens[this.index]; }
  private match(value: string): boolean { if (this.peek().value !== value) return false; this.index += 1; return true; }
  private matchWord(value: string): boolean { if (this.peek().kind !== 'name' || this.peek().value !== value) return false; this.index += 1; return true; }
  private expect(value: string): void { if (!this.match(value)) throw new Error(`expected '${value}' in formula`); }
}

function resolvePath(values: Record<string, FormulaValue>, path: string): FormulaValue {
  const parts = path.split('.');
  let current: FormulaValue = values[parts.shift() ?? ''];
  for (const part of parts) current = current && typeof current === 'object' ? current[part] : undefined;
  return current;
}
function truthy(value: FormulaValue): boolean { return Boolean(value); }
function numeric(value: FormulaValue): number { const result = Number(value); return Number.isFinite(result) ? result : 0; }
