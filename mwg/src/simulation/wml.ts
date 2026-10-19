/**
 * A deliberately small WML (Wesnoth Markup Language) preprocessor and parser.
 *
 * Ported by hand from the behaviour of `src/serialization/preprocessor.cpp` and
 * `src/serialization/parser.cpp`, restricted to the subset the core-data pipeline
 * needs: `#define`/`#enddef` macros with `{ARG}` substitution, `{file.cfg}` and
 * `{dir}` includes, `#ifdef`/`#ifndef`/`#else`/`#endif`, `#textdomain` (ignored),
 * `_ "gettext"` markers (the `_` is stripped, translation itself is not ported),
 * and `[tag]`/`[/tag]` with line-based `key=value` attributes.
 *
 * Deliberately not handled (each case throws by name rather than guessing):
 * Unknown pragmas are ignored, as in the game preprocessor.
 * Macro calls whose macro is not defined expand to the empty string: this is how
 * animation/sound macros such as `{DEFENSE_ANIM_FILTERED ...}` are dropped
 * without the pipeline knowing about them. See PORT_COVERAGE.md.
 *
 * This module is build-time tooling: it reads files with node:fs and is never
 * imported by the browser bundle.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface WmlNode {
  tag: string;
  attributes: Record<string, string>;
  children: WmlNode[];
  /** attribute names whose raw value carried the `_ "..."` gettext marker */
  gettext?: string[];
  /** Position in the CFG file after preprocessing, used by MWL diagnostics. */
  location: WmlLocation;
  /** the source of a `[lua]` block's `code=` (kept opaque in `attributes`, read by the Lua kernel) */
  luaSource?: string;
}

export interface WmlLocation {
  file: string;
  line: number;
  column: number;
}

export interface WmlPreprocessorOptions {
  /** Directory that include specs such as `core/units` resolve against. */
  dataDir: string;
  /** Extra symbol names to treat as defined for `#ifdef` (campaign defines). */
  defines?: Iterable<string>;
  /** Called for every file the preprocessor opens. */
  onFile?: (path: string) => void;
}

interface WmlMacro {
  name: string;
  args: string[];
  /** `#arg NAME` optional parameters mapped to the default value before `#endarg`. */
  optional: Map<string, string>;
  body: string;
}

/**
 * Split `#arg NAME\n<default>\n#endarg` blocks out of a macro body. Wesnoth
 * stores each optional parameter with its default and never emits the block, so
 * a call that omits the parameter expands `{NAME}` to the default.
 */
function extractOptionalArgs(body: string): { optional: Map<string, string>; body: string } {
  const optional = new Map<string, string>();
  const cleaned = body.replace(/#arg[ \t]+([A-Za-z0-9_]+)[ \t]*\r?\n([\s\S]*?)#endarg/g, (_match, name: string, value: string) => {
    optional.set(name, value.trim());
    return '';
  });
  return { optional, body: cleaned };
}

const DIRECTIVES = new Set(['define', 'enddef', 'ifdef', 'ifndef', 'else', 'endif', 'textdomain', 'undef', 'pragma']);

/** Preprocess a WML file: expand includes and macros, return flat WML text. */
export function preprocessWmlFile(filePath: string, options: WmlPreprocessorOptions): string {
  return new PreprocessContext(options).expandFile(filePath);
}

/** Preprocess WML source text already held in memory (used by tests). */
export function preprocessWmlText(text: string, options: WmlPreprocessorOptions): string {
  return new PreprocessContext(options).expandText(text);
}

/**
 * Pre-scan files and register every `#define` they contain without emitting
 * anything. The data pipeline uses this to load the core macro files before
 * processing the files that call those macros.
 */
export function loadMacroDefinitions(paths: string[], options: WmlPreprocessorOptions): void {
  const ctx = new PreprocessContext(options);
  for (const filePath of paths) {
    ctx.scanDefinitions(ctx.read(filePath));
  }
}

/**
 * A shared preprocessor: macro definitions registered by `loadMacros` stay
 * visible to every later `preprocessFile`/`preprocessText` call, which is what
 * the data pipeline needs (core macro files loaded once, then terrain.cfg,
 * units.cfg, and the schedule all expand against the same macro table).
 */
export class WmlPreprocessor {
  private readonly ctx: PreprocessContext;

  constructor(options: WmlPreprocessorOptions) {
    this.ctx = new PreprocessContext(options);
  }

