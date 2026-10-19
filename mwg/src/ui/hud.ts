// The in-game status layout, after the default Wesnoth theme
// (`data/themes/default.cfg`): a top bar with the turn, the side's gold, villages,
// units, upkeep and income icons, and a right-hand sidebar carrying the minimap
// slot, the time-of-day picture, the selected unit and the hovered terrain.
//
// Deviation (PORT_COVERAGE.md "In-game HUD"): the real theme is a resolution
// independent WML layout with its own frame art (`themes/classic/*.png`); this is
// a fixed two-panel arrangement drawn with `Shape2D` in the same order and with the
// same icons, not a GUI1 theme interpreter.
import { Container2D, Node2D, Shape2D, Sprite2D, Text2D, Texture2D } from 'mwg/two-d/render';

export const TOP_BAR_HEIGHT = 30;
export const SIDEBAR_WIDTH = 184;
/** Below this width the sidebar is dropped and the top bar carries the essentials. */
export const SIDEBAR_MIN_WIDTH = 720;
/** Height reserved for the minimap at the top of the sidebar. */
export const MINIMAP_SLOT = 150;

export interface HudUnit {
  name: string;
  typeName: string;
  image: string;
  level: number;
  side: number;
  hitpoints: number;
  maxHitpoints: number;
  experience: number;
  maxExperience: number;
  movement: number;
  maxMovement: number;
  alignment: string;
  traits: string[];
  /** percent resistance by damage type, positive = takes less damage */
  resistances: Record<string, number>;
  attacks: { name: string; damage: number; number: number; range: string; type: string }[];
}

export interface HudModel {
  title: string;
  round: number;
  side: number;
  sideLabel: string;
  tod: { id: string; name: string; lawful: number };
  gold: number;
  villages: number;
  units: number;
  upkeep: number;
  income: number;
  /** 'VICTORY' / 'DEFEAT' once the scenario is decided */
  result: string;
  unit: HudUnit | null;
  terrain: { name: string; defense: number; x: number; y: number } | null;
  /** the last log line plus the key hints */
  message: string;
}

/** The schedule picture for a time of day id (`data/core/macros/schedules.cfg`). */
export function todImagePath(id: string): string {
  switch (id) {
    case 'dawn':
    case 'morning':
    case 'afternoon':
    case 'dusk':
      return `misc/time-schedules/default/schedule-${id}.png`;
    case 'first_watch':
      return 'misc/time-schedules/default/schedule-firstwatch.png';
    case 'second_watch':
      return 'misc/time-schedules/default/schedule-secondwatch.png';
    case 'midday':
    case 'midnight':
    case 'indoors':
    case 'underground':
      return `misc/time-schedules/schedule-${id}.png`;
    case 'deep_underground':
      return 'misc/time-schedules/schedule-underground.png';
    default:
      return 'misc/time-schedules/default/schedule-dawn.png';
  }
}

const TEXT = 0xf4edd9;
const MUTED = 0xb9ad8a;
const GOLD = 0xe8c75a;
const PANEL = 0x15120d;
const EDGE = 0x8c7a4a;

type TextureLookup = (path: string) => Texture2D;

function label(size: number, fill: number = TEXT, bold = false): Text2D {
  return new Text2D({ text: '', style: { fill, fontSize: size, fontFamily: 'system-ui', fontWeight: bold ? 'bold' : 'normal' } });
}

/** One icon followed by its number, as the status row of the default theme. */
class Stat extends Container2D {
  readonly icon = new Sprite2D(Texture2D.EMPTY);
  readonly value = label(13, TEXT, true);
  constructor() {
    super();
    this.addChild(this.icon, this.value);
    this.value.position.set(22, 5);
    this.icon.position.set(0, 7);
  }
  set(texture: Texture2D, text: string, fill: number = TEXT): void {
    this.icon.texture = texture;
    this.icon.width = 16;
    this.icon.height = 16;
    this.value.text = text;
    this.value.style.fill = fill;
  }
}

