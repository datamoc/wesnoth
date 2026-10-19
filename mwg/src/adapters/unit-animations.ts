/**
 * Build-time extraction of the real unit animations from parsed Wesnoth nodes.
 *
 * The pipeline expands the animation macros (`data/core/macros/animation-utils.cfg`,
 * `animation-utils2.cfg`) into ordinary `[standing_anim]`/`[attack_anim]`/... children
 * of each `[unit_type]`, then this adapter reads them into the port's own
 * `UnitAnimations` shape. It touches no Pixi and writes no file; it only turns
 * `WmlNode` trees into the model `src/simulation/animation.ts` defines.
 *
 * Facing and hit/miss are the two runtime choices Wesnoth makes per frame
 * (`src/units/animation.cpp` `unit_animation::get_animation_time` and the
 * `direction`/`hits` filters). The port downloads the **south-east** facing and
 * the **hit** branch, the one a portrait-style rendering shows, and records the
 * others as `Simplified` in `PORT_COVERAGE.md` rather than pretending to own
 * the full filter engine.
 */

import { parseFrameSpec, type AnimFrame, type AttackAnimation, type UnitAnimations } from '../simulation/animation.ts';
import type { WmlNode } from '../simulation/wml.ts';

/**
 * Wesnoth image paths are root-relative (`scenery/gate-rusty-sw.png`), but a few
 * campaign units spell the source location out fully
 * (`data/core/images/scenery/gate-rusty-sw.png`, Winds of Fate's `Gate`). Strip
 * the data root so the stored path matches the asset bundle key everywhere.
 */
export function normalizeImagePath(value: string): string {
  const trimmed = value.replace(/^"|"$/g, '').trim();
  const rooted = /^data\/.*?\/(?:images|sounds)\/(.+)$/i.exec(trimmed);
  return rooted ? rooted[1] : trimmed;
}

/** The animation tags a unit type may carry, in the order the scene prefers them. */
const ANIMATION_TAGS = ['standing_anim', 'idle_anim', 'movement_anim', 'death', 'attack_anim'] as const;

/** True when a `direction=` filter includes the south-east facing this port draws. */
function facesSouthEast(direction: string | undefined): boolean {
  if (direction === undefined || direction === '') return true;
  return direction.split(',').some((entry) => /^(s|se|sw)$/.test(entry.trim()));
}

/**
 * Whether an `[if]` branch should be taken for the port's fixed facing.
 *
 * `direction` picks the facing; `hits` picks the damage outcome (the port takes
 * the hit branch, since it only plays the animation once the strike landed);
 * anything else is taken, so a branch the port does not model degrades to
 * "played" rather than silently dropped.
 */
function branchMatches(node: WmlNode): boolean {
  if (node.attributes.direction !== undefined && !facesSouthEast(node.attributes.direction)) return false;
  if (node.attributes.hits !== undefined && node.attributes.hits === 'no') return false;
  if (node.attributes.wounded !== undefined && node.attributes.wounded === 'no') return false;
  return true;
}

/**
 * Flatten one animation node into frames, resolving its `[if]`/`[else]` branches
 * for the fixed facing. `[frame]` keeps its `image`; a frame with no image is a
 * sound-only or offset-only step and contributes no drawn frame.
 */
function framesOf(node: WmlNode): AnimFrame[] {
  const frames: AnimFrame[] = [];
  let lastIfMatched = true;
  for (const child of node.children) {
    if (child.tag === 'frame') {
      const image = child.attributes.image;
      // A frame carries its own sound (`[frame] sound={SOUND_LIST:THROW}`), and
      // the engine plays it while that frame is on screen (animated.cpp). The
      // cue is kept on every frame the image spec expands to; a sound-only
      // frame (no image) is not drawn at all, so its cue is dropped with it.
      const sound = child.attributes.sound;
      if (image) {
        const x = Number(child.attributes.x ?? 0);
        const y = Number(child.attributes.y ?? 0);
        // The cue plays once, when the frame first appears, so it rides the
        // first image the spec expands to rather than every one of them.
        frames.push(...parseFrameSpec(normalizeImagePath(image)).map((frame, index) => ({
          ...frame,
          ...(Number.isFinite(x) && x !== 0 ? { x } : {}),
          ...(Number.isFinite(y) && y !== 0 ? { y } : {}),
          ...(sound && index === 0 ? { sound } : {}),
        })));
      }
      continue;
    }
    if (child.tag === 'if') {
      lastIfMatched = branchMatches(child);
      if (lastIfMatched) frames.push(...framesOf(child));
      continue;
    }
    if (child.tag === 'else') {
      if (!lastIfMatched) frames.push(...framesOf(child));
      continue;
    }
    // `[missile_frame]`, `[sound_frame]`, `[halo_frame]`: recorded elsewhere; not
    // part of the drawn unit frames this port plays yet.
  }
  return frames;
}