  loadMacros(paths: string[]): void {
    for (const filePath of paths) {
      this.ctx.scanDefinitions(this.ctx.read(filePath));
    }
  }

  preprocessFile(filePath: string): string {
    return this.ctx.expandFile(filePath);
  }

  preprocessText(text: string): string {
    return this.ctx.expandText(text);
  }
}

class PreprocessContext {
  private readonly macros = new Map<string, WmlMacro>();
  private readonly symbols: Set<string>;
  private readonly includeStack: string[] = [];
  private readonly onFile?: (path: string) => void;

  private readonly options: WmlPreprocessorOptions;

  constructor(options: WmlPreprocessorOptions) {
    this.options = options;
    this.symbols = new Set(options.defines ?? []);
    this.onFile = options.onFile;
  }

  read(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8');
  }

  /** Register every top-level `#define` in `text`; emits nothing. */
  scanDefinitions(text: string): void {
    let i = 0;
    while (i < text.length) {
      if (text[i] === '#' && isAtLineStart(text, i)) {
        const end = lineEnd(text, i);
        const line = text.slice(i, end).trim();
        // No space may separate `#` from `define` (see `parseDirective`).
        // A macro name may contain `/` (`Heir_To_The_Throne/utils/conditionals.cfg`
        // defines `#define /IF` to mirror the closing tag).
        const match = /^#define\s+([A-Za-z0-9_./:]+)((?:\s+[A-Za-z0-9_]+)*)\s*$/.exec(line);
        if (match) {
          const name = match[1];
          const declared = match[2].trim().split(/\s+/).filter(Boolean);
          const bodyStart = end + 1;
          const rawBody = this.readMacroBody(text, bodyStart);
          // `#arg NAME` declarations add optional parameters beyond the ones on
          // the #define line; the block's body is the default value, and a call
          // can override it with the `NAME=value` keyword syntax.
          const { optional, body } = extractOptionalArgs(rawBody);
          const args = [...declared, ...[...optional.keys()].filter((arg) => !declared.includes(arg))];
          this.macros.set(name, { name, args, optional, body });
          this.symbols.add(name);
          i = bodyStart + rawBody.length;
          continue;
        }
        const undef = /^#undef\s+([A-Za-z0-9_./:]+)\s*$/.exec(line);
        if (undef) {
          this.macros.delete(undef[1]);
          this.symbols.delete(undef[1]);
        }
        i = end + 1;
        continue;
      }
      i++;
    }
  }

  /** Find the `#enddef` closing a macro body; returns the body text. */
  private readMacroBody(text: string, from: number): string {
    let i = from;
    while (i < text.length) {
      if (text[i] === '"') {
        i = readQuoted(text, i)[1];
        continue;
      }
      if (text[i] === '#' && text.startsWith('#enddef', i)) {
        return text.slice(from, i);
      }
      i++;
    }
    throw new Error('missing #enddef');
  }

  expandFile(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (this.includeStack.includes(resolved)) {
      throw new Error(`circular WML include: ${this.includeStack.join(' -> ')} -> ${resolved}`);
    }
    this.includeStack.push(resolved);
    this.onFile?.(resolved);
    try {
      const text = this.read(resolved);
      this.scanDefinitions(text);
      return this.expandText(text);
    } finally {
      this.includeStack.pop();
    }
  }

  expandText(text: string): string {
    let out = '';
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        const [literal, next] = this.expandQuoted(text, i);
        out += literal;
        i = next;
      } else if (c === '#') {
        if (!isAtLineStart(text, i)) {
          // Mid-line comment: drop through end of line.
          i = lineEnd(text, i);
          continue;
        }
        const end = lineEnd(text, i);
        const line = text.slice(i, end).trim();
        const directive = parseDirective(line);
        if (directive) {
          if (directive.word === 'textdomain' || directive.word === 'pragma') {
            i = end + 1;
          } else if (directive.word === 'define') {
            i = this.handleDefine(text, line, end);
          } else if (directive.word === 'undef') {
            const undef = /^#undef\s+([A-Za-z0-9_./:]+)\s*$/.exec(line);
            if (!undef) throw new Error(`malformed #undef: ${line.trim()}`);
            this.macros.delete(undef[1]);
            this.symbols.delete(undef[1]);
            i = end + 1;
          } else if (directive.word === 'ifdef' || directive.word === 'ifndef') {
            const cond = this.symbols.has(directive.arg) === (directive.word === 'ifdef');
            const [child, next] = this.scanConditional(text, end + 1, cond);
            out += child;
            i = next;
          } else {
            throw new Error(`unexpected #${directive.word}`);
          }
        } else {
          i = end + 1; // plain #comment line
        }
      } else if (c === '{') {
        const close = findMatchingBrace(text, i);
        if (close === -1) throw new Error('unterminated { in WML text');
        out += this.expandCall(text.slice(i + 1, close).trim());
        i = close + 1;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  }

