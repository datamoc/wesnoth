// Only the pieces MWG has no renderer-facade name for stay on Pixi directly: the asset
// loader and the colour-matrix filter. Everything else uses MWG's facade classes below.
import { Assets, ColorMatrixFilter } from 'pixi.js';
import { Game, Input, Scene2D, hexDistance, hexNeighbors, hexToPixel, pixelToHex } from 'mwg';
import { Achievements, ActionJournal, Generator, PlayerStats, SaveSystem, UndoHistory, type AchievementDef, type ActionJournalEntry } from 'mwg/core';
import { MwlRuntime, type MwlCompiledGame, type MwlMessage, type MwlTraceEvent } from 'mwg/mwl';
import { applyImageModifiers, applyTextureModifiers, Container2D, croppedTexture, Minimap, Node2D, parseImagePath, recolorTexture, Shape2D, Sprite2D, Text2D, Texture2D, type PaletteMapping, type ParsedImagePath } from 'mwg/two-d/render';
import { FloatingTextStack, HelpScreen, RebindScreen, Window, WindowStack, type ListItem, type MarkupMeasure } from 'mwg/two-d/ui';
import { createSceneControls, type SceneControls } from 'mwg/testing';
import { createEngineHooks } from './scenarios/engine-hooks.ts';
import { Hud, TOP_BAR_HEIGHT, type HudModel } from './ui/hud.ts';
import { WorldConquest, wcCompiledGame, wcDifficulties, wcFactions, type WcSetup } from './scripting/world-conquest.ts';
import type { LuaGameServices, SideSettings } from './scripting/game-host.ts';
import { AudioSurface, type AudioSettings } from './ui/audio.ts';
import { attackCue, deathCue, expandSoundList, hitCue, musicPath, pickCue, statusCue, uiCue } from './simulation/sounds.ts';
import { TEXT_SCALES, actionWindow, applyWesnothTheme, listWindow, textWindow, widgetWindow, type MenuEntry } from './ui/menus.ts';
import { CARRYOVER_GOLD_PERCENT, carryoverFor, describeCarryover, nextScenarioWithOverride, type CampaignDefinition, type Carryover } from './campaign.ts';
import { CAMPAIGNS } from './generated/campaigns.ts';
import { GAME_DATA } from './generated/game-data.ts';
import { DEFAULT_SCENARIO, MULTIPLAYER_SCENARIO_ORDER, SCENARIO_COMPATIBILITY, SCENARIO_ORDER, SCENARIO_TITLES, SCENARIOS } from './generated/scenarios.ts';
import { UNIT_ANIMATIONS } from './generated/unit-animations.ts';
import { ASSET_URLS, assetUrl } from './generated/assets.ts';
import { OVERLAY_PATH, TERRAIN_PATH } from './generated/terrain-art.ts';

// Placeholder for the title screen background
import { TERRAIN_RULES } from './generated/terrain-transitions.ts';
import { COLOR_PALETTES, COLOR_RANGES, DEFAULT_COLOR_RANGES } from './generated/team-colors.ts';
import { frameAt, totalDuration, type AnimFrame, type UnitAnimations } from './simulation/animation.ts';
import { lifecycleEvents, turnContextVariables } from './simulation/event-lifecycle.ts';
import { areAllied, attackWithRules, activeSchedule, endTurn, incomeFor, upkeepFor, isFogged, isKeepHex, isShrouded, lawfulBonusAt, makeGame, predictAttack, recruit, setTerrainAt, sideLeaders, teamOf, terrainCodeAt, unitAt, updateVision, vacantRecruitHexes, type GameState } from './simulation/game.ts';
import { reachable, moveUnit, movetypeOf } from './simulation/movement.ts';
import { isHidden } from './simulation/vision.ts';
import { buildTerrainTiles, type BuiltTerrainImage } from './simulation/terrain-graphics.ts';
import { resolveTerrain, splitCode } from './simulation/terrain.ts';
import { damagePerStrike, chanceToHit, resistanceOf, type CombatExchange } from './simulation/combat.ts';
import { makeUnit, makeUnitWithTraits, type Unit } from './simulation/unit.ts';
import type { WesnothData } from './simulation/types.ts';
import { WesnothNetworkSession, type WesnothNetworkSnapshot } from './simulation/network.ts';
import { planSide } from './ai/plan.ts';
import { applyAspects, policyFor, type AiPolicy, type Difficulty } from './ai/policy.ts';
import { createReplay, decodeReplay, encodeReplay, replayActions, type WesnothAction, type WesnothEvent } from './simulation/replay.ts';
import { mwgSpritePath, resolveNamedColour } from './simulation/image-modifiers.ts';
import { paletteMapping } from './simulation/color-range.ts';
import { syncStateHash } from './simulation/sync.ts';
import { SaveError, SAVE_VERSION, decodeSaveExport, encodeSaveExport, normalizeSave, saveFileName, type WesnothRuleState, type WesnothSavePayload } from './simulation/save.ts';
import { wesnothAccessibilityText, wrapWesnothMarkup } from './ui/text-markup.ts';
import { availableLocales, isRightToLeft, localeFromLocation, localeName, translatorFor } from './ui/language.ts';

/** One entry of a Lua dialog tree (the invest dialog's categories and items). */
interface LuaTreeNode {
  name?: unknown;
  desc?: unknown;
  category?: unknown;
  path?: unknown;
  children?: unknown;
}

/** The scenario name the scene uses while a World Conquest map is running (its map is generated, not compiled). */
const WC_SCENARIO = 'wc-lua';

/** A running World Conquest campaign: the Lua controller and the current generated map. */
interface LuaGame {
  wc: WorldConquest;
  setup: WcSetup;
  factionId: string;
  compiled: ReturnType<typeof wcCompiledGame>;
  settings: Map<number, SideSettings>;
  /** the player's surviving units from the previous map, recalled into this one */
  carried: Unit[];
  /** set by Lua's `[endlevel]` */
  ended: 'victory' | 'defeat' | null;
}

const TILE = 36;
const HEX_POINTS = [-TILE / 2, 0, -TILE / 4, -TILE / 2, TILE / 4, -TILE / 2, TILE / 2, 0, TILE / 4, TILE / 2, -TILE / 4, TILE / 2];

/** The hex outline translated to a centre, for the merged overlay `Shape2D`. */
function translatedHex(cx: number, cy: number): number[] {
  const out: number[] = [];
  for (let index = 0; index < HEX_POINTS.length; index += 2) out.push(HEX_POINTS[index] + cx, HEX_POINTS[index + 1] + cy);
  return out;
}

/** Wesnoth terrain art is authored against 72px hexes. */
const TILE_SOURCE = 72;
/**
 * Art that is an overlay sprite rather than a hex tile, from its measured alpha
 * and size (mountains/basic.png is 180x216 and 87% transparent).
 */
const OVERLAY_ONLY = new Set<string>(["terrain/mountains/basic.png"]);
/** Ground drawn under an overlay-only base, when a code has no tile of its own. */
const GROUND_FOR: Record<string, string> = { Mm: "terrain/hills/regular.png" };
/** Milliseconds one hex of a move animation takes (`src/animated.cpp` uses ~0.13s). */
const MOVE_MS_PER_HEX = 130;

/** How a unit view is animating right now. */
type ViewState = 'idle' | 'move' | 'attack' | 'dead';

/**
 * One unit's persistent sprites. The rules move the unit instantly; the view is
 * what interpolates, which is why it is kept outside the board rebuild.
 */
interface UnitView {
  unit: Unit;
  container: Container2D;
  sprite: Sprite2D;
  health: Shape2D;
  /** the frame image currently bound, so a texture is only re-fetched on change */
  lastImage: string;
  state: ViewState;
  /** ms spent in the current non-looping animation */
  elapsed: number;
  /** board-space pixels the current move animation runs between */
  moveFrom: { x: number; y: number } | null;
  moveTo: { x: number; y: number } | null;
  moveDuration: number;
}

interface HaloView {
  readonly sprite: Sprite2D;
  readonly frames: readonly { image: string; duration: number }[];
  frameIndex: number;
  frameRemaining: number;
  remaining: number;
}

interface ProjectileView {
  readonly sprite: Sprite2D;
  readonly frames: readonly AnimFrame[];
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
  elapsed: number;
}

const ACHIEVEMENT_DEFS: AchievementDef[] = [
  { id: 'arvith_the_great_knight', counter: 'achievement:arvith_the_great_knight', target: 1, description: 'Arvith reaches the rank of great knight.' },
  { id: 'heroes_of_maghre', counter: 'achievement:heroes_of_maghre', target: 1, description: 'The heroes of Maghre are gathered.' },
  { id: 'treasure', counter: 'achievement:treasure', target: 1, description: 'The hidden treasure is recovered.' },
  { id: 'baran_returns', counter: 'achievement:baran_returns', target: 1, description: 'Baran returns to the village.' },
];

/** The next text scale in the cycle (`src/ui/menus.ts`'s TEXT_SCALES), wrapping to 100%. */
function nextTextScale(current: number): number {
  const index = TEXT_SCALES.indexOf(current);
  return TEXT_SCALES[(index + 1) % TEXT_SCALES.length];
}

/** The language after English in the preferences cycle, wrapping back to English. */
function nextLocale(current: string): string {
  const ids = ['en', ...availableLocales().map((locale) => locale.id)];
  const index = ids.indexOf(current);
  return ids[(index + 1) % ids.length];
}

function createAchievements(data?: { counts: [string, number][] }): Achievements {
  return data ? Achievements.fromJSON(ACHIEVEMENT_DEFS, data) : Achievements.fromJSON(ACHIEVEMENT_DEFS, { counts: [] });
}

interface WesnothStats {
  actions: number;
  moves: number;
  attacks: number;
  recruits: number;
  kills: number;
  victories: number;
  defeats: number;
}

const EMPTY_STATS: WesnothStats = { actions: 0, moves: 0, attacks: 0, recruits: 0, kills: 0, victories: 0, defeats: 0 };

/**
 * The hexes a scenario asks the player to reach: every `unit_at` victory
 * objective. They are drawn with a marker so a scripted scenario can say
 * "deliver this to the village" without a minimap or an objective list.
 */
function objectiveHexes(game: MwlCompiledGame): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const visit = (node: (typeof game.roots)[number]): void => {
    if (node.tag === 'victory' && node.attributes.condition === 'unit_at') {
      const x = Number(node.attributes.x);
      const y = Number(node.attributes.y);
      if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
    }
    node.children.forEach(visit);
  };
  game.roots.forEach(visit);
  return out;
}

function objectiveSummary(game: MwlCompiledGame): string[] {
  const out: string[] = [];
  const visit = (node: (typeof game.roots)[number]): void => {
    if (node.tag === 'objectives') {
      if (node.attributes.victory) out.push(`Win: ${node.attributes.victory}`);
      if (node.attributes.defeat) out.push(`Lose: ${node.attributes.defeat}`);
    }
    node.children.forEach(visit);
  };
  game.roots.forEach(visit);
  return out;
}

function scenarioCarryoverPercent(runtime: MwlRuntime): number {
  const value = Number(runtime.world.variables.carryover_percentage ?? CARRYOVER_GOLD_PERCENT);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : CARRYOVER_GOLD_PERCENT;
}

/** Is early-finish gold declared for this scenario (`[endlevel] bonus=yes`)? */
function scenarioWantsBonus(runtime: MwlRuntime): boolean {
  return runtime.world.variables.carryover_bonus === 'yes';
}

/** Build the data-driven encyclopedia shown by the Help window. */
export function buildEncyclopediaTopics(data: WesnothData): { title: string; body: string }[] {
  const topics: { title: string; body: string }[] = [
    { title: 'Controls', body: "Click a unit, then a highlighted hex to move. Click an adjacent enemy to attack. Space ends the selected unit's turn; Ctrl+Space ends your whole turn, like Wesnoth's own endturn; U undoes the last player action." },
    { title: 'Keyboard play', body: 'Arrow keys move the hex cursor, Enter selects the unit there or moves and attacks with the one already selected, N cycles to the next unit with moves left, D describes the unit under the cursor, and Escape deselects. Every menu is driven by the arrows and Enter as well.' },
    { title: 'Accessibility', body: 'Preferences offers text size (100-150%), a high-contrast theme, a reduce-motion switch (which follows your system setting until you change it), volume controls and the language. All hotkeys are rebindable in Controls.' },
    { title: 'Terrain', body: 'Terrain affects movement, defence, healing and income. The entries below are generated from the loaded core terrain table.' },
    { title: 'Units', body: 'Unit entries contain the real hitpoints, movement, cost, experience, advancement and attacks from the compiled core data.' },
    { title: 'Abilities', body: 'Ability entries are the registry definitions loaded from the core abilities macros.' },
    { title: 'Weapon specials', body: 'Weapon-special entries are the registry definitions loaded from the core weapon-special macros.' },
  ];
  for (const terrain of Object.values(data.terrains).sort((a, b) => a.id.localeCompare(b.id))) {
    topics.push({
      title: `Terrain: ${terrain.id}`,
      body: `Map code: ${terrain.code}\nHealing: ${terrain.heals || 0}\nIncome: ${terrain.givesIncome ? 'yes' : 'no'}\nAliases: ${terrain.aliasof.join(', ') || 'none'}`,
    });
  }
  for (const unit of Object.values(data.unitTypes).sort((a, b) => a.name.localeCompare(b.name))) {
    const attacks = unit.attacks.map((attack) => `${attack.name}: ${attack.damage}×${attack.number} ${attack.type} (${attack.range})`).join('\n');
    topics.push({
      title: `Unit: ${unit.name || unit.id}`,
      body: `Race: ${unit.race}\nLevel ${unit.level} — ${unit.hitpoints} HP — ${unit.movement} movement — ${unit.cost} gold\nXP: ${unit.experience}\nAlignment: ${unit.alignment}\nAbilities: ${unit.abilities.join(', ') || 'none'}\nAdvances to: ${unit.advancesTo.join(', ') || 'none'}\nAttacks:\n${attacks || 'none'}`,
    });
  }
  for (const entry of Object.values(data.abilities).sort((a, b) => a.name.localeCompare(b.name))) {
    topics.push({ title: `Ability: ${entry.name || entry.id}`, body: `Id: ${entry.id}\nEffect: ${entry.tag}\n${entry.effects.map((effect) => effect.tag).join(', ') || 'No direct effect details.'}` });
  }
  for (const entry of Object.values(data.weaponSpecials).sort((a, b) => a.name.localeCompare(b.name))) {
    topics.push({ title: `Special: ${entry.name || entry.id}`, body: `Id: ${entry.id}\nEffect: ${entry.tag}\n${entry.effects.map((effect) => effect.tag).join(', ') || 'No direct effect details.'}` });
  }
  return topics;
}

/** A campaign's difficulty define (`EASY`, `HARD`) mapped to the AI policy name. */
function difficultyFromCampaign(id: string): Difficulty {
  const lower = id.toLowerCase();
  return lower === 'easy' || lower === 'hard' ? lower : 'normal';
}

/**
 * The browser skirmish, driven by the compiled MWL scenario.
 *
 * `MwlRuntime` owns the scenario: sides, gold, starting units, events, and the
 * win/lose objectives. The port's `src/simulation` owns the real rules:
 * terrain, pathfinding, combat, experience. After each action the scene writes
 * the rule results back into the runtime world and asks it to evaluate the
 * objectives, so victory and defeat come from MWL, not from ad hoc checks.
 */
// Declare __WESNOTH__ on the window object for testing
declare global {
  interface Window {
    __WESNOTH__: {
      state?: any;
      data?: any;
      scene?: any;
      endTurn?: () => void;
      controls?: SceneControls;
    };
  }
}

class WesnothScene extends Scene2D {
  /** Whether autoplay is enabled (simulate turns without user input). */
  private autoplay = false;
  private readonly saves = new SaveSystem<WesnothSavePayload>({ namespace: 'mwg-wesnoth', version: 1 });
  /** Rebindable keys, persisted separately from a game save. */
  private readonly settings = new SaveSystem<{ bindings?: Record<string, string[]>; language?: string; theme?: { textScale?: number; highContrast?: boolean; reducedMotion?: boolean } } & Partial<AudioSettings>>({ namespace: 'mwg-wesnoth-settings', version: 1 });
  /** The framework's window stack: every menu and dialog lives on it. */
  private readonly windows = new WindowStack();
  /**
   * Set when a window closes, so the same Escape keypress that closed a menu
   * does not immediately reopen it in the same frame.
   */
  private suppressMenuToggle = false;
  private runtime!: MwlRuntime;
  private state!: GameState;
  private gold: Record<number, number> = {};
  /** the player's chosen campaign difficulty, feeding the AI policy (P6f) */
  private difficulty: Difficulty = 'normal';
  /** When enabled, both local sides use the same board controls instead of AI. */
  private localMultiplayer = false;
  /** Controller declared by each scenario side, populated from MWL. */
  private sideControllers = new Map<number, string>();
  /** Factions selected in the local MP setup, keyed by Wesnoth side number. */
  private multiplayerFactions = new Map<number, string>();
  private network: WesnothNetworkSession | null = null;
  private achievements = createAchievements();
  private readonly statistics = new PlayerStats<WesnothStats>({
    namespace: 'mwg-wesnoth',
    initial: EMPTY_STATS,
    combine: (total, summary) => ({
      actions: total.actions + summary.actions,
      moves: total.moves + summary.moves,
      attacks: total.attacks + summary.attacks,
      recruits: total.recruits + summary.recruits,
      kills: total.kills + summary.kills,
      victories: total.victories + summary.victories,
      defeats: total.defeats + summary.defeats,
    }),
  });
  /** the campaign being played, so `next_scenario` follows its own chain (P7) */
  private campaign: CampaignDefinition | null = null;
  /** MWL scenario unit id -> the simulation unit it drives */
  private unitsById = new Map<string, Unit>();
  private storedUnits = new Map<string, { key: string; unit: Unit }>();
  private recallList: Carryover['units'][number][] = [];
  private selected: Unit | null = null;
  private outcome: 'playing' | 'won' | 'lost' = 'playing';
  private board = new Node2D();
  /** Current WML camera target, in map coordinates; null means fit-map layout. */
  private cameraTarget: { x: number; y: number } | null = null;
  /**
   * The board is drawn in three persistent layers instead of rebuilding a
   * container per cell: terrain art is static for the whole scenario, the
   * overlay (selection, reachable cells, fog) is one merged `Shape2D`, and the
   * units are long-lived views the animation loop advances. Input is a single
   * hit area over the board, so a 39x26 map has one pointer listener, not 1000.
   */
  private terrainLayer = new Node2D();
  /** Transition images that draw in front of units (`layer >= 0` and `basey >= UNITPOS`). */
  private terrainForegroundLayer = new Node2D();
  private overlayLayer = new Node2D();
  private unitLayer = new Node2D();
  /** `[item]` pictures the Lua kernel put on the map (`wesnoth.interface.add_hex_overlay`) */
  private itemLayer = new Node2D();
  private haloLayer = new Node2D();
  private hitLayer = new Shape2D();
  private unitViews = new Map<string, UnitView>();
  private halos: HaloView[] = [];
  private projectiles: ProjectileView[] = [];
  /**
   * Terrain sprites waiting on an asynchronously loaded texture, by image path.
   * Terrain is built once, so unlike the old per-refresh rebuild these sprites
   * must be updated in place when their texture finally arrives.
   */
  private artSprites = new Map<string, { sprite: Sprite2D; parsed: ParsedImagePath }[]>();
  private ui = new Node2D();
  private minimap: Minimap | null = null;
  private minimapUnits = new Shape2D();
  private minimapDimensions = { width: 0, height: 0 };
  private minimapCell = 3;
  private status!: Text2D;
  private hud!: Hud;
  /** the World Conquest campaign in progress, when one is */
  private luaGame: LuaGame | null = null;
  /** the title screen's background and logo, shown under the main menu windows */
  private titleLayer = new Node2D();
  private titleOpen = false;
  private log = '';
  private textureCache = new Map<string, Texture2D>();
  private loadingTextures = new Set<string>();
  /** Team-coloured textures, keyed by `path|colorRangeId`, rebuilt from the magenta palette. */
  private teamTextures = new Map<string, Texture2D>();
  private teamTextureLoading = new Set<string>();
  private colorMappings = new Map<string, PaletteMapping>();
  /** One 2D context reused to measure markup, so wrapping uses the same font Pixi draws with. */
  private markupMeasureContext: CanvasRenderingContext2D | null = null;
  private refreshScheduled = false;
  private scenarioName = DEFAULT_SCENARIO;
  private objectives: { x: number; y: number }[] = [];
  private objectiveLines: string[] = [];
  private hoveredHex: { x: number; y: number } | null = null;
  /** Whether Ctrl/Cmd was held for the current key press (`Ctrl+Space` ends the turn). */
  private modifierHeld = false;
  /**
   * Reduced motion: the OS preference unless a preference overrides it. The
   * scene still resolves every action through the rules; this only shortens the
   * presentation that plays beside it.
   */
  private reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  /** The user's own motion override; null follows the OS. */
  private reducedMotionOverride: boolean | null = null;
  /** Text scale and contrast, from the preferences (see `applyWesnothTheme`). */
  private textScale = 1;
  private highContrast = false;
  /** The keyboard cursor: the hex the arrows move and Enter acts on. */
  private cursor = { x: 0, y: 0 };
  private cursorVisible = false;
  private hiddenSides = new Set<number>();
  /** what the next scenario inherits when the current one is won */
  private carryover: Carryover | null = null;
  /** Campaign-global WML variables survive rebuilding the scenario runtime. */
  private globalVariables: Record<string, import('mwg/mwl').MwlValue> = {};
  private endScreen = new Node2D();
  private endScreenOpen = false;
  private endScreenTitle = '';
  private endScreenLines: string[] = [];
  private endScreenHint = '';
  private attackDialog = new Node2D();
  private pendingAttack: { attacker: Unit; defender: Unit } | null = null;
  private floatingTextStack = new FloatingTextStack();
  /** messages waiting to be read, one dialogue box at a time */
  private dialogueQueue: MwlMessage[] = [];
  private dialogueOpen = false;
  private dialogue = new Node2D();
  private dialogueMessage: MwlMessage | null = null;
  /** Recent MWL lifecycle records, available through the developer handle. */
  private runtimeTrace: MwlTraceEvent[] = [];
  private journal = new ActionJournal<WesnothAction, WesnothEvent>();
  private replaying = false;
  /** Bounded player-action history; MWG stores and steps the snapshots, the port supplies them. */
  private readonly undo = new UndoHistory<WesnothSavePayload>({ limit: 32 });
  /** True while `restoreUndo` rebuilds the scenario, so the rebuild does not reset the history. */
  private restoringState = false;
  private readonly diagnostics = globalThis.location?.search.includes('diagnostics=1') ?? false;
  /**
   * The scenario's random stream: the framework's seeded `Generator`
   * (`mwg/core`), reseeded every scenario. Trait rolls, combat rolls and the
   * AI draw from this instead of `Math.random`, so recording the seed (P9
   * persistence) replays the scenario identically. The simulation itself
   * stays injectable (`Rng` parameters) and never imports the framework.
   */
  private rng = new Generator((Date.now() % 2147483647) >>> 0);
  private roll = (): number => this.rng.float();

