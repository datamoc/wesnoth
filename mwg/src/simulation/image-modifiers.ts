/**
 * The image-modifier pieces that stay with the Wesnoth adapter because MWG models them
 * differently. Everything else is MWG's `applyImageModifiers` (sprite-level) plus
 * `applyTextureModifiers` (pixel-level, 0.8.0) with the port's `resolveNamedColour` probe.
 * MWG 0.8.0 `applyAllImageModifiers` is deliberately not used: it runs both steps over one
 * parsed path, while the port must bake the full path at texture level (exact `~BLEND`)
 * but filter `~CHAN`/`~BLEND`/`~ROTATE` out of the sprite step.
 */
import type { ParsedImagePath } from 'mwg/two-d/render';

/** Common target colours used by Wesnoth's ~RC(magenta>name) modifier. */
const TEAM_COLOURS: Readonly<Record<string, number>> = {
  red: 0xff0000, blue: 0x2e419b, green: 0x62b664, purple: 0x93009d,
  black: 0x5a5a5a, brown: 0x945027, orange: 0xff7e00, white: 0xe1e1e1,
  teal: 0x30cbc0, gold: 0xfff35a, lightblue: 0x00a4ff, brightgreen: 0x8cff00,
  darkred: 0x8a0808, brightorange: 0xffc600, lightred: 0xd1620d,
  yellow: 0xe7ed2d, pink: 0xffc0cb, darkblue: 0x0e2270, wesred: 0xff0000,
};

/** Return the destination colour from a parsed RC modifier, if supported. */
export function replacementColour(args: readonly string[]): number | undefined {
  if (args.length < 1) return undefined;
  const separator = args[0].indexOf('>');
  if (separator < 1) return undefined;
  return resolveNamedColour(args[0].slice(separator + 1));
}

/**
 * Named colour resolver for MWG's pixel-level `applyTextureModifiers` probe.
 * MWG resolves hex itself; this supplies Wesnoth's named team colours
 * (`~RC(magenta>red)`, `~PAL`), so `~RC`/`~PAL` bake an exact palette swap
 * instead of the port's old tint approximation.
 */
export function resolveNamedColour(name: string): number | undefined {
  const key = name.trim().toLowerCase().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(key)) return Number.parseInt(key, 16);
  return TEAM_COLOURS[key];
}

/**
 * Sprite-level modifiers MWG's `applyImageModifiers` does not model the way Wesnoth does, so
 * they must not be handed to it: `~CHAN` evaluates channel formulas (`red*1.2`) where MWG swaps
 * channel sources, `~BLEND` blends per pixel where MWG uses a colour matrix, and `~ROTATE`
 * rotates the pixels and expands the surface where MWG rotates the sprite node. The port keeps
 * its own handling for `~CHAN` and looks past the other two, rather than letting MWG's
 * approximations overwrite what the port would otherwise leave alone.
 */
export const MWG_SPRITE_MODIFIER_SKIPS: ReadonlySet<string> = new Set(['CHAN', 'BLEND', 'ROTATE']);

/** A copy of `parsed` without the modifiers MWG must not apply (returns the input when it has none). */
export function mwgSpritePath(parsed: ParsedImagePath): ParsedImagePath {
  const modifiers = parsed.modifiers.filter((modifier) => !MWG_SPRITE_MODIFIER_SKIPS.has(modifier.name));
  return modifiers.length === parsed.modifiers.length ? parsed : { path: parsed.path, modifiers };
}