  /**
   * Expand a quoted literal, but still expand `{...}` calls inside it: the real
   * Wesnoth preprocessor is text-based and does not treat quotes as a barrier.
   */
  private expandQuoted(text: string, from: number): [string, number] {
    let out = '"';
    let i = from + 1;
    while (i < text.length) {
      if (text[i] === '"' && text[i + 1] === '"') {
        out += '""';
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        out += '"';
        return [out, i + 1];
      }
      if (text[i] === '{') {
        const close = findMatchingBrace(text, i);
        if (close === -1) throw new Error('unterminated { inside WML string');
        out += this.expandCall(text.slice(i + 1, close).trim());
        i = close + 1;
        continue;
      }
      out += text[i];
      i++;
    }
    throw new Error('unterminated string in WML text');
  }

  private handleDefine(text: string, line: string, end: number): number {
    const match = /^#\s*define\s+([A-Za-z0-9_./:]+)((?:\s+[A-Za-z0-9_]+)*)\s*$/.exec(line);
    if (!match) throw new Error(`malformed #define: ${line.trim()}`);
    const name = match[1];
    const declared = match[2].trim().split(/\s+/).filter(Boolean);
    const bodyStart = end + 1;
    const rawBody = this.readMacroBody(text, bodyStart);
    const { optional, body } = extractOptionalArgs(rawBody);
    const args = [...declared, ...[...optional.keys()].filter((arg) => !declared.includes(arg))];
    this.macros.set(name, { name, args, optional, body });
    this.symbols.add(name);
    // bodyStart + rawBody.length is the start of the #enddef line; skip that line too.
    return lineEnd(text, bodyStart + rawBody.length) + 1;
  }

  /**
   * Scan one conditional level, whose first branch is taken when `firstBranchCond`
   * is true. Returns [emittedText, indexAfterEndif]. Nested conditionals recurse;
   * the caller only appends the returned text when its own branch is taken.
   */
  private scanConditional(text: string, from: number, firstBranchCond: boolean): [string, number] {
    let out = '';
    let taking = firstBranchCond;
    let i = from;
    while (i < text.length) {
      if (text[i] === '#' && isAtLineStart(text, i)) {
        const end = lineEnd(text, i);
        const line = text.slice(i, end).trim();
        const directive = parseDirective(line);
        if (directive?.word === 'ifdef' || directive?.word === 'ifndef') {
          const cond = this.symbols.has(directive.arg) === (directive.word === 'ifdef');
          const [child, next] = this.scanConditional(text, end + 1, cond);
          if (taking) out += child;
          i = next;
          continue;
        }
        if (directive?.word === 'else') {
          taking = !firstBranchCond;
          i = end + 1;
          continue;
        }
        if (directive?.word === 'endif') {
          return [out, end + 1];
        }
        if (taking && !directive) out += `\n`;
        i = end + 1;
        continue;
      }
      if (taking) {
        if (text[i] === '"') {
          const [literal, next] = this.expandQuoted(text, i);
          out += literal;
          i = next;
        } else if (text[i] === '#' && !isAtLineStart(text, i)) {
          // Mid-line comment inside a taken branch: drop it through end of line,
          // the same as the top-level `expandText` loop. Without this, a value
          // like `type=fire # note` inside `#ifndef EASY` kept its comment and
          // failed the MWL `id` validation.
          i = lineEnd(text, i);
        } else if (text[i] === '{') {
          const close = findMatchingBrace(text, i);
          if (close === -1) throw new Error('unterminated { in WML conditional');
          out += this.expandCall(text.slice(i + 1, close).trim());
          i = close + 1;
        } else {
          out += text[i];
          i++;
        }
      } else {
        i++;
      }
    }
    throw new Error('missing #endif');
  }

