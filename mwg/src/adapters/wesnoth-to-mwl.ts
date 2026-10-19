/**
 * Wesnoth nodes -> MWL **text**.
 *
 * `from-mwl.ts` is the other direction: it reads MWL back into `WesnothData`.
 * This module holds the conversion the `npm run convert` CLI uses, so the rules
 * are testable without a CLI:
 *
 * - `genericMwlNodes` runs no vocabulary knowledge: tags, attributes, nesting
 *   and the `_ "..."` gettext markers are preserved, so the result parses back
 *   to the same tree. Macros are already expanded by the preprocessor.
 * - `sliceMwlNodes` applies the typed slice conversions (terrain_type,
 *   movetype, trait, unit_type) and flattens them to roots, reporting what it
 *   skipped. It is lossy on purpose: the port consumes a subset of the data.
 */

import type { MwlNode } from 'mwg/mwl';
import { wesnothNodeToMwl } from './from-mwl.ts';
import type { WmlNode } from '../simulation/wml.ts';
import { renderJson5Document } from '../scenarios/mwl-json5-emit.ts';

export interface ConversionStats {
  nodes: number;
  converted: number;
  skipped: number;
  attributes: number;
  gettext: number;
  quoted: number;
  /** tags outside the slice, counted by tag (containers such as `[units]` are not listed) */
  skippedTags: Map<string, number>;
}

/** Tags that only wrap other nodes; not worth reporting as skipped. */
const CONTAINER_TAGS = ['units', 'terrain', 'multiplayer', 'scenario', 'campaign'];

export function newConversionStats(): ConversionStats {
  return { nodes: 0, converted: 0, skipped: 0, attributes: 0, gettext: 0, quoted: 0, skippedTags: new Map() };
}

/** Generic conversion: preserve every tag, attribute and child. */
export function genericMwlNodes(nodes: readonly WmlNode[], stats: ConversionStats = newConversionStats()): MwlNode[] {
  return nodes.map((node) => {
    stats.nodes++;
    stats.converted++;
    return {
      tag: node.tag,
      attributes: { ...node.attributes },
      children: genericMwlNodes(node.children, stats),
      gettext: node.gettext ? [...node.gettext] : [],
      location: { file: node.location.file, line: node.location.line, column: node.location.column },
    };
  });
}

/** Slice conversion: convert matching tags anywhere, flattened to roots. */
export function sliceMwlNodes(nodes: readonly WmlNode[], stats: ConversionStats = newConversionStats()): MwlNode[] {
  const out: MwlNode[] = [];
  const visit = (list: readonly WmlNode[]): void => {
    for (const node of list) {
      stats.nodes++;
      const converted = wesnothNodeToMwl(node);
      if (converted) {
        stats.converted++;
        out.push(converted);
      } else {
        stats.skipped++;
        if (!CONTAINER_TAGS.includes(node.tag)) stats.skippedTags.set(node.tag, (stats.skippedTags.get(node.tag) ?? 0) + 1);
      }
      visit(node.children);
    }
  };
  visit(nodes);
  return out;
}

/**
 * Nodes to JSON5 `.mwl` text (`mwl-json5-emit.ts` owns the value mapping).
 * Unlike the retired tag syntax, whose attributes were line-based, a JSON5
 * string can carry a newline, so multi-line values render escaped instead of
 * throwing.
 */
export function emitMwl(nodes: readonly MwlNode[], stats: ConversionStats = newConversionStats()): string {
  if (nodes.length === 0) return '';
  const counter = { attributes: 0, gettext: 0, quoted: 0 };
  const text = renderJson5Document(nodes, counter);
  stats.attributes += counter.attributes;
  stats.gettext += counter.gettext;
  stats.quoted += counter.quoted;
  return text;
}
