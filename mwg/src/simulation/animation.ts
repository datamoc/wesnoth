/**
 * Unit animation model, in the port's own vocabulary.
 *
 * Wesnoth describes an animation as a list of `[frame]` images, each with a
 * duration in milliseconds, and wraps some of them in `[if]`/`[else]` branches
 * chosen at runtime by facing direction or by whether an attack hit
 * (`src/animated.cpp`, `src/units/animation.cpp`). This module owns the pure
 * part: turning one real `image="stem.png:100"` / range / `*` spec into a flat
 * frame list, and answering "which frame is showing at `t`".
 *
 * It deliberately has no node and no Pixi import, so both the build-time data
 * pipeline and the browser scene can use it. The real engine also carries
 * per-frame `x`/`y` offsets, `[missile_frame]` projectiles and hit sounds; those
 * are recorded only where the scene needs them and are noted in
 * `PORT_COVERAGE.md`.
 */

/** One drawn frame: an image path (modifiers allowed) and how long it shows. */
export interface AnimFrame {
  readonly image: string;
  /** milliseconds this frame is displayed */
  readonly duration: number;
  /** Wesnoth pixel offset of the image relative to the unit hex. */
  readonly x?: number;
  readonly y?: number;
  /** Optional normalized projectile position along the attack path. */
  readonly offset?: number;
  /** Optional opacity for projectile/halo frames. */
  readonly alpha?: number;
  /**
   * The sound this frame plays (`[frame] sound=`, which `{SOUND:HIT ...}`
   * expands into). The engine attaches sounds to animation frames rather than
   * to the attack as a whole (`src/animated.cpp`), so the swing lands with the
   * frame that shows it.
   */
  readonly sound?: string;
}

/** One `[attack_anim]`, keyed by the attack name its `[filter_attack]` names. */
export interface AttackAnimation {
  /** the attack name, e.g. `spear`; empty means "any attack" */
  readonly attack: string;
  /** `start_time=` in ms, negative for a wind-up before the strike */
  readonly startTime: number;
  readonly frames: readonly AnimFrame[];
  /** Optional projectile/halo frames shown during the attack. */
  readonly missileFrames: readonly AnimFrame[];
  readonly missileStartTime: number;
}

/** Every animation the scene can play for one unit type. */
export interface UnitAnimations {
  readonly standing: readonly AnimFrame[];
  readonly idle: readonly AnimFrame[];
  readonly movement: readonly AnimFrame[];
  readonly death: readonly AnimFrame[];
  readonly attacks: readonly AttackAnimation[];
}

/**
 * Wesnoth's default when a `[frame]` omits its duration, matching
 * `src/units/animation.cpp`'s `display::default_frame_duration`.
 */
export const DEFAULT_FRAME_DURATION = 100;

/** The fallback animation every unit can play, so a sprite is never blank. */
export function fallbackStanding(image: string): AnimFrame[] {
  return [{ image, duration: DEFAULT_FRAME_DURATION }];
}

/**
 * Resolve one `image` attribute into concrete frames.
 *
 * Handles the four shapes the real data uses, all measured over
 * `data/core/units`:
 *
 * - `stem.png:100` - one frame.
 * - `stem.png:100,200,50` - the same image held for a list of durations.
 * - `stem-[1~4,1].png:[100,100,75,50,100]` - an image range/list paired with
 *   the durations, one frame per image.
 * - `stem.png:[100*3,50]` - a duration repeated with `*`.
 *
 * Image-modifier suffixes (`~BLIT(...)`, `~FL`, ...) are kept in the path; the
 * scene's image-modifier layer resolves them at draw time.
 */