export class Hud extends Node2D {
  private readonly bar = new Shape2D();
  private readonly side = new Shape2D();
  private readonly title = label(13, GOLD, true);
  private readonly turn = label(13, TEXT, true);
  private readonly stats = {
    gold: new Stat(),
    villages: new Stat(),
    units: new Stat(),
    upkeep: new Stat(),
    income: new Stat(),
  };
  private readonly result = label(14, 0xffd24a, true);
  private readonly todSprite = new Sprite2D(Texture2D.EMPTY);
  private readonly todText = label(12, TEXT);
  private readonly unitSprite = new Sprite2D(Texture2D.EMPTY);
  private readonly unitText = label(12, TEXT);
  private readonly unitDetails = label(11, MUTED);
  private readonly unitBars = new Shape2D();
  private readonly terrainText = label(12, TEXT);
  private readonly messageBar = new Shape2D();
  private readonly tipBox = new Shape2D();
  private readonly tipPortrait = new Sprite2D(Texture2D.EMPTY);
  private readonly tipText = label(12, TEXT);
  private readonly messageText = label(12, MUTED);
  private viewW = 0;
  private viewH = 0;
  private model: HudModel | null = null;
  private lookup: TextureLookup;

  constructor(lookup: TextureLookup) {
    super();
    this.lookup = lookup;
    this.addChild(this.bar, this.side, this.messageBar, this.title, this.turn, this.result, this.unitBars, this.todSprite, this.todText, this.unitSprite, this.unitText, this.unitDetails, this.terrainText, this.messageText, this.tipBox, this.tipPortrait, this.tipText);
    for (const stat of Object.values(this.stats)) this.addChild(stat);
  }

  /** Whether the sidebar is shown at this width. */
  get sidebarVisible(): boolean {
    return this.viewW >= SIDEBAR_MIN_WIDTH;
  }

  /** Where the minimap sits: the top of the sidebar, or under the bar on a narrow screen. */
  minimapOrigin(cellsWidth: number, cellsHeight: number): { x: number; y: number } {
    if (!this.sidebarVisible) return { x: Math.max(12, this.viewW - cellsWidth - 12), y: TOP_BAR_HEIGHT + 8 };
    const x = this.viewW - SIDEBAR_WIDTH + Math.max(8, (SIDEBAR_WIDTH - cellsWidth) / 2);
    const y = TOP_BAR_HEIGHT + 10 + Math.max(0, (MINIMAP_SLOT - 20 - cellsHeight) / 2);
    return { x, y };
  }

  /** Width the board may use. */
  boardWidth(width: number): number {
    return width >= SIDEBAR_MIN_WIDTH ? width - SIDEBAR_WIDTH : width;
  }

  /** Height of the strip under the board used for the message line. */
  readonly messageHeight = 22;

  layout(width: number, height: number): void {
    this.viewW = width;
    this.viewH = height;
    const wide = this.sidebarVisible;
    this.bar.clear().rect(0, 0, width, TOP_BAR_HEIGHT).fill({ color: PANEL, alpha: 0.96 });
    this.bar.rect(0, TOP_BAR_HEIGHT - 2, width, 2).fill({ color: EDGE });
    this.side.clear();
    if (wide) {
      const x = width - SIDEBAR_WIDTH;
      this.side.rect(x, TOP_BAR_HEIGHT, SIDEBAR_WIDTH, height - TOP_BAR_HEIGHT).fill({ color: PANEL, alpha: 0.96 });
      this.side.rect(x, TOP_BAR_HEIGHT, 2, height - TOP_BAR_HEIGHT).fill({ color: EDGE });
      this.side.roundRect(x + 6, TOP_BAR_HEIGHT + 6, SIDEBAR_WIDTH - 12, MINIMAP_SLOT - 10, 4).fill({ color: 0x090c12, alpha: 0.9 });
    }
    const boardRight = this.boardWidth(width);
    this.messageBar.clear().rect(0, height - this.messageHeight, boardRight, this.messageHeight).fill({ color: PANEL, alpha: 0.9 });
    this.messageText.position.set(8, height - this.messageHeight + 4);
    this.messageText.style.wordWrap = true;
    this.messageText.style.wordWrapWidth = boardRight - 16;
    this.title.position.set(10, 6);
    this.turn.position.set(0, 6);
    if (this.model) this.refresh(this.model);
  }

