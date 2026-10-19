import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_FRAME_DURATION,
  fallbackStanding,
  frameAt,
  frameIndexAt,
  parseFrameSpec,
  totalDuration,
} from '../src/simulation/animation.ts';
import { collectAnimationImages, extractUnitAnimations, imageReferences } from '../src/adapters/unit-animations.ts';
import type { WmlNode } from '../src/simulation/wml.ts';

const loc = { file: 'test.cfg', line: 1, column: 1 };

function node(tag: string, attributes: Record<string, string>, children: WmlNode[] = []): WmlNode {
  return { tag, attributes, children, location: loc };
}

test('a plain frame spec is one frame with its duration', () => {
  assert.deepEqual(parseFrameSpec('units/elf.png:120'), [{ image: 'units/elf.png', duration: 120 }]);
});

test('a duration list repeats one image for each duration', () => {
  const frames = parseFrameSpec('units/elf.png:100,200,50');
  assert.deepEqual(frames.map((frame) => frame.duration), [100, 200, 50]);
  assert.ok(frames.every((frame) => frame.image === 'units/elf.png'));
});

test('a missing duration falls back to the engine default', () => {
  assert.deepEqual(parseFrameSpec('units/elf.png'), [{ image: 'units/elf.png', duration: DEFAULT_FRAME_DURATION }]);
});

test('an image range pairs each expanded image with its duration', () => {
  const frames = parseFrameSpec('units/bowman-bow-attack-[1~4,1].png:[75*2,100,130,65]');
  assert.deepEqual(frames.map((frame) => frame.image), [
    'units/bowman-bow-attack-1.png',
    'units/bowman-bow-attack-2.png',
    'units/bowman-bow-attack-3.png',
    'units/bowman-bow-attack-4.png',
    'units/bowman-bow-attack-1.png',
  ]);
  assert.deepEqual(frames.map((frame) => frame.duration), [75, 75, 100, 130, 65]);
});

test('a duration repeated with * expands to that many frames', () => {
  const frames = parseFrameSpec('units/elf.png:[100*3,50]');
  assert.deepEqual(frames.map((frame) => frame.duration), [100, 100, 100, 50]);
});

test('an image repeated with * inside the list expands in place', () => {
  // The real Mage idle: `n-[1~4,4*2,4~1].png` holds on image 4 for three frames.
  const frames = parseFrameSpec('units/human-magi/n-[1~4,4*2,4~1].png:[150*10]');
  assert.deepEqual(frames.map((frame) => frame.image), [
    'units/human-magi/n-1.png',
    'units/human-magi/n-2.png',
    'units/human-magi/n-3.png',
    'units/human-magi/n-4.png',
    'units/human-magi/n-4.png',
    'units/human-magi/n-4.png',
    'units/human-magi/n-4.png',
    'units/human-magi/n-3.png',
    'units/human-magi/n-2.png',
    'units/human-magi/n-1.png',
  ]);
});

test('a quote substituted mid-path by a macro is dropped', () => {
  const frames = parseFrameSpec('units/dwarves/fighter"-se-bob[1~2].png:200');
  assert.deepEqual(frames.map((frame) => frame.image), ['units/dwarves/fighter-se-bob1.png', 'units/dwarves/fighter-se-bob2.png']);
});

test('image modifiers stay on the frame path for the renderer to resolve', () => {
  const frames = parseFrameSpec('units/spearman-attack-se-3.png~BLIT(units/swoosh-se.png):50');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].image, 'units/spearman-attack-se-3.png~BLIT(units/swoosh-se.png)');
  assert.equal(frames[0].duration, 50);
});

test('frameIndexAt wraps a looping list and holds a one-shot list', () => {
  const frames = parseFrameSpec('anim-[1,2,3].png:100');
  assert.equal(totalDuration(frames), 300);
  assert.equal(frameIndexAt(frames, 0), 0);
  assert.equal(frameIndexAt(frames, 150), 1);
  assert.equal(frameIndexAt(frames, 250), 2);
  assert.equal(frameIndexAt(frames, 350), 0);
  assert.equal(frameIndexAt(frames, 350, false), 2);
  assert.equal(frameAt(frames, 150)?.image, 'anim-2.png');
});

test('animation frames preserve Wesnoth image offsets', () => {
  const node = {
    tag: 'unit_type', attributes: { id: 'Offset Unit' }, location: { file: 'test.cfg', line: 1, column: 1 },
    children: [{
      tag: 'standing_anim', attributes: {}, location: { file: 'test.cfg', line: 2, column: 1 },
      children: [{ tag: 'frame', attributes: { image: 'units/test.png:100', x: '6', y: '-4' }, children: [], location: { file: 'test.cfg', line: 3, column: 1 } }],
    }],
  } as never;
  const animation = extractUnitAnimations(node);
  assert.deepEqual(animation.standing[0], { image: 'units/test.png', duration: 100, x: 6, y: -4 });
});

