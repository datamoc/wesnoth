import assert from 'node:assert/strict';
import test from 'node:test';
import { GAME_DATA } from '../src/generated/game-data.ts';
import { makeUnit } from '../src/simulation/unit.ts';
import { UNIT_ANIMATIONS } from '../src/generated/unit-animations.ts';
import { attackCue, deathCue, expandSoundList, hitCue, musicPath, pickCue, statusCue, uiCue } from '../src/simulation/sounds.ts';

/**
 * The audio mapping (ROADMAP: "Audio and music pipeline").
 *
 * The port plays the game's own files, chosen by the game's own data: an
 * attack's `sound=`, a unit type's `hit_sound=`/`die_sound=`, and the
 * `[sounds]` table in `data/game_config.cfg`. The resolution is pure, so it is
 * tested here; `src/ui/audio.ts` only feeds the result to the framework.
 */

test('a SOUND_LIST expands its ranges and comma lists', () => {
  // `{SOUND_LIST:THROW}` compiles to this spelling, and the engine expands the
  // range before it plays one of them (`src/sound.cpp`).
  assert.deepEqual(expandSoundList('throw-[1~4].wav'), ['throw-1.wav', 'throw-2.wav', 'throw-3.wav', 'throw-4.wav']);
  assert.deepEqual(expandSoundList('human-hit-[1~2].ogg,elf-hit-[1~2].ogg'), ['human-hit-1.ogg', 'human-hit-2.ogg', 'elf-hit-1.ogg', 'elf-hit-2.ogg']);
  assert.deepEqual(expandSoundList('axe.ogg'), ['axe.ogg']);
  assert.deepEqual(expandSoundList(undefined), []);
  assert.deepEqual(expandSoundList('a.ogg,,b.ogg'), ['a.ogg', 'b.ogg']);
});

test('one file is picked from a cue list, deterministically for a given roll', () => {
  const files = ['a.ogg', 'b.ogg', 'c.ogg'];
  assert.equal(pickCue(files, () => 0), 'a.ogg');
  assert.equal(pickCue(files, () => 0.5), 'b.ogg');
  assert.equal(pickCue(files, () => 0.999), 'c.ogg');
  assert.equal(pickCue([], () => 0), null);
});

test('a swing sound rides the animation frame that shows it', () => {
  // Wesnoth attaches sounds to frames, not to the attack (`src/animated.cpp`),
  // so `{SOUND_LIST:THROW}` on the spear's throw frame is where the cue is.
  const throwFrame = UNIT_ANIMATIONS['Goblin Spearman'].attacks?.[0].frames.find((frame) => frame.sound);
  assert.ok(throwFrame, 'the throw animation carries a frame sound');
  assert.equal(throwFrame!.sound, 'throw-[1~4].wav');
  const cue = pickCue(expandSoundList(throwFrame!.sound), () => 0);
  assert.equal(cue, 'throw-1.wav');
  // The same expansion the animation pipeline produced is what the build inlined.
  assert.match(cue!, /\.wav$/);
});

test('attack, hit and death cues come from the compiled unit data', () => {
  const goblin = makeUnit(GAME_DATA, 'Goblin Spearman', 1, 0, 0, () => 0);
  const type = GAME_DATA.unitTypes['Goblin Spearman'];
  assert.ok(type.dieSound, 'the unit type carries die_sound=');
  assert.ok(expandSoundList(type.dieSound).includes(deathCue(GAME_DATA, goblin, () => 0)!));

  // An attack's own `sound=` (not every weapon has one) resolves when it exists.
  const bat = makeUnit(GAME_DATA, 'Vampire Bat', 1, 0, 0, () => 0);
  const declared = UNIT_ANIMATIONS['Vampire Bat'].attacks?.[0].frames.find((frame) => frame.sound);
  assert.ok(declared?.sound, 'the bat bite declares its sound');
  assert.equal(attackCue(bat, bat.attacks[0].name, () => 0), null, 'the attack tag itself names none');

  // A unit type without the attribute is silence, not an error.
  const mage = makeUnit(GAME_DATA, 'Mage', 1, 0, 0, () => 0);
  const withoutHitSound = { ...GAME_DATA, unitTypes: { ...GAME_DATA.unitTypes, Mage: { ...GAME_DATA.unitTypes.Mage, hitSound: undefined } } };
  assert.equal(hitCue(withoutHitSound, mage), null);
});

test('the UI and status cues are the game_config table', () => {
  // `data/game_config.cfg`'s `[sounds]`: turn_bell, game_has_begun, and the
  // nested status group.
  assert.equal(GAME_DATA.sounds?.turn_bell, 'bell.wav');
  assert.equal(uiCue(GAME_DATA, 'turn_bell', () => 0), 'bell.wav');
  assert.equal(uiCue(GAME_DATA, 'not_a_cue', () => 0), null);
  assert.ok(GAME_DATA.statusSounds?.poisoned, 'the status group compiled');
  assert.ok(statusCue(GAME_DATA, 'poisoned', () => 0));
  assert.equal(statusCue(GAME_DATA, 'not_a_status', () => 0), null);
});

test('a music reference resolves to the folder the host serves', () => {
  assert.equal(musicPath('revelation.ogg'), 'music/revelation.ogg');
  assert.equal(musicPath('campaigns/x/track.ogg'), 'campaigns/x/track.ogg');
  assert.equal(musicPath(undefined), null);
  assert.equal(musicPath('  '), null);
});