  refresh(model: HudModel): void {
    this.model = model;
    const wide = this.sidebarVisible;
    const boardRight = this.boardWidth(this.viewW);
    const tex = this.lookup;
    this.title.text = model.title;
    this.turn.text = `Turn ${model.round}  ·  ${model.sideLabel}`;
    // The status row: right-aligned in the bar, in the default theme's order.
    const stats = this.stats;
    stats.gold.set(tex('themes/gold.png'), String(model.gold), GOLD);
    stats.villages.set(tex('themes/villages.png'), String(model.villages));
    stats.units.set(tex('themes/units.png'), String(model.units));
    stats.upkeep.set(tex('themes/upkeep.png'), String(model.upkeep));
    stats.income.set(tex('themes/income.png'), `${model.income >= 0 ? '+' : ''}${model.income}`, model.income < 0 ? 0xff8a7a : TEXT);
    const order = [stats.gold, stats.villages, stats.units, stats.upkeep, stats.income];
    const slot = 72;
    let x = this.viewW - 8 - order.length * slot;
    for (const stat of order) {
      stat.position.set(x, 0);
      x += slot;
    }
    const rowLeft = this.viewW - 8 - order.length * slot;
    this.turn.position.x = Math.max(this.title.x + this.title.width + 24, rowLeft - this.turn.width - 12);
    // keep the title from running under the turn counter on a narrow screen
    this.title.visible = this.title.x + this.title.width + 12 < this.turn.position.x;
    this.result.text = model.result;
    this.result.position.set(Math.max(8, boardRight / 2 - this.result.width / 2), TOP_BAR_HEIGHT + 6);

    this.todSprite.visible = this.todText.visible = this.unitSprite.visible = this.unitText.visible = this.unitDetails.visible = this.terrainText.visible = this.unitBars.visible = wide;
    this.unitBars.clear();
    if (wide) this.refreshSidebar(model);
    this.messageText.text = model.message;
    const lines = Math.max(1, Math.ceil(this.messageText.height / 14));
    const stripHeight = Math.max(this.messageHeight, lines * 14 + 8);
    this.messageBar.clear().rect(0, this.viewH - stripHeight, boardRight, stripHeight).fill({ color: PANEL, alpha: 0.9 });
    this.messageText.position.set(8, this.viewH - stripHeight + 4);
  }

