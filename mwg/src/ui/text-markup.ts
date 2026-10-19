/**
 * Wesnoth inline markup, adapted onto MWG's renderer-neutral markup contract.
 *
 * The port keeps the Wesnoth side: `$variable`/`${variable}` substitution (including dotted
 * paths) and the tag names Wesnoth content is written with. MWG owns the tokenizer
 * (`parseMarkup`), the post-styling line layout (`layoutMarkupLines`) and the accessibility
 * projection (`markupAccessibilityText`). This module only maps Wesnoth's tags onto the tags
 * MWG knows, then turns the resulting spans back into Pixi rich text.
 */
import {
  layoutMarkupLines,
  markupAccessibilityText,
  parseMarkup,
  type MarkupLine,
  type MarkupMeasure,
  type MarkupSpan,
} from 'mwg/two-d/ui';

/** Named colours Wesnoth's markup accepts, matching its default palette. */
const COLORS: Record<string, number> = {
  red: 0xff7777,
  green: 0x8ee27a,
  blue: 0x78b7ff,
  yellow: 0xf0d27a,
  white: 0xf4edd9,
  gray: 0x9a927f,
  black: 0x1a1a1a,
  orange: 0xffb347,
  purple: 0xc586ff,
};

/** Tags whose text should stay but whose markup Pixi cannot style. */
const STRIPPED_TAGS = 'u|ref|jump|format';

export interface WesnothMarkup {
  readonly text: string;
  readonly tagStyles: Record<string, { fill?: number; fontWeight?: 'bold'; fontStyle?: 'italic'; fontSize?: number }>;
}

type Variables = Record<string, unknown>;

function lookupVariable(variables: Variables, path: string): string | undefined {
  let value: unknown = variables;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object' || !(part in (value as Variables))) return undefined;
    value = (value as Variables)[part];
  }
  if (value === undefined || value === null) return undefined;
  return String(value);
}

/**
 * Replace `$name` and `${name}` with the scenario variable of that name. An unknown variable is
 * left as written, so a message never loses text silently (MWG's own policy for unset names).
 */
export function substituteVariables(input: string, variables: Variables = {}): string {
  return input.replace(/\$\{([A-Za-z0-9_.]+)\}|\$([A-Za-z_][A-Za-z0-9_.]*)/g, (whole, braced: string | undefined, bare: string | undefined) => {
    const value = lookupVariable(variables, braced ?? bare ?? '');
    return value ?? whole;
  });
}

/** Wesnoth tags MWG has no spelling for, rewritten into MWG's known tag set. */
function toMwgMarkup(input: string): string {
  return input
    .replace(/<small>/gi, "<span size='12'>")
    .replace(/<\/small>/gi, '</span>')
    .replace(/<big>/gi, "<span size='18'>")
    .replace(/<\/big>/gi, '</span>')
    .replace(new RegExp(`</?(?:${STRIPPED_TAGS})\\b[^>]*>`, 'gi'), '');
}

/** Parse Wesnoth markup + variables into MWG's renderer-neutral spans. */
export function wesnothToSpans(input: string, variables: Variables = {}): MarkupSpan[] {
  return parseMarkup(toMwgMarkup(substituteVariables(input, variables)));
}

function baseTagStyles(): WesnothMarkup['tagStyles'] {
  return {
    b: { fontWeight: 'bold' },
    i: { fontStyle: 'italic' },
    small: { fontSize: 12 },
    big: { fontSize: 18 },
  };
}

function tagsFor(span: MarkupSpan, tagStyles: WesnothMarkup['tagStyles']): string[] {
  const tags: string[] = [];
  if (span.bold) tags.push('b');
  if (span.italic) tags.push('i');
  if (span.size !== undefined) {
    if (span.size === 12) tags.push('small');
    else if (span.size === 18) tags.push('big');
    else {
      const tag = `size_${span.size}`;
      tagStyles[tag] = { fontSize: span.size };
      tags.push(tag);
    }
  }
  if (span.color) {
    const key = span.color.toLowerCase().replace(/^#/, '');
    const color = /^[0-9a-f]{6}$/i.test(key) ? Number.parseInt(key, 16) : COLORS[key];
    if (color !== undefined && Number.isFinite(color)) {
      const tag = `color_${key}`;
      tagStyles[tag] = { fill: color };
      tags.push(tag);
    }
  }
  return tags;
}

/** Turn spans into Pixi rich text, reusing `tagStyles` across multiple lines when given. */
function spansToPixi(spans: readonly MarkupSpan[], tagStyles: WesnothMarkup['tagStyles'] = baseTagStyles()): WesnothMarkup {
  let text = '';
  for (const span of spans) {
    // Pixi rich text has no inline image; keep the position the image occupied rather than
    // dropping it, so a message with an icon does not silently lose a word.
    if (span.image !== undefined) {
      text += '[image]';
      continue;
    }
    let piece = span.text;
    for (const tag of tagsFor(span, tagStyles)) piece = `<${tag}>${piece}</${tag}>`;
    text += piece;
  }
  return { text, tagStyles };
}

/** Convert Wesnoth markup to Pixi rich text, for a `Text` style's `tagStyles`. */
export function wesnothMarkup(input: string, variables: Variables = {}): WesnothMarkup {
  return spansToPixi(wesnothToSpans(input, variables));
}

/**
 * Wrap Wesnoth markup into lines measured after styling (MWG's `layoutMarkupLines`), then
 * serialize every line back to Pixi rich text joined by newlines. `measure` should be a canvas
 * text metric; a plain character count is enough in a test.
 */
export function wrapWesnothMarkup(
  input: string,
  variables: Variables,
  measure: MarkupMeasure,
  maxWidth: number,
): WesnothMarkup {
  const lines: MarkupLine[] = layoutMarkupLines(wesnothToSpans(input, variables), measure, maxWidth);
  const tagStyles = baseTagStyles();
  const text = lines.map((line) => spansToPixi(line.spans, tagStyles).text).join('\n');
  return { text, tagStyles };
}

/** A plain-text projection of Wesnoth markup, for accessibility names and hints. */
export function wesnothAccessibilityText(
  input: string,
  variables: Variables = {},
  options: { describeImage?: (path: string) => string } = {},
): string {
  return markupAccessibilityText(wesnothToSpans(input, variables), options);
}