  override create(): void {
    // Initialize window.__WESNOTH__ if not already done
    if (!window.__WESNOTH__) {
      window.__WESNOTH__ = {};
      console.log('window.__WESNOTH__ initialized');
    }
    // Enable autoplay if the URL hash contains "autoplay"
    if (window.location.hash.includes('autoplay')) {
      this.autoplay = true;
      console.log('Autoplay enabled');
    }
    // Expose endTurn and scene for testing
    window.__WESNOTH__ = window.__WESNOTH__ || {};
    window.__WESNOTH__.endTurn = () => {
      if (this.state && GAME_DATA) {
        endTurn(this.state, GAME_DATA);
      }
    };
    window.__WESNOTH__.scene = this;
    applyWesnothTheme();
    // The defaults follow Wesnoth's own (`data/core/hotkeys.cfg`): `endturn` is
    // Ctrl+Space, `endunitturn` is Space, `cycle` is N, `describeunit` is D.
    // The framework binds physical keys without modifiers, so the one modifier
    // Wesnoth needs is read from the key event itself (`onKey` below). Enter is
    // the port's keyboard-play key (select, move, attack, confirm); J jumps to
    // the next scenario, the port convenience N used to carry.
    Input.bind('confirm', ['Enter']);
    Input.bind('endTurn', ['Space']);
    Input.bind('cursorUp', ['ArrowUp']);
    Input.bind('cursorDown', ['ArrowDown']);
    Input.bind('cursorLeft', ['ArrowLeft']);
    Input.bind('cursorRight', ['ArrowRight']);
    Input.bind('cycleUnit', ['KeyN']);
    Input.bind('describeUnit', ['KeyD']);
    Input.bind('restart', ['KeyR']);
    Input.bind('nextScenario', ['KeyJ']);
    Input.bind('saveGame', ['KeyS']);
    Input.bind('loadGame', ['KeyL']);
    Input.bind('undo', ['KeyU']);
    Input.bind('redo', ['KeyY']);
    Input.bind('objectives', ['KeyO']);
    Input.bind('menu', ['KeyM']);
    // The one modifier Wesnoth's defaults need: Ctrl+Space ends the turn,
    // plain Space ends the selected unit's turn (`endunitturn`).
    Input.onKey.add((event: KeyboardEvent) => {
      this.modifierHeld = event.ctrlKey || event.metaKey;
    });
    // Restore rebindings before the first frame, so a saved key layout is live.
    try {
      const saved = this.settings.load('bindings');
      if (saved?.state.bindings) Input.importBindings(saved.state.bindings);
    } catch {
      // a corrupt settings blob falls back to the defaults
    }
    // Volume preferences, and the gesture that lets the browser play anything.
    try {
      const saved = this.settings.load('audio');
      if (saved?.state) this.audio.configure(saved.state);
    } catch {
      // a corrupt settings blob falls back to the defaults
    }
    // Accessibility: text size, contrast and the motion override.
    try {
      const saved = this.settings.load('theme');
      const theme = saved?.state as { textScale?: number; highContrast?: boolean; reducedMotion?: boolean } | undefined;
      if (theme?.textScale) this.textScale = theme.textScale;
      if (theme?.highContrast) this.highContrast = theme.highContrast;
      if (theme?.reducedMotion !== undefined) this.reducedMotionOverride = theme.reducedMotion;
      applyWesnothTheme({ textScale: this.textScale, highContrast: this.highContrast });
    } catch {
      // a corrupt settings blob falls back to the shipped theme
    }
    // The language: a `?lang=` parameter wins (it is how a test or a link picks
    // one), else the saved choice, else English.
    try {
      const fromUrl = localeFromLocation(globalThis.location?.search ?? '');
      const saved = this.settings.load('language');
      const savedLocale = (saved?.state as { language?: string } | undefined)?.language;
      this.locale = fromUrl !== 'en' ? fromUrl : (savedLocale && (savedLocale === 'en' || localeName(savedLocale) !== 'English') ? savedLocale : 'en');
    } catch {
      // a corrupt settings blob falls back to English
    }
    for (const type of ['pointerdown', 'keydown'] as const) {
      globalThis.addEventListener?.(type, () => this.audio.unlock(), { once: true });
    }
    this.board.addChild(this.terrainLayer, this.overlayLayer, this.itemLayer, this.unitLayer, this.terrainForegroundLayer, this.haloLayer, this.hitLayer);
    // One listener for the whole board: the hex is recovered from the pointer
    // position instead of from a per-cell container's own handlers.
    this.hitLayer.eventMode = 'static';
    this.hitLayer.cursor = 'pointer';
    this.hitLayer.on('pointertap', (event) => {
      const hex = this.hexAt(event.getLocalPosition(this.board));
      if (hex) this.click(hex.x, hex.y);
    });
    this.hitLayer.on('pointermove', (event) => {
      const hex = this.hexAt(event.getLocalPosition(this.board));
      if (!hex || (this.hoveredHex?.x === hex.x && this.hoveredHex.y === hex.y)) return;
      this.hoveredHex = hex;
      this.refresh();
    });
    this.hitLayer.on('pointerout', () => {
      if (!this.hoveredHex) return;
      this.hoveredHex = null;
      this.refresh();
    });
    this.stage.addChild(this.board, this.ui);
    this.status = new Text2D({ text: '', style: { fill: 0xf4edd9, fontSize: 13, fontFamily: 'system-ui', wordWrap: true, wordWrapWidth: 900 } });
    this.status.visible = false;
    this.ui.addChild(this.status);
    this.hud = new Hud((path) => this.texture(path));
    this.ui.addChildAt(this.hud, 0);
    this.ui.addChild(this.floatingTextStack);
    this.ui.addChild(this.minimapUnits);
    this.attackDialog.visible = false;
    this.ui.addChild(this.attackDialog);
    this.dialogue.visible = false;
    this.ui.addChild(this.dialogue);
    this.endScreen.visible = false;
    this.ui.addChild(this.endScreen);
    // The title backdrop sits just below the window stack, which is topmost: every menu
    // and dialog is a window on it.
    this.titleLayer.visible = false;
    this.ui.addChild(this.titleLayer);
    this.ui.addChild(this.windows);
    this.startScenario();
    this.ensureMinimap();
    this.resize(Game.current.width, Game.current.height);
    this.refresh();
    // Without a `#scenario` in the URL the game opens on its main menu, the way
    // the real client does; a direct link goes straight to the board.
    const requested = globalThis.location?.hash.replace(/^#/, '');
    if (!requested || !SCENARIOS[requested]) this.openMainMenu();
  }

  /** Convert a pointer position in board space to the hex under it, or null off-map. */
  private hexAt(point: { x: number; y: number }): { x: number; y: number } | null {
    if (!this.state) return null;
    const hex = pixelToHex(point.x, point.y, TILE, TILE);
    if (hex.x < 0 || hex.y < 0 || hex.x >= this.state.width || hex.y >= this.state.height) return null;
    return hex;
  }

  /**
   * Build the session from a compiled MWL scenario. Without arguments it uses
   * the scenario in the URL hash; the campaign continues with an explicit name
   * and the carry-over it earned.
   */
  private startScenario(name?: string, incoming: Carryover | null = null, seed?: number): void {
    this.floatingTextStack.clear();
    this.halos.forEach((halo) => halo.sprite.destroy());
    this.halos = [];
    this.projectiles.forEach((projectile) => projectile.sprite.destroy());
    this.projectiles = [];
    this.haloLayer.removeChildren();
    if (name === WC_SCENARIO && this.luaGame) this.scenarioName = name;
    else if (name && SCENARIOS[name]) this.scenarioName = name;
    else {
      const requested = globalThis.location?.hash.replace(/^#/, '');
      if (requested && SCENARIOS[requested]) this.scenarioName = requested;
    }
    if (this.scenarioName !== WC_SCENARIO) this.luaGame = null;
    const scenarioTemplate = this.luaGame && this.scenarioName === WC_SCENARIO
      ? this.luaGame.compiled
      : SCENARIOS[this.scenarioName] ?? SCENARIOS[DEFAULT_SCENARIO];
    const scenario = this.isRandomMultiplayerScenario(this.scenarioName)
      ? this.generateRandomMultiplayerScenario(scenarioTemplate)
      : scenarioTemplate;
    this.objectives = objectiveHexes(scenario);
    this.objectiveLines = objectiveSummary(scenario);
    this.hiddenSides.clear();
    this.cameraTarget = null;
    this.rng = new Generator(seed);
    this.unitsById.clear();
    this.storedUnits.clear();
    this.recallList = [];
    // The previous scenario's sprites and textures are not this one's; release
    // them before the new map builds its own layers.
    this.releaseScenarioAssets();
    this.runtimeTrace = [];
    this.journal = new ActionJournal<WesnothAction, WesnothEvent>();
    // A fresh scenario starts a new history; an undo rebuild keeps the one it is stepping.
    if (!this.restoringState) this.undo.clear();
    this.dialogueQueue = [];
    this.dialogueOpen = false;
    this.dialogue.visible = false;
    this.windows.closeAll();
    this.cancelAttack();
    this.endScreenOpen = false;
    this.endScreen.visible = false;
    this.carryover = null;
    // Scenario events call these hooks; the hooks call the real rules.
    const hooks = createEngineHooks({
      data: GAME_DATA,
      state: () => this.state,
      unit: (id) => this.unitsById.get(id),
      units: () => this.state.units,
      globalVariables: this.globalVariables,
      log: (text) => {
        this.log = text;
      },
      scrollTo: (x, y) => {
        this.cameraTarget = { x, y };
        this.layoutBoard(Game.current.width, Game.current.height);
      },
      // `[music]` and `[sound]` from scenario content: the scene owns playback,
      // the scenario says when.
      playMusic: (file, options) => this.audio.playMusic(musicPath(file), options.fade),
      playSound: (file) => this.audio.playCue(file),
      playSoundSource: (file, x, y, options) => this.audio.playSource(file, x, y, options),
      removeSoundSource: (id) => this.audio.removeSource(id),
      configureAudio: (settings) => this.audio.configure(settings),
      gold: (side) => this.gold[side] ?? 0,
      storeUnit: (variable, filter, kill) => {
        // Real engine (action_wml.cpp [store_unit]): every matching unit is stored, as an array.
        const matches = [...this.unitsById.entries()].filter(([, unit]) =>
          (!filter.id || unit.id.toString() === filter.id || unit.name === filter.id) &&
          (!filter.side || unit.side === Number(filter.side)) &&
          (!filter.type || unit.typeId === filter.type) &&
          !(filter.notId && (unit.id.toString() === filter.notId || unit.name === filter.notId || unit.wmlId === filter.notId)) &&
          !(filter.notType && unit.typeId === filter.notType));
        if (!variable) return [];
        const handles: string[] = [];
        matches.forEach(([key, unit], index) => {
          const copy: Unit = { ...unit, traits: [...unit.traits], attacks: unit.attacks.map((attack) => ({ ...attack })), extraAbilities: [...unit.extraAbilities] };
          const handle = `${variable}#${index}`;
          const entry = { key, unit: copy };
          this.storedUnits.set(handle, entry);
          // a plain `variable=name` unstore reads the first (usually only) stored unit
          if (index === 0) this.storedUnits.set(variable, entry);
          handles.push(handle);
          if (kill) {
            this.unitsById.delete(key);
            this.state.units = this.state.units.filter((candidate) => candidate !== unit);
          }
        });
        return handles;
      },
      unstoreUnit: (variable, x, y, side) => {
        const stored = this.storedUnits.get(variable);
        if (!stored) return;
        const unit = stored.unit;
        const targetSide = side ? Number(side) : unit.side;
        const keep = this.state.keeps.get(targetSide)?.[0];
        const parse = (value: string | undefined, fallback: number): number => {
          if (!value || value === 'recall') return fallback;
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed - 1 : fallback;
        };
        unit.side = targetSide;
        unit.x = parse(x, keep?.x ?? unit.x);
        unit.y = parse(y, keep?.y ?? unit.y);
        // Real engine (src/game_events/action_wml.cpp [unstore_unit]): a unit with the same id is
        // replaced, e.g. HttT 01 puts the stored Konrad over the placeholder it created.
        const replaced = this.unitsById.get(stored.key);
        if (replaced && replaced !== unit) this.state.units = this.state.units.filter((candidate) => candidate !== replaced);
        this.unitsById.set(stored.key, unit);
        if (!this.state.units.some((candidate) => candidate.id === unit.id)) this.state.units.push(unit);
        // the handle and the plain-name alias of this one stored unit go together
        for (const [name, entry] of this.storedUnits) if (entry === stored) this.storedUnits.delete(name);
      },
      spawnUnit: (id, type, side, x, y) => {
        if (this.unitsById.has(id)) return;
        const unit = makeUnit(GAME_DATA, type, side, x, y, this.roll);
        unit.wmlId = id;
        this.state.units.push(unit);
        this.unitsById.set(id, unit);
      },
      recallUnit: (id) => {
        const entry = [...this.storedUnits.entries()].find(([key, stored]) => key === id || stored.unit.name === id);
        if (!entry) return;
        const [variable, stored] = entry;
        const keep = this.state.keeps.get(stored.unit.side)?.[0];
        if (!keep) return;
        stored.unit.x = keep.x;
        stored.unit.y = keep.y;
        this.unitsById.set(stored.key, stored.unit);
        if (!this.state.units.includes(stored.unit)) this.state.units.push(stored.unit);
        this.storedUnits.delete(variable);
      },
      recallUnitByFilter: (filter) => {
        const index = this.recallList.findIndex((entry) =>
          (!filter.id || entry.name === filter.id || entry.wmlId === filter.id) && (!filter.type || entry.typeId === filter.type));
        if (index < 0) return false;
        const entry = this.recallList[index];
        const side = 1;
        // `[recall] x= y=` (1-based) puts the unit there; without them it takes a free castle hex
        const at = filter.x && filter.y ? { x: Number(filter.x) - 1, y: Number(filter.y) - 1 } : this.recallHex(side);
        if (!at || !this.runtime) return false;
        const unit = makeUnitWithTraits(GAME_DATA, entry.typeId, side, at.x, at.y, entry.traits ?? []);
        unit.name = entry.name;
        unit.hitpoints = Math.max(1, Math.min(unit.maxHitpoints, entry.hitpoints));
        unit.experience = entry.experience;
        unit.loyal = entry.loyal;
        unit.extraAbilities = [...(entry.extraAbilities ?? [])];
        if (entry.canRecruit) unit.canRecruit = true;
        // keep the unit's WML id so later `id=Konrad` filters still find it
        const id = entry.wmlId && !this.unitsById.has(entry.wmlId) ? entry.wmlId : `recall-filter-${index}-${unit.id}`;
        unit.wmlId = id;
        this.state.units.push(unit);
        this.unitsById.set(id, unit);
        this.recallList.splice(index, 1);
        return true;
      },
      replaceUnit: (previous, replacement) => {
        for (const [key, unit] of this.unitsById) if (unit === previous) this.unitsById.set(key, replacement);
      },
      putToRecallList: (id, heal) => {
        const entry = [...this.unitsById.entries()].find(([key, unit]) => key === id || unit.name === id || unit.id.toString() === id);
        if (!entry) return;
        const [key, unit] = entry;
        this.recallList.push({
          typeId: unit.typeId,
          name: unit.name,
          hitpoints: heal ? unit.maxHitpoints : unit.hitpoints,
          experience: unit.experience,
          traits: [...unit.traits],
          loyal: unit.loyal,
          extraAbilities: [...unit.extraAbilities],
          wmlId: key,
          ...(unit.canRecruit ? { canRecruit: true } : {}),
        });
        this.unitsById.delete(key);
        this.state.units = this.state.units.filter((candidate) => candidate !== unit);
      },
      makeLoyal: (id) => {
        const unit = this.unitsById.get(id);
        if (unit) unit.loyal = true;
      },
      setAchievement: (id) => this.unlockAchievement(id),
      killUnit: (id) => {
        // The scenario names a unit by WML id; match the registry key or the
        // unit's name, and do nothing when neither is on the map (WML semantics).
        const entry = [...this.unitsById.entries()].find(([key, unit]) => key === id || unit.name === id || unit.id.toString() === id);
        if (!entry) return;
        const [key, unit] = entry;
        unit.hitpoints = 0;
        this.unitsById.delete(key);
        this.state.units = this.state.units.filter((candidate) => candidate !== unit);
      },
      fireEvent: (event) => {
        this.runtime?.run(event);
      },
      showHalo: (image, x, y, duration, frames) => this.showHalo(image, x, y, duration, frames),
      configureSide: (side, attributes) => {
        const target = this.runtime?.world.sides[String(side)];
        if (!target) return;
        if (attributes.gold !== undefined) {
          target.gold = Number(attributes.gold) || target.gold;
          this.gold[side] = target.gold;
          if (this.runtime) this.runtime.world.gold[String(side)] = target.gold;
        }
        if (attributes.recruit !== undefined) target.recruit = attributes.recruit;
        if (attributes.income !== undefined) target.income = Number(attributes.income) || 0;
        if (attributes.village_gold !== undefined) target.villageGold = Number(attributes.village_gold) || 0;
        if (attributes.controller !== undefined) target.controller = attributes.controller;
        if (attributes.team_name !== undefined) target.teamName = attributes.team_name;
        if (attributes.user_team_name !== undefined) target.userTeamName = attributes.user_team_name;
        if (attributes.share_vision !== undefined) target.shareVision = attributes.share_vision;
        if (attributes.share_view !== undefined) target.shareVision = attributes.share_view;
        // These WML fields are consumed by the side panel/map controller in
        // the native client. Keep them on the runtime side so a later UI
        // layer can observe the same scenario state.
        const sidePresentation = target as unknown as Record<string, unknown>;
        if (attributes.reset_maps !== undefined) sidePresentation.reset_maps = attributes.reset_maps;
        if (attributes.reset_view !== undefined) sidePresentation.reset_view = attributes.reset_view;
        if (attributes.defeat_condition !== undefined) sidePresentation.defeat_condition = attributes.defeat_condition;
        if (attributes.heal !== undefined) target.heal = attributes.heal === 'yes' || attributes.heal === 'true';
        if (attributes.fog !== undefined) target.fog = attributes.fog === 'yes' || attributes.fog === 'true';
        if (attributes.shroud !== undefined) target.shroud = attributes.shroud === 'yes' || attributes.shroud === 'true';
        const presentation = target as unknown as Record<string, unknown>;
        if (attributes.color !== undefined) presentation.color = attributes.color;
        if (attributes.flag !== undefined) presentation.flag = attributes.flag;
        if (attributes.flag_icon !== undefined) presentation.flag_icon = attributes.flag_icon;
        if (attributes.recall_filter !== undefined) presentation.recall_filter = attributes.recall_filter;
        if (attributes.side_variables !== undefined) {
          try { presentation.variables = JSON.parse(decodeURIComponent(attributes.side_variables)); } catch { /* retain prior side variables */ }
        }
        if (attributes.hidden === 'yes') this.hiddenSides.add(side);
        if (attributes.hidden === 'no') this.hiddenSides.delete(side);
      },
      configureRecruit: (side, mode, types) => {
        const target = this.runtime?.world.sides[String(side)];
        if (!target || !types) return;
        const current = (target.recruit ?? '').split(',').map((type) => type.trim()).filter(Boolean);
        const requested = types.split(',').map((type) => type.trim()).filter(Boolean);
        target.recruit = [...new Set(mode === 'allow' ? [...current, ...requested] : current.filter((type) => !requested.includes(type)))].join(',');
      },
      addGold: (side, amount) => {
        this.gold[side] = (this.gold[side] ?? 0) + amount;
        const runtimeSide = this.runtime?.world.sides[String(side)];
        if (runtimeSide) runtimeSide.gold = this.gold[side];
        if (this.runtime) this.runtime.world.gold[String(side)] = this.gold[side];
      },
      rng: this.roll,
    });
    this.runtime = new MwlRuntime(scenario, {
      onMessage: (message) => this.enqueueMessage(message),
      hooks,
      onTrace: (event) => {
        // Deviation: MWG caps WML loops at 1000 iterations; the real engine has no
        // such cap. Keep its while_limit diagnostic visible (PORT_COVERAGE.md).
        this.runtimeTrace.push(event);
        if (this.runtimeTrace.length > 500) this.runtimeTrace.shift();
        if (event.type === 'error') this.log = `MWL error: ${event.message}`;
      },
    });
    const map = this.runtime.world.map;
    if (!map) throw new Error('scenario has no [map]');

    const keeps = new Map<number, { x: number; y: number }[]>();
    for (const [side, starts] of Object.entries(map.starts)) keeps.set(Number(side), [...starts]);
    this.state = makeGame(map.width, map.height, [...map.codes], keeps);
    // Expose endTurn for testing
    window.__WESNOTH__ = window.__WESNOTH__ || {};
    window.__WESNOTH__.endTurn = () => {
      if (this.state && GAME_DATA) {
        endTurn(this.state, GAME_DATA);
      }
    };
    this.ensureMinimap();
    // Terrain art is static for the whole scenario; the unit views are rebuilt
    // from the new world below.
    this.rebuildTerrain();
    this.layoutBoard(Game.current.width, Game.current.height);

    const sides = Object.keys(this.runtime.world.sides).map(Number).sort((a, b) => a - b);
    this.state.sides = sides.length ? sides : [1, 2];
    this.seedMultiplayerSetup();
    this.sideControllers.clear();
    for (const [side, entry] of Object.entries(this.runtime.world.sides)) {
      const config = entry as typeof entry & { team?: string; team_name?: string; teamName?: string; shareVision?: string; share_vision?: string };
      this.sideControllers.set(Number(side), String((config as typeof config & { controller?: string }).controller ?? (Number(side) === this.state.sides[0] ? 'human' : 'ai')));
      const team = config.teamName ?? config.team ?? config.team_name;
      const shareVision = config.shareVision ?? config.share_vision;
      if (team && shareVision !== 'none') this.state.teams.set(Number(side), team);
    }
    this.state.turn = this.state.sides[0];

    // Carry-over gold is applied immediately, while survivors remain in the
    // recall list until the player explicitly chooses and pays for them.
    if (incoming) this.prepareCarryover(incoming);

    this.gold = {};
    for (const [side, entry] of Object.entries(this.runtime.world.sides)) this.gold[Number(side)] = entry.gold;
    // Difficulty shifts each AI side's starting gold, standing in for the
    // per-difficulty `[side] gold=` bonuses the original campaigns declare.
    const openingPolicy = this.aiPolicy();
    for (const side of this.state.sides.slice(1)) {
      this.gold[side] = (this.gold[side] ?? 0) + openingPolicy.bonusGold;
      const runtimeSide = this.runtime.world.sides[String(side)];
      if (runtimeSide) runtimeSide.gold = this.gold[side];
    }

    for (const [id, entry] of Object.entries(this.runtime.world.units)) {
      if (!entry.type || entry.side === undefined) continue;
      const unitEntry = entry as typeof entry & { facing?: string };
      // MWL keys a side by its string id, the port numbers sides.
      const unit = makeUnit(GAME_DATA, entry.type, Number(entry.side), entry.x, entry.y, this.roll);
      unit.wmlId = id;
      if (unitEntry.name !== undefined) unit.name = unitEntry.name;
      if (unitEntry.facing !== undefined) unit.facing = unitEntry.facing;
      // A side's declared leader, or a unit the scenario marks `can_recruit`
      // (the framework autospawns `[side] leader=<type>` as `can_recruit`).
      unit.canRecruit = this.runtime.world.sides[String(entry.side)]?.leader === id || entry.can_recruit === true;
      unit.hitpoints = unit.maxHitpoints;
      this.state.units.push(unit);
      this.unitsById.set(id, unit);
    }
    // A side that declares `[side] leader=` only recruits while that leader
    // stands on a keep; sides without one (the port-authored skirmish) keep the
    // pre-leader approximation. `game.ts isRecruitHex` owns the rule.
    const leaderSides = new Set<number>();
    for (const [side, config] of Object.entries(this.runtime.world.sides)) {
      if (config.leader) leaderSides.add(Number(side));
    }
    this.state.leaderSides = leaderSides;
    this.startLua();

    // Wesnoth's opening sequence (`src/play_controller.cpp:380-425`): `preload`,
    // one `unit_placed` per unit a side starts with, `prestart`, `start`, and
    // then the first side turn's own events.
    for (const name of lifecycleEvents('scenarioStart')) this.runtime.run(name);
    for (const unit of this.unitsById.values()) {
      this.setTriggerUnit('unit_placed', unit);
      this.runtime.run('unit_placed');
    }
    for (const name of lifecycleEvents('prestart')) this.runtime.run(name);
    this.luaEvent('prestart');
    this.luaEvent('start');
    this.enterSideTurn(this.state.round, true);
    // The opening position is the baseline `sighted` is measured against, and
    // `enemies_defeated` may fire once per scenario.
    this.visibility = this.visibilitySnapshot();
    this.enemiesDefeatedFired = false;
    updateVision(this.state, GAME_DATA);
    this.showNextMessage();
    this.log = 'Select a unit, then a highlighted hex or an adjacent enemy.';
    this.selected = null;
    this.outcome = 'playing';
    this.syncRuntime();
    this.outcome = this.runtime.evaluate();
    // `state` is a getter: loading a save replaces the state object, and a
    // captured reference would keep pointing at the pre-load one.
    const scene = this;
    const controls = createSceneControls();
    // Named steps use the scene's full flow, including lifecycle events and runtime sync.
    // MWG has no arguments on steps, so scenario selection is encoded in each name.
    for (const id of SCENARIO_ORDER) controls.register(`enterScenario:${id}`, () => this.startScenario(id));
    controls.register('finishTurn', () => this.finishTurn());
    controls.register('advanceDialogue', () => this.advanceDialogue());
    controls.register('update', () => this.update(0.016));
    (globalThis as unknown as Record<string, unknown>).__WESNOTH__ = { scene: this, controls, get state() { return scene.state; }, runtime: this.runtime, data: GAME_DATA, trace: this.runtimeTrace, campaigns: CAMPAIGNS, compatibility: SCENARIO_COMPATIBILITY, achievements: () => this.achievements.toJSON(), statistics: () => this.statistics.get(), network: () => this.network, connectNetwork: (url: string) => this.connectNetwork(url), sendChat: (text: string) => this.network?.sendChat(text), exportReplay: () => this.exportReplay(), undo: () => this.undoLast(), redo: () => this.redoLast(), undoState: () => ({ canUndo: this.undo.canUndo, canRedo: this.undo.canRedo }), stateHash: () => this.currentStateHash(), save: (slot: string) => this.saveGame(slot), load: (slot: string) => this.loadGame(slot), diagnostics: () => this.diagnosticsSnapshot() };
    if (this.diagnostics) console.info('[wesnoth diagnostics] scenario started', this.diagnosticsSnapshot());
    // The opening position is the first point a player action can be undone back to.
    if (!this.restoringState) this.undo.push(this.undoPayload());
  }

  /** Give a compiled standard MP map a playable default-era opening position. */
  private seedMultiplayerSetup(): void {
    if (!this.scenarioName.startsWith('mp-')) return;
    const factions = GAME_DATA.eras?.era_default?.factions.filter((faction) => faction.leaders.length && faction.recruit.length) ?? [];
    if (!factions.length) return;
    for (const [index, side] of this.state.sides.entries()) {
      const selected = this.multiplayerFactions.get(side);
      const faction = factions.find((candidate) => candidate.id === selected) ?? factions[index % factions.length];
      const config = this.runtime.world.sides[String(side)];
      const keep = this.state.keeps.get(side)?.[0];
      if (!config || !keep) continue;
      if (!config.recruit) config.recruit = faction.recruit.join(',');
      if (config.gold <= 0) config.gold = 100;
      if (!config.leader) {
        const leaderId = `mp_leader_${side}`;
        config.leader = leaderId;
        this.runtime.world.units[leaderId] = {
          hp: 1,
          x: keep.x,
          y: keep.y,
          alive: true,
          type: faction.leaders[0],
          side: String(side),
        };
      }
      if (!this.state.teams.has(side)) this.state.teams.set(side, String(side));
    }
  }

  /** Persist the port-native scenario state, including traits and statuses. */
  private saveGame(slot = 'autosave'): void {
    this.syncRuntime();
    const payload: WesnothSavePayload = {
      version: SAVE_VERSION,
      seed: this.rng.seed,
      scenario: this.scenarioName,
      rngState: this.rng.getState(),
      runtime: this.runtime.snapshot(),
      gold: this.gold,
      teams: [...this.state.teams.entries()],
      units: [...this.unitsById.entries()],
      recallList: this.recallList,
      journal: this.journal.toJSON(),
      achievements: this.achievements.toJSON(),
      rules: this.captureRuleState(),
    };
    try {
      this.saves.save(slot, payload, this.savePreview());
      this.log = slot === 'autosave' ? 'Autosaved.' : `Saved to “${slot}”.`;
    } catch {
      this.log = 'Save unavailable in this browser context.';
    }
    this.refresh();
  }

  /** The one-line summary a save slot shows in the load menu. */
  private savePreview(): string {
    const title = this.scenarioTitle();
    return `${title} — round ${this.state.round}, ${this.gold[1] ?? 0} gold`;
  }

  /** Register and unlock a WML achievement, retaining progress across saves. */
  private unlockAchievement(id: string): void {
    const definition = ACHIEVEMENT_DEFS.find((entry) => entry.id === id);
    if (!definition) return;
    const earned = definition.counter ? this.achievements.increment(definition.counter) : [];
    if (earned.length) this.log = `Achievement unlocked: ${earned.join(', ')}.`;
  }

  private openAchievements(): void {
    const lines = ACHIEVEMENT_DEFS.map((definition) => {
      const progress = this.achievements.progress(definition.id);
      return `${this.achievements.unlocked(definition.id) ? '✓' : '○'} ${definition.id}: ${progress.count}/${progress.target}${definition.description ? ` — ${definition.description}` : ''}`;
    });
    this.track(textWindow('Achievements', lines));
  }

  private openStatistics(): void {
    const stats = this.statistics.get();
    this.track(textWindow('Statistics', [
      `Actions: ${stats.actions}`,
      `Moves: ${stats.moves}`,
      `Attacks: ${stats.attacks}`,
      `Recruits: ${stats.recruits}`,
      `Enemies defeated: ${stats.kills}`,
      `Victories: ${stats.victories}`,
      `Defeats: ${stats.defeats}`,
    ]));
  }

  /** Append only resolved commands; rejected clicks never enter a replay. */
  private recordAction(action: WesnothAction, events: WesnothEvent[] = [{ type: 'resolved' }]): void {
    if (this.replaying) return;
    this.syncRuntime();
    const stamped = { ...action, stateHash: this.currentStateHash() } as WesnothAction;
    this.journal.append(stamped, events);
    this.statistics.record({
      ...EMPTY_STATS,
      actions: 1,
      moves: action.type === 'move' ? 1 : 0,
      attacks: action.type === 'attack' ? 1 : 0,
      recruits: action.type === 'recruit' ? 1 : 0,
      kills: events.filter((event) => event.type === 'killed').length,
    });
    this.network?.submit(stamped);
    if (this.diagnostics) console.debug('[wesnoth diagnostics] action', action, events);
  }

  /** Connect the port's action stream to the framework lockstep transport. */
  private connectNetwork(url: string): void {
    this.network?.close();
    this.localMultiplayer = true;
    this.network = new WesnothNetworkSession({
      url,
      onTick: (tick, actions) => {
        let applied = 0;
        for (const [peer, action] of Object.entries(actions)) {
          if (!action || peer === this.network?.id) continue;
          try { this.applyNetworkAction(action); applied += 1; }
          catch (error) { this.log = `Network action rejected: ${(error as Error).message}`; }
        }
        this.log = `Network tick ${tick}: ${applied} remote action(s).`;
        this.refresh();
      },
      onInitialState: (initial) => {
        if (initial.snapshot && initial.authority && this.network?.id !== 'p1') {
          try {
            this.applyNetworkSnapshot(initial.snapshot, initial.seed);
            this.log = `Network state synchronized (${initial.scenario}/${initial.seed}).`;
          } catch (error) {
            this.log = `Network snapshot rejected: ${(error as Error).message}`;
          }
        } else if (initial.scenario !== this.scenarioName || initial.seed !== this.rng.seed) {
          this.log = `Network initial state mismatch (${initial.scenario}/${initial.seed}).`;
        } else {
          this.log = `Network initial state verified (${initial.scenario}/${initial.seed}).`;
        }
        this.refresh();
      },
      onChat: (peer, text) => {
        this.log = `${peer}: ${text}`;
        this.refresh();
      },
      onStatus: (status) => {
        this.log = `Network: ${status}.`;
        if (status === 'connected') {
          const authority = this.network?.id === 'p1';
          this.network?.submitInitialState({ scenario: this.scenarioName, seed: this.rng.seed, authority, ...(authority ? { snapshot: this.networkSnapshot() } : {}) });
        }
        this.refresh();
      },
    });
    try { this.network.connect(); } catch (error) { this.log = `Network unavailable: ${(error as Error).message}`; }
  }

  /** Convert the live state to the same JSON-safe shape used by local saves. */
  private networkSnapshot(): WesnothNetworkSnapshot {
    this.syncRuntime();
    return {
      version: 1,
      scenario: this.scenarioName,
      rngState: this.rng.getState(),
      runtime: this.runtime.snapshot(),
      gold: { ...this.gold },
      teams: [...this.state.teams.entries()],
      units: [...this.unitsById.entries()],
      recallList: [...this.recallList],
      journal: this.journal.toJSON(),
      achievements: this.achievements.toJSON(),
    };
  }

  /** Apply an authoritative snapshot sent by the room host to a late joiner. */
  private applyNetworkSnapshot(snapshot: WesnothNetworkSnapshot, seed: number): void {
    if (!SCENARIOS[snapshot.scenario]) throw new Error('snapshot scenario is not available in this build');
    this.startScenario(snapshot.scenario, null, seed);
    this.rng.setState(snapshot.rngState as [number, number, number, number]);
    this.runtime.restore(snapshot.runtime);
    this.gold = { ...snapshot.gold };
    this.state.teams = new Map(snapshot.teams ?? this.state.teams);
    this.unitsById = new Map(snapshot.units as [string, Unit][]);
    this.recallList = [...snapshot.recallList] as Carryover['units'][number][];
    this.journal = ActionJournal.fromJSON(snapshot.journal as ActionJournalEntry<WesnothAction, WesnothEvent>[]);
    this.achievements = createAchievements(snapshot.achievements);
    this.state.units = [...this.unitsById.values()];
    updateVision(this.state, GAME_DATA);
    this.selected = null;
    this.outcome = this.runtime.evaluate();
  }

  /** Apply one remote command without re-broadcasting or adding a local undo point. */
  private applyNetworkAction(action: WesnothAction): void {
    if (action.side !== this.state.turn) throw new Error(`expected side ${this.state.turn}, received side ${action.side}`);
    this.replaying = true;
    try {
      if (action.type === 'move') {
        const unit = this.state.units.find((candidate) => candidate.side === action.side && candidate.x === action.from.x && candidate.y === action.from.y && (candidate.name === action.unitName || candidate.id === action.unitId));
        if (!unit || !moveUnit(this.state, GAME_DATA, unit, action.to.x, action.to.y).ok) throw new Error('move could not be applied');
      } else if (action.type === 'attack') {
        const attacker = this.state.units.find((candidate) => candidate.side === action.side && (candidate.name === action.attackerName || candidate.id === action.attackerId));
        const defender = this.state.units.find((candidate) => candidate.side !== action.side && (candidate.name === action.defenderName || candidate.id === action.defenderId));
        if (!attacker || !defender || defender.hitpoints <= 0) throw new Error('attack target could not be resolved');
        attackWithRules(this.state, GAME_DATA, attacker, defender, action.attackName, this.roll);
      } else if (action.type === 'recruit') {
        if (!this.placeRecruit(action.side, action.typeId, action.x, action.y)) throw new Error('recruit could not be applied');
      } else if (action.type === 'end_turn') {
        this.finishTurn();
      }
      if (action.stateHash && action.stateHash !== this.currentStateHash()) throw new Error(`state hash mismatch (${action.stateHash} != ${this.currentStateHash()})`);
    } finally {
      this.replaying = false;
    }
  }

  private currentStateHash(): string {
    return syncStateHash(this.state, this.runtime.snapshot(), this.gold, this.rng.getState());
  }

  /** The transport URL is user-supplied so a file:// build needs no config file. */
  private promptNetworkConnection(): void {
    const url = globalThis.prompt?.('WebSocket server URL', 'ws://localhost:8787') ?? '';
    if (url.trim()) this.connectNetwork(url.trim());
  }

  private promptNetworkChat(): void {
    if (!this.network?.connected) {
      this.log = 'Chat is only available while connected to a network room.';
      this.refresh();
      return;
    }
    const text = globalThis.prompt?.('Chat message', '') ?? '';
    if (!text.trim()) return;
    try {
      this.network.sendChat(text);
      this.log = 'Chat message sent.';
    } catch (error) {
      this.log = `Chat rejected: ${(error as Error).message}`;
    }
    this.refresh();
  }

  /** Stable JSON-friendly evidence for reproducing a browser run. */
  /**
   * Everything a reproducible run needs, in one record: the seed and the live
   * RNG state, the world variables, the MWL trace (claimed events, variable
   * writes and content errors), the action journal, the rules state, the
   * scenario's WML compatibility report and the outcome. `?diagnostics=1`
   * prints it at scenario start and at the end screen, and
   * `__WESNOTH__.diagnostics()` returns it at any point.
   */
  private diagnosticsSnapshot(): Record<string, unknown> {
    this.syncRuntime();
    return {
      scenario: this.scenarioName,
      seed: this.rng.seed,
      rngState: this.rng.getState(),
      outcome: this.outcome,
      round: this.state?.round,
      turn: this.state?.turn,
      variables: this.runtime ? structuredClone(this.runtime.world.variables) : {},
      state: this.state ? structuredClone(this.state) : null,
      journal: this.journal.toJSON(),
      trace: structuredClone(this.runtimeTrace),
      audio: this.audio.snapshot(),
      assets: { failures: [...this.assetFailures], manifestAssets: Object.keys(ASSET_URLS).length },
      compatibility: SCENARIO_COMPATIBILITY[this.scenarioName as keyof typeof SCENARIO_COMPATIBILITY] ?? null,
    };
  }

  /** The complete native state a player action can be undone from. */
  private undoPayload(): WesnothSavePayload {
    this.syncRuntime();
    return structuredClone({
      version: 1,
      scenario: this.scenarioName,
      rngState: this.rng.getState(),
      runtime: this.runtime.snapshot(),
      gold: this.gold,
      teams: [...this.state.teams.entries()],
      units: [...this.unitsById.entries()],
      recallList: this.recallList,
      journal: this.journal.toJSON(),
      achievements: this.achievements.toJSON(),
    });
  }

  /** Record the state a completed action produced, so it can be undone (and redone). */
  private commitUndo(): void {
    if (this.replaying) return;
    this.undo.push(this.undoPayload());
  }

  /** Rebuild the scenario from one snapshot, without touching the browser save slots. */
  private restoreUndo(payload: WesnothSavePayload): void {
    this.restoringState = true;
    try {
      this.startScenario(payload.scenario, null, 1);
      this.rng.setState(payload.rngState);
      this.runtime.restore(payload.runtime);
      this.gold = { ...payload.gold };
      this.state.teams = new Map(payload.teams ?? this.state.teams);
      this.unitsById = new Map(payload.units.map(([key, unit]) => [key, structuredClone(unit)]));
      this.recallList = structuredClone([...payload.recallList]);
      this.state.units = [...this.unitsById.values()];
      this.journal = ActionJournal.fromJSON(payload.journal);
      this.achievements = createAchievements(payload.achievements);
      updateVision(this.state, GAME_DATA);
      this.selected = null;
      this.outcome = this.runtime.evaluate();
    } catch {
      this.log = 'Undo snapshot is incompatible.';
    } finally {
      this.restoringState = false;
    }
  }

  /** Step back one player action; `UndoHistory` owns the cursor and the bound. */
  private undoLast(): void {
    const payload = this.undo.undo();
    if (!payload) {
      this.log = 'Nothing to undo.';
      this.refresh();
      return;
    }
    this.restoreUndo(payload);
    this.runtime?.run('on_undo');
    this.log = 'Last action undone.';
    this.refresh();
  }

  /** Step forward again after an undo, until a new action discards the redo trail. */
  private redoLast(): void {
    const payload = this.undo.redo();
    if (!payload) {
      this.log = 'Nothing to redo.';
      this.refresh();
      return;
    }
    this.restoreUndo(payload);
    this.log = 'Action redone.';
    this.refresh();
  }

  /** Download the current action stream as a portable, seed-bound replay file. */
  private exportReplay(): void {
    try {
      const replay = createReplay(this.scenarioName, this.rng.seed, this.journal.toJSON());
      const blob = new Blob([encodeReplay(replay)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${this.scenarioName}-replay.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.log = 'Replay exported.';
    } catch {
      this.log = 'Replay export unavailable in this browser context.';
    }
    this.refresh();
  }

  /** Choose and execute a previously exported replay file. */
  private openReplayImport(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void file.text().then((source) => this.playReplay(source));
    };
    input.click();
  }

  /** Rebuild a scenario from its seed and dispatch its human commands. */
  private playReplay(source: string): void {
    try {
      const replay = decodeReplay(source);
      if (!SCENARIOS[replay.scenario]) throw new Error('scenario is not available in this build');
      this.replaying = true;
      this.startScenario(replay.scenario, null, replay.seed);
      replayActions(replay, (action) => {
        // AI commands are recorded for diagnostics, but finishTurn regenerates
        // them and applying them again would duplicate the opponent's turn.
        // Human-controlled sides, including both sides of local multiplayer,
        // must remain playable from the same portable journal.
        if (this.sideController(action.side) !== 'human') return;
        if (action.type === 'move') {
          const unit = this.state.units.find((candidate) => candidate.side === 1 && candidate.x === action.from.x && candidate.y === action.from.y && (candidate.name === action.unitName || candidate.id === action.unitId));
          if (!unit || !moveUnit(this.state, GAME_DATA, unit, action.to.x, action.to.y).ok) throw new Error('replay move could not be applied');
        } else if (action.type === 'attack') {
          const attacker = this.state.units.find((candidate) => candidate.side === 1 && (candidate.name === action.attackerName || candidate.id === action.attackerId));
          const defender = this.state.units.find((candidate) => !areAllied(this.state, action.side, candidate.side) && (candidate.name === action.defenderName || candidate.id === action.defenderId));
          if (!attacker || !defender || defender.hitpoints <= 0) throw new Error('replay attack target could not be resolved');
          attackWithRules(this.state, GAME_DATA, attacker, defender, action.attackName, this.roll);
        } else if (action.type === 'recruit') {
          if (!this.placeRecruit(action.side, action.typeId, action.x, action.y)) throw new Error('replay recruit could not be applied');
        } else if (action.type === 'end_turn') {
          this.finishTurn();
        }
      });
      this.journal = ActionJournal.fromJSON(replay.actions);
      this.log = `Replay loaded: ${replay.actions.length} actions.`;
    } catch (error) {
      this.log = `Replay rejected: ${(error as Error).message}`;
    } finally {
      this.replaying = false;
      this.refresh();
    }
  }

  /** The newest save, which the L key and Continue load when no slot is named. */
  private mostRecentSlot(): string | null {
    const slots = this.saves.list().sort((a, b) => b.meta.savedAt - a.meta.savedAt);
    return slots[0]?.slot ?? null;
  }

  /** Restore a save without re-rolling traits or losing combat statuses. */
  private loadGame(slot?: string): void {
    const target = slot ?? this.mostRecentSlot();
    if (!target) {
      this.log = 'No saved game found.';
      this.refresh();
      return;
    }
    let saved: ReturnType<typeof this.saves.load>;
    try {
      saved = this.saves.load(target);
    } catch {
      this.log = 'Save is invalid or from an incompatible version.';
      this.refresh();
      return;
    }
    if (!saved) {
      this.log = `No save in “${target}”.`;
      this.refresh();
      return;
    }
    try {
      // `normalizeSave` validates and migrates, so an older payload loads and a
      // foreign file fails with a reason instead of a half-restored scene.
      const { payload } = normalizeSave(saved.state, (id) => Boolean(SCENARIOS[id]));
      this.restorePayload(payload);
      this.log = `Loaded “${target}”.`;
      this.refresh();
    } catch (error) {
      this.log = error instanceof SaveError ? `Cannot load “${target}”: ${error.message}.` : 'Save is invalid or from an incompatible version.';
      this.refresh();
    }
  }

  /** Apply a validated payload to the live scene, rebuilt from its scenario. */
  private restorePayload(payload: WesnothSavePayload): void {
    this.startScenario(payload.scenario);
    this.rng.setState(payload.rngState);
    this.runtime.restore(payload.runtime);
    this.gold = { ...payload.gold };
    this.state.teams = new Map(payload.teams ?? this.state.teams);
    this.unitsById = new Map(payload.units);
    this.recallList = [...payload.recallList];
    this.journal = ActionJournal.fromJSON(payload.journal);
    this.state.units = [...this.unitsById.values()];
    // The rule state: a version 2 save has none, and keeps the scenario's
    // opening turn, villages and shroud (the migration says so in `normalizeSave`).
    const rules = payload.rules;
    if (rules) {
      this.state.turn = rules.turn;
      this.state.round = rules.round;
      this.state.scheduleIndex = rules.scheduleIndex;
      if (rules.scheduleId) this.state.scheduleId = rules.scheduleId;
      if (rules.customSchedules) this.state.customSchedules = structuredClone(rules.customSchedules);
      if (rules.fogLifts) this.state.fogLifts = structuredClone(rules.fogLifts);
      if (rules.villageOwner.length === this.state.villageOwner.length) this.state.villageOwner = [...rules.villageOwner];
      if (rules.terrainCodes.length === this.state.terrainCodes.length) {
        this.state.terrainCodes = [...rules.terrainCodes];
        setTerrainAt(this.state, 0, 0, this.state.terrainCodes[0] ?? 'Gg');
      }
      if (rules.itemIds) {
        const remaining = new Set(rules.itemIds);
        this.state.items = this.state.items.filter((item) => remaining.has(`${item.x},${item.y}`) || item.taken);
      }
      for (const [faction, cells] of rules.explored ?? []) {
        this.state.fog.reveal(faction, cells.map((index) => ({ x: index % this.state.width, y: Math.floor(index / this.state.width) })));
      }
    }
    updateVision(this.state, GAME_DATA);
    this.selected = null;
    this.outcome = this.runtime.evaluate();
  }

  /**
   * The rule-engine state a save has to carry beyond the runtime snapshot:
   * the turn and time of day, village ownership, any terrain the scenario
   * changed, the map items still on the ground and the shroud each faction
   * remembers. Without these a reload silently rewinds the position.
   */
  private captureRuleState(): WesnothRuleState {
    const explored: [string, number[]][] = [];
    for (const side of this.state.sides) {
      const faction = teamOf(this.state, side);
      if (explored.some(([key]) => key === faction)) continue;
      explored.push([faction, [...this.state.fog.exploredCells(faction)]]);
    }
    return {
      turn: this.state.turn,
      round: this.state.round,
      scheduleIndex: this.state.scheduleIndex,
      scheduleId: this.state.scheduleId,
      customSchedules: this.state.customSchedules ? structuredClone(this.state.customSchedules) : undefined,
      fogLifts: this.state.fogLifts ? structuredClone(this.state.fogLifts) : undefined,
      villageOwner: [...this.state.villageOwner],
      terrainCodes: [...this.state.terrainCodes],
      explored,
      // Items are addressed by their hex: the scenario's own `[item]` list is
      // what a reload rebuilds, so what has to survive is which ones are gone.
      itemIds: this.state.items.filter((item) => !item.taken).map((item) => `${item.x},${item.y}`),
    };
  }

  /** Download the current position as a portable save artifact. */
  private exportSave(): void {
    try {
      this.syncRuntime();
      const payload: WesnothSavePayload = {
        version: SAVE_VERSION,
        seed: this.rng.seed,
        scenario: this.scenarioName,
        rngState: this.rng.getState(),
        runtime: this.runtime.snapshot(),
        gold: this.gold,
        teams: [...this.state.teams.entries()],
        units: [...this.unitsById.entries()],
        recallList: this.recallList,
        journal: this.journal.toJSON(),
        achievements: this.achievements.toJSON(),
      };
      const blob = new Blob([encodeSaveExport(payload)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = saveFileName(this.scenarioName);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.log = 'Save exported.';
    } catch {
      this.log = 'Save export unavailable in this browser context.';
    }
    this.refresh();
  }

  /** Choose and load a previously exported save artifact. */
  private openSaveImport(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) {
        void file.text().then((source) => {
          try {
            const { payload } = decodeSaveExport(source, (id) => Boolean(SCENARIOS[id]));
            this.restorePayload(payload);
            this.log = `Imported “${payload.scenario}”.`;
          } catch (error) {
            this.log = error instanceof SaveError ? `Cannot import: ${error.message}.` : 'Cannot import that file.';
          }
          this.refresh();
        });
      }
    };
    input.click();
  }

  // ------------------------------------------------------------------ windows

  /**
   * Push a window and arm `suppressMenuToggle`, so the Escape that closes it
   * does not reopen a menu in the same frame.
   */
  private track(window: Window, onClosed?: () => void): Window {
    window.onClose.add(() => {
      this.suppressMenuToggle = true;
      onClosed?.();
      return false;
    });
    this.windows.push(window);
    return window;
  }

  /** Close every window, switch scenario, and relayout for the new map. */
  private enterScenario(name: string, incoming: Carryover | null): void {
    this.windows.closeAll();
    if (globalThis.location) globalThis.location.hash = name;
    this.startScenario(name, incoming);
    this.resize(Game.current.width, Game.current.height);
  }

  /** The scenario order the active campaign defines, else the free-play list. */
  private scenarioOrder(): readonly string[] {
    return this.campaign?.scenarios ?? SCENARIO_ORDER;
  }

  /** Side whose fog and input are currently local-player controlled. */
  private viewSide(): number {
    return this.localMultiplayer || this.sideController(this.state.turn) === 'human' ? this.state.turn : this.state.sides[0];
  }

  private sideController(side: number): string {
    return this.localMultiplayer ? 'human' : (this.sideControllers.get(side) ?? (side === this.state.sides[0] ? 'human' : 'ai'));
  }

  /** The start screen: play, choose a scenario, resume, read the controls, quit. */
  private openMainMenu(): void {
    // The real title screen's order (`src/gui/dialogs/title_screen.cpp`): campaign,
    // multiplayer, load, preferences, credits, quit; the port's own scenario picker and
    // help sit beside them.
    const entries: MenuEntry[] = [
      { label: 'Campaign', onSelect: () => this.openCampaignMenu() },
      { label: 'Multiplayer', onSelect: () => this.openMultiplayerMenu() },
      { label: 'Load', disabled: this.saves.list().length === 0, onSelect: () => { this.windows.closeAll(); this.loadGame(); } },
      { label: 'Scenarios', onSelect: () => this.openScenarioMenu() },
      { label: 'Preferences', onSelect: () => this.openPreferences() },
      { label: 'Help', onSelect: () => this.openHelp() },
      { label: 'Credits', onSelect: () => this.openCredits() },
      { label: 'Quit', onSelect: () => this.quitGame() },
    ];
    this.titleOpen = true;
    this.layoutTitle(Game.current.width, Game.current.height);
    this.track(actionWindow('Battle for Wesnoth', entries, 300));
  }

  /** The multiplayer entry of the title screen: local hot seat or a network room. */
  private openMultiplayerMenu(): void {
    this.track(actionWindow('Multiplayer', [
      { label: 'Local 2-player', onSelect: () => { this.localMultiplayer = true; this.windows.closeAll(); this.enterScenario(DEFAULT_SCENARIO, null); } },
      { label: 'Connect to a server…', onSelect: () => this.promptNetworkConnection() },
    ], 300));
  }

  /** The title screen: the real background cover-fitted, the real logo above the menu. */
  private layoutTitle(width: number, height: number): void {
    this.titleLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    if (!this.titleOpen) return;
    const shade = new Shape2D();
    shade.rect(0, 0, width, height).fill({ color: 0x05070b });
    this.titleLayer.addChild(shade);
    const background = new Sprite2D(this.texture('maps/titlescreen.webp'));
    const source = background.texture;
    if (source.width > 1 && source.height > 1) {
      const scale = Math.max(width / source.width, height / source.height);
      background.scale.set(scale);
      background.position.set((width - source.width * scale) / 2, (height - source.height * scale) / 2);
    }
    this.titleLayer.addChild(background);
    const logo = new Sprite2D(this.texture('misc/logo.png'));
    if (logo.texture.width > 1) {
      const scale = Math.min(1, (width - 40) / logo.texture.width, (height * 0.3) / logo.texture.height);
      logo.scale.set(scale);
      logo.position.set((width - logo.texture.width * scale) / 2, Math.max(8, height * 0.04));
    }
    this.titleLayer.addChild(logo);
  }

  /** The campaigns the port ships, compiled from their own `[campaign]` nodes. */
  private openCampaignMenu(): void {
    const items: ListItem[] = CAMPAIGNS.map((campaign) => ({
      text: `${campaign.title} (${campaign.abbrev}) — ${campaign.scenarios.length} scenarios`,
      value: campaign.id,
    }));
    if (!items.length) {
      items.push({ text: 'No campaigns compiled', value: '', disabled: true });
    }
    const { window } = listWindow({
      title: 'Choose a campaign',
      width: 520,
      height: 340,
      items,
      footer: 'The campaign file defines its scenarios, order and difficulties.',
      onSelect: (item) => {
        const campaign = CAMPAIGNS.find((entry) => entry.id === String(item.value));
        if (campaign?.id === 'World_Conquest') this.openWorldConquestMenu();
        else if (campaign) this.openDifficultyMenu(campaign);
      },
    });
    this.track(window);
  }

  /** A campaign's own `[difficulty]` list, with its default preselected. */
  private openDifficultyMenu(campaign: CampaignDefinition): void {
    const items: ListItem[] = campaign.difficulties.map((difficulty) => ({
      text: `${difficulty.label}${difficulty.default ? ' (default)' : ''}${difficulty.description ? ` — ${difficulty.description}` : ''}`,
      value: difficulty.id,
    }));
    if (!items.length) {
      items.push({ text: 'Normal', value: 'NORMAL' });
    }
    const { window } = listWindow({
      title: `${campaign.title} — difficulty`,
      width: 520,
      height: 300,
      items,
      footer: campaign.abbrev ? `${campaign.abbrev}: the enemy side scales with difficulty.` : 'The enemy side scales with difficulty.',
      onSelect: (item) => this.startCampaign(campaign, String(item.value ?? campaign.defaultDifficulty)),
    });
    this.track(window);
  }

  /** Start a campaign at its own first scenario, with the chosen difficulty. */
  private startCampaign(campaign: CampaignDefinition, difficultyId: string): void {
    this.localMultiplayer = false;
    this.campaign = campaign;
    this.difficulty = difficultyFromCampaign(difficultyId);
    this.windows.closeAll();
    this.log = `${campaign.title} — ${difficultyId}. ${this.log}`;
    this.enterScenario(campaign.firstScenario, null);
  }

  /** The Escape menu during play, with save/load and preferences. */
  private openPauseMenu(): void {
    const title = this.campaign ? this.campaign.title : this.scenarioTitle();
    const entries: MenuEntry[] = [
      { label: 'Resume', onSelect: () => this.windows.pop() },
      { label: 'Send chat…', disabled: !this.network?.connected, onSelect: () => this.promptNetworkChat() },
      { label: 'Scenarios…', onSelect: () => this.openScenarioMenu() },
      { label: 'Save game…', onSelect: () => this.openSaveMenu('save') },
      { label: 'Load game…', disabled: this.saves.list().length === 0, onSelect: () => this.openSaveMenu('load') },
      { label: 'Export save…', onSelect: () => this.exportSave() },
      { label: 'Import save…', onSelect: () => this.openSaveImport() },
      { label: 'Export replay', disabled: this.journal.size === 0, onSelect: () => this.exportReplay() },
      { label: 'Import replay…', onSelect: () => this.openReplayImport() },
      { label: 'Undo last action', disabled: !this.undo.canUndo, onSelect: () => this.undoLast() },
      { label: 'Redo action', disabled: !this.undo.canRedo, onSelect: () => this.redoLast() },
      { label: 'Achievements', onSelect: () => this.openAchievements() },
      { label: 'Statistics', onSelect: () => this.openStatistics() },
      { label: 'Objectives', onSelect: () => this.openObjectives() },
      { label: 'Preferences…', onSelect: () => this.openPreferences() },
      { label: 'Help', onSelect: () => this.openHelp() },
      { label: 'Quit to main menu', onSelect: () => this.openMainMenu() },
    ];
    this.track(actionWindow(title, entries));
  }

  /** The free-play scenario list; picking one leaves any campaign. */
  private openScenarioMenu(): void {
    const order = [...this.scenarioOrder(), ...MULTIPLAYER_SCENARIO_ORDER];
    const items = order
      .map((name) => ({ text: `${name.startsWith('mp-') ? 'MP — ' : ''}${SCENARIO_TITLES[name] ?? name}`, value: name }));
    const { window } = listWindow({
      title: 'Choose a scenario',
      width: 420,
      height: 360,
      items,
      footer: 'In game, N cycles to the next scenario.',
      onSelect: (item) => {
        this.campaign = null;
        const name = String(item.value);
        if (name.startsWith('mp-')) this.openMultiplayerSetup(name);
        else this.enterScenario(name, null);
      },
    });
    this.track(window);
  }

  /** Choose one default-era faction for each side before entering an MP map. */
  private openMultiplayerSetup(name: string, side = 1, choices = new Map<number, string>()): void {
    const factions = GAME_DATA.eras?.era_default?.factions.filter((faction) => faction.leaders.length && faction.recruit.length) ?? [];
    const sideCount = this.multiplayerSideCount(name);
    if (side > sideCount || factions.length === 0) {
      this.multiplayerFactions = choices;
      this.localMultiplayer = true;
      this.windows.closeAll();
      this.enterScenario(name, null);
      return;
    }
    const items = factions.map((faction) => ({ text: `${faction.name} — ${faction.recruit.length} recruits`, value: faction.id }));
    const { window } = listWindow({
      title: `${SCENARIO_TITLES[name] ?? name} — side ${side} faction`,
      width: 500,
      height: 360,
      items,
      footer: `Default era setup: choose a faction for side ${side} of ${sideCount}.`,
      onSelect: (item) => {
        const next = new Map(choices);
        next.set(side, String(item.value));
        this.openMultiplayerSetup(name, side + 1, next);
      },
    });
    this.track(window);
  }

  /** Count declared sides in a compiled MP game, including nested definitions. */
  private multiplayerSideCount(name: string): number {
    const game = SCENARIOS[name];
    if (!game) return 2;
    let count = 0;
    const visit = (node: (typeof game.roots)[number]): void => {
      if (node.tag === 'side') count += 1;
      node.children.forEach(visit);
    };
    game.roots.forEach(visit);
    return Math.max(2, count);
  }

  private isRandomMultiplayerScenario(name: string): boolean {
    return /^mp-random-map(?:-|$)/.test(name);
  }

  /** Build a deterministic playable map for the four WML generator presets. */
  private generateRandomMultiplayerScenario(template: MwlCompiledGame): MwlCompiledGame {
    const width = 20;
    const height = 20;
    const desert = this.scenarioName.endsWith('-desert');
    const marsh = this.scenarioName.endsWith('-marsh');
    const winter = this.scenarioName.endsWith('-winter');
    const ground = desert ? 'Dd' : winter ? 'Aa' : marsh ? 'Ss' : 'Gg';
    const hill = desert ? 'Hd' : winter ? 'Ha' : 'Hh';
    const water = winter ? 'Ai' : 'Ww';
    const rows: string[] = [];
    for (let y = 0; y < height; y++) {
      const cells: string[] = [];
      for (let x = 0; x < width; x++) {
        const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
        const roll = this.rng.float();
        cells.push(edge || roll < (marsh ? 0.12 : 0.08) ? water : roll < 0.18 ? hill : ground);
      }
      rows.push(cells.join(', '));
    }
    const mapRows = rows.map((row) => row.split(', '));
    const set = (x: number, y: number, value: string): void => { mapRows[y][x] = value; };
    for (const [side, x, y] of [[1, 1, 1], [2, width - 2, height - 2]] as const) {
      for (let yy = Math.max(0, y - 2); yy <= Math.min(height - 1, y + 2); yy++) {
        for (let xx = Math.max(0, x - 2); xx <= Math.min(width - 1, x + 2); xx++) set(xx, yy, 'Ch');
      }
      set(x, y, `${side} Ch`);
    }
    const terrain = mapRows.map((row) => row.join(', ')).join('\n');
    const clone = (node: MwlCompiledGame['roots'][number]): MwlCompiledGame['roots'][number] => {
      if (node.tag === 'map') return { ...node, attributes: { ...node.attributes, terrain }, children: [] };
      return { ...node, children: node.children.map(clone) };
    };
    const roots = template.roots.map(clone);
    const game = roots.find((node) => node.tag === 'game');
    if (game) {
      type CompiledNode = MwlCompiledGame['roots'][number];
      const node = (tag: string, attributes: Record<string, string>, children: readonly CompiledNode[] = []): CompiledNode => ({ tag, attributes, children });
      const sides = [1, 2].map((side) => node('side', { id: String(side), controller: side === 1 ? 'human' : 'ai', gold: '100' }));
      const objectives = node('objectives', { side: '1' }, [
        node('victory', { condition: 'units_dead', side_filter: '2' }),
        node('defeat', { condition: 'units_dead', side: '1' }),
      ]);
      (game as { children: typeof game.children }).children = [...game.children, ...sides, objectives];
    }
    return { ...template, roots };
  }

  /** Multi-slot save or load, with the autosave slot and a delete flow. */
  private openSaveMenu(mode: 'save' | 'load'): void {
    const slots = this.saves.list().sort((a, b) => b.meta.savedAt - a.meta.savedAt);
    const items: ListItem[] = slots.map((entry) => ({
      text: `${entry.slot} — ${typeof entry.meta.preview === 'string' ? entry.meta.preview : 'saved game'}`,
      value: entry.slot,
    }));
    if (mode === 'save') items.unshift({ text: '+ New save slot', value: '__new__' });
    if (mode === 'load') items.push({ text: 'Delete a save…', value: '__delete__' });
    if (!items.length) items.push({ text: 'No saved games yet', value: '', disabled: true });
    const { window } = listWindow({
      title: mode === 'save' ? 'Save game' : 'Load game',
      width: 500,
      height: 400,
      items,
      footer: 'Autosave is written at the end of every turn.',
      onSelect: (item) => {
        const value = String(item.value ?? '');
        if (!value) return;
        if (value === '__delete__') {
          this.openDeleteMenu();
          return;
        }
        this.windows.closeAll();
        if (mode === 'load') {
          this.loadGame(value);
          return;
        }
        const slot = value === '__new__' ? `slot-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}` : value;
        this.saveGame(slot);
      },
    });
    this.track(window);
  }

  private openDeleteMenu(): void {
    const slots = this.saves.list();
    const items: ListItem[] = slots.map((entry) => ({
      text: `${entry.slot} — ${typeof entry.meta.preview === 'string' ? entry.meta.preview : 'saved game'}`,
      value: entry.slot,
    }));
    if (!items.length) items.push({ text: 'No saved games to delete', value: '', disabled: true });
    const { window } = listWindow({
      title: 'Delete a save',
      width: 500,
      height: 360,
      items,
      footer: 'This cannot be undone.',
      onSelect: (item) => {
        const value = String(item.value ?? '');
        if (!value) return;
        this.saves.delete(value);
        this.log = `Deleted “${value}”.`;
        this.windows.closeAll();
        this.refresh();
      },
    });
    this.track(window);
  }

  /** Victory, defeat, turn, time of day and income in one panel (the O key). */
  private openObjectives(): void {
    const time = GAME_DATA.schedule[this.state.scheduleIndex];
    const lines = [
      ...this.objectiveLines,
      '',
      `Round ${this.state.round}, ${time?.name ?? 'time of day'} (lawful ${time?.lawfulBonus ?? 0}%).`,
      `Gold: side 1 ${this.gold[1] ?? 0}, side 2 ${this.gold[2] ?? 0}.`,
      `Income per turn: side 1 ${incomeFor(this.state, GAME_DATA, this.state.sides[0])}.`,
    ];
    this.track(textWindow(`Objectives — ${this.scenarioTitle()}`, lines));
  }

  /** Rebindable controls, over the framework's `RebindScreen`, persisted on close. */
  private openPreferences(): void {
    // Audio first, then the controls screen: the settings a player reaches for
    // most often are one row away, and both are keyboard-drivable like the rest
    // of the menus (`buildAudioRows` owns the values and their persistence).
    const entries = this.buildAudioRows(() => this.openControls());
    this.track(actionWindow('Preferences', entries));
  }

  /**
   * The audio settings as menu rows: each volume row steps by 10% and wraps,
   * each switch toggles. Values persist with the other preferences, so the next
   * launch starts at the volumes the player chose.
   */
  private buildAudioRows(openControls: () => void): MenuEntry[] {
    const step = (value: number): number => Math.round(((value + 0.1) % 1.1) * 10) / 10;
    const apply = (settings: Partial<AudioSettings>): void => {
      this.audio.configure(settings);
      try {
        this.settings.save('audio', { ...this.audio.current });
      } catch {
        // settings are best-effort; a private-mode browser simply keeps defaults
      }
      this.refresh();
    };
    const percent = (value: number): string => `${Math.round(value * 100)}%`;
    return [
      { label: `Music volume: ${percent(this.audio.current.musicVolume)}`, onSelect: () => apply({ musicVolume: step(this.audio.current.musicVolume) }) },
      { label: `Sound volume: ${percent(this.audio.current.soundVolume)}`, onSelect: () => apply({ soundVolume: step(this.audio.current.soundVolume) }) },
      { label: `Music: ${this.audio.current.musicEnabled ? 'on' : 'off'}`, onSelect: () => apply({ musicEnabled: !this.audio.current.musicEnabled }) },
      { label: `Sound effects: ${this.audio.current.soundEnabled ? 'on' : 'off'}`, onSelect: () => apply({ soundEnabled: !this.audio.current.soundEnabled }) },
      { label: `Language: ${this.locale === 'en' ? 'English' : localeName(this.locale)}`, onSelect: () => this.setLocale(nextLocale(this.locale)) },
      { label: `Text size: ${Math.round(this.textScale * 100)}%`, onSelect: () => this.setThemeOption({ textScale: nextTextScale(this.textScale) }) },
      { label: `High contrast: ${this.highContrast ? 'on' : 'off'}`, onSelect: () => this.setThemeOption({ highContrast: !this.highContrast }) },
      { label: `Reduce motion: ${this.reducedMotion ? 'on' : 'off'}`, onSelect: () => this.setThemeOption({ reducedMotion: !this.reducedMotion }) },
      { label: 'Controls…', onSelect: openControls },
    ];
  }

  /**
   * Apply one accessibility preference: the framework theme is rebuilt (so text
   * size and contrast change everywhere it draws), motion is remembered, and the
   * choice is persisted with the other settings.
   */
  private setThemeOption(option: { textScale?: number; highContrast?: boolean; reducedMotion?: boolean }): void {
    if (option.textScale !== undefined) this.textScale = option.textScale;
    if (option.highContrast !== undefined) this.highContrast = option.highContrast;
    if (option.reducedMotion !== undefined) {
      this.reducedMotionOverride = option.reducedMotion;
      // Apply it now rather than on the next frame, so the switch is honest the
      // moment it is flipped.
      this.reducedMotion = option.reducedMotion;
    }
    applyWesnothTheme({ textScale: this.textScale, highContrast: this.highContrast });
    try {
      this.settings.save('theme', { theme: { textScale: this.textScale, highContrast: this.highContrast, reducedMotion: this.reducedMotionOverride ?? undefined } });
    } catch {
      // settings are best-effort; a private-mode browser simply keeps defaults
    }
    this.windows.closeAll();
    this.track(actionWindow('Preferences', this.buildAudioRows(() => this.openControls())));
    this.refresh();
  }

  /** The keyboard rebinding screen, saved when it closes. */
  private openControls(): void {
    const window = new Window({ width: 460, height: 400, title: 'Preferences — controls' });
    const actions = ['endTurn', 'restart', 'nextScenario', 'saveGame', 'loadGame', 'objectives', 'menu', 'cancel', 'up', 'down', 'left', 'right'];
    const rebind = new RebindScreen({ width: window.contentWidth, height: window.contentHeight, actions, label: (action) => action });
    window.content.addChild(rebind);
    window.delegate = rebind;
    this.track(window, () => {
      try {
        this.settings.save('bindings', { bindings: Input.exportBindings() });
      } catch {
        // settings are best-effort; a private-mode browser simply keeps defaults
      }
    });
  }

  /** The controls reference, over the framework's `HelpScreen`. */
  private openHelp(): void {
    const help = new HelpScreen({
      width: 500,
      height: 300,
      topics: [
        { title: 'Movement', body: 'Click one of your units (gold marker), then a highlighted hex to move. Click an adjacent enemy to attack it.' },
        { title: 'Turns', body: 'Ctrl+Space ends your turn; the enemy side moves at once. The round and time of day advance on the HUD.' },
        { title: 'Recruit', body: 'Click your keep to open the Recruit / Recall list. Recruits cost their unit cost; recalls cost 20 gold.' },
        { title: 'Menus', body: 'Escape or M opens the menu: scenarios, save, load, objectives and preferences. J jumps to the next scenario; R restarts; S autosaves.' },
        { title: 'Objectives', body: this.objectiveLines.join(' ') || 'This scenario has no written objectives.' },
        ...buildEncyclopediaTopics(GAME_DATA),
      ],
    });
    this.track(widgetWindow('Help', help, 540, 400));
  }

  /** Credits for the port and the reusable MWG framework. */
  private openCredits(): void {
    this.track(textWindow('Credits', [
      'Battle for Wesnoth — MWG port',
      '',
      'Wesnoth content and artwork: GPL-2.0-or-later.',
      'Game framework: MWG, MPL-2.0.',
      '',
      'This build is a TypeScript port of the 1.19.27 data and rules slice.',
    ]));
  }

  /** Stop the session; in a browser the honest quit is to say so and stop input. */
  private quitGame(): void {
    this.windows.closeAll();
    this.showEndScreen('Quit', ['The game has stopped.', 'Reload the page to start a new campaign.'], 'Reload the page to play again');
  }

  /** Push the rule engine's unit state into the runtime world before an objective check. */
  private syncRuntime(): void {
    const world = this.runtime.world;
    for (const [id, unit] of [...this.unitsById]) {
      if (unit.hitpoints <= 0) this.unitsById.delete(id);
    }
    for (const [id, entry] of Object.entries(world.units)) entry.alive = this.unitsById.has(id);
    for (const [id, unit] of this.unitsById) {
      const entry = world.units[id] ?? (world.units[id] = { hp: unit.hitpoints, x: unit.x, y: unit.y, alive: true });
      entry.hp = unit.hitpoints;
      entry.x = unit.x;
      entry.y = unit.y;
      entry.alive = true;
      entry.type = unit.typeId;
      entry.side = String(unit.side);
    }
  }

  private evaluateOutcome(): void {
    const before = this.outcome;
    this.syncRuntime();
    // `enemies_defeated` fires before the victory is registered, so content can
    // still act on it (`src/play_controller.cpp:1009-1016`). It fires once.
    if (this.outcome === 'playing' && !this.enemiesDefeatedFired && this.enemiesDefeated()) {
      this.enemiesDefeatedFired = true;
      this.runtime.run('enemies_defeated');
      this.luaEvent('enemies_defeated');
      this.syncRuntime();
    }
    this.outcome = this.runtime.evaluate();
    this.applyLuaOutcome();
    if (this.outcome === before || this.outcome === 'playing') return;
    // A finished scenario prints its final state too, so a failing run leaves
    // the seed, trace and journal in the console without a second command.
    if (this.diagnostics) console.info('[wesnoth diagnostics] scenario finished', this.diagnosticsSnapshot());
    if (this.outcome === 'won') {
      this.statistics.record({ ...EMPTY_STATS, victories: 1 });
      this.finishScenario();
      return;
    }
    this.statistics.record({ ...EMPTY_STATS, defeats: 1 });
    this.carryover = null;
    this.log = 'Defeat: the scenario objectives failed. R retries it.';
    this.showEndScreen(
      'Defeat',
      [this.scenarioTitle(), 'The scenario objectives failed.'],
      'R: retry this scenario',
    );
  }

  /** No enemy of the local player's side is left standing on the map. */
  private enemiesDefeated(): boolean {
    const player = this.state.sides[0];
    return !this.state.units.some((unit) => unit.hitpoints > 0 && !areAllied(this.state, unit.side, player));
  }

  /** A won scenario hands the next one a gold share and the survivors. */
  private finishScenario(): void {
    const gold = this.gold[1] ?? 0;
    const eventNext = this.runtime.world.variables.__next_scenario;
    const next = nextScenarioWithOverride(
      this.scenarioOrder(),
      this.scenarioName,
      this.campaign && typeof eventNext === 'string' ? eventNext : undefined,
      (scenario) => Boolean(this.campaign && SCENARIOS[scenario]),
    );
    // `[endlevel] bonus=yes` pays the turns you did not need, at the side's
    // income rate (Wesnoth's early-finish bonus).
    const turnLimit = Number(this.runtime.world.variables.turn_limit ?? 0);
    const bonusGold = scenarioWantsBonus(this.runtime) && turnLimit > 0
      ? Math.max(0, turnLimit - this.state.round) * Math.max(0, incomeFor(this.state, GAME_DATA, 1))
      : 0;
    const carryover = next
      ? carryoverFor({
          from: this.scenarioName,
          to: next,
          gold,
          percent: scenarioCarryoverPercent(this.runtime),
          bonusGold,
          units: [...this.unitsById.values()],
        })
      : null;
    this.carryover = carryover;
    this.log = 'Victory: the scenario objectives are met.';
    if (!carryover) {
      this.showEndScreen('Victory', ['The campaign is complete.'], 'Space: play the campaign again');
      return;
    }
    this.showEndScreen(
      'Victory',
      describeCarryover(carryover, gold),
      `Space: continue to ${SCENARIO_TITLES[carryover.to] ?? carryover.to}`,
    );
  }

  override resize(width: number, height: number): void {
    this.layoutBoard(width, height);
    this.windows.setViewport(width, height);
    // The HUD owns the top bar and the sidebar; below tablet width the sidebar is
    // dropped and the minimap moves under the bar (`ui/hud.ts`).
    this.hud.layout(width, height);
    const minimapOrigin = this.hud.minimapOrigin(this.state.width * this.minimapCell, this.state.height * this.minimapCell);
    this.minimap?.position.set(minimapOrigin.x, minimapOrigin.y);
    this.minimapUnits.position.set(minimapOrigin.x, minimapOrigin.y);
    this.layoutTitle(width, height);
    this.layoutDialogue();
    this.layoutEndScreen();
    this.layoutAttackDialog();
    this.refresh();
  }

  /**
   * Size and place the board. The origin lives on the board container rather
   * than being baked into every child, so a window resize only moves one
   * object; the terrain and unit sprites are positioned in pure hex pixels.
   */
  private layoutBoard(width: number, height: number): void {
    const boardWidth = (this.state.width - 1) * TILE * 0.75 + TILE;
    const boardHeight = (this.state.height + 0.5) * TILE;
    // Fit the whole map above the HUD, whatever the window size.
    const top = TOP_BAR_HEIGHT + 4;
    const usable = this.hud ? this.hud.boardWidth(width) : width;
    const scale = Math.min(1, (usable - 16) / boardWidth, Math.max(0.2, height - top - 28) / boardHeight);
    this.board.scale.set(scale);
    this.board.position.set(
      Math.max(8, (usable - boardWidth * scale) / 2),
      top + Math.max(0, (height - top - 28 - boardHeight * scale) / 2),
    );
    if (this.cameraTarget) {
      const target = hexToPixel(this.cameraTarget.x, this.cameraTarget.y, TILE, TILE);
      const desired = { x: usable / 2, y: top + (height - top) / 2 };
      this.board.position.x += desired.x - (this.board.position.x + target.x * scale);
      this.board.position.y += desired.y - (this.board.position.y + target.y * scale);
    }
    // The hit area covers the board in its own local space.
    this.hitLayer.clear().rect(0, 0, boardWidth + TILE, boardHeight + TILE).fill({ color: 0xffffff, alpha: 0 });
  }

  /** Assets the build could not resolve, in first-seen order (bounded). */
  private readonly assetFailures: string[] = [];

  private recordAssetFailure(path: string): void {
    if (this.assetFailures.includes(path)) return;
    this.assetFailures.push(path);
    if (this.assetFailures.length > 50) this.assetFailures.shift();
    console.warn(`missing compiled asset (frame skipped): ${path}`);
  }

  /**
   * Release the per-scenario asset caches before a new scenario builds its own.
   * The textures are keyed by path and re-created on demand, so this bounds
   * memory across a campaign instead of holding every unit and terrain sprite
   * of every scenario visited (ROADMAP: "Asset manifest, cache and loading
   * observability").
   */
  private releaseScenarioAssets(): void {
    this.artSprites.clear();
    for (const texture of this.textureCache.values()) texture.destroy?.();
    this.textureCache.clear();
    for (const texture of this.teamTextures.values()) texture.destroy?.();
    this.teamTextures.clear();
    this.teamTextureLoading.clear();
  }

  private texture(path: string): Texture2D {
    const cached = this.textureCache.get(path);
    if (cached) return cached;
    // Pixi 8 loads asynchronously through Assets. `Texture2D.from(url)` only reads
    // Pixi's cache, so calling it on an unloaded data URI silently yields no
    // texture; load first, then refresh so the sprite picks the texture up.
    if (!this.loadingTextures.has(path)) {
      this.loadingTextures.add(path);
      // A frame the data references but the checkout lacks is skipped, the way
      // `terrain_builder::load_images` skips missing frames; the sprite stays
      // transparent rather than aborting the whole scene.
      let source: string;
      try {
        source = assetUrl(path);
      } catch {
        // Loading observability (ROADMAP): a missing asset is a skipped frame,
        // not a failure, but it is recorded so `diagnostics()` can report what
        // this build could not draw, once per path.
        this.recordAssetFailure(path);
        this.loadingTextures.delete(path);
        return Texture2D.EMPTY;
      }
      // Assets cannot pick a parser for a `data:` URI (no file extension), so
      // name the texture parser explicitly.
      Assets.load<Texture2D>({ src: source, parser: 'loadTextures' })
        .then((texture) => {
          this.loadingTextures.delete(path);
          this.textureCache.set(path, texture);
          // Terrain sprites were built before this texture existed; patch them
          // in place instead of rebuilding the whole layer.
          const waiting = this.artSprites.get(path);
          if (waiting) {
            for (const entry of waiting) this.sizeArt(entry.sprite, entry.parsed, croppedTexture(texture, entry.parsed));
            this.artSprites.delete(path);
          }
          // The dialogue box is not part of the board redraw, so rebuild it when
          // the portrait it is waiting on arrives.
          if (this.dialogueMessage && this.portraitFor(this.dialogueMessage) === path) this.layoutDialogue();
          if (this.titleOpen && (path === 'maps/titlescreen.webp' || path === 'misc/logo.png')) this.layoutTitle(Game.current.width, Game.current.height);
          this.scheduleRefresh();
        })
        .catch((error) => {
          this.loadingTextures.delete(path);
          console.error(`texture failed: ${path}`, error);
        });
    }
    return Texture2D.EMPTY;
  }

  /**
   * The team colour a side uses. Scenarios can set `color=`, but the port's
   * side model does not carry it, so sides follow the `[color_range] default=yes`
   * order (red, blue, green, ...), which is what the engine falls back to.
   */
  private sideColorId(side: number): string {
    if (DEFAULT_COLOR_RANGES.length === 0) return 'red';
    return DEFAULT_COLOR_RANGES[(side - 1) % DEFAULT_COLOR_RANGES.length];
  }

  /**
   * Magenta palette -> side range, computed once per id with Wesnoth's `recolor_palette`
   * arithmetic. MWG's `recolorTexture` applies the mapping in its exact mode, which is what a
   * sparse, specific palette needs.
   */
  private paletteMappingFor(colorId: string): PaletteMapping {
    const cached = this.colorMappings.get(colorId);
    if (cached) return cached;
    const range = COLOR_RANGES[colorId];
    const reference = COLOR_PALETTES.magenta ?? [];
    const mapping: PaletteMapping = range ? paletteMapping(range, reference) : { from: [], to: [] };
    this.colorMappings.set(colorId, mapping);
    return mapping;
  }

  /** A unit texture with its magenta pixels swapped for the side's team colour. */
  private teamTexture(path: string, colorId: string): Texture2D {
    const key = `${path}|${colorId}`;
    const cached = this.teamTextures.get(key);
    if (cached) return cached;
    if (!this.teamTextureLoading.has(key)) {
      this.teamTextureLoading.add(key);
      let source: string;
      try {
        source = assetUrl(path);
      } catch {
        this.teamTextureLoading.delete(key);
        return Texture2D.EMPTY;
      }
      Assets.load<Texture2D>({ src: source, parser: 'loadTextures' })
        .then((texture) => {
          this.teamTextureLoading.delete(key);
          const mapping = this.paletteMappingFor(colorId);
          this.teamTextures.set(key, this.recolorTeamTexture(texture, mapping));
          this.scheduleRefresh();
        })
        .catch((error) => {
          this.teamTextureLoading.delete(key);
          console.error(`team texture failed: ${path}`, error);
        });
    }
    return Texture2D.EMPTY;
  }

  /**
   * Recolour a texture with MWG's `recolorTexture` in exact mode (0.8.0 builds a
   * real `ImageData` for `putImageData`, which was the old blocker). The mapping
   * itself stays Wesnoth's `recolor_palette` arithmetic via `paletteMapping`;
   * MWG only owns the canvas bookkeeping.
   */
  private recolorTeamTexture(texture: Texture2D, mapping: PaletteMapping): Texture2D {
    if (mapping.from.length === 0) return texture;
    return recolorTexture(texture, mapping, undefined, 'exact');
  }

  /** Coalesce the refreshes triggered by textures finishing their load. */
  private scheduleRefresh(): void {
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    setTimeout(() => {
      this.refreshScheduled = false;
      this.refresh();
    }, 0);
  }

  private refresh(): void {
    if (!this.board || !this.status || !this.state) return;
    const moves = this.selected && this.outcome === 'playing' ? reachable(this.state, GAME_DATA, this.selected) : new Map<string, number>();
    this.refreshOverlay(moves);
    this.drawLuaItems();
    this.syncUnitViews();
    this.drawMinimap();

    const time = GAME_DATA.schedule[this.state.scheduleIndex];
    const active = `Side ${this.state.turn}${this.localMultiplayer ? ' (local)' : ''}`;
    const result = this.outcome === 'playing' ? '' : `  |  ${this.outcome === 'won' ? 'VICTORY' : 'DEFEAT'}`;
    const selectedInfo = this.selected
      ? `${this.selected.name}  HP ${this.selected.hitpoints}/${this.selected.maxHitpoints}  moves ${this.selected.movement}/${this.selected.maxMovement}  xp ${this.selected.experience}/${this.selected.maxExperience}`
      : 'No unit selected.';
    const objectives = this.objectiveLines.length ? `\n${this.objectiveLines.join('  |  ')}` : '';
    const hover = this.hoverSummary();
    this.status.text = `${this.scenarioTitle()}  |  round ${this.state.round}  |  ${active}  |  ${time?.name ?? ''} (lawful ${time?.lawfulBonus ?? 0}%)  |  gold P1 ${this.gold[1] ?? 0} P2 ${this.gold[2] ?? 0}  |  income P1 ${incomeFor(this.state, GAME_DATA, this.state.sides[0])}${result}\n${selectedInfo}\n${this.log}  [N: next scenario, R: restart, S: save, L: load, Space: end turn]${objectives}${hover}`;
    const side = this.viewSide();
    const hovered = this.hoveredHex;
    const inBounds = hovered && hovered.x >= 0 && hovered.y >= 0 && hovered.x < this.state.width && hovered.y < this.state.height;
    let terrainInfo: HudModel['terrain'] = null;
    if (hovered && inBounds) {
      const probe = this.selected ?? this.state.units.find((unit) => unit.side === side);
      const resolved = resolveTerrain(GAME_DATA, probe ? movetypeOf(GAME_DATA, probe) : undefined, terrainCodeAt(this.state, hovered.x, hovered.y));
      terrainInfo = { name: resolved.id, defense: resolved.defense, x: hovered.x, y: hovered.y };
    }
    const shown = this.selected ?? (hovered && inBounds ? unitAt(this.state, hovered.x, hovered.y) : undefined);
    // Tooltip over the hovered hex, as the real client does: unit portrait and summary,
    // or the terrain's name and defense. Not shown while a window owns the screen.
    if (hovered && inBounds && this.windows.isEmpty && !this.dialogueOpen) {
      const over = unitAt(this.state, hovered.x, hovered.y);
      const visibleUnit = over && !isFogged(this.state, GAME_DATA, side, over.x, over.y) ? over : undefined;
      const centre = hexToPixel(hovered.x, hovered.y, TILE, TILE);
      const anchor = { x: this.board.position.x + centre.x * this.board.scale.x, y: this.board.position.y + centre.y * this.board.scale.y };
      const lines = visibleUnit
        ? [
            `${visibleUnit.name}`,
            `${GAME_DATA.unitTypes[visibleUnit.typeId]?.name ?? visibleUnit.typeId}  (level ${visibleUnit.level}, ${visibleUnit.alignment})`,
            `HP ${visibleUnit.hitpoints}/${visibleUnit.maxHitpoints}   XP ${visibleUnit.experience}/${visibleUnit.maxExperience}`,
            `Moves ${visibleUnit.movement}/${visibleUnit.maxMovement}`,
            ...visibleUnit.attacks.map((attack) => `${attack.name}: ${attack.damage}-${attack.number} ${attack.type} (${attack.range})`),
          ]
        : terrainInfo ? [terrainInfo.name, `Defense ${terrainInfo.defense}%`] : [];
      this.hud.showTooltip(lines.length ? { lines, portrait: visibleUnit ? (GAME_DATA.unitTypes[visibleUnit.typeId]?.profile ?? null) : null } : null, anchor);
    } else {
      this.hud.showTooltip(null, { x: 0, y: 0 });
    }
    this.hud.refresh({
      title: this.scenarioTitle(),
      round: this.state.round,
      side: this.state.turn,
      sideLabel: active,
      tod: { id: time?.id ?? 'dawn', name: time?.name ?? '', lawful: time?.lawfulBonus ?? 0 },
      gold: this.gold[side] ?? 0,
      villages: this.state.villageOwner.filter((owner) => owner === side).length,
      units: this.state.units.filter((unit) => unit.side === side && unit.hitpoints > 0).length,
      upkeep: upkeepFor(this.state, GAME_DATA, side),
      income: incomeFor(this.state, GAME_DATA, side),
      result: this.outcome === 'playing' ? '' : this.outcome === 'won' ? 'VICTORY' : 'DEFEAT',
      unit: shown && !isFogged(this.state, GAME_DATA, side, shown.x, shown.y) ? {
        name: shown.name,
        typeName: GAME_DATA.unitTypes[shown.typeId]?.name ?? shown.typeId,
        image: shown.image,
        level: shown.level,
        side: shown.side,
        hitpoints: shown.hitpoints,
        maxHitpoints: shown.maxHitpoints,
        experience: shown.experience,
        maxExperience: shown.maxExperience,
        movement: shown.movement,
        maxMovement: shown.maxMovement,
        alignment: shown.alignment,
        traits: shown.traits,
        resistances: Object.fromEntries(['blade', 'pierce', 'impact', 'fire', 'cold', 'arcane'].map((type) => [type, 100 - resistanceOf(GAME_DATA, shown, type)])),
        attacks: shown.attacks.map((attack) => ({ name: attack.name, damage: attack.damage, number: attack.number, range: attack.range, type: attack.type })),
      } : null,
      terrain: terrainInfo,
      message: `${this.log}${objectives ? `  |  ${this.objectiveLines.join('  |  ')}` : ''}${hover ? `  |  ${hover.trim()}` : ''}  [N: next scenario, R: restart, S: save, L: load, Space: end turn]`,
    });
  }

  /** Information shown for the currently hovered hex, including a legal attack preview. */
  private hoverSummary(): string {
    const hovered = this.hoveredHex;
    if (!hovered || !this.state || hovered.x < 0 || hovered.y < 0 || hovered.x >= this.state.width || hovered.y >= this.state.height) return '';
    const code = terrainCodeAt(this.state, hovered.x, hovered.y);
    const target = unitAt(this.state, hovered.x, hovered.y);
    const probe = target ?? this.selected ?? this.state.units.find((unit) => unit.side === this.viewSide());
    const terrain = resolveTerrain(GAME_DATA, probe ? movetypeOf(GAME_DATA, probe) : undefined, code);
    let line = `\nHover ${hovered.x + 1},${hovered.y + 1}: ${terrain.id} — défense ${terrain.defense}%`;
    if (target && this.selected && target.side !== this.selected.side && this.adjacent(this.selected, target)) {
      const prediction = predictAttack(this.state, GAME_DATA, this.selected, target);
      if (prediction) line += ` — ${prediction.attackName}: ${prediction.cth}% / ${prediction.damage} dégâts`;
    }
    return line;
  }

  /** Recreate the framework minimap only when a scenario changes dimensions. */
  private ensureMinimap(): void {
    if (!this.state || (this.minimap && this.minimapDimensions.width === this.state.width && this.minimapDimensions.height === this.state.height)) return;
    this.minimap?.destroy({ children: true });
    this.minimapCell = Math.max(2, Math.min(4, 120 / Math.max(this.state.width, this.state.height)));
    this.minimap = new Minimap({ widthInCells: this.state.width, heightInCells: this.state.height, cellSize: this.minimapCell, shape: 'square' });
    this.minimapDimensions = { width: this.state.width, height: this.state.height };
    this.ui.addChildAt(this.minimap, this.ui.getChildIndex(this.hud) + 1);
  }

  /**
   * Draw every terrain cell once. Terrain never changes within a scenario, so
   * this is not part of `refresh`; only the fog/selection overlay is.
   */
  private rebuildTerrain(): void {
    this.terrainLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    this.terrainForegroundLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    this.artSprites.clear();
    this.unitViews.forEach((view) => view.container.destroy({ children: true }));
    this.unitViews.clear();
    if (!this.state) return;
    const state = this.state;
    const schedule = activeSchedule(GAME_DATA, state);
    const tod = schedule[state.scheduleIndex % Math.max(1, schedule.length)]?.id;
    // The real transition build: every `[terrain_graphics]` rule over this map,
    // matching terrain, flags and rotations, resolved to per-hex image lists.
    const transitions = buildTerrainTiles(TERRAIN_RULES, {
      width: state.width,
      height: state.height,
      terrainAt: (x, y) => terrainCodeAt(state, x, y),
      drawBorder: true,
      tod,
    });
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const code = terrainCodeAt(state, x, y);
        if (code.startsWith('_off')) continue;
        const tile = transitions.get(`${x},${y}`);
        if (!tile) {
          // No transition rule matched this hex: keep the representative art so
          // the board never has a hole.
          this.addTerrainCell(x, y, code);
          continue;
        }
        const center = hexToPixel(x, y, TILE, TILE);
        if (tile.background.length === 0) this.addTerrainGround(code, center.x, center.y);
        for (const image of tile.background) this.addBuiltArt(this.terrainLayer, image, center.x, center.y);
        for (const image of tile.foreground) this.addBuiltArt(this.terrainForegroundLayer, image, center.x, center.y);
      }
    }
  }

  /** The representative ground tile only, used under a transition with no base. */
  private addTerrainGround(code: string, px: number, py: number): void {
    const { base } = splitCode(code);
    const baseArt = TERRAIN_PATH[base];
    const baseIsOverlay = baseArt !== undefined && OVERLAY_ONLY.has(baseArt);
    const ground = baseIsOverlay ? GROUND_FOR[base] ?? TERRAIN_PATH.Gg : baseArt;
    if (ground) this.addArt(this.terrainLayer, ground, px, py);
    else {
      const g = new Shape2D().poly(HEX_POINTS).fill(0x0c1016);
      g.position.set(px, py);
      this.terrainLayer.addChild(g);
    }
  }

  /** Draw one built transition image at its tile, honouring `[image] center=`. */
  private addBuiltArt(parent: Container2D, image: BuiltTerrainImage, px: number, py: number): void {
    const scale = TILE / TILE_SOURCE;
    this.addArt(parent, image.image, px + image.offsetX * scale, py + image.offsetY * scale);
  }

  /** One cell's base, overlay and overlay-only art, all sprites in the shared layer. */
  private addTerrainCell(x: number, y: number, code: string): void {
    const center = hexToPixel(x, y, TILE, TILE);
    const px = center.x;
    const py = center.y;
    const { base, overlay } = splitCode(code);
    const baseArt = TERRAIN_PATH[base];
    // Mountain art is a 180x216 sprite, 87% transparent: it is an overlay drawn
    // on top of a ground tile, not a hex tile of its own. Drawing it as a base
    // put a peak on the black background.
    const baseIsOverlay = baseArt !== undefined && OVERLAY_ONLY.has(baseArt);
    const ground = baseIsOverlay ? GROUND_FOR[base] ?? TERRAIN_PATH.Gg : baseArt;
    if (ground) this.addArt(this.terrainLayer, ground, px, py);
    else {
      const g = new Shape2D().poly(HEX_POINTS).fill(0x0c1016);
      g.position.set(px, py);
      this.terrainLayer.addChild(g);
    }
    if (overlay) {
      const key = `^${overlay.split('^').filter(Boolean)[0]}`;
      const art = OVERLAY_PATH[key];
      // `Mm^Xm` overlays the same mountain sprite the base already drew.
      if (art && art !== baseArt) this.addArt(this.terrainLayer, art, px, py);
    }
    if (baseIsOverlay && baseArt) this.addArt(this.terrainLayer, baseArt, px, py);
  }

  /**
   * The per-refresh board overlay: hex outlines, fog/shroud, reachable cells,
   * the selection ring and objective markers, merged into a single `Shape2D`.
   * One object instead of one `Shape2D` per cell per overlay kind.
   */
  private refreshOverlay(moves: Map<string, number>): void {
    this.overlayLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    if (!this.state) return;
    const g = new Shape2D();
    const playerSide = this.viewSide();
    const selection = this.selected;
    for (let y = 0; y < this.state.height; y++) {
      for (let x = 0; x < this.state.width; x++) {
        const code = terrainCodeAt(this.state, x, y);
        if (code.startsWith('_off')) continue;
        const center = hexToPixel(x, y, TILE, TILE);
        const cx = center.x;
        const cy = center.y;
        const points = translatedHex(cx, cy);
        g.poly(points).stroke({ color: 0x1a2026, width: 1 });
        if (isShrouded(this.state, playerSide, x, y)) {
          g.poly(points).fill({ color: 0x05070b, alpha: 1 });
        } else if (isFogged(this.state, GAME_DATA, playerSide, x, y)) {
          g.poly(points).fill({ color: 0x11151d, alpha: 0.68 });
        }
        if (this.objectives.some((hex) => hex.x === x && hex.y === y)) {
          g.circle(cx, cy, TILE * 0.4).stroke({ color: 0xffe48a, width: 2 });
          g.circle(cx, cy, TILE * 0.11).fill({ color: 0xffe48a, alpha: 0.9 });
        }
        if (moves.has(`${x},${y}`)) g.poly(points).fill({ color: 0x9cdb69, alpha: 0.28 });
        if (selection && selection.x === x && selection.y === y) g.poly(points).stroke({ color: 0xffe48a, width: 2.5 });
        // The keyboard cursor: a bright outline that reads against both fog and
        // unexplored shroud, so keyboard play always shows where Enter will act.
        if (this.cursorVisible && this.cursor.x === x && this.cursor.y === y) {
          g.poly(points).stroke({ color: 0xffffff, width: 3 });
          g.circle(cx, cy, TILE * 0.12).fill({ color: 0xffffff, alpha: 0.85 });
        }
      }
    }
    this.overlayLayer.addChild(g);
  }

  /**
   * Add one art file centred on a board position at its native aspect ratio:
   * Wesnoth terrain art is authored against 72px hexes, and overlays are larger
   * than one hex on purpose (a 144x144 forest, a 180x216 mountain). Forcing
   * them into TILE x TILE squashed them.
   */
  private addArt(parent: Container2D, path: string, px: number, py: number): void {
    const parsed = parseImagePath(path);
    const texture = croppedTexture(this.texture(parsed.path), parsed);
    const sprite = new Sprite2D(texture);
    sprite.anchor.set(0.5);
    sprite.position.set(px, py);
    this.sizeArt(sprite, parsed, texture);
    // The terrain layer is built once, so a sprite whose texture is still
    // loading is registered and patched in `texture()`'s own callback.
    if (texture === Texture2D.EMPTY) {
      const waiting = this.artSprites.get(parsed.path) ?? [];
      waiting.push({ sprite, parsed });
      this.artSprites.set(parsed.path, waiting);
    }
    parent.addChild(sprite);
    for (const modifier of parsed.modifiers.filter((entry) => entry.name === 'BLIT')) {
      const blitPath = modifier.args[0];
      if (!blitPath) continue;
      const offsetX = Number(modifier.args[1] ?? 0);
      const offsetY = Number(modifier.args[2] ?? 0);
      this.addBlit(parent, blitPath, px + (Number.isFinite(offsetX) ? offsetX : 0) * (TILE / TILE_SOURCE), py + (Number.isFinite(offsetY) ? offsetY : 0) * (TILE / TILE_SOURCE));
    }
  }

  /** Draw a BLIT source as a sibling so its position is independent of the base crop. */
  private addBlit(parent: Container2D, value: string, px: number, py: number): void {
    const parsed = parseImagePath(value);
    const texture = croppedTexture(this.texture(parsed.path), parsed);
    const sprite = new Sprite2D(texture);
    sprite.anchor.set(0.5);
    sprite.position.set(px, py);
    this.sizeArt(sprite, parsed, texture);
    if (texture === Texture2D.EMPTY) {
      const waiting = this.artSprites.get(parsed.path) ?? [];
      waiting.push({ sprite, parsed });
      this.artSprites.set(parsed.path, waiting);
    }
    parent.addChild(sprite);
  }

  /** Apply one art texture to a sprite: native 72px aspect, then its modifiers. */
  private sizeArt(sprite: Sprite2D, parsed: ParsedImagePath, texture: Texture2D): void {
    const scale = TILE / TILE_SOURCE;
    const baked = this.pixelTexture(texture, parsed);
    sprite.texture = baked;
    sprite.filters = [];
    sprite.tint = 0xffffff;
    sprite.width = baked.width * scale;
    sprite.height = baked.height * scale;
    applyImageModifiers(sprite, mwgSpritePath(parsed), scale);
    this.applyAdditionalImageModifiers(sprite, parsed);
  }

  /**
   * Pixel-level modifiers MWG now bakes exactly (0.8.0): named `~RC`/`~PAL`,
   * raw nested `~BLIT`/`~MASK` args and exact `~BLEND`. Without a
   * `resolveTexture` probe `~BLIT`/`~MASK` are safely skipped, so the port's
   * sibling-sprite BLIT path below keeps working with no double draw.
   */
  private pixelTexture(texture: Texture2D, parsed: ParsedImagePath): Texture2D {
    if (texture === Texture2D.EMPTY) return texture;
    return applyTextureModifiers(texture, parsed, { resolveColor: resolveNamedColour });
  }

  /**
   * The sprite modifiers MWG still does not model like Wesnoth (see
   * `MWG_SPRITE_MODIFIER_SKIPS`): the numeric `~CHAN` approximation. `~RC` is
   * now an exact pixel swap via `pixelTexture`, not a tint.
   */
  private applyAdditionalImageModifiers(sprite: Sprite2D, parsed: ParsedImagePath): void {
    const channel = parsed.modifiers.find((modifier) => modifier.name === 'CHAN');
    if (!channel) return;
    const values = channel.args.slice(0, 3).map(Number);
    if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) return;
    const factor = (value: number): number => value > 1 ? value / 255 : value;
    const filter = new ColorMatrixFilter();
    filter.matrix = [factor(values[0]), 0, 0, 0, 0, 0, factor(values[1]), 0, 0, 0, 0, 0, factor(values[2]), 0, 0, 0, 0, 0, 1, 0] as typeof filter.matrix;
    sprite.filters = [...(sprite.filters ?? []), filter];
  }