  /** Expand a `{...}` call: an include, or a macro call with arguments. */
  private expandCall(call: string): string {
    if (call === '') return '';
    const parenthesizedCall = /^([A-Za-z0-9_.:]+)\(([\s\S]*)\)$/.test(call.trim());
    const [name, ...rawArgs] = splitMacroArgs(call);
    const macro = this.macros.get(name);
    if (macro) {
      // WML macro calls mix positional arguments and NAME=value keywords; a
      // keyword fills its named parameter, positionals fill the rest in order.
      const positional: string[] = [];
      const keywords = new Map<string, string>();
      for (const rawArg of rawArgs) {
        // Parentheses group one positional argument. Keep that fact before
        // unwrapping it, otherwise `(terrain=Qx*)` is mistaken for the
        // keyword `terrain=...` and shifts every later macro parameter.
        const grouped = rawArg.trim().startsWith('(') && rawArg.trim().endsWith(')');
        const arg = unwrapMacroArgument(rawArg);
        const eq = arg.indexOf('=');
        const keyword = eq > 0 ? arg.slice(0, eq) : '';
        // A keyword names a declared parameter. A grouped `NAME=value` is a
        // keyword only for a `#arg` optional parameter, whose spaces need the
        // grouping (`{LISAR_SIDE 5 (RECRUIT=Elite Heavy Infantryman)}`); for a
        // required parameter the parentheses mark it as a plain value, not a
        // keyword (`(terrain=Qx*)` fills its positional slot).
        const isKeyword = !parenthesizedCall && eq > 0 && !arg.startsWith('"')
          && (grouped ? macro.optional.has(keyword) : macro.args.includes(keyword) || macro.optional.has(keyword));
        if (isKeyword) {
          keywords.set(keyword, arg.slice(eq + 1));
        }
        // Keep the grouping of a parenthesized positional argument so a
        // substituted multi-word value stays one argument in a nested macro
        // call (`{ELF (Elvish Shyde) ...}` calls `{NAMED_NOTRAIT_UNIT 6
        // {TYPE} ...}`); `parseWmlValue` strips the grouping from the
        // attribute it finally lands in (Wesnoth carries this as a token).
        // Only a whitespace-separated run of plain words is regrouped (a
        // multi-word unit type like `Elvish Shyde`); a block of tags or a
        // nested macro call (`([goal]...)`, `({GOAL_LOCATION ...})`) must
        // substitute verbatim, because after expansion it becomes tag lines and
        // the inserted `(`/`)` would break tag matching.
        else if (grouped && /\s/.test(arg) && /^[A-Za-z0-9_ .:/-]+$/.test(arg)) positional.push(`(${arg})`);
        else positional.push(arg);
      }
      let body = macro.body;
      macro.args.forEach((param, index) => {
        // A keyword wins, then a positional, then the `#arg` default, then empty.
        const value = keywords.get(param) ?? positional[index] ?? macro.optional.get(param) ?? '';
        body = replaceParam(body, param, value);
      });
      return this.expandText(body);
    }
    // Not a defined macro: treat path-like tokens as includes (core data always
    // spells includes with a slash or a ~/@ prefix), and drop the rest - that is
    // how animation/sound macros this pipeline does not define disappear.
    // A leading `/` is part of a macro name (`/IF`), not an include path.
    if ((name.includes('/') && !name.startsWith('/')) || name.startsWith('~') || name.startsWith('@')) {
      return this.expandInclude(name);
    }
    return '';
  }

  private expandInclude(spec: string): string {
    // WML accepts both data-root includes (`core/macros`) and paths relative
    // to the file currently being expanded (`{about.cfg}` in campaigns).
    // Prefer the current file for the latter, then retain the historical
    // data-root lookup for Wesnoth's global include namespace.
    const relativeBase = this.includeStack.length ? path.resolve(path.dirname(this.includeStack[this.includeStack.length - 1]), spec) : null;
    const rootBase = path.resolve(this.options.dataDir, spec);
    const bases = relativeBase && (fs.existsSync(relativeBase) || fs.existsSync(`${relativeBase}.cfg`))
      ? [relativeBase, rootBase]
      : [rootBase, ...(relativeBase ? [relativeBase] : [])];
    const base = bases.find((candidate) => fs.existsSync(candidate) || fs.existsSync(`${candidate}.cfg`)) ?? rootBase;
    if (spec.endsWith('/') || (fs.existsSync(base) && fs.statSync(base).isDirectory())) {
      let out = '';
      const files = fs
        .readdirSync(base)
        .filter((name) => name.endsWith('.cfg'))
        .sort();
      for (const file of files) out += this.expandFile(path.join(base, file));
      return out;
    }
    const file = fs.existsSync(`${base}.cfg`) ? `${base}.cfg` : base;
    if (!fs.existsSync(file)) {
      throw new Error(`WML include not found: ${spec} (looked for ${bases.map((candidate) => `${candidate}.cfg and ${candidate}`).join('; ')})`);
    }
    return this.expandFile(file);
  }
}