test('attack animations preserve selected missile frames', () => {
  const node = {
    tag: 'unit_type', attributes: { id: 'Projectile Unit' }, location: loc,
    children: [{
      tag: 'attack_anim', attributes: { missile_start_time: '-150' }, location: loc,
      children: [
        { tag: 'filter_attack', attributes: { name: 'fire' }, children: [], location: loc },
        { tag: 'missile_frame', attributes: { image: 'projectiles/fire.png', duration: '150' }, children: [], location: loc },
        { tag: 'frame', attributes: { image: 'units/test.png:100' }, children: [], location: loc },
      ],
    }],
  } as never;
  const animation = extractUnitAnimations(node);
  assert.deepEqual(animation.attacks[0].missileFrames, [{ image: 'projectiles/fire.png', duration: 150 }]);
  assert.equal(animation.attacks[0].missileStartTime, -150);
});

test('missile frames preserve constant position and opacity modifiers', () => {
  const node = {
    tag: 'unit_type', attributes: { id: 'Projectile Offset Unit' }, location: loc,
    children: [{
      tag: 'attack_anim', attributes: {}, location: loc,
      children: [
        { tag: 'filter_attack', attributes: { name: 'fire' }, children: [], location: loc },
        { tag: 'missile_frame', attributes: { image: 'projectiles/fire.png', duration: '100', offset: '0.7', x: '4', y: '-3', alpha: '0.5' }, children: [], location: loc },
      ],
    }],
  } as never;
  assert.deepEqual(extractUnitAnimations(node).attacks[0].missileFrames, [{ image: 'projectiles/fire.png', duration: 100, x: 4, y: -3, offset: 0.7, alpha: 0.5 }]);
});

test('missile frames prefer the diagonal image for the fixed south-east facing', () => {
  const node = {
    tag: 'unit_type', attributes: { id: 'Diagonal Projectile Unit' }, location: loc,
    children: [{
      tag: 'attack_anim', attributes: {}, location: loc,
      children: [
        { tag: 'filter_attack', attributes: { name: 'bow' }, children: [], location: loc },
        { tag: 'missile_frame', attributes: { image: 'projectiles/arrow-n.png', image_diagonal: 'projectiles/arrow-se.png', duration: '100' }, children: [], location: loc },
      ],
    }],
  } as never;
  assert.equal(extractUnitAnimations(node).attacks[0].missileFrames[0].image, 'projectiles/arrow-se.png');
});

test('a unit type reads its standing, idle, move, death and attack animations', () => {
  const unit = node('unit_type', { id: 'Spearman' }, [
    node('standing_anim', {}, [
      node('if', { direction: 's,se,sw' }, [node('frame', { image: 'units/spear-se.png:150' })]),
      node('else', { direction: 'n,ne,nw' }, [node('frame', { image: 'units/spear-ne.png:150' })]),
    ]),
    node('idle_anim', {}, [node('frame', { image: 'units/spear-idle.png:200' })]),
    node('movement_anim', {}, [node('frame', { image: 'units/spear-move-[1,2].png:[100,100]' })]),
    node('death', {}, [node('frame', { image: 'units/spear-death.png' })]),
    node('attack_anim', { direction: 'se,sw', start_time: '-325' }, [
      node('filter_attack', { name: 'spear' }),
      node('frame', { image: 'units/spear-attack-se-1.png:100' }),
    ]),
    node('attack_anim', { direction: 'n', start_time: '-228' }, [
      node('filter_attack', { name: 'spear' }),
      node('frame', { image: 'units/spear-attack-n-1.png:32' }),
    ]),
  ]);

  const animations = extractUnitAnimations(unit);
  assert.equal(animations.standing[0].image, 'units/spear-se.png');
  assert.equal(animations.idle[0].image, 'units/spear-idle.png');
  assert.deepEqual(animations.movement.map((frame) => frame.image), ['units/spear-move-1.png', 'units/spear-move-2.png']);
  assert.deepEqual(animations.death, [{ image: 'units/spear-death.png', duration: DEFAULT_FRAME_DURATION }]);
  assert.equal(animations.attacks.length, 1);
  assert.equal(animations.attacks[0].attack, 'spear');
  assert.equal(animations.attacks[0].startTime, -325);
  assert.equal(animations.attacks[0].frames[0].image, 'units/spear-attack-se-1.png');
});

test('a unit with no animation still gets a standing fallback', () => {
  assert.deepEqual(fallbackStanding('units/plain.png'), [{ image: 'units/plain.png', duration: DEFAULT_FRAME_DURATION }]);
  assert.deepEqual(extractUnitAnimations(node('unit_type', { id: 'Plain' })).standing, []);
});

test('asset collection follows image modifier sources as well as frame paths', () => {
  const references = imageReferences('units/spearman-attack-se-3.png~BLIT(units/swoosh-se.png):50');
  assert.deepEqual(references, ['units/spearman-attack-se-3.png', 'units/swoosh-se.png']);

  const unit = node('unit_type', { id: 'Spearman' }, [
    node('standing_anim', {}, [node('frame', { image: 'units/spear.png:150' })]),
    node('attack_anim', {}, [
      node('frame', { image: 'units/spear-attack-[1,2].png~BLIT(units/swoosh.png):[100,100]' }),
    ]),
  ]);
  const images = collectAnimationImages(extractUnitAnimations(unit));
  assert.ok(images.has('units/spear.png'));
  assert.ok(images.has('units/spear-attack-1.png'));
  assert.ok(images.has('units/spear-attack-2.png'));
  assert.ok(images.has('units/swoosh.png'));
});