  /** The scenario's compiled animations for a unit, or undefined for a bare type. */
  private animationsFor(unit: Unit): UnitAnimations | undefined {
    return UNIT_ANIMATIONS[unit.typeId];
  }

  /** Idle frames, falling back to the type's static image when it has none. */
  private idleFrames(unit: Unit): readonly AnimFrame[] {
    const animations = this.animationsFor(unit);
    const frames = animations?.idle.length ? animations.idle : animations?.standing.length ? animations.standing : [];
    return frames.length ? frames : [{ image: unit.image, duration: 200 }];
  }

  private movementFrames(unit: Unit): readonly AnimFrame[] {
    const frames = this.animationsFor(unit)?.movement ?? [];
    return frames.length ? frames : this.idleFrames(unit);
  }

  private deathFrames(unit: Unit): readonly AnimFrame[] {
    const frames = this.animationsFor(unit)?.death ?? [];
    return frames.length ? frames : [{ image: unit.image, duration: 120 }];
  }

  /** The frames for the unit's strongest attack, matching its `[filter_attack]`. */
  private attackFrames(unit: Unit): readonly AnimFrame[] {
    const animations = this.animationsFor(unit);
    if (!animations?.attacks.length) return this.idleFrames(unit);
    const strongest = [...unit.attacks].sort((a, b) => b.damage * b.number - a.damage * a.number)[0];
    const named = strongest ? animations.attacks.find((entry) => entry.attack === strongest.name) : undefined;
    return named?.frames.length ? named.frames : animations.attacks[0].frames;
  }