function isAtLineStart(text: string, i: number): boolean {
  return i === 0 || text[i - 1] === '\n';
}

function lineEnd(text: string, from: number): number {
  const end = text.indexOf('\n', from);
  return end === -1 ? text.length : end;
}

function parseDirective(line: string): { word: string; arg: string } | null {
  if (!line.startsWith('#')) return null;
  // Wesnoth reads the directive name with `read_word()`, which does not skip a
  // leading space, so `# define resource here` is an ordinary comment while
  // `#define RESOURCE` is a directive. Trimming after the `#` used to make the
  // preprocessor read the comment's body and fail with `missing #enddef`.
  const rest = line.slice(1);
  const space = rest.search(/\s/);
  const word = space === -1 ? rest : rest.slice(0, space);
  if (!DIRECTIVES.has(word)) return null;
  const arg = space === -1 ? '' : rest.slice(space + 1).trim();
  return { word, arg };
}

/** Read a `"..."` literal, honouring the WML `""` escape, and return it with quotes. */
function readQuoted(text: string, from: number): [string, number] {
  let i = from + 1;
  let out = '"';
  while (i < text.length) {
    if (text[i] === '"' && text[i + 1] === '"') {
      out += '""';
      i += 2;
      continue;
    }
    if (text[i] === '"') {
      out += '"';
      return [out, i + 1];
    }
    out += text[i];
    i++;
  }
  throw new Error('unterminated string in WML text');
}

/** Find the `}` matching the `{` at `from`, honouring nested braces and strings. */
function findMatchingBrace(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '"') {
      i = readQuoted(text, i)[1] - 1;
      continue;
    }
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Parenthesized macro arguments are grouping syntax in WML, not literal text. */
function unwrapMacroArgument(value: string): string {
  const text = value.trim();
  return text.startsWith('(') && text.endsWith(')') ? text.slice(1, -1).trim() : text;
}

/**
 * Split the inside of a macro call into a name and arguments. Arguments are
 * separated by whitespace; a quoted string, a `{...}` group, or a `(...)` group
 * counts as one argument no matter how much whitespace it contains.
 */
