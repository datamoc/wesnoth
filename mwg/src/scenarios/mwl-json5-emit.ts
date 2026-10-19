/**
 * `MwlNode` tree -> JSON5 `.mwl` text.
 *
 * The value mapping is the one `notes/mwl-to-json5.ts` used for the repo-wide
 * migration (see `notes/MWL JSON5 Format Proposal.md`, "Value mapping"): a
 * value is a real JSON5 number whenever its text is numeric-shaped, `yes`/`no`
 * become real booleans on attributes `schema01` types as boolean,
 * gettext-marked values become `_(...)`, everything else a quoted string.
 * `MwlNode.attributes` stays `Record<string, string>` at the IR boundary, so
 * the reader stringifies every value back when building the node; this only
 * changes what an author types and what a JSON5-aware tool can check.
 *
 * New code must build nodes (or this text) directly. The retired tag-syntax
 * MWL front end has been removed. Build-time WML conversion code may still
 * use the port's WML parser for its private intermediate fragments.
 */

import { schema01, type MwlAttributeType, type MwlNode } from 'mwg/mwl';

/** Counters an emitter may collect while rendering; all fields optional. */
export interface MwlEmitStats {
  attributes?: number;
  gettext?: number;
  quoted?: number;
}

function attributeType(tag: string, name: string): MwlAttributeType | undefined {
  const entry = schema01[tag];
  return entry?.attributes?.[name] ?? entry?.openAttributes;
}

function isSafeKey(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

// A number is a number if it's shaped like one, full stop: checkable by a
// JSON5 parser or a plain `typeof`, not just by trusting MWL's own schema.
// schema01's declared type still decides booleans (yes/no/true/false has no
// shape-only tell) and is ignored when it disagrees with a clearly numeric
// value, exactly like the migration script.
function isNumericLiteral(raw: string): boolean {
  return /^-?(0|[1-9]\d*)(\.\d+)?$/.test(raw);
}

function renderAttributeValue(tag: string, name: string, raw: string, gettext: boolean, stats?: MwlEmitStats): string {
  if (stats) stats.attributes = (stats.attributes ?? 0) + 1;
  if (gettext) {
    if (stats) {
      stats.gettext = (stats.gettext ?? 0) + 1;
      stats.quoted = (stats.quoted ?? 0) + 1;
    }
    return `_(${JSON.stringify(raw)})`;
  }
  const type = attributeType(tag, name);
  if (type === 'boolean') {
    if (raw === 'yes' || raw === 'true') return 'true';
    if (raw === 'no' || raw === 'false') return 'false';
    if (stats) stats.quoted = (stats.quoted ?? 0) + 1;
    return JSON.stringify(raw);
  }
  if (isNumericLiteral(raw)) return raw;
  if (stats) stats.quoted = (stats.quoted ?? 0) + 1;
  return JSON.stringify(raw);
}

function renderNode(node: MwlNode, depth: number, stats?: MwlEmitStats): string {
  const pad = '  '.repeat(depth);
  const innerPad = '  '.repeat(depth + 1);
  const lines: string[] = [`${pad}{`, `${innerPad}tag: ${JSON.stringify(node.tag)},`];
  for (const [name, raw] of Object.entries(node.attributes)) {
    const gettext = node.gettext?.includes(name) ?? false;
    const key = isSafeKey(name) ? name : JSON.stringify(name);
    lines.push(`${innerPad}${key}: ${renderAttributeValue(node.tag, name, raw, gettext, stats)},`);
  }
  if (node.children.length > 0) {
    lines.push(`${innerPad}children: [`);
    for (const child of node.children) lines.push(`${renderNode(child, depth + 2, stats)},`);
    lines.push(`${innerPad}],`);
  }
  lines.push(`${pad}}`);
  return lines.join('\n');
}

/**
 * Render nodes as a top-level JSON5 array, the only document shape (one rule
 * for every file, even a single root: a JSON5 object cannot express repeated
 * sibling keys, so sibling top-level tags are array entries).
 */
export function renderJson5Document(nodes: readonly MwlNode[], stats?: MwlEmitStats): string {
  return `[\n${nodes.map((node) => `${renderNode(node, 1, stats)},`).join('\n')}\n]\n`;
}