  /** Whether a unit should be drawn at all for the human side. */
  private unitVisible(unit: Unit): boolean {
    if (unit.hidden) return false;
    if (this.localMultiplayer) return true;
    if (unit.side === this.viewSide()) return true;
    return !(
      this.hiddenSides.has(unit.side) ||
      isFogged(this.state, GAME_DATA, this.viewSide(), unit.x, unit.y) ||
      isHidden(this.state, GAME_DATA, unit, this.viewSide(), lawfulBonusAt(GAME_DATA, this.state, unit.x, unit.y))
    );
  }

  /** Create the persistent sprite, health bar and status icons for a unit. */
  private createUnitView(key: string, unit: Unit): void {
    const container = new Node2D();
    const sprite = new Sprite2D(Texture2D.EMPTY);
    sprite.anchor.set(0.5, 0.78);
    sprite.width = TILE * 1.05;
    sprite.height = TILE * 1.05;
    const health = new Shape2D();
    container.addChild(sprite, health);
    this.unitLayer.addChild(container);
    this.unitViews.set(key, {
      unit,
      container,
      sprite,
      health,
      lastImage: '',
      state: 'idle',
      elapsed: 0,
      moveFrom: null,
      moveTo: null,
      moveDuration: 0,
    });
  }

  /**
   * Add, drop and update the persistent unit views. A unit that left
   * `state.units` with no hitpoints left plays its death animation first; one
   * that was simply stored away is removed at once.
   */
  private syncUnitViews(): void {
    const alive = new Set(this.state.units);
    for (const [key, view] of [...this.unitViews]) {
      if (alive.has(view.unit) || view.state === 'dead') continue;
      if (view.unit.hitpoints <= 0) {
        view.state = 'dead';
        view.elapsed = 0;
        view.moveFrom = null;
      } else {
        this.removeUnitView(key);
      }
    }
    for (const unit of this.state.units) {
      const key = String(unit.id);
      if (!this.unitViews.has(key)) this.createUnitView(key, unit);
    }
    for (const view of this.unitViews.values()) {
      view.container.visible = this.unitVisible(view.unit);
      if (view.container.visible) this.drawUnitHealth(view);
    }
  }