  private refreshSidebar(model: HudModel): void {
    const x0 = this.viewW - SIDEBAR_WIDTH + 10;
    const inner = SIDEBAR_WIDTH - 20;
    let y = TOP_BAR_HEIGHT + MINIMAP_SLOT + 4;
    // Time of day: the real schedule picture, then its name and the lawful modifier.
    this.todSprite.texture = this.lookup(todImagePath(model.tod.id));
    this.todSprite.position.set(x0 + (inner - 125) / 2, y);
    this.todSprite.width = 125;
    this.todSprite.height = 39;
    this.todText.position.set(x0, y + 42);
    const bonus = model.tod.lawful === 0 ? 'neutral' : `lawful ${model.tod.lawful > 0 ? '+' : ''}${model.tod.lawful}%`;
    this.todText.text = `${model.tod.name}  (${bonus})`;
    y += 66;
    const unit = model.unit;
    this.unitSprite.visible = Boolean(unit);
    if (unit) {
      this.unitSprite.texture = this.lookup(unit.image);
      this.unitSprite.position.set(x0, y);
      this.unitSprite.width = 54;
      this.unitSprite.height = 54;
      const lines = [
        unit.name,
        `${unit.typeName}  L${unit.level}`,
        unit.alignment,
      ];
      this.unitText.position.set(x0 + 58, y);
      this.unitText.text = lines.join('\n');
      y += 60;
      this.unitBars.rect(x0, y, inner, 8).fill({ color: 0x2b2418 });
      this.unitBars.rect(x0, y, inner * Math.max(0, Math.min(1, unit.hitpoints / Math.max(1, unit.maxHitpoints))), 8).fill({ color: this.hpColor(unit.hitpoints / Math.max(1, unit.maxHitpoints)) });
      this.unitBars.rect(x0, y + 11, inner, 5).fill({ color: 0x2b2418 });
      this.unitBars.rect(x0, y + 11, inner * Math.max(0, Math.min(1, unit.experience / Math.max(1, unit.maxExperience))), 5).fill({ color: 0x6aa7e8 });
      const details = [
        `HP ${unit.hitpoints}/${unit.maxHitpoints}   XP ${unit.experience}/${unit.maxExperience}`,
        `Moves ${unit.movement}/${unit.maxMovement}`,
        ...unit.attacks.map((attack) => `${attack.name}  ${attack.damage}-${attack.number}  ${attack.range}`),
        ...(unit.traits.length ? [unit.traits.join(', ')] : []),
        '',
        ...Object.entries(unit.resistances).map(([type, value]) => `${type.padEnd(8)} ${value > 0 ? '+' : ''}${value}%`),
      ];
      this.unitDetails.position.set(x0, y + 22);
      this.unitDetails.text = details.join('\n');
    } else {
      this.unitText.position.set(x0, y);
      this.unitText.text = 'No unit selected';
      this.unitDetails.text = '';
    }
    const terrain = model.terrain;
    this.terrainText.position.set(x0, this.viewH - this.messageHeight - 60);
    this.terrainText.text = terrain ? `${terrain.name}\nDefense ${terrain.defense}%\nHex ${terrain.x + 1},${terrain.y + 1}` : '';
  }

  /**
   * The tooltip the real client shows over a hex: a unit's portrait and summary, or the
   * terrain's name and defense. `anchor` is the hex's centre in screen pixels; the box
   * keeps off the sidebar and the edges.
   */
  showTooltip(tip: { lines: string[]; portrait: string | null } | null, anchor: { x: number; y: number }): void {
    this.tipBox.clear();
    this.tipText.visible = this.tipPortrait.visible = Boolean(tip);
    if (!tip) return;
    const portraitSize = tip.portrait ? 72 : 0;
    this.tipText.text = tip.lines.join('\n');
    const width = portraitSize + (portraitSize ? 8 : 0) + this.tipText.width + 16;
    const height = Math.max(portraitSize, this.tipText.height) + 12;
    const limit = this.boardWidth(this.viewW);
    let x = anchor.x + 24;
    let y = anchor.y - height / 2;
    if (x + width > limit) x = anchor.x - 24 - width;
    x = Math.max(4, x);
    y = Math.max(TOP_BAR_HEIGHT + 4, Math.min(this.viewH - height - 28, y));
    this.tipBox.roundRect(x, y, width, height, 4).fill({ color: 0x0e0c09, alpha: 0.96 });
    this.tipBox.roundRect(x, y, width, height, 4).stroke({ color: EDGE, width: 1 });
    this.tipPortrait.visible = Boolean(tip.portrait);
    if (tip.portrait) {
      this.tipPortrait.texture = this.lookup(tip.portrait);
      this.tipPortrait.position.set(x + 6, y + 6);
      this.tipPortrait.width = 72;
      this.tipPortrait.height = 72;
    }
    this.tipText.position.set(x + 8 + (portraitSize ? portraitSize + 8 : 0) - (portraitSize ? 2 : 0), y + 6);
  }

  private hpColor(ratio: number): number {
    if (ratio > 0.66) return 0x4fbf4a;
    if (ratio > 0.33) return 0xe0b83a;
    return 0xd9503a;
  }
}
