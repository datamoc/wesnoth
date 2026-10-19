/**
 * The sound cues the rules produce, resolved from the game's own data.
 *
 * Wesnoth keeps its audio references in content, not in code: an attack names
 * its swing sound (`[attack] sound=`), a unit type names the sound it makes
 * when it is struck or dies (`hit_sound=`, `die_sound=`), and
 * `data/game_config.cfg` holds the UI cues (`turn_bell`, `game_has_begun`) and
 * the status cues (`slowed`, `poisoned`, `petrified`). Two of those values are
 * file *lists*: `{SOUND_LIST:THROW}` expands to `throw-[1~4].wav` and the engine
 * picks one at random per strike (`src/sound.cpp`'s `get_sound_id`, which
 * expands the range and the comma list the same way).
 *
 * This module is pure: it answers "which file plays" and never touches an audio
 * element, so the mapping is testable in node and the scene keeps owning
 * playback. A cue that resolves to nothing is silence, never an error, which is
 * what the engine does for a missing sound file.
 */

import type { Unit } from './unit.ts';
import type { WesnothData } from './types.ts';

/** Wesnoth's `[1~4]` range expansion (`utils::split` plus the engine's own range syntax). */
export function expandSoundList(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const chunk of value.split(',')) {
    const entry = chunk.trim();
    if (!entry) continue;
    const range = /\[(\d+)~(\d+)\]/.exec(entry);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const step = start <= end ? 1 : -1;
      for (let index = start; index !== end + step; index += step) out.push(entry.replace(range[0], String(index)));
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** One file from a cue list, or null when the list is empty. */
export function pickCue(files: readonly string[], roll: () => number = Math.random): string | null {
  if (!files.length) return null;
  const index = Math.min(files.length - 1, Math.max(0, Math.floor(roll() * files.length)));
  return files[index];
}

function unitTypeSounds(data: WesnothData, unit: Unit, key: 'sound' | 'hit_sound' | 'die_sound'): string[] {
  const type = data.unitTypes[unit.typeId];
  const value = key === 'die_sound' ? type?.dieSound : key === 'hit_sound' ? type?.hitSound : undefined;
  return expandSoundList(value);
}

/** The sound an attack makes when it swings, from the weapon's own `sound=`. */
export function attackCue(unit: Unit, attackName: string, roll: () => number = Math.random): string | null {
  const attack = unit.attacks.find((candidate) => candidate.name === attackName);
  return pickCue(expandSoundList(attack?.sound), roll);
}

/** The sound a struck unit makes, from its type's `hit_sound=`. */
export function hitCue(data: WesnothData, defender: Unit, roll: () => number = Math.random): string | null {
  return pickCue(unitTypeSounds(data, defender, 'hit_sound'), roll);
}

/** The sound a unit makes when it dies, from its type's `die_sound=`. */
export function deathCue(data: WesnothData, unit: Unit, roll: () => number = Math.random): string | null {
  return pickCue(unitTypeSounds(data, unit, 'die_sound'), roll);
}

/** A UI cue from `data/game_config.cfg`'s `[sounds]` table (`turn_bell`, `game_has_begun`). */
export function uiCue(data: WesnothData, id: string, roll: () => number = Math.random): string | null {
  return pickCue(expandSoundList(data.sounds?.[id]), roll);
}

/** A status cue (`slowed`, `poisoned`, `petrified`) from the same table. */
export function statusCue(data: WesnothData, status: string, roll: () => number = Math.random): string | null {
  return pickCue(expandSoundList(data.statusSounds?.[status]), roll);
}

/** Wesnoth's `[music]` default fade, in seconds (`music::play_music`. fadein). */
export const DEFAULT_MUSIC_FADE = 1;

/**
 * The track a scenario's `music=` names. Wesnoth tracks are file names under
 * `data/core/music` (`revelation.ogg`); the port resolves them the same way,
 * with `music/` as the folder the host is expected to serve.
 */
export function musicPath(track: string | undefined): string | null {
  const name = track?.trim();
  if (!name) return null;
  return name.includes('/') ? name : `music/${name}`;
}