  /** Health bar, side marker and the poisoned/slowed/petrified icons. */
  private drawUnitHealth(view: UnitView): void {
    const unit = view.unit;
    const g = view.health;
    g.clear();
    const barWidth = TILE * 0.8;
    const barY = TILE * 0.28;
    g.rect(-barWidth / 2, barY, barWidth, 4).fill(0x321f24);
    const ratio = Math.max(0, Math.min(1, unit.hitpoints / unit.maxHitpoints));
    g.rect(-barWidth / 2, barY, barWidth * ratio, 4).fill(ratio > 0.5 ? 0x9cdb69 : 0xe8b84b);
    g.circle(TILE * 0.38, -TILE * 0.38, 4).fill(unit.side === 2 ? 0xb3a6dd : 0xf6d365);
    let x = -TILE * 0.45;
    for (const [active, color] of [[unit.poisoned, 0x8fd14f], [unit.slowed, 0x6fb7ff], [unit.petrified, 0xbfc3cc]] as const) {
      if (!active) continue;
      g.circle(x, -TILE * 0.46, 3.4).fill(color).stroke({ color: 0x0b0d12, width: 1 });
      x += 9;
    }
  }

  private removeUnitView(key: string): void {
    const view = this.unitViews.get(key);
    if (!view) return;
    view.container.destroy({ children: true });
    this.unitViews.delete(key);
  }