function splitMacroArgs(call: string): string[] {
  // Wesnoth commonly writes one-argument macros as NAME( body ), especially
  // for filter wrappers. The outer parentheses belong to the call syntax, not
  // to the argument value; peel them before applying whitespace splitting.
  const parenthesized = /^([A-Za-z0-9_.:]+)\(([\s\S]*)\)$/.exec(call.trim());
  if (parenthesized) return [parenthesized[1], parenthesized[2].trim()];
  const parts: string[] = [];
  let current = '';
  let depthParen = 0;
  let depthBrace = 0;
  for (let i = 0; i < call.length; i++) {
    const c = call[i];
    if (c === '"') {
      const [literal, next] = readQuoted(call, i);
      current += literal;
      i = next - 1;
      continue;
    }
    if (c === '(') {
      // A `(` directly after a word ends the current argument and starts a
      // grouped one: `{EFFECT new_animation([...])}` passes `APPLY_TO=
      // new_animation` and the parenthesized body as `WML`. A `$(` formula or a
      // `~MOD(...)` image modifier keeps its parenthesis inside the value.
      const previous = current[current.length - 1] ?? '';
      if (depthParen === 0 && depthBrace === 0 && current !== '' && /[A-Za-z0-9_]/.test(previous)
        && !current.includes('~') && !current.includes('$')) {
        parts.push(current);
        current = '';
      }
      depthParen++;
    } else if (c === ')') depthParen--;
    else if (c === '{') depthBrace++;
    else if (c === '}') depthBrace--;
    if (/\s/.test(c) && depthParen === 0 && depthBrace === 0) {
      if (current !== '') {
        parts.push(current);
        current = '';
      }
    } else {
      current += c;
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

/** Replace `{PARAM}` occurrences of one macro parameter in a macro body. */
function replaceParam(body: string, param: string, value: string): string {
  // A parameter value may be a parenthesized group (`expandCall`). Wesnoth
  // carries that grouping as a token, so inside a nested `{...}` call the
  // parentheses must stay (`{ELF (Elvish Shyde) ...}` calls
  // `{NAMED_NOTRAIT_UNIT 6 {TYPE} ...}` and `TYPE` must stay one argument),
  // while in a plain attribute or tag position the inner text is what belongs
  // there (`type={TYPE}` is `type=Elvish Shyde`, not `type=(Elvish Shyde)`).
  const bare = value.startsWith('(') && value.endsWith(')') ? value.slice(1, -1).trim() : null;
  let out = '';
  let i = 0;
  let depth = 0;
  let inComment = false;
  while (i < body.length) {
    const c = body[i];
    if (inComment) {
      // A comment runs to end of line and is dropped later; a `{PARAM}` there
      // is prose, so substituting it would splice the value into text that is
      // about to disappear.
      if (c === '\n') inComment = false;
      out += c;
      i += 1;
      continue;
    }
    if (c === '#') {
      inComment = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '{') {
      const close = body.indexOf('}', i);
      if (close !== -1 && body.slice(i + 1, close) === param) {
        out += bare !== null && depth === 0 ? bare : value;
        i = close + 1;
        continue;
      }
      depth += 1;
      out += c;
      i += 1;
      continue;
    }
    if (c === '}') depth = Math.max(0, depth - 1);
    out += c;
    i += 1;
  }
  return out;
}

/** True when the whole string is wrapped in one balanced `(...)` pair. */
function wrappedInParens(value: string): boolean {
  if (!value.startsWith('(') || !value.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '(') depth += 1;
    else if (value[i] === ')') {
      depth -= 1;
      if (depth === 0 && i !== value.length - 1) return false;
    }
  }
  return depth === 0;
}

/**
 * A tag token anywhere in a line, for splitting inline tags. Wesnoth tolerates
 * whitespace inside the brackets (`[ /elseif]` appears in mainline HttT).
 */
const TAG_INLINE = /\[\s*[+/]?\s*[A-Za-z_][A-Za-z0-9_.:+]*\s*\]/;
const TAG_INLINE_GLOBAL = /\[\s*[+/]?\s*[A-Za-z_][A-Za-z0-9_.:+]*\s*\]/g;

/**
 * Parse flat (already preprocessed) WML text into a node tree.
 */
export function parseWml(text: string, file = '<wml>'): WmlNode[] {
  const root: WmlNode[] = [];
  const stack: WmlNode[] = [];
  // `[+tag]` insertions (used by animation macros this port drops) open a tag
  // that merges into the previous one; the pipeline skips their whole block.
  const skipped: string[] = [];
  let rawBlock: WmlNode | null = null;
  let rawBlockText = '';
  // A preprocessed line may hold more than one tag: a macro used mid-line
  // expands to a tag on that line (`[redraw][/redraw] {DELAY 150}` becomes
  // `[redraw][/redraw] [delay]`). Split it into one tag per line so the
  // single-tag branches below handle it. An assignment whose value holds a `[`
  // (`text="...[...]..."`) keeps its whole line, because the text before the
  // first `[` carries the `=`.
  const logical = logicalWmlLines(text).flatMap((entry) => {
    const line = entry.rawLine.trim();
    if (line === '' || line.startsWith('#')) return [entry];
    const firstTag = TAG_INLINE.exec(line);
    if (!firstTag || line.slice(0, firstTag.index).includes('=')) return [entry];
    const parts: { rawLine: string; lineIndex: number }[] = [];
    TAG_INLINE_GLOBAL.lastIndex = 0;
    let index = 0;
    let match: RegExpExecArray | null;
    while ((match = TAG_INLINE_GLOBAL.exec(line))) {
      const before = line.slice(index, match.index).trim();
      if (before) parts.push({ rawLine: before, lineIndex: entry.lineIndex });
      parts.push({ rawLine: match[0], lineIndex: entry.lineIndex });
      index = match.index + match[0].length;
    }
    const after = line.slice(index).trim();
    if (after) parts.push({ rawLine: after, lineIndex: entry.lineIndex });
    return parts;
  });
  for (const { rawLine, lineIndex } of logical) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const source = { file, line: lineIndex + 1, column: Math.max(1, rawLine.indexOf(line) + 1) };
    // `[lua]` holds arbitrary Lua, where `[loc_i]` is an index, not a WML tag.
    // Consume its body verbatim until the closing tag.
    if (rawBlock !== null) {
      if (/^\[\s*\/\s*lua\s*\]$/.test(line)) {
        // Lua blocks use WML's heredoc syntax (`code=<< ... >>`). They are
        // intentionally kept opaque to the WML parser, but the scenario
        // converter still needs the code attribute for pure predicates.
        // The Lua kernel needs every block's source and its `[args]`, wherever it sits.
        const heredoc = /(?:^|\n)\s*code\s*=\s*<<([\s\S]*?)>>/.exec(rawBlockText);
        const inline = heredoc ? null : /(?:^|\n)\s*code\s*=\s*(.*?)(?:\n|$)/.exec(rawBlockText);
        if (heredoc) rawBlock.luaSource = heredoc[1].trim();
        else if (inline) rawBlock.luaSource = parseWmlValue(inline[1].trim());
        const argsText = rawBlockText.replace(heredoc?.[0] ?? inline?.[0] ?? '', '\n');
        if (/\[\s*args\s*\]/.test(argsText)) rawBlock.children.push(...parseWml(argsText, file));
        const parentTag = stack.length > 1 ? stack[stack.length - 2].tag : '';
        if (parentTag === 'filter_condition' || parentTag === 'if' || parentTag === 'and' || parentTag === 'or' || parentTag === 'not') {
          if (rawBlock.luaSource !== undefined) rawBlock.attributes.code = rawBlock.luaSource;
        }
        rawBlock = null;
        rawBlockText = '';
        stack.pop();
      } else {
        rawBlockText += `${line}\n`;
      }
      continue;
    }
    if (/^\[\s*lua\s*\]$/.test(line)) {
      const node: WmlNode = { tag: 'lua', attributes: {}, children: [], gettext: [], location: source };
      if (stack.length === 0) root.push(node);
      else stack[stack.length - 1].children.push(node);
      stack.push(node);
      rawBlock = node;
      rawBlockText = '';
      continue;
    }
    const insertion = /^\[\s*\+\s*([A-Za-z0-9_.:+]+)\s*\]$/.exec(line);
    if (insertion) {
      const siblings = stack.length === 0 ? root : stack[stack.length - 1].children;
      const target = [...siblings].reverse().find((candidate) => candidate.tag === insertion[1]);
      if (target) stack.push(target);
      else skipped.push(insertion[1]);
      continue;
    }
    if (skipped.length > 0) {
      const closeInsertion = /^\[\s*\/\s*([A-Za-z0-9_.:+]+)\s*\]$/.exec(line);
      if (closeInsertion) {
        const top = skipped[skipped.length - 1];
        if (top === '*' || closeInsertion[1] === top) skipped.pop();
        continue;
      }
      if (closeInsertion) continue;
      if (!/^\[/.test(line)) continue; // attributes inside a skipped insertion
      // Nested ordinary tags inside an insertion are skipped by depth counting
      // below; treat any opening tag as another level of skipping.
      if (/^\[\s*\+?\s*[A-Za-z0-9_.:+]+\s*\]$/.test(line)) skipped.push('*');
      continue;
    }
    const open = /^\[\s*([A-Za-z0-9_.:+]+)\s*\]$/.exec(line);
    if (open) {
      const node: WmlNode = { tag: open[1], attributes: {}, children: [], gettext: [], location: source };
      if (stack.length === 0) root.push(node);
      else stack[stack.length - 1].children.push(node);
      stack.push(node);
      continue;
    }
    const close = /^\[\s*\/\s*([A-Za-z0-9_.:+]+)\s*\]$/.exec(line);
    if (close) {
      const node = stack.pop();
      if (!node || node.tag !== close[1]) {
        throw new Error(`${file}:${lineIndex + 1}: mismatched closing tag [/ ${close[1]}] (top of stack: ${node?.tag ?? 'empty'})`);
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1 || stack.length === 0) continue;
    const rawKey = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();
    const target = stack[stack.length - 1];
    // WML `x,y=5,3` assigns each name/value pair: the parser's `parse_variable`
    // splits the names on commas and advances one name per value comma. A single
    // name keeps the value intact, commas and all.
    const keys = rawKey.includes(',') ? rawKey.split(',').map((name) => name.trim()).filter(Boolean) : [rawKey];
    const values = keys.length > 1 ? splitWmlValueList(rawValue, keys.length) : [rawValue];
    (keys.length ? keys : [rawKey]).forEach((key, index) => {
      const value = values[index] ?? '';
      // Keep the marker so a `.cfg` -> `.mwl` conversion can re-emit `_ "..."`.
      if (isWmlGettext(value)) target.gettext?.push(key);
      target.attributes[key] = parseWmlValue(value);
    });
  }
  if (stack.length !== 0) {
    throw new Error(`unclosed WML tag [${stack[stack.length - 1].tag}]`);
  }
  return root;
}

/**
 * WML attributes may contain a quoted value spanning physical lines. Keep
 * those lines together before parsing tags and assignments. This is needed by
 * campaign diary/story text and mirrors the parser's string handling, while
 * preserving the physical line on which the assignment began for diagnostics.
 */
function logicalWmlLines(text: string): { rawLine: string; lineIndex: number }[] {
  const physical = text.split('\n');
  const result: { rawLine: string; lineIndex: number }[] = [];
  for (let index = 0; index < physical.length; index++) {
    let rawLine = physical[index];
    const trimmed = rawLine.trim();
    if (trimmed.includes('=') && hasUnclosedWmlQuote(rawLine)) {
      while (++index < physical.length) {
        rawLine += `\n${physical[index]}`;
        if (!hasUnclosedWmlQuote(rawLine)) break;
      }
    }
    result.push({ rawLine, lineIndex: index - (rawLine.match(/\n/g)?.length ?? 0) });
  }
  return result;
}

function hasUnclosedWmlQuote(value: string): boolean {
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '"') continue;
    if (value[index + 1] === '"') {
      index++;
      continue;
    }
    quoted = !quoted;
  }
  return quoted;
}

/** Whether a raw WML attribute value carries the `_ "..."` gettext marker. */
export function isWmlGettext(raw: string): boolean {
  return /^_\s*"/.test(raw.trim());
}

/** Parse one attribute value: quoted string (stripping `_` gettext marker), or raw text. */
export function parseWmlValue(raw: string): string {
  let value = raw.trim();
  const gettext = /^_\s*"/.exec(value);
  if (gettext) value = value.slice(gettext[0].length - 1);
  // Parentheses wrapping the whole value are WML grouping syntax, not literal
  // text (`unwrapMacroArgument`); a macro argument kept grouped by
  // `replaceParam` reaches the attribute as `(Elvish Shyde)`.
  if (wrappedInParens(value)) value = value.slice(1, -1).trim();
  return readWmlScalar(value);
}

/**
 * Split the value list of a multi-name WML assignment (`x,y=5,3`). Commas
 * inside a quoted string are not separators, and once the declared names run
 * out the remaining commas stay in the last value, matching the parser's
 * `parse_variable`.
 */
function splitWmlValueList(value: string, count: number): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        current += '""';
        index += 1;
        continue;
      }
      quoted = !quoted;
      current += character;
      continue;
    }
    if (character === ',' && !quoted) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current.trim());
  while (parts.length > count) {
    const extra = parts.pop()!;
    parts[parts.length - 1] = `${parts[parts.length - 1]},${extra}`;
  }
  return parts;
}