/** Flatten the selected `[missile_frame]` branch for the fixed facing/hit. */
function missileFramesOf(node: WmlNode): AnimFrame[] {
  const frames: AnimFrame[] = [];
  let lastIfMatched = true;
  for (const child of node.children) {
    if (child.tag === 'missile_frame') {
      // The renderer's fixed facing is south-east, so prefer Wesnoth's
      // diagonal projectile image when the animation provides one.
      const image = child.attributes.image_diagonal ?? child.attributes.image ?? child.attributes.halo;
      if (!image) continue;
      const duration = Number(child.attributes.duration ?? 100);
      const normalized = normalizeImagePath(image);
      const spec = normalized.includes(':') ? normalized : `${normalized}:${Number.isFinite(duration) && duration > 0 ? duration : 100}`;
      const x = Number(child.attributes.x ?? 0);
      const y = Number(child.attributes.y ?? 0);
      const offset = Number(child.attributes.offset ?? Number.NaN);
      const alpha = Number(child.attributes.alpha ?? Number.NaN);
      frames.push(...parseFrameSpec(spec).map((frame) => ({
        ...frame,
        ...(Number.isFinite(x) && x !== 0 ? { x } : {}),
        ...(Number.isFinite(y) && y !== 0 ? { y } : {}),
        ...(Number.isFinite(offset) ? { offset: Math.max(0, Math.min(1, offset)) } : {}),
        ...(Number.isFinite(alpha) ? { alpha: Math.max(0, Math.min(1, alpha)) } : {}),
      })));
      continue;
    }
    if (child.tag === 'if') {
      lastIfMatched = branchMatches(child);
      if (lastIfMatched) frames.push(...missileFramesOf(child));
      continue;
    }
    if (child.tag === 'else') {
      if (!lastIfMatched) frames.push(...missileFramesOf(child));
    }
  }
  return frames;
}

/**
 * Among several animation nodes (one per facing), the one the port plays.
 * Wesnoth picks by direction at runtime; the port keeps the SE node when it
 * exists so the frames match the SE `image` it already draws.
 */
function pickFacing(nodes: readonly WmlNode[]): WmlNode | null {
  if (!nodes.length) return null;
  const southEast = nodes.find((node) => facesSouthEast(node.attributes.direction) && node.attributes.direction !== undefined);
  return southEast ?? nodes.find((node) => node.attributes.direction === undefined) ?? nodes[0];
}

/** Read every animation a unit type declares. */
export function extractUnitAnimations(node: WmlNode): UnitAnimations {
  const byTag = new Map<string, WmlNode[]>();
  for (const child of node.children) {
    if (!(ANIMATION_TAGS as readonly string[]).includes(child.tag)) continue;
    const list = byTag.get(child.tag) ?? [];
    list.push(child);
    byTag.set(child.tag, list);
  }

  const standing = pickFacing(byTag.get('standing_anim') ?? []);
  const idle = pickFacing(byTag.get('idle_anim') ?? []);
  const movement = pickFacing(byTag.get('movement_anim') ?? []);
  const death = pickFacing(byTag.get('death') ?? []);
  const standingFrames = standing ? framesOf(standing) : [];
  const idleFrames = idle ? framesOf(idle) : [];

  // Group `[attack_anim]` by the attack name their `[filter_attack]` names.
  const attacksByType = new Map<string, WmlNode[]>();
  for (const attackAnim of byTag.get('attack_anim') ?? []) {
    const filter = attackAnim.children.find((child) => child.tag === 'filter_attack');
    const attack = filter?.attributes.name ?? '';
    const list = attacksByType.get(attack) ?? [];
    list.push(attackAnim);
    attacksByType.set(attack, list);
  }

  const attacks: AttackAnimation[] = [];
  for (const [attack, nodes] of attacksByType) {
    const chosen = pickFacing(nodes);
    if (!chosen) continue;
    const frames = framesOf(chosen);
    const missileFrames = missileFramesOf(chosen);
    if (!frames.length && !missileFrames.length) continue;
    const startTime = Number(chosen.attributes.start_time ?? 0);
    const missileStartTime = Number(chosen.attributes.missile_start_time ?? startTime);
    attacks.push({
      attack,
      startTime: Number.isFinite(startTime) ? startTime : 0,
      frames,
      missileFrames,
      missileStartTime: Number.isFinite(missileStartTime) ? missileStartTime : 0,
    });
  }

  return {
    standing: standingFrames,
    idle: idleFrames.length ? idleFrames : standingFrames,
    movement: movement ? framesOf(movement) : [],
    death: death ? framesOf(death) : [],
    attacks,
  };
}

/** Every unit type that declares at least one readable animation, keyed by id. */
export function extractAllUnitAnimations(nodes: readonly WmlNode[]): Record<string, UnitAnimations> {
  const out: Record<string, UnitAnimations> = {};
  for (const node of nodes) {
    if (node.tag !== 'unit_type' || !node.attributes.id) continue;
    const animations = extractUnitAnimations(node);
    if (
      animations.standing.length ||
      animations.idle.length ||
      animations.movement.length ||
      animations.death.length ||
      animations.attacks.length
    ) {
      out[node.attributes.id] = animations;
    }
  }
  return out;
}

/**
 * Every image file an animation set references, including the sources embedded
 * in image modifiers such as `~BLIT(other.png)`, so the asset collector copies
 * exactly what the scene can draw.
 */
export function collectAnimationImages(animations: UnitAnimations | undefined): Set<string> {
  const images = new Set<string>();
  if (!animations) return images;
  const addFrames = (frames: readonly AnimFrame[]): void => {
    for (const frame of frames) for (const path of imageReferences(frame.image)) images.add(path);
  };
  addFrames(animations.standing);
  addFrames(animations.idle);
  addFrames(animations.movement);
  addFrames(animations.death);
  for (const attack of animations.attacks) addFrames(attack.frames);
  for (const attack of animations.attacks) addFrames(attack.missileFrames);
  return images;
}

/** The concrete file paths inside one frame image expression, modifiers included. */
export function imageReferences(expression: string): string[] {
  const out: string[] = [];
  for (const frame of parseFrameSpec(expression)) {
    for (const match of frame.image.matchAll(/[A-Za-z0-9_./-]+\.(?:png|webp|jpg|jpeg)/gi)) out.push(match[0]);
  }
  return out;
}