  /** Bind one frame's texture, applying its image modifiers once on change. */
  private applyFrame(view: UnitView, frame: AnimFrame | null, fallback: string): void {
    const image = frame?.image || fallback;
    if (!image) return;
    // Wesnoth hangs a sound on an animation frame (`[frame] sound=`, which
    // `{SOUND:HIT ...}` expands into), so a swing or a death rattle is heard
    // when its frame appears rather than when the rules resolved the fight.
    const cue = image !== view.lastImage ? frame?.sound : undefined;
    if (cue) this.audio.playCue(pickCue(expandSoundList(cue)));
    if (image !== view.lastImage) {
      const parsed = parseImagePath(image);
      // Recolour the magenta team-colour pixels onto the side's range (the real
      // team-colour pass), instead of tinting the whole sprite.
      const texture = this.pixelTexture(croppedTexture(this.teamTexture(parsed.path, this.sideColorId(view.unit.side)), parsed), parsed);
      // The texture loads asynchronously; retry next frame rather than binding an
      // empty one and forgetting the frame.
      if (texture !== Texture2D.EMPTY) {
        view.sprite.texture = texture;
        view.sprite.filters = [];
        view.sprite.width = TILE * 1.05;
        view.sprite.height = TILE * 1.05;
        view.sprite.tint = 0xffffff;
        applyImageModifiers(view.sprite, mwgSpritePath(parsed), TILE / TILE_SOURCE);
        this.applyAdditionalImageModifiers(view.sprite, parsed);
        view.lastImage = image;
      }
    }
    const scale = TILE / TILE_SOURCE;
    view.sprite.position.set((frame?.x ?? 0) * scale, (frame?.y ?? 0) * scale);
  }

  /** Start interpolating a unit's view from where it was to where the rules put it. */
  /**
   * An animation duration in milliseconds, zero under reduced motion. The
   * engine's own animation lengths are unchanged; a player who asked for less
   * motion sees the frame the action ends on.
   */
  private motionMs(ms: number): number {
    return this.reducedMotion ? 0 : ms;
  }

  private startMoveAnimation(unit: Unit, from: { x: number; y: number }): void {
    const view = this.unitViews.get(String(unit.id));
    if (!view) return;
    const fromPixel = hexToPixel(from.x, from.y, TILE, TILE);
    const toPixel = hexToPixel(unit.x, unit.y, TILE, TILE);
    view.state = 'move';
    view.elapsed = 0;
    view.moveFrom = { x: fromPixel.x, y: fromPixel.y - TILE * 0.18 };
    view.moveTo = { x: toPixel.x, y: toPixel.y - TILE * 0.18 };
    view.moveDuration = this.motionMs(Math.max(1, hexDistance(from, unit)) * MOVE_MS_PER_HEX);
  }

  /** Play an attack animation once, then fall back to idle. */
  private startAttackAnimation(unit: Unit, target?: Unit, attackName?: string): void {
    const view = this.unitViews.get(String(unit.id));
    if (!view) return;
    view.state = 'attack';
    view.elapsed = 0;
    view.moveFrom = null;
    if (target) this.startProjectile(unit, target, attackName);
  }

  private attackAnimation(unit: Unit, attackName?: string): UnitAnimations['attacks'][number] | undefined {
    const animations = this.animationsFor(unit)?.attacks ?? [];
    return (attackName ? animations.find((entry) => entry.attack === attackName) : undefined) ?? animations[0];
  }

  /** Create a presentation-only projectile; the rules have already resolved synchronously. */
  private startProjectile(attacker: Unit, defender: Unit, attackName?: string): void {
    const animation = this.attackAnimation(attacker, attackName);
    if (!animation?.missileFrames.length) return;
    const sprite = new Sprite2D(Texture2D.EMPTY);
    sprite.anchor.set(0.5);
    this.haloLayer.addChild(sprite);
    this.projectiles.push({
      sprite,
      frames: animation.missileFrames,
      from: hexToPixel(attacker.x, attacker.y, TILE, TILE),
      to: hexToPixel(defender.x, defender.y, TILE, TILE),
      elapsed: 0,
    });
  }

  /** Simulate turns and skip dialogues when autoplay is enabled (test aid only). */
  private autoplayUpdate(dt: number): void {
    if (this.autoAnswerLuaDialog()) return;
    if (this.dialogueOpen) {
      this.advanceDialogue();
      return;
    }
    if (this.outcome !== 'playing') return;
    this.autoplayTimer += dt;
    if (this.autoplayTimer >= 0.5) {
      this.autoplayTimer = 0;
      // Force the end of the turn even for a human-controlled side.
      this.finishTurn();
    }
  }

  private autoplayTimer = 0;