/**
 * Wesnoth reads an attribute value as a sequence of quoted and unquoted
 * segments joined by the `+` concatenation operator (the tokenizer returns a
 * `QSTRING` without its delimiters and the parser appends the next token), so
 * `"portraits/x.webp"~SCALE(93,93)` is the image `portraits/x.webp` with a
 * modifier, and `_ "a" + "b"` is `ab`. A value with no quote and no `+` is
 * returned unchanged, which keeps paths, modifier chains and `1-5,8` ranges
 * intact.
 */
function readWmlScalar(value: string): string {
  if (!value.includes('"') && !value.includes('+')) return value.trim();
  let out = '';
  // Whitespace is held back so the spaces around a `+` operator can be dropped.
  let pending = '';
  let i = 0;
  let afterQuote = false;
  const nextNonSpace = (from: number): string => {
    let j = from;
    while (j < value.length && /\s/.test(value[j])) j++;
    return value[j] ?? '';
  };
  while (i < value.length) {
    const c = value[i];
    if (c === '"') {
      out += pending;
      pending = '';
      i++;
      while (i < value.length) {
        if (value[i] === '"') {
          if (value[i + 1] === '"') {
            out += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        out += value[i++];
      }
      afterQuote = true;
      continue;
    }
    if (/\s/.test(c)) {
      pending += c;
      i++;
      continue;
    }
    // A `+` is concatenation when it follows a quoted segment or leads into
    // one; `a+b` with no quotes stays a literal plus.
    if (c === '+' && (afterQuote || nextNonSpace(i + 1) === '"')) {
      pending = '';
      i++;
      while (i < value.length && /\s/.test(value[i])) i++;
      afterQuote = false;
      continue;
    }
    out += pending + c;
    pending = '';
    afterQuote = false;
    i++;
  }
  return out.trim();
}