export function parseFrameSpec(image: string, fallbackDuration = DEFAULT_FRAME_DURATION): AnimFrame[] {
  // Strip every quote, not just the ends: a macro argument passed as
  // `"stem"` and substituted mid-string yields `"stem"-se-bob1.png`, which the
  // real text preprocessor leaves for the WML parser to concatenate. An image
  // path never contains a quote, so removing them is exact here.
  const spec = image.replace(/"/g, '').trim();
  if (spec === '') return [];

  const split = splitSpec(spec);
  const images = expandImageList(split.images);
  const durations = expandDurationList(split.durations);

  if (images.length === 0) return [];
  if (durations.length === 0) return images.map((path) => ({ image: path, duration: fallbackDuration }));
  if (durations.length === 1) return images.map((path) => ({ image: path, duration: durations[0] }));

  const frames: AnimFrame[] = [];
  if (images.length === 1) {
    for (const duration of durations) frames.push({ image: images[0], duration });
    return frames;
  }
  for (let index = 0; index < images.length; index += 1) {
    frames.push({ image: images[index], duration: durations[index] ?? durations[durations.length - 1] });
  }
  return frames;
}

/** Split `images:duration` at the first top-level colon (paths never contain one). */
function splitSpec(spec: string): { images: string; durations: string } {
  let depth = 0;
  for (let index = 0; index < spec.length; index += 1) {
    const char = spec[index];
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    else if (char === ':' && depth === 0) return { images: spec.slice(0, index), durations: spec.slice(index + 1) };
  }
  return { images: spec, durations: '' };
}

/** Expand the one optional `[a~b,c,...]` group in an image stem into concrete paths. */
function expandImageList(stem: string): string[] {
  const open = stem.indexOf('[');
  const close = open === -1 ? -1 : stem.indexOf(']', open);
  if (open === -1 || close === -1) return [stem.trim()];
  const prefix = stem.slice(0, open);
  const suffix = stem.slice(close + 1);
  const values = stem.slice(open + 1, close).split(',').map((entry) => entry.trim()).filter(Boolean);
  const out: string[] = [];
  for (const value of values) {
    // `4*2`: image 4 used twice in a row (`mage-idle-[1~4,4*2,4~1].png`).
    const repeat = /^(\d+)\s*\*\s*(\d+)$/.exec(value);
    if (repeat) {
      const image = `${prefix}${repeat[1]}${suffix}`;
      const count = Number(repeat[2]);
      for (let n = 0; n < count && n < 512; n += 1) out.push(image);
      continue;
    }
    const range = /^(\d+)~(\d+)$/.exec(value);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      const step = from <= to ? 1 : -1;
      for (let n = from; step > 0 ? n <= to : n >= to; n += step) out.push(`${prefix}${n}${suffix}`);
    } else {
      out.push(`${prefix}${value}${suffix}`);
    }
  }
  return out.length ? out : [`${prefix}${suffix}`];
}

/** Expand a duration list such as `[100*3,50]` or `100,200` into milliseconds. */
function expandDurationList(raw: string): number[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  const body = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  const out: number[] = [];
  for (const entry of body.split(',')) {
    const value = entry.trim();
    if (value === '') continue;
    const repeat = /^(\d+)\s*\*\s*(\d+)$/.exec(value);
    if (repeat) {
      const duration = Number(repeat[1]);
      const count = Number(repeat[2]);
      for (let n = 0; n < count && n < 512; n += 1) out.push(duration);
      continue;
    }
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) out.push(number);
  }
  return out;
}

/** Total duration of a frame list in milliseconds. */
export function totalDuration(frames: readonly AnimFrame[]): number {
  let total = 0;
  for (const frame of frames) total += frame.duration;
  return total;
}

/**
 * Index of the frame showing at `elapsedMs`. A looping list wraps; a one-shot
 * list holds its last frame, the same as `src/animated.cpp` holding the end of
 * a death animation.
 */
export function frameIndexAt(frames: readonly AnimFrame[], elapsedMs: number, loop = true): number {
  if (frames.length === 0) return -1;
  if (frames.length === 1) return 0;
  const total = totalDuration(frames);
  if (total <= 0) return frames.length - 1;
  let time = elapsedMs;
  if (loop) time = ((time % total) + total) % total;
  else if (time >= total) return frames.length - 1;
  let accumulated = 0;
  for (let index = 0; index < frames.length; index += 1) {
    accumulated += frames[index].duration;
    if (time < accumulated) return index;
  }
  return frames.length - 1;
}

/** The frame showing at `elapsedMs`, or null for an empty list. */
export function frameAt(frames: readonly AnimFrame[], elapsedMs: number, loop = true): AnimFrame | null {
  const index = frameIndexAt(frames, elapsedMs, loop);
  return index < 0 ? null : frames[index];
}