  private updateProjectiles(dt: number): void {
    const ms = dt * 1000;
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      projectile.elapsed += ms;
      const frame = frameAt(projectile.frames, projectile.elapsed, false);
      if (frame) {
        const parsed = parseImagePath(frame.image);
        const texture = croppedTexture(this.texture(parsed.path), parsed);
        if (texture !== Texture2D.EMPTY) {
          // `sizeArt` already binds the texture and applies its modifiers.
          this.sizeArt(projectile.sprite, parsed, texture);
        }
      }
      const total = Math.max(1, totalDuration(projectile.frames));
      const progress = frame?.offset ?? Math.min(1, projectile.elapsed / total);
      const scale = TILE / TILE_SOURCE;
      projectile.sprite.position.set(
        projectile.from.x + (projectile.to.x - projectile.from.x) * progress + (frame?.x ?? 0) * scale,
        projectile.from.y + (projectile.to.y - projectile.from.y) * progress - TILE * 0.18 + (frame?.y ?? 0) * scale,
      );
      projectile.sprite.alpha = frame?.alpha ?? 1;
      if (projectile.elapsed < total) continue;
      projectile.sprite.destroy();
      this.projectiles.splice(index, 1);
    }
  }

  /** Advance every unit view: idle loops, move interpolates, attack and death play once. */
  private updateUnitViews(dt: number): void {
    const ms = dt * 1000;
    for (const [key, view] of [...this.unitViews]) {
      const unit = view.unit;
      if (view.state === 'dead') {
        view.elapsed += ms;
        const frames = this.deathFrames(unit);
        this.applyFrame(view, frameAt(frames, view.elapsed, false), unit.image);
        if (view.elapsed >= Math.max(1, totalDuration(frames))) this.removeUnitView(key);
        continue;
      }
      const center = hexToPixel(unit.x, unit.y, TILE, TILE);
      let px = center.x;
      let py = center.y - TILE * 0.18;
      if (view.state === 'move' && view.moveFrom && view.moveTo) {
        view.elapsed += ms;
        const t = view.moveDuration <= 0 ? 1 : Math.min(1, view.elapsed / view.moveDuration);
        px = view.moveFrom.x + (view.moveTo.x - view.moveFrom.x) * t;
        py = view.moveFrom.y + (view.moveTo.y - view.moveFrom.y) * t;
        this.applyFrame(view, frameAt(this.movementFrames(unit), view.elapsed, true), unit.image);
        if (t >= 1) {
          view.state = 'idle';
          view.elapsed = 0;
          view.moveFrom = null;
          view.moveTo = null;
        }
      } else if (view.state === 'attack') {
        view.elapsed += ms;
        const frames = this.attackFrames(unit);
        this.applyFrame(view, frameAt(frames, view.elapsed, false), unit.image);
        if (view.elapsed >= Math.max(1, totalDuration(frames))) {
          view.state = 'idle';
          view.elapsed = 0;
        }
      } else {
        view.elapsed += ms;
        this.applyFrame(view, frameAt(this.idleFrames(unit), view.elapsed, true), unit.image);
      }
      view.container.position.set(px, py);
    }
  }

  /** Small tactical overview, using the same fog state as the main board. */
  private drawMinimap(): void {
    if (!this.minimap) return;
    const cell = this.minimapCell;
    const colors: Record<string, number> = {
      Gg: 0x66854c,
      Gs: 0x9b925b,
      Hh: 0x84785e,
      Mm: 0x8d8c86,
      Ww: 0x4d83a7,
      Aa: 0xc9b878,
      Uu: 0x4c4a55,
      Ch: 0xa08b67,
    };
    const darken = (color: number): number => {
      const r = Math.floor(((color >> 16) & 0xff) * 0.45);
      const g = Math.floor(((color >> 8) & 0xff) * 0.45);
      const b = Math.floor((color & 0xff) * 0.45);
      return (r << 16) | (g << 8) | b;
    };
    this.minimap.reset();
    const minimapSide = this.viewSide();
    const explored = new Set(this.state.fog.exploredCells(String(minimapSide)));
    this.minimap.sync(explored, (x, y) => {
      const base = splitCode(terrainCodeAt(this.state, x, y)).base;
      const color = colors[base] ?? 0x5e665e;
      return this.localMultiplayer ? color : (isFogged(this.state, GAME_DATA, minimapSide, x, y) ? darken(color) : color);
    });

    this.minimapUnits.clear();
    this.minimapUnits.roundRect(-6, -6, this.state.width * cell + 12, this.state.height * cell + 12, 5).fill({ color: 0x090c12, alpha: 0.92 });
    const markers: { x: number; y: number; color: number }[] = [];
    for (const unit of this.state.units) {
      if (unit.hitpoints <= 0 || (!this.localMultiplayer && (isShrouded(this.state, minimapSide, unit.x, unit.y) || (unit.side !== minimapSide && isFogged(this.state, GAME_DATA, minimapSide, unit.x, unit.y))))) continue;
      markers.push({ x: unit.x, y: unit.y, color: unit.side === 1 ? 0xf6d365 : 0xc5b4ec });
    }
    const minimapWithMarkers = this.minimap as Minimap & { setMarkers?: (items: readonly { x: number; y: number; color: number }[]) => void };
    if (minimapWithMarkers.setMarkers) {
      minimapWithMarkers.setMarkers(markers);
    } else {
      for (const marker of markers) {
        this.minimapUnits.circle(marker.x * cell + cell / 2, marker.y * cell + cell / 2, Math.max(1.5, cell * 0.42)).fill(marker.color);
      }
    }
  }

  private click(x: number, y: number): void {
    // A modal window takes the click; the board underneath stays inert.
    if (this.windows.blocksWorld) return;

    if (Input.justPressed('undo')) {
      this.undoLast();
      return;
    }
    if (Input.justPressed('redo')) {
      this.redoLast();
      return;
    }
    if (this.endScreenOpen) return;
    if (this.dialogueOpen) {
      this.advanceDialogue();
      return;
    }
    if (this.pendingAttack) {
      if (Input.justPressed('endTurn')) this.cancelAttack();
      return;
    }
    if (this.outcome !== 'playing') return;
    const playerSide = this.viewSide();
    const target = unitAt(this.state, x, y);

    if (!this.selected) {
      if (target?.side === playerSide) {
        this.selected = target;
        this.log = `${target.name} selected: ${target.movement} movement left. Click a highlighted hex or an adjacent enemy.`;
      } else if (isKeepHex(this.state, GAME_DATA, x, y) && (this.state.keeps.get(playerSide) ?? []).some((keep) => keep.x === x && keep.y === y)) {
        this.openRecruitMenu(playerSide);
      }
      this.refresh();
      return;
    }

    // A unit hidden from side 1 cannot be seen or attacked: the click falls
    // through to movement, the same as clicking an empty hex.
    const targetVisible =
      !target || target.side === playerSide || this.localMultiplayer || !isHidden(this.state, GAME_DATA, target, playerSide, lawfulBonusAt(GAME_DATA, this.state, target.x, target.y));
    if (target && targetVisible && target.side !== playerSide && this.adjacent(this.selected, target)) {
      this.showAttackDialog(this.selected, target);
    } else if (target && targetVisible && target?.side === playerSide && target.id !== this.selected.id) {
      this.selected = target;
      this.log = `${target.name} selected.`;
    } else if (this.selected) {
      const mover = this.selected;
      const from = { x: mover.x, y: mover.y };
      const moved = moveUnit(this.state, GAME_DATA, mover, x, y);
      if (moved.ok) {
        this.log = `${mover.name} moves.`;
        this.recordAction({ type: 'move', unitId: mover.id, unitName: mover.name, from, to: { x, y }, side: mover.side });
        this.selected = null;
        this.startMoveAnimation(mover, from);
        this.reportMove(mover, moved.capturedVillage ? { previousOwner: moved.previousOwner ?? null } : null, from);
        this.evaluateOutcome();
        this.commitUndo();
      } else {
        this.log = 'That hex is not reachable this turn.';
        this.selected = null;
      }
    }
    this.refresh();
  }

  private adjacent(a: Unit, b: Unit): boolean {
    return Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && hexNeighbors(a.x, a.y).some((n) => n.x === b.x && n.y === b.y);
  }

  /** Ask for confirmation before resolving combat, as Wesnoth's attack dialog does. */
  private showAttackDialog(attacker: Unit, defender: Unit): void {
    if (!predictAttack(this.state, GAME_DATA, attacker, defender)) return;
    this.pendingAttack = { attacker, defender };
    this.attackDialog.visible = true;
    this.layoutAttackDialog();
  }

  private cancelAttack(): void {
    this.pendingAttack = null;
    this.attackDialog.visible = false;
  }

  private confirmAttack(): void {
    const pending = this.pendingAttack;
    if (!pending) return;
    this.cancelAttack();
    this.doAttack(pending.attacker, pending.defender);
  }

  private layoutAttackDialog(): void {
    if (!this.pendingAttack || !this.state || !this.attackDialog.visible) return;
    const prediction = predictAttack(this.state, GAME_DATA, this.pendingAttack.attacker, this.pendingAttack.defender);
    if (!prediction) {
      this.cancelAttack();
      return;
    }
    const width = Math.min(520, Math.max(320, Game.current.width - 48));
    const height = 154;
    this.attackDialog.removeChildren().forEach((child) => child.destroy({ children: true }));
    this.attackDialog.addChild(new Shape2D().roundRect(0, 0, width, height, 10).fill({ color: 0x171310, alpha: 0.98 }).stroke({ color: 0xc9a227, width: 2 }));
    this.attackDialog.addChild(new Text2D({
      text: `${this.pendingAttack.attacker.name} attaque ${this.pendingAttack.defender.name}`,
      style: { fill: 0xf0d27a, fontSize: 18, fontFamily: 'system-ui', fontWeight: '700' },
    })).position.set(18, 14);
    this.attackDialog.addChild(new Text2D({
      text: `${prediction.attackName}: ${prediction.strikes} frappes à ${prediction.cth}% — ${prediction.damage} dégâts\n` +
        (prediction.defenderAttackName
          ? `${prediction.defenderAttackName}: ${prediction.defenderStrikes} frappes à ${prediction.defenderCth}% — ${prediction.defenderDamage} dégâts en riposte`
          : 'Aucune riposte possible'),
      style: { fill: 0xf4edd9, fontSize: 13, fontFamily: 'system-ui', wordWrap: true, wordWrapWidth: width - 36 },
    })).position.set(18, 48);

    const button = (label: string, x: number, color: number, action: () => void): void => {
      const control = new Node2D();
      control.position.set(x, 112);
      control.eventMode = 'static';
      control.cursor = 'pointer';
      control.addChild(new Shape2D().roundRect(0, 0, 112, 28, 5).fill({ color, alpha: 0.95 }));
      control.addChild(new Text2D({ text: label, style: { fill: 0xffffff, fontSize: 13, fontFamily: 'system-ui', fontWeight: '700' } }));
      control.on('pointertap', action);
      this.attackDialog.addChild(control);
    };
    button('Attaquer', 18, 0x6a3c32, () => this.confirmAttack());
    button('Annuler', width - 130, 0x343848, () => this.cancelAttack());
    this.attackDialog.position.set(Math.round((Game.current.width - width) / 2), Math.round((Game.current.height - height) / 2));
  }

  private doAttack(attacker: Unit, defender: Unit): void {
    const attack = [...attacker.attacks].sort((a, b) => b.damage * b.number - a.damage * a.number)[0];
    const terrain = resolveTerrain(GAME_DATA, movetypeOf(GAME_DATA, defender), terrainCodeAt(this.state, defender.x, defender.y));
    const cth = chanceToHit({ data: GAME_DATA, lawfulBonus: lawfulBonusAt(GAME_DATA, this.state, defender.x, defender.y) }, defender, terrain, attack.specials);
    const damage = damagePerStrike({ data: GAME_DATA, lawfulBonus: lawfulBonusAt(GAME_DATA, this.state, attacker.x, attacker.y) }, attacker, defender, attack);
    const outcome = attackWithRules(this.state, GAME_DATA, attacker, defender, attack.name, this.roll);
    this.recordAction(
      { type: 'attack', attackerId: attacker.id, attackerName: attacker.name, defenderId: defender.id, defenderName: defender.name, attackName: attack.name, side: attacker.side },
      [{ type: 'resolved' }, ...(outcome.exchange.defenderKilled ? [{ type: 'killed', id: defender.id } as WesnothEvent] : [])],
    );
    this.reportCombat(attacker, defender, outcome.exchange.defenderKilled, outcome.exchange, outcome.plagueSpawn);
    this.reportAdvancements(outcome);
    const dealt = outcome.exchange.strikes.reduce((total, strike) => total + (strike.attacker === attacker.id ? strike.damage : 0), 0);
    const received = outcome.exchange.strikes.reduce((total, strike) => total + (strike.attacker === defender.id ? strike.damage : 0), 0);
    // The rules resolve the exchange at once; the view plays the swing beside it
    // so combat reads as an attack rather than a silent number change.
    this.startAttackAnimation(attacker, defender, attack.name);
    if (dealt > 0) this.pushLabel(defender, `-${dealt}`, 0xff9b87);
    if (received > 0) this.pushLabel(attacker, `-${received}`, 0xffc06e);
    this.log = `${attacker.name} attacks ${defender.name} with ${attack.name}: ${outcome.exchange.strikes.length} strikes at ${cth}% for ${damage} each.`;
    this.selected = null;
    this.evaluateOutcome();
    this.commitUndo();
  }

  /** A floating label over a unit, positioned through the board's own transform. */
  private pushLabel(unit: Unit, text: string, color: number): void {
    const center = hexToPixel(unit.x, unit.y, TILE, TILE);
    const point = this.board.toGlobal({ x: center.x, y: center.y - TILE * 0.8 });
    this.floatingTextStack.push({ x: point.x, y: point.y, text, color, duration: 0.9, key: unit.id });
  }

  /** Place a recruited unit on a named hex; shared by the player and the AI. */
  private placeRecruit(side: number, typeId: string, x: number, y: number): Unit | null {
    const unit = recruit(this.state, GAME_DATA, side, typeId, x, y, this.roll);
    if (!unit) return null;
    this.gold[side] -= unit.cost;
    this.unitsById.set(`recruit-${unit.id}`, unit);
    this.recordAction({ type: 'recruit', unitId: unit.id, unitName: unit.name, typeId, x, y, side });
    this.reportRecruit(unit);
    this.log = `Side ${side} recruits a ${unit.name}.`;
    this.evaluateOutcome();
    if (side === 1) this.commitUndo();
    return unit;
  }

  private tryRecruit(side: number, requestedType?: string): void {
    const list = (this.runtime.world.sides[String(side)]?.recruit ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    const typeId = requestedType && list.includes(requestedType)
      ? requestedType
      : list.find((id) => (GAME_DATA.unitTypes[id]?.cost ?? Infinity) <= (this.gold[side] ?? 0));
    if (!typeId) {
      this.log = 'Not enough gold to recruit.';
      return;
    }
    const [hex] = vacantRecruitHexes(this.state, GAME_DATA, side);
    if (hex && this.placeRecruit(side, typeId, hex.x, hex.y)) return;
    this.log = sideLeaders(this.state, side).length
      ? 'Your leader must stand on a keep with a free castle hex.'
      : 'No free castle hex next to the keep.';
  }

  /**
   * The Recruit / Recall list, over a framework `Window` + `ListView`: every
   * row carries its real cost, and a row the side cannot afford is disabled
   * rather than hidden, so the list reads the same as the real client's.
   */
  private openRecruitMenu(side: number): void {
    if (side !== this.viewSide()) return;
    const gold = this.gold[side] ?? 0;
    const recruitables = (this.runtime.world.sides[String(side)]?.recruit ?? '')
      .split(',').map((id) => id.trim()).filter((id) => GAME_DATA.unitTypes[id]);
    const items: ListItem[] = [];
    for (const typeId of recruitables) {
      const stats = GAME_DATA.unitTypes[typeId];
      items.push({
        text: `Recruit ${stats.name || typeId} — ${stats.cost} gold`,
        value: `recruit:${typeId}`,
        disabled: stats.cost > gold,
      });
    }
    const sideConfig = this.runtime.world.sides[String(side)] as { recall_filter?: string } | undefined;
    this.recallList.forEach((entry, index) => {
      if (sideConfig?.recall_filter && !this.matchesRecallFilter(entry, sideConfig.recall_filter)) return;
      items.push({
        text: `Recall ${entry.name || entry.typeId} — 20 gold (${entry.hitpoints} HP, ${entry.experience} XP)`,
        value: `recall:${index}`,
        disabled: gold < 20,
      });
    });
    if (!items.length) {
      this.log = 'This side has no recruitable or recallable units.';
      return;
    }
    const { window } = listWindow({
      title: `Recruit / Recall — ${gold} gold`,
      width: 470,
      height: 380,
      items,
      footer: 'Recruits take the free castle hexes beside your keep.',
      onSelect: (item) => {
        const value = String(item.value ?? '');
        this.windows.closeAll();
        if (value.startsWith('recruit:')) this.tryRecruit(side, value.slice('recruit:'.length));
        else if (value.startsWith('recall:')) this.recallOne(Number(value.slice('recall:'.length)));
      },
    });
    this.track(window);
  }

  /** Evaluate the small, data-only subset used by side-level recall filters. */
  private matchesRecallFilter(entry: Carryover['units'][number], encoded: string): boolean {
    try {
      const filter = JSON.parse(decodeURIComponent(encoded)) as { attributes?: Record<string, string>; children?: unknown[] };
      const match = (node: { attributes?: Record<string, string>; children?: unknown[] }): boolean => {
        const attrs = node.attributes ?? {};
        if (attrs.type && !attrs.type.split(',').map((value) => value.trim()).includes(entry.typeId)) return false;
        if (attrs.id && !attrs.id.split(',').map((value) => value.trim()).includes(entry.name)) return false;
        if (attrs.trait && !entry.traits?.some((trait) => attrs.trait!.split(',').map((value) => value.trim()).includes(trait))) return false;
        return (node.children ?? []).every((child) => {
          if (!child || typeof child !== 'object') return true;
          const nested = child as { tag?: string; attributes?: Record<string, string>; children?: unknown[] };
          return nested.tag === 'not' ? !match(nested.children?.[0] as { attributes?: Record<string, string>; children?: unknown[] } ?? {}) : match(nested);
        });
      };
      return match(filter);
    } catch {
      return true;
    }
  }

  override update(dt: number): void {
    this.floatingTextStack.update(dt);
    // The title backdrop lives as long as the main menu's windows do.
    if (this.titleOpen && this.windows.isEmpty) this.titleOpen = false;
    // A Lua handler is waiting on the invest dialog: Escape does not dismiss it.
    if (this.luaDialog && this.windows.isEmpty) this.showLuaDialog();
    this.titleLayer.visible = this.titleOpen;
    this.updateHalos(dt);
    this.updateProjectiles(dt);

    // Autoplay: simulate turns automatically
    if (this.autoplay) {
      this.autoplayUpdate(dt);
    }
    // The crossfade advances with the frame, like every other animation.
    const listener = sideLeaders(this.state, this.viewSide())[0];
    if (listener) this.audio.setListener(listener.x, listener.y);
    this.audio.update(dt);
    this.reducedMotion = this.reducedMotionOverride ?? (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
    // Animation is presentation, not input: keep it running even while a
    // dialogue, dialog or end screen owns the keyboard.
    this.updateUnitViews(dt);
    this.windows.update(dt);

    // A window owns the keyboard while it is open. The one Escape press that
    // closes it must not immediately reopen the menu, hence `suppressMenuToggle`.
    if ((Input.justPressed('cancel') || Input.justPressed('menu')) && this.suppressMenuToggle) {
      this.suppressMenuToggle = false;
    } else if (
      (Input.justPressed('cancel') || Input.justPressed('menu')) &&
      this.windows.isEmpty &&
      !this.endScreenOpen &&
      !this.dialogueOpen
    ) {
      this.openPauseMenu();
      return;
    }
    if (this.windows.blocksWorld) return;

    if (Input.justPressed('saveGame')) {
      this.saveGame();
      return;
    }
    if (Input.justPressed('loadGame')) {
      this.loadGame();
      return;
    }
    if (Input.justPressed('objectives')) {
      this.openObjectives();
      return;
    }
    if (this.endScreenOpen) {
      if (Input.justPressed('restart')) {
        this.startScenario(this.scenarioName, null);
        this.resize(Game.current.width, Game.current.height);
        return;
      }
      if ((Input.justPressed('confirm') || Input.justPressed('endTurn')) && this.luaGame && this.outcome === 'won') {
        this.continueWorldConquest();
        return;
      }
      if (Input.justPressed('confirm') || Input.justPressed('endTurn')) {
        const carryover = this.carryover;
        if (carryover) {
          if (globalThis.location) globalThis.location.hash = carryover.to;
          this.startScenario(carryover.to, carryover);
        } else {
          const first = this.scenarioOrder()[0] ?? DEFAULT_SCENARIO;
          if (globalThis.location) globalThis.location.hash = first;
          this.startScenario(first, null);
        }
        this.resize(Game.current.width, Game.current.height);
      }
      return;
    }
    if (this.dialogueOpen) {
      // A dialogue box owns the input until it is dismissed.
      if (Input.justPressed('confirm') || Input.justPressed('endTurn')) this.advanceDialogue();
      return;
    }
    if (Input.justPressed('restart')) {
      this.startScenario();
      this.log = `Fresh battle. ${this.log}`;
      this.refresh();
    }
    if (Input.justPressed('nextScenario')) {
      const order = this.scenarioOrder();
      const index = order.indexOf(this.scenarioName);
      this.scenarioName = order[(index + 1) % order.length] ?? DEFAULT_SCENARIO;
      if (globalThis.location) globalThis.location.hash = this.scenarioName;
      this.startScenario();
      this.log = `${this.scenarioTitle()}. ${this.log}`;
      this.resize(Game.current.width, Game.current.height);
    }
    // Keyboard play: the arrows drive a hex cursor, Enter acts on it, and Space
    // ends the selected unit's turn (Wesnoth's `endunitturn`). Ctrl+Space ends
    // the whole turn (`endturn`), N cycles to the next unit with moves left.
    if (this.moveCursor()) return;
    if (Input.justPressed('describeUnit')) {
      // Wesnoth's `describeunit` (D): the unit under the cursor, in the same
      // generated form the encyclopedia uses, plus its current state.
      const unit = unitAt(this.state, this.cursor.x, this.cursor.y);
      if (unit) {
        const type = GAME_DATA.unitTypes[unit.typeId];
        const attacks = unit.attacks
          .map((attack) => `${attack.name}: ${attack.damage}×${attack.number} ${attack.type} (${attack.range})${attack.specials.length ? ` [${attack.specials.join(', ')}]` : ''}`)
          .join('\n');
        this.track(textWindow(unit.name || unit.typeId, [
          `Side ${unit.side} — ${unit.hitpoints}/${unit.maxHitpoints} HP — ${unit.movement}/${unit.maxMovement} moves`,
          `XP ${unit.experience}/${unit.maxExperience} — status: ${[unit.poisoned && 'poisoned', unit.slowed && 'slowed', unit.petrified && 'petrified'].filter(Boolean).join(', ') || 'ok'}`,
          `Race: ${type?.race ?? 'unknown'} — level ${unit.level} — ${unit.alignment}`,
          `Abilities: ${[...(type?.abilities ?? []), ...unit.extraAbilities].join(', ') || 'none'}`,
          `Advances to: ${(type?.advancesTo ?? []).join(', ') || 'none'}`,
          '',
          attacks || 'No attacks.',
        ], 460));
      } else {
        this.log = 'No unit under the cursor.';
        this.refresh();
      }
      return;
    }
    if (Input.justPressed('cycleUnit')) {
      this.cycleToNextUnit();
      return;
    }
    if (Input.justPressed('confirm')) {
      this.activateCursor();
      return;
    }
    if (Input.justPressed('endTurn')) {
      // Space ends the selected unit's turn; Ctrl+Space ends the whole turn.
      if (this.modifierHeld) {
        this.finishTurn();
      } else if (this.selected) {
        this.selected.movement = 0;
        this.log = `${this.selected.name} ends its turn.`;
        this.selected = null;
        this.refresh();
      } else {
        this.log = 'Select a unit first, or press Ctrl+Space to end the turn.';
        this.refresh();
      }
      return;
    }
  }

  /** Move the keyboard cursor; returns true when an arrow key was handled. */
  private moveCursor(): boolean {
    const step = (dx: number, dy: number): void => {
      this.cursor = {
        x: Math.max(0, Math.min(this.state.width - 1, this.cursor.x + dx)),
        y: Math.max(0, Math.min(this.state.height - 1, this.cursor.y + dy)),
      };
      this.cursorVisible = true;
      this.describeCursor();
      this.refresh();
    };
    if (Input.justPressed('cursorLeft')) { step(-1, 0); return true; }
    if (Input.justPressed('cursorRight')) { step(1, 0); return true; }
    if (Input.justPressed('cursorUp')) { step(0, -1); return true; }
    if (Input.justPressed('cursorDown')) { step(0, 1); return true; }
    return false;
  }

  /** The status line follows the keyboard cursor, the way it follows the pointer. */
  private describeCursor(): void {
    const unit = unitAt(this.state, this.cursor.x, this.cursor.y);
    if (!this.cursorVisible) return;
    this.log = unit
      ? `${unit.name} (${unit.typeId}) — ${unit.hitpoints}/${unit.maxHitpoints} HP, ${unit.movement} moves.`
      : `Hex ${this.cursor.x + 1},${this.cursor.y + 1}: ${terrainCodeAt(this.state, this.cursor.x, this.cursor.y)}.`;
  }

  /** Enter on the cursor hex: exactly what clicking there does. */
  private activateCursor(): void {
    this.cursorVisible = true;
    this.click(this.cursor.x, this.cursor.y);
  }

  /** N selects the next own unit with movement left, nearest the cursor first. */
  private cycleToNextUnit(): void {
    const mine = this.state.units.filter((unit) => unit.side === this.state.sides[0] && unit.hitpoints > 0 && unit.movement > 0);
    if (!mine.length) {
      this.log = 'No unit has moves left.';
      this.refresh();
      return;
    }
    const ordered = [...mine].sort((a, b) =>
      Math.max(Math.abs(a.x - this.cursor.x), Math.abs(a.y - this.cursor.y)) - Math.max(Math.abs(b.x - this.cursor.x), Math.abs(b.y - this.cursor.y)));
    const current = this.selected ? ordered.findIndex(unit => unit.id === this.selected!.id) : -1;
    const next = ordered[(current + 1) % ordered.length];
    this.selected = next;
    this.cursor = { x: next.x, y: next.y };
    this.cursorVisible = true;
    this.log = `${next.name} selected.`;
    this.refresh();
  }

  /** Add a temporary Wesnoth halo; the rule event owns lifetime, rendering owns the sprite. */
  private showHalo(image: string, x: number, y: number, duration: number, frames?: readonly { image: string; duration: number }[]): void {
    const center = hexToPixel(x, y, TILE, TILE);
    const sequence = frames?.length ? frames : [{ image, duration }];
    const parsed = parseImagePath(sequence[0].image);
    const texture = croppedTexture(this.texture(parsed.path), parsed);
    const sprite = new Sprite2D(texture);
    sprite.anchor.set(0.5);
    sprite.position.set(center.x, center.y);
    this.sizeArt(sprite, parsed, texture);
    this.haloLayer.addChild(sprite);
    this.halos.push({ sprite, frames: sequence, frameIndex: 0, frameRemaining: sequence[0].duration * 1000, remaining: Math.max(0.05, duration) * 1000 });
  }

  private updateHalos(dt: number): void {
    const ms = dt * 1000;
    for (let index = this.halos.length - 1; index >= 0; index--) {
      const halo = this.halos[index];
      halo.remaining -= ms;
      halo.frameRemaining -= ms;
      while (halo.frameRemaining <= 0 && halo.frames.length > 1 && halo.remaining > 0) {
        halo.frameIndex = (halo.frameIndex + 1) % halo.frames.length;
        const frame = halo.frames[halo.frameIndex];
        const parsed = parseImagePath(frame.image);
        const texture = croppedTexture(this.texture(parsed.path), parsed);
        halo.sprite.texture = texture;
        this.sizeArt(halo.sprite, parsed, texture);
        halo.frameRemaining += frame.duration * 1000;
      }
      if (halo.remaining > 0) continue;
      halo.sprite.destroy();
      this.halos.splice(index, 1);
    }
  }

  private finishTurn(): void {
    if (this.outcome !== 'playing') return;
    const side = this.state.turn;
    if (this.sideController(side) !== 'human') return;
    this.selected = null;
    // The ending side's turn closes before the next one opens, in the engine's
    // order (`src/play_controller.cpp:620-645`).
    this.publishTurnContext(this.state.round, side);
    this.runtime.run('side_turn_end');
    this.luaSideTurnEnd();
    this.gold[side] = (this.gold[side] ?? 0) + incomeFor(this.state, GAME_DATA, side);
    const before = new Map(this.state.units.map((unit) => [unit.id, unit.hitpoints] as const));
    let round = this.state.round;
    endTurn(this.state, GAME_DATA);
    this.recordAction({ type: 'end_turn', side, round: this.state.round });
    if (this.localMultiplayer) {
      this.reportHealthChanges(before);
      const opened = this.state.round !== round;
      if (opened) {
        this.runtime.run('turn_end');
        this.luaTurnEnd(round);
        round = this.state.round;
      }
      this.enterSideTurn(round, opened);
      this.saveGame();
      this.evaluateOutcome();
      this.log = this.outcome === 'playing' ? `Side ${this.state.turn} to move.` : this.log;
      this.refresh();
      return;
    }
    let opensTurn = this.state.round !== round;
    // A `controller=null` side has no player and no AI: its turn passes by itself.
    while (['ai', 'null'].includes(this.sideController(this.state.turn)) && this.outcome === 'playing') {
      const aiSide = this.state.turn;
      if (opensTurn) {
        this.runtime.run('turn_end');
        this.luaTurnEnd(round);
        round = this.state.round;
      }
      this.enterSideTurn(round, opensTurn);
      opensTurn = false;
      const idle = this.sideController(aiSide) === 'null';
      if (!idle) this.aiTurn(aiSide);
      if (!idle) this.gold[aiSide] = (this.gold[aiSide] ?? 0) + incomeFor(this.state, GAME_DATA, aiSide) + this.aiPolicy().bonusIncome;
      this.publishTurnContext(this.state.round, aiSide);
      this.runtime.run('side_turn_end');
      this.luaSideTurnEnd();
      endTurn(this.state, GAME_DATA);
      opensTurn = this.state.round !== round;
    }
    this.reportHealthChanges(before);
    if (opensTurn) {
      this.runtime.run('turn_end');
      this.luaTurnEnd();
    }
    this.enterSideTurn(this.state.round, opensTurn);
    this.saveGame();
    this.evaluateOutcome();
    this.log = this.outcome === 'playing' ? `Side ${this.state.turn} to move. Your units are ready.` : this.log;
    this.refresh();
  }

  /**
   * Publish the context a life-cycle trigger's conditions are read against and
   * fire the side turn's opening sequence (`src/play_controller.cpp:505-560`):
   * `turn`, `new_turn` when a round opens, then the refresh events.
   */
  private enterSideTurn(turn: number, opensTurn: boolean): void {
    this.publishTurnContext(turn, this.state.turn);
    // `turn_bell` from `data/game_config.cfg`, for the side the player controls.
    if (this.sideController(this.state.turn) === 'human') this.audio.playCue(uiCue(GAME_DATA, 'turn_bell'));
    for (const name of lifecycleEvents('turnStart', { opensTurn })) this.runtime.run(name);
    this.luaTurnStart(opensTurn);
    this.checkTimeOver();
    for (const name of lifecycleEvents('turnRefresh')) this.runtime.run(name);
    this.luaTurnRefresh();
  }

  /**
   * Wesnoth's `time over` (`src/play_controller.cpp:1292-1300`): once the turn
   * limit has passed the event fires exactly once, and what it means is the
   * scenario's business (`[endlevel]` or the loader's own turn-limit defeat).
   */
  private checkTimeOver(): void {
    const variables = this.runtime.world.variables;
    const limit = Number(variables.turn_limit ?? 0);
    if (!(limit > 0) || this.runtime.world.turn <= limit || variables.time_over === 'yes') return;
    variables.time_over = 'yes';
    this.runtime.run('time_over');
  }

  /**
   * Set `turn_number`/`turn_side`/`side_number` before a turn event runs. The
   * loader folds `turn 5` and `side 2 turn` into conditions on these, so an
   * unset variable would silently disable every scripted turn event.
   */
  private publishTurnContext(turn: number, side: number): void {
    // The engine owns the round counter; MWL `turns_elapsed` objectives read it.
    this.runtime.world.turn = turn;
    Object.assign(this.runtime.world.variables, turnContextVariables({ turn, side }));
  }

  /** Floating labels for the end-of-turn healing and the damage the AI dealt. */
  private reportHealthChanges(before: Map<number, number>): void {
    for (const unit of this.state.units) {
      const previous = before.get(unit.id);
      if (previous === undefined || previous === unit.hitpoints) continue;
      const delta = unit.hitpoints - previous;
      this.pushLabel(unit, `${delta > 0 ? '+' : ''}${delta}`, delta > 0 ? 0x8ee27a : 0xff9b87);
    }
  }

  /** Every enemy each side can see as of the last action, for `sighted` events. */
  private visibility = new Map<number, Set<number>>();
  /** The game's own sound cues and the scenario's music (`src/ui/audio.ts`). */
  private readonly audio = new AudioSurface(assetUrl);
  /** `enemies_defeated` fires once per scenario. */
  private enemiesDefeatedFired = false;

  /** The AI policy for the current difficulty, with the scenario's `[ai]` aspects folded in. */
  private aiPolicy(): AiPolicy {
    const variables = this.runtime?.world.variables ?? {};
    const aspect = (value: unknown): string | undefined => (value === undefined || value === null ? undefined : String(value));
    const policy = applyAspects(policyFor(this.difficulty), {
      aggression: aspect(variables.ai_aggression),
      caution: aspect(variables.ai_caution),
      greed: aspect(variables.ai_greed),
      grouping: aspect(variables.ai_grouping),
      stages: aspect(variables.ai_stages),
      // The scenario's own `[stage]`/`[candidate_action]` configuration: which
      // RCA candidates run, which it disabled, and any `max_score` retuning.
      candidates: aspect(variables.ai_candidates),
      disabledCandidates: aspect(variables.ai_candidate_off),
      candidateScores: aspect(variables.ai_candidate_scores),
    });
    const directives = aspect(variables.ai_directives)?.split(';').flatMap((entry) => {
      const [kind, x, y, radius, value, encodedFilter] = entry.split(',');
      const nx = Number(x); const ny = Number(y); const nr = Number(radius); const nv = Number(value);
      let filter: Record<string, unknown> | undefined;
      if (encodedFilter) {
        try { filter = JSON.parse(decodeURIComponent(encodedFilter)) as Record<string, unknown>; } catch { return []; }
      }
      const hasPoint = Number.isFinite(nx) && Number.isFinite(ny);
      return (kind === 'goal' || kind === 'avoid') && Number.isFinite(nr) && Number.isFinite(nv) && (hasPoint || filter)
        ? [{ kind, ...(hasPoint ? { x: nx, y: ny } : {}), radius: Math.max(0, nr), value: Math.max(0, nv), ...(filter ? { filter } : {}) } as const]
        : [];
    }) ?? [];
    return directives.length ? { ...policy, directives } : policy;
  }

  /**
   * The AI side's turn. `planSide` scores every reachable position and attack
   * with the engine's own combat rules and a threat map of the visible enemies;
   * this method only executes the plan through the same `moveUnit`,
   * `attackWithRules` and `placeRecruit` calls the human uses, so the AI pays
   * real movement, terrain and combat rolls.
   */
  private aiTurn(side = 2): void {
    const policy = this.aiPolicy();
    const recruitTypes = (this.runtime.world.sides[String(side)]?.recruit ?? '')
      .split(',').map((id) => id.trim()).filter(Boolean);
    const actions = planSide(this.state, GAME_DATA, side, { policy, recruitTypes, gold: this.gold[side] ?? 0 });
    for (const action of actions) {
      if (action.kind === 'recruit') {
        this.placeRecruit(side, action.typeId, action.x, action.y);
        continue;
      }
      const unit = this.state.units.find((candidate) => candidate.id === action.unitId);
      if (!unit || unit.hitpoints <= 0) continue;
      if (action.kind === 'move') {
        const from = { x: unit.x, y: unit.y };
        const moved = moveUnit(this.state, GAME_DATA, unit, action.x, action.y);
        if (moved.ok) {
          this.recordAction({ type: 'move', unitId: unit.id, unitName: unit.name, from, to: { x: action.x, y: action.y }, side: unit.side });
          this.startMoveAnimation(unit, from);
          this.reportMove(unit, moved.capturedVillage ? { previousOwner: moved.previousOwner ?? null } : null, from);
        }
        continue;
      }
      const target = this.state.units.find((candidate) => candidate.id === action.targetId);
      if (!target || target.hitpoints <= 0) continue;
      // The plan was made before the turn's earlier actions ran; an advancement or a
      // scenario event in between can change a unit's weapons, and the engine's own AI
      // re-evaluates after every action. Drop a step whose weapon is gone.
      if (!unit.attacks.some((attack) => attack.name === action.attackName)) continue;
      this.startAttackAnimation(unit, target, action.attackName);
      const exchange = attackWithRules(this.state, GAME_DATA, unit, target, action.attackName, this.roll);
      this.recordAction(
        { type: 'attack', attackerId: unit.id, attackerName: unit.name, defenderId: target.id, defenderName: target.name, attackName: action.attackName, side: unit.side },
        [{ type: 'resolved' }, ...(exchange.exchange.defenderKilled ? [{ type: 'killed', id: target.id } as WesnothEvent] : [])],
      );
      this.reportCombat(unit, target, exchange.exchange.defenderKilled, exchange.exchange, exchange.plagueSpawn);
      this.reportAdvancements(exchange);
    }
  }

  /**
   * Tell the runtime about a move the rule engine resolved. `on=moveto` events
   * read the unit's position from the runtime world, so sync first. A capture
   * fires first, with `$owner_side` set to the side that lost the village
   * (`src/team.cpp:424-441`, `src/actions/move.cpp:1221-1232`).
   */
  private reportMove(unit: Unit, capture: { previousOwner: number | null } | null = null, from?: { x: number; y: number }): void {
    this.syncRuntime();
    if (capture) {
      const variables = this.runtime.world.variables;
      if (capture.previousOwner === null) delete variables.owner_side;
      else variables.owner_side = String(capture.previousOwner);
      this.setTriggerUnit('last_capturer', unit);
      this.runtime.run('capture');
      delete variables.owner_side;
      this.showNextMessage();
    }
    // WML dynamic variable names commonly use the movement context `$x1` and
    // `$y1`; expose the same 1-based coordinates before dispatching moveto.
    this.runtime.world.variables.x1 = String(unit.x + 1);
    this.runtime.world.variables.y1 = String(unit.y + 1);
    // `$x2`/`$y2` of a moveto is the hex the unit came from (the overworld's POI events use it)
    if (from) {
      this.runtime.world.variables.x2 = String(from.x + 1);
      this.runtime.world.variables.y2 = String(from.y + 1);
    }
    const id = [...this.unitsById].find(([, candidate]) => candidate === unit)?.[0];
    // The mover is the subject of a `moveto` filter, the way the engine's own
    // event carries the moving unit (`src/actions/move.cpp:1232`).
    if (id) this.runtime.world.variables.unit_moved_id = id;
    if (id) this.runtime.fireMoveto(id);
    this.luaEvent('moveto', this.luaPos(unit), this.luaPos(unit));
    this.updateSighted(unit);
    this.showNextMessage();
  }

  // ------------------------------------------------------------------ World Conquest (real Lua)

  /** Draw the item pictures the Lua kernel placed (World Conquest's bonus items, shelters, ...). */
  private drawLuaItems(): void {
    this.itemLayer.removeChildren().forEach((child) => child.destroy());
    const overlays = this.luaGame?.wc.host?.overlays;
    if (!overlays) return;
    for (const [key, entries] of overlays) {
      const [x, y] = key.split(',').map(Number);
      const center = hexToPixel(x, y, TILE, TILE);
      for (const entry of entries) {
        const image = typeof entry.image === 'string' ? entry.image : typeof entry.halo === 'string' ? entry.halo : '';
        if (!image) continue;
        const sprite = new Sprite2D(this.texture(image.split('~')[0]));
        sprite.anchor.set(0.5);
        sprite.position.set(center.x, center.y);
        sprite.width = TILE;
        sprite.height = TILE;
        this.itemLayer.addChild(sprite);
      }
    }
  }

  /** The title of the scenario on screen: the compiled one's, or the generated World Conquest map's. */
  private scenarioTitle(): string {
    if (this.luaGame && this.scenarioName === WC_SCENARIO) return this.luaGame.setup.name;
    return SCENARIO_TITLES[this.scenarioName] ?? this.scenarioName;
  }

  /** Step one of the World Conquest flow: pick the faction (the era's `[multiplayer_side]`s). */
  private openWorldConquestMenu(): void {
    const items: ListItem[] = wcFactions().map((faction) => ({
      text: `${faction.name} — leaders: ${faction.leaders.slice(0, 4).join(', ')}${faction.leaders.length > 4 ? '…' : ''}`,
      value: faction.id,
    }));
    const { window } = listWindow({
      title: 'World Conquest — choose your faction',
      width: 640,
      height: 420,
      items,
      footer: 'Your commander and your starting heroes come from this faction.',
      onSelect: (item) => this.openWorldConquestDifficulty(String(item.value)),
    });
    this.track(window);
  }

  /** Step two: the campaign's own difficulties. */
  private openWorldConquestDifficulty(factionId: string): void {
    const items: ListItem[] = wcDifficulties().map((difficulty) => ({ text: difficulty.label, value: difficulty.id }));
    const { window } = listWindow({
      title: 'World Conquest — difficulty',
      width: 420,
      height: 300,
      items,
      footer: 'A higher difficulty makes the enemy armies stronger and your reserves smaller.',
      onSelect: (item) => this.startWorldConquest(factionId, String(item.value)),
    });
    this.track(window);
  }

  private startWorldConquest(factionId: string, difficulty: string): void {
    this.localMultiplayer = false;
    this.campaign = null;
    const wc = new WorldConquest({ data: GAME_DATA, seed: (Date.now() % 2147483647) >>> 0, difficulty, factionId });
    this.windows.closeAll();
    this.log = 'Generating the map…';
    this.beginWcScenario(wc, factionId, []);
  }

  /** Generate the next map and start it; `carried` are the previous map's survivors. */
  private beginWcScenario(wc: WorldConquest, factionId: string, carried: Unit[]): void {
    const setup = wc.generate();
    const carriedLeaderSides = new Set(carried.filter((unit) => unit.canRecruit).map((unit) => unit.side));
    this.luaGame = {
      wc,
      setup,
      factionId,
      compiled: wcCompiledGame(setup, carriedLeaderSides),
      settings: WorldConquest.sideSettings(setup, factionId),
      carried,
      ended: null,
    };
    this.enterScenario(WC_SCENARIO, null);
  }

  /** After a victory: keep the gold and the survivors, generate the next map. */
  private continueWorldConquest(): void {
    const game = this.luaGame;
    if (!game) return;
    const survivors = this.state.units.filter((unit) => unit.side === 1 && unit.hitpoints > 0);
    const gold = this.gold[1] ?? 0;
    game.wc.endScenario();
    // Lua's carry-over (15% of the gold, added to the next map's start) is the scenario's own
    // `carryover_percentage`; the units come along as the new map's recall list.
    this.carriedGold = Math.floor(gold * 0.15);
    this.beginWcScenario(game.wc, game.factionId, survivors);
  }

  private carriedGold = 0;

  /** Boot the game kernel on the scenario that just started (units exist, nothing has fired yet). */
  private startLua(): void {
    const game = this.luaGame;
    if (!game || this.scenarioName !== WC_SCENARIO) return;
    // Lua reads and writes gold through the side settings; keep it one number with the scene's.
    for (const [side, settings] of game.settings) {
      Object.defineProperty(settings, 'gold', {
        configurable: true,
        enumerable: true,
        get: () => this.gold[side] ?? 0,
        set: (value: number) => {
          this.gold[side] = value;
          if (this.runtime) this.runtime.world.gold[String(side)] = value;
        },
      });
    }
    if (this.carriedGold > 0) this.gold[1] = (this.gold[1] ?? 0) + this.carriedGold;
    this.carriedGold = 0;
    const services: LuaGameServices = {
      state: () => this.state,
      data: GAME_DATA,
      sides: game.settings,
      random: () => this.rng.float(),
      currentSide: () => this.state.turn,
      currentTurn: () => this.state.round,
      say: (message) => this.enqueueMessage({ text: message.text, speaker: message.speaker || undefined, portrait: message.image }),
      playSound: (file) => this.audio.playCue(file),
      endLevel: (result) => {
        game.ended = result === 'defeat' || result === 'loss' ? 'defeat' : 'victory';
      },
      log: (text) => {
        this.log = text;
      },
    };
    try {
      game.wc.start(game.setup, services);
    } catch (error) {
      console.error('World Conquest Lua failed to start', error);
      this.log = `Lua: ${(error as Error).message}`;
      return;
    }
    // The previous map's units: the leader takes its place, the rest wait on the recall list.
    const host = game.wc.host;
    for (const unit of game.carried) {
      if (unit.canRecruit) {
        const start = game.setup.starts.get(unit.side);
        if (start) {
          unit.x = start.x;
          unit.y = start.y;
        }
        unit.movement = unit.maxMovement;
        this.state.units.push(unit);
      } else if (host) {
        const list = host.recall.get(unit.side) ?? [];
        list.push(unit);
        host.recall.set(unit.side, list);
      }
    }
    game.carried = [];
  }

  private luaPos(unit: Unit): { x: number; y: number } {
    return { x: unit.x, y: unit.y };
  }

  /** Queue an event for the Lua kernel (the same names the MWL runtime hears); dialogs it opens block the queue. */
  private luaEvent(name: string, first?: { x: number; y: number }, second?: { x: number; y: number }, eventUnits: Unit[] = []): void {
    if (!this.luaGame || !this.luaGame.wc.vm) return;
    this.luaQueue.push({ name, first, second, eventUnits });
    this.pumpLua();
  }

  private luaQueue: { name: string; first?: { x: number; y: number }; second?: { x: number; y: number }; eventUnits: Unit[] }[] = [];
  private luaPumping = false;
  /** a Lua handler is waiting for the player (the invest tree) */
  private luaDialog: { tree: LuaTreeNode[] } | null = null;

  private pumpLua(): void {
    const game = this.luaGame;
    if (!game || this.luaPumping) return;
    this.luaPumping = true;
    try {
      while (!this.luaDialog && this.luaQueue.length > 0) {
        const event = this.luaQueue.shift()!;
        let request: Record<string, unknown> | null = null;
        try {
          request = game.wc.fire(event.name, event.first, event.second, event.eventUnits) as Record<string, unknown> | null;
        } catch (error) {
          console.error(`Lua event "${event.name}" failed`, error);
          this.log = `Lua: ${(error as Error).message.split('\n')[0]}`;
        }
        this.afterLua();
        if (request) this.openLuaDialog(request);
      }
    } finally {
      this.luaPumping = false;
    }
    this.scheduleRefresh();
    this.showNextMessage();
  }

  /** The numbered entries of a Lua table that crossed the bridge (`{"1": a, "2": b}`). */
  private luaList<T>(table: unknown): T[] {
    const record = (table ?? {}) as Record<string, T>;
    return Object.keys(record).filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b)).map((key) => record[key]);
  }

  /** A Lua handler asked the player something: show it, and resume the handler with the answer. */
  private openLuaDialog(request: Record<string, unknown>): void {
    this.luaDialog = { tree: this.luaList<LuaTreeNode>(request.tree) };
    this.showLuaDialog();
  }

  /** Pick the first item of the open Lua dialog (autoplay, tests); false when none is open. */
  private autoAnswerLuaDialog(): boolean {
    const dialog = this.luaDialog;
    if (!dialog) return false;
    const first = (nodes: LuaTreeNode[]): number[] | null => {
      for (const node of nodes) {
        const children = this.luaList<LuaTreeNode>(node.children);
        if (children.length > 0 || node.category) {
          const inner = first(children);
          if (inner) return inner;
        } else {
          return this.luaList<number>(node.path);
        }
      }
      return null;
    };
    const path = first(dialog.tree) ?? [1];
    this.windows.closeAll();
    this.luaDialog = null;
    let next: Record<string, unknown> | null = null;
    try {
      next = this.luaGame?.wc.answer(path as never) as Record<string, unknown> | null;
    } catch (error) {
      this.log = `Lua: ${(error as Error).message.split('\n')[0]}`;
    }
    this.afterLua();
    if (next) this.openLuaDialog(next);
    else this.pumpLua();
    return true;
  }

  private showLuaDialog(): void {
    const dialog = this.luaDialog;
    if (!dialog) return;
    const plain = (text: unknown): string => String(text ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const items: ListItem[] = [];
    const walk = (nodes: LuaTreeNode[]): void => {
      for (const node of nodes) {
        const children = this.luaList<LuaTreeNode>(node.children);
        if (children.length > 0 || node.category) {
          items.push({ text: `— ${plain(node.category ?? node.name)} —`, value: '', disabled: true });
          walk(children);
        } else {
          const label = [plain(node.name), plain(node.desc)].filter(Boolean).join(' — ');
          items.push({ text: label || '(item)', value: JSON.stringify(this.luaList<number>(node.path)) });
        }
      }
    };
    walk(dialog.tree);
    const { window } = listWindow({
      title: 'World Conquest — invest',
      width: 720,
      height: 460,
      items,
      footer: 'Choose one reward: gold, a hero, a training or an item.',
      onSelect: (item) => {
        const value = String(item.value ?? '');
        if (!value) return;
        this.windows.closeAll();
        const path = JSON.parse(value) as number[];
        this.luaDialog = null;
        let next: Record<string, unknown> | null = null;
        try {
          next = this.luaGame?.wc.answer(path as never) as Record<string, unknown> | null;
        } catch (error) {
          console.error('Lua dialog answer failed', error);
          this.log = `Lua: ${(error as Error).message.split('\n')[0]}`;
        }
        this.afterLua();
        if (next) this.openLuaDialog(next);
        else this.pumpLua();
        this.scheduleRefresh();
      },
    });
    this.track(window);
  }

  private afterLua(): void {
    if (!this.luaGame) return;
    for (const [side, settings] of this.luaGame.settings) {
      if (!this.runtime) continue;
      this.runtime.world.gold[String(side)] = settings.gold;
      // `[set_recruit]`/`[allow_recruit]` in Lua (the era's recruit pairs) reach the recruit menu
      const runtimeSide = this.runtime.world.sides[String(side)];
      if (runtimeSide) runtimeSide.recruit = settings.recruit.join(',');
    }
  }

  /** The engine's start-of-turn names (`play_controller.cpp:505-560`), for the Lua handlers. */
  private luaTurnStart(opensTurn: boolean): void {
    if (!this.luaGame) return;
    const turn = this.state.round;
    const side = this.state.turn;
    if (opensTurn) {
      this.luaEvent(`turn_${turn}`);
      this.luaEvent('new_turn');
    }
    for (const name of ['side_turn', `side_${side}_turn`, `side_turn_${turn}`, `side_${side}_turn_${turn}`]) this.luaEvent(name);
  }

  private luaTurnRefresh(): void {
    if (!this.luaGame) return;
    const turn = this.state.round;
    const side = this.state.turn;
    for (const name of ['turn_refresh', `side_${side}_turn_refresh`, `turn_${turn}_refresh`, `side_${side}_turn_${turn}_refresh`]) this.luaEvent(name);
  }

  private luaSideTurnEnd(): void {
    if (!this.luaGame) return;
    const turn = this.state.round;
    const side = this.state.turn;
    for (const name of ['side_turn_end', `side_${side}_turn_end`, `side_turn_${turn}_end`, `side_${side}_turn_${turn}_end`]) this.luaEvent(name);
  }

  private luaTurnEnd(round = this.state.round): void {
    if (!this.luaGame) return;
    this.luaEvent('turn_end');
    this.luaEvent(`turn_${round}_end`);
  }

  /** The outcome Lua decided (`[endlevel]`) or the leader's death. */
  private applyLuaOutcome(): void {
    const game = this.luaGame;
    if (!game || this.scenarioName !== WC_SCENARIO || this.outcome !== 'playing') return;
    if (game.ended === 'victory') this.outcome = 'won';
    else if (game.ended === 'defeat') this.outcome = 'lost';
    else if (!this.state.units.some((unit) => unit.side === 1 && unit.canRecruit && unit.hitpoints > 0)) this.outcome = 'lost';
  }

  /** Populate the WML trigger context with the unit fields filters commonly use. */
  private setTriggerUnit(prefix: string, unit: Unit): void {
    const variables = this.runtime.world.variables;
    const worldId = [...this.unitsById].find(([, candidate]) => candidate === unit)?.[0] ?? (unit.name || String(unit.id));
    variables[`${prefix}_id`] = worldId;
    variables[`${prefix}_name`] = unit.name;
    variables[`${prefix}_type`] = unit.typeId;
    variables[`${prefix}_side`] = String(unit.side);
    variables[`${prefix}_x`] = String(unit.x + 1);
    variables[`${prefix}_y`] = String(unit.y + 1);
    variables[`${prefix}_level`] = String(unit.level);
    variables[`${prefix}_race`] = GAME_DATA.unitTypes[unit.typeId]?.race ?? '';
    variables[`${prefix}_alignment`] = unit.alignment;
  }

  /** Fire combat events in Wesnoth's order, after the rules exchange resolves. */
  private reportCombat(attacker: Unit, defender: Unit, killed: boolean, exchange?: CombatExchange, spawned?: Unit | null): void {
    this.syncRuntime();
    // The game's own cues: the weapon's swing sound, the struck unit's hit
    // sound, and `die_sound` when the fight kills (`src/sound.cpp`).
    this.audio.playCue(attackCue(attacker, exchange?.attackName ?? attacker.attacks[0]?.name ?? ''));
    if (exchange?.strikes.some((strike) => strike.hit && strike.defender === defender.id)) this.audio.playCue(hitCue(GAME_DATA, defender));
    if (exchange?.inflicts.petrified && defender.petrified) this.audio.playCue(statusCue(GAME_DATA, 'petrified'));
    if (exchange?.inflicts.slowed && defender.slowed) this.audio.playCue(statusCue(GAME_DATA, 'slowed'));
    if (exchange?.inflicts.poisoned && defender.poisoned) this.audio.playCue(statusCue(GAME_DATA, 'poisoned'));
    this.setTriggerUnit('last_attacker', attacker);
    this.setTriggerUnit('last_defender', defender);
    this.runtime.run('attack');
    this.luaEvent('attack', this.luaPos(attacker), this.luaPos(defender));
    // A petrifying hit stops the fight outright (`src/actions/attack.cpp:1080-1086`).
    if (exchange?.inflicts.petrified && defender.petrified) this.runtime.run('petrified');
    if (killed) {
      this.audio.playCue(deathCue(GAME_DATA, defender));
      this.setTriggerUnit('last_dead', defender);
      this.setTriggerUnit('last_killer', attacker);
      this.runtime.run('last breath');
      this.luaEvent('last_breath', this.luaPos(defender), this.luaPos(attacker), [defender, attacker]);
      this.runtime.run('die');
      this.luaEvent('die', this.luaPos(defender), this.luaPos(attacker), [defender, attacker]);
      if (spawned) {
        this.setTriggerUnit('unit_placed', spawned);
        this.runtime.run('unit_placed');
      }
    }
    this.updateSighted(attacker);
    this.showNextMessage();
  }

  /**
   * Fire the level-up sequence for every survivor the exchange advanced. The
   * rules layer has already applied the new type, so the three events run after
   * the fact and in order: WML that rewrites the unit in `pre_advance` cannot
   * pick a different advancement here (see PORT_COVERAGE.md).
   */
  private reportAdvancements(outcome: { advancements: { unitId: number; fromType: string; toType: string }[] }): void {
    for (const advancement of outcome.advancements) {
      const unit = this.state.units.find((candidate) => candidate.id === advancement.unitId);
      if (!unit) continue;
      this.setTriggerUnit('last_advance', unit);
      this.runtime.run('pre_advance');
      this.runtime.run('advance');
      this.runtime.run('post_advance');
    }
  }

  /** Fire recruit events after the recruited unit has entered the runtime world. */
  private reportRecruit(unit: Unit, mode: 'recruit' | 'recall' = 'recruit'): void {
    this.syncRuntime();
    this.setTriggerUnit('unit_placed', unit);
    this.runtime.run('unit_placed');
    this.setTriggerUnit('last_recruit', unit);
    this.runtime.run(mode === 'recall' ? 'prerecall' : 'prerecruit');
    this.runtime.run(mode === 'recall' ? 'recall' : 'recruit');
    this.luaEvent(mode === 'recall' ? 'prerecall' : 'prerecruit', this.luaPos(unit));
    this.luaEvent(mode === 'recall' ? 'recall' : 'recruit', this.luaPos(unit));
    this.updateSighted(unit);
    this.showNextMessage();
  }

  /**
   * Fire `sighted` for every enemy a side can now see that it could not before
   * (`src/actions/vision.cpp:640-680`): the seen unit is the subject, the
   * nearest unit of the viewing side the second unit. The scene keeps one
   * snapshot of "who each side can see" and refreshes it after every action
   * that can change visibility.
   */
  private updateSighted(seer?: Unit): void {
    const next = this.visibilitySnapshot();
    for (const [side, ids] of next) {
      const previous = this.visibility.get(side) ?? new Set<number>();
      for (const id of ids) {
        if (previous.has(id)) continue;
        const seen = this.state.units.find((unit) => unit.id === id);
        if (!seen) continue;
        this.setTriggerUnit('last_sighted', seen);
        const viewer = seer && areAllied(this.state, seer.side, side) ? seer : this.nearestViewer(side, seen);
        if (viewer) this.setTriggerUnit('last_seer', viewer);
        this.runtime.run('sighted');
      }
    }
    this.visibility = next;
  }

  /** The living unit of `side` closest to `target`, the engine's second unit. */
  private nearestViewer(side: number, target: Unit): Unit | undefined {
    let best: Unit | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const unit of this.state.units) {
      if (unit.side !== side || unit.hitpoints <= 0) continue;
      const distance = Math.max(Math.abs(unit.x - target.x), Math.abs(unit.y - target.y));
      if (distance < bestDistance) {
        best = unit;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Every enemy unit each side can see right now, keyed by side. */
  private visibilitySnapshot(): Map<number, Set<number>> {
    const seen = new Map<number, Set<number>>();
    for (const side of this.state.sides) {
      const ids = new Set<number>();
      for (const unit of this.state.units) {
        if (unit.hitpoints <= 0) continue;
        if (areAllied(this.state, unit.side, side)) continue;
        if (isFogged(this.state, GAME_DATA, side, unit.x, unit.y)) continue;
        if (isHidden(this.state, GAME_DATA, unit, side, lawfulBonusAt(GAME_DATA, this.state, unit.x, unit.y))) continue;
        ids.add(unit.id);
      }
      seen.set(side, ids);
    }
    return seen;
  }

  /** Queue a `[message]` from the scenario; the box shows them one at a time. */
  private enqueueMessage(message: MwlMessage): void {
    this.dialogueQueue.push(message);
  }

  /** Show the next queued message, or close the box when the queue is empty. */
  private showNextMessage(): void {
    const message = this.dialogueQueue.shift();
    if (!message) {
      this.dialogueOpen = false;
      this.dialogue.visible = false;
      return;
    }
    this.dialogueOpen = true;
    this.dialogue.visible = true;
    this.dialogueMessage = message;
    this.layoutDialogue();
  }

  private advanceDialogue(): void {
    this.showNextMessage();
  }

  /** Draw the box: portrait, speaker, text, and how to continue. */
  private layoutDialogue(): void {
    const message = this.dialogueMessage;
    if (!message) return;
    const width = Math.min(980, Math.max(420, Game.current.width - 48));
    const storyBackground = message.speaker === 'narrator' && Boolean(message.portrait);
    const height = storyBackground ? 176 : 138;
    this.dialogue.removeChildren().forEach((child) => child.destroy({ children: true }));
    if (storyBackground && message.portrait) {
      const background = new Sprite2D(this.texture(message.portrait));
      background.width = Game.current.width;
      background.height = Game.current.height;
      background.alpha = 0.62;
      background.position.set(0, -Game.current.height + height + 18);
      this.dialogue.addChild(background);
      const shade = new Shape2D().rect(0, 0, Game.current.width, Game.current.height).fill({ color: 0x08080c, alpha: 0.28 });
      shade.position.set(0, -Game.current.height + height + 18);
      this.dialogue.addChild(shade);
    }
    this.dialogue.addChild(
      new Shape2D().roundRect(0, 0, width, height, 10).fill({ color: 0x171310, alpha: 0.95 }).stroke({ color: 0xc9a227, width: 2 }),
    );

    const portrait = storyBackground ? null : this.portraitFor(message);
    const textLeft = portrait ? 142 : 20;
    if (portrait) {
      const sprite = new Sprite2D(this.texture(portrait));
      sprite.anchor.set(0, 1);
      const size = height - 32;
      sprite.width = size;
      sprite.height = size;
      sprite.position.set(16, height - 16);
      this.dialogue.addChild(sprite);
    }
    if (message.speaker) {
      const name = new Text2D({ text: message.speaker, style: { fill: 0xf0d27a, fontSize: 16, fontFamily: 'system-ui' } });
      name.position.set(textLeft, 14);
      this.dialogue.addChild(name);
    }
    // `$variables` in scenario text resolve against the runtime world variables. MWG lays the
    // lines out after styling, so the body is pre-wrapped and Pixi does not wrap it again.
    const translated = this.translate(message.text);
    const variables = this.runtime?.world.variables ?? {};
    const textWidth = width - textLeft - 24;
    const rtl = isRightToLeft(this.locale);
    const markup = wrapWesnothMarkup(translated, variables, this.markupMeasure(15), textWidth);
    const body = new Text2D({
      text: markup.text,
      style: {
        fill: 0xf4edd9,
        fontSize: 15,
        fontFamily: 'system-ui',
        wordWrap: false,
        wordWrapWidth: textWidth,
        align: rtl ? 'right' : 'left',
        lineHeight: 21,
        tagStyles: markup.tagStyles,
      },
    });
    body.position.set(rtl ? width - 20 - textWidth : textLeft, message.speaker ? 42 : 30);
    this.dialogue.addChild(body);
    // A plain-text projection for screen readers, with no Pixi markup tags in it.
    this.dialogue.accessible = true;
    this.dialogue.accessibleText = wesnothAccessibilityText(translated, variables);
    this.dialogue.accessibleHint = this.dialogue.accessibleText;
    const hint = new Text2D({ text: 'Space or click to continue', style: { fill: 0x9a927f, fontSize: 11, fontFamily: 'system-ui' } });
    hint.position.set(width - hint.width - 16, height - 20);
    this.dialogue.addChild(hint);

    this.dialogue.position.set(
      Math.round((Game.current.width - width) / 2),
      Math.round(Game.current.height - height - 18),
    );
  }

  /** The language content is rendered in: the URL's `?lang=`, else the setting, else English. */
  private locale = 'en';

  private translate(text: string, count?: number, vars?: Readonly<Record<string, string | number>>): string {
    return translatorFor(this.locale)(text, count, vars);
  }

  /** Switch the content language and repaint; the choice persists with the settings. */
  private setLocale(locale: string): void {
    this.locale = locale;
    try {
      this.settings.save('language', { language: locale });
    } catch {
      // settings are best-effort; a private-mode browser simply keeps defaults
    }
    // The open dialogue was laid out in the previous language; re-lay it out.
    if (this.dialogueOpen) this.layoutDialogue();
    this.log = `Language: ${locale === 'en' ? 'English' : localeName(locale)}`;
    this.refresh();
  }

  /**
   * Measure a markup piece with the same family and size Pixi draws it with, so
   * `layoutMarkupLines` wraps after styling. Falls back to a per-character estimate without a DOM.
   */
  private markupMeasure(fontSize: number): MarkupMeasure {
    if (!this.markupMeasureContext && typeof document !== 'undefined') {
      this.markupMeasureContext = document.createElement('canvas').getContext('2d');
    }
    const context = this.markupMeasureContext;
    if (!context) return (piece) => (piece.image ? fontSize : (piece.text ?? '').length * fontSize * 0.5);
    return (piece) => {
      if (piece.image) return fontSize;
      context.font = `${piece.italic ? 'italic ' : ''}${piece.bold ? 'bold ' : ''}${piece.size ?? fontSize}px system-ui`;
      return context.measureText(piece.text ?? '').width;
    };
  }

  /** The portrait for a message: its own, or the speaker unit type profile. */
  private portraitFor(message: MwlMessage): string | null {
    if (message.portrait) return message.portrait;
    const type = message.speaker ? GAME_DATA.unitTypes[message.speaker] : undefined;
    return type?.profile ?? null;
  }

  /** Apply carry-over gold and keep survivors available for explicit recall. */
  private prepareCarryover(carryover: Carryover): void {
    const side = 1;
    const gold = this.runtime.world.sides[String(side)];
    if (gold) gold.gold += carryover.gold;
    this.recallList = carryover.units.map((unit) => ({ ...unit }));
  }

  /** Find a free castle hex the side's leader can place a recalled unit on. */
  private recallHex(side: number): { x: number; y: number } | null {
    const occupiedInRuntime = (candidate: { x: number; y: number }): boolean =>
      Object.values(this.runtime.world.units).some((unit) => unit.alive && unit.x === candidate.x && unit.y === candidate.y);
    return vacantRecruitHexes(this.state, GAME_DATA, side).find((candidate) => !occupiedInRuntime(candidate)) ?? null;
  }

  private recallOne(index: number): void {
    const entry = this.recallList[index];
    if (!entry) return;
    const side = this.state.sides[0];
    const cost = 20;
    if ((this.gold[side] ?? 0) < cost) {
      this.log = 'Not enough gold to recall this unit.';
      return;
    }
    const stats = GAME_DATA.unitTypes[entry.typeId];
    const hex = stats ? this.recallHex(side) : null;
    if (!stats) {
      this.log = `Cannot recall unknown unit type ${entry.typeId}.`;
      return;
    }
    if (!hex) {
      this.log = 'No free castle hex next to the keep.';
      return;
    }
    // Recall rebuilds the unit from its type, but with the traits it already
    // earned instead of a fresh roll (Wesnoth keeps the saved unit's traits).
    const unit = makeUnitWithTraits(GAME_DATA, entry.typeId, side, hex.x, hex.y, entry.traits ?? []);
    unit.hitpoints = Math.max(1, Math.min(unit.maxHitpoints, entry.hitpoints));
    unit.experience = entry.experience;
    if (entry.loyal) unit.loyal = true;
    if (entry.extraAbilities) unit.extraAbilities = [...entry.extraAbilities];
    const id = `recall-${index}-${unit.id}`;
    this.state.units.push(unit);
    this.unitsById.set(id, unit);
    this.runtime.world.units[id] = { hp: unit.hitpoints, x: unit.x, y: unit.y, alive: true, type: unit.typeId, side: String(side), moves: unit.movement };
    this.gold[side] -= cost;
    this.runtime.world.sides[String(side)]!.gold = this.gold[side];
    this.recallList.splice(index, 1);
    this.reportRecruit(unit, 'recall');
    this.log = `Recalled ${unit.name} for ${cost} gold.`;
    this.refresh();
  }

  /**
   * The victory or defeat screen: title, summary lines, and what to press. It is
   * the only thing asking for input, so a dialogue still on screen steps aside
   * (its last line moves into the HUD log) instead of competing for the key.
   */
  private showEndScreen(title: string, lines: string[], hint: string): void {
    if (this.dialogueMessage) this.log = `${this.dialogueMessage.text}  ${this.log}`;
    this.dialogueQueue = [];
    this.dialogueOpen = false;
    this.dialogue.visible = false;
    this.endScreenTitle = title;
    this.endScreenLines = lines;
    this.endScreenHint = hint;
    this.endScreenOpen = true;
    this.endScreen.visible = true;
    this.layoutEndScreen();
  }

  private layoutEndScreen(): void {
    if (!this.endScreenOpen) return;
    const won = this.endScreenTitle === 'Victory';
    const width = Math.min(660, Math.max(360, Game.current.width - 64));
    const height = 132 + this.endScreenLines.length * 24;
    this.endScreen.removeChildren().forEach((child) => child.destroy({ children: true }));
    this.endScreen.addChild(
      new Shape2D()
        .roundRect(0, 0, width, height, 12)
        .fill({ color: 0x171310, alpha: 0.96 })
        .stroke({ color: won ? 0xc9a227 : 0xb4635f, width: 2 }),
    );
    const title = new Text2D({
      text: `${this.endScreenTitle} — ${this.scenarioTitle()}`,
      style: { fill: won ? 0xf0d27a : 0xe08a86, fontSize: 22, fontFamily: 'system-ui' },
    });
    title.position.set(24, 20);
    this.endScreen.addChild(title);
    this.endScreenLines.forEach((line, index) => {
      const text = new Text2D({
        text: line,
        style: { fill: 0xf4edd9, fontSize: 14, fontFamily: 'system-ui', wordWrap: true, wordWrapWidth: width - 48 },
      });
      text.position.set(24, 62 + index * 24);
      this.endScreen.addChild(text);
    });
    const hint = new Text2D({ text: this.endScreenHint, style: { fill: 0x9a927f, fontSize: 12, fontFamily: 'system-ui' } });
    hint.position.set(24, height - 28);
    this.endScreen.addChild(hint);
    this.endScreen.position.set(
      Math.round((Game.current.width - width) / 2),
      Math.round((Game.current.height - height) / 2),
    );
  }
}

const game = new Game({ canvas: document.querySelector('#game') as HTMLCanvasElement, background: 0x08080c });
game.start(WesnothScene).catch((error) => {
  document.body.innerHTML = `<pre>${String(error?.stack ?? error)}</pre>`;
});
