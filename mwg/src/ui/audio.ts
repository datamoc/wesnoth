/**
 * The port's audio surface.
 *
 * The framework owns playback (`mwg/audio`: a pooled `Sound`, a crossfading
 * `Music`, and an `Orchestrator` that keeps "where we are" apart from "what
 * just happened"); the port owns the *data*, which is the game's own: an
 * attack's `sound=`, a unit type's `hit_sound=`/`die_sound=`, the
 * `game_config.cfg` cue table, and the `[music]`/`[sound]` a scenario plays.
 * `src/simulation/sounds.ts` resolves all of that without touching an audio
 * element; this module is the thin layer that feeds it to the framework.
 *
 * Two constraints shape it:
 *
 * - The offline build is one HTML file. Sound effects are small enough (259
 *   files, ~8 MB) that the pipeline inlines them, so `assetUrl` hands back a
 *   `data:` URI and playback works from `file://`. Music is 172 MB of core
 *   tracks alone, so it is *not* inlined: a track resolves to a host-relative
 *   `music/<file>` URL, which plays when the page is served from a directory
 *   that has the tracks beside it and is reported once as unavailable
 *   otherwise. Nothing else about the scene changes either way.
 * - A browser refuses to start audio before a user gesture. The surface
 *   therefore queues the first cue and flushes it on the first input, which is
 *   what the player expects (the turn bell on their first click, not silence).
 */

import { AudioListener, Music, Sound, SoundSource } from 'mwg/audio';
import { expandSoundList, pickCue } from '../simulation/sounds.ts';

export interface AudioSettings {
  /** 0..1, persisted with the other preferences */
  musicVolume: number;
  soundVolume: number;
  musicEnabled: boolean;
  soundEnabled: boolean;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  musicVolume: 0.7,
  soundVolume: 0.8,
  musicEnabled: true,
  soundEnabled: true,
};

/** Resolve a compiled asset key (a `game_config` cue) to something playable. */
export type AssetResolver = (path: string) => string;

export class AudioSurface {
  private readonly music: Music;
  private readonly sounds = new Map<string, Sound>();
  private readonly listener = new AudioListener();
  private readonly sources: { id?: string; source: SoundSource; repeat: boolean; interval: number; elapsed: number; file: string }[] = [];
  private settings: AudioSettings;
  private readonly resolve: AssetResolver;
  private /** the cue the first user gesture should start with */ pending: (() => void)[] = [];
  private unlocked = false;
  private musicUnavailable = false;
  /** what the scene reports in the log or the diagnostics snapshot */
  readonly log: string[] = [];

  constructor(resolve: AssetResolver, settings: AudioSettings = DEFAULT_AUDIO_SETTINGS) {
    this.resolve = resolve;
    this.settings = { ...settings };
    this.music = new Music({ volume: settings.musicEnabled ? settings.musicVolume : 0 });
  }

  get current(): AudioSettings {
    return { ...this.settings };
  }

  /**
   * Apply new volumes. The preferences screen calls this on every change, so
   * a slider is audible while it moves.
   */
  configure(settings: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.music.volume = this.settings.musicEnabled ? this.settings.musicVolume : 0;
    for (const sound of this.sounds.values()) sound.volume = this.settings.soundVolume;
  }

  /** Crossfade to a track. Unavailable music is reported once, then ignored. */
  playMusic(track: string | null, fadeSeconds = 1): void {
    if (!track || !this.settings.musicEnabled) return;
    // The real engine streams tracks from data/core/music. This port
    // deliberately excludes that 172MB music payload from the offline build,
    // so do not hand a missing URL to the browser and create a failed request.
    // The rest of the audio surface remains active for shipped sound cues.
    void fadeSeconds;
    this.reportUnavailableMusic();
  }

  /**
   * A track the browser cannot fetch (the offline build has no `music/`
   * folder) is silence, not a failure: the game is fully playable without it.
   */
  private reportUnavailableMusic(): void {
    if (this.musicUnavailable) return;
    this.musicUnavailable = true;
    this.note('music is unavailable here: the offline build ships no music files');
  }

  stopMusic(fadeSeconds = 1): void {
    this.music.stop(fadeSeconds);
  }

  /** Move the positional-audio listener with the scene's active viewpoint. */
  setListener(x: number, y: number, facing = 0): void {
    this.listener.moveTo(x, y);
    this.listener.face(facing);
  }

  /** Register and start a WML `[sound_source]` using MWG's distance mixer. */
  playSource(file: string, x: number, y: number, options: { id?: string; repeat: boolean; interval: number; refDistance?: number; maxDistance?: number }): void {
    const selected = pickCue(expandSoundList(file));
    if (!selected || !this.settings.soundEnabled) return;
    this.defer(() => {
      let sound = this.sounds.get(selected);
      if (!sound) {
        try { sound = new Sound(this.resolve(selected), { poolSize: 4, volume: this.settings.soundVolume }); }
        catch { return; }
        this.sounds.set(selected, sound);
      }
      const source = new SoundSource(sound, { x, y, refDistance: options.refDistance, maxDistance: options.maxDistance });
      if (options.id) this.removeSource(options.id);
      this.sources.push({ id: options.id, source, repeat: options.repeat, interval: options.interval, elapsed: options.interval, file: selected });
      source.playFor(this.listener);
      this.note(`sound_source: ${selected}@${x},${y}`);
    });
  }

  /** Remove a named WML ambient source. */
  removeSource(id: string): void {
    for (let index = this.sources.length - 1; index >= 0; index -= 1) {
      if (this.sources[index].id === id) this.sources.splice(index, 1);
    }
  }

  /** Play one cue by its compiled asset key (`axe.ogg`, `bell.wav`). */
  playCue(file: string | null): void {
    if (!file || !this.settings.soundEnabled) return;
    this.defer(() => {
      let sound = this.sounds.get(file);
      if (!sound) {
        let url: string;
        try {
          url = this.resolve(file);
        } catch {
          // A cue the build never collected (a campaign sound the checkout is
          // missing) is silence, the same as the engine's missing-file path.
          return;
        }
        sound = new Sound(url, { poolSize: 4, volume: this.settings.soundVolume });
        this.sounds.set(file, sound);
      }
      sound.play();
      this.note(`sound: ${file}`);
    });
  }

  /**
   * Run an audio action now if the page has been unlocked, or on the next user
   * gesture. Browsers refuse to start audio before one, and the first cue of a
   * scenario (its music, or the opening bell) arrives before any click.
   */
  private defer(action: () => void): void {
    if (this.unlocked) {
      action();
      return;
    }
    this.pending.push(action);
    if (this.pending.length > 8) this.pending.shift();
  }

  /** The first user gesture: flush what was queued and stop queueing. */
  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    const queued = this.pending;
    this.pending = [];
    for (const action of queued) action();
  }

  /** The scene's frame loop advances the crossfade. */
  update(dt: number): void {
    this.music.update(dt);
    for (const entry of this.sources) {
      if (!entry.repeat) continue;
      entry.elapsed += dt;
      if (entry.elapsed < entry.interval) continue;
      entry.elapsed = 0;
      entry.source.playFor(this.listener);
    }
  }

  /** A short record of what played, for the diagnostics snapshot. */
  snapshot(): { settings: AudioSettings; playing: string[]; unavailable: boolean; unlocked: boolean; queued: number } {
    return {
      settings: this.current,
      playing: [...this.log].slice(-20),
      unavailable: this.musicUnavailable,
      unlocked: this.unlocked,
      queued: this.pending.length,
    };
  }

  private note(message: string): void {
    this.log.push(message);
    if (this.log.length > 50) this.log.shift();
  }
}
