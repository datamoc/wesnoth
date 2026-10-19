/**
 * Report which MWG framework gaps the Wesnoth port is waiting on, so a watcher
 * can tell the moment one lands and the port can drop its local copy.
 *
 * Two independent signals, because either alone lies:
 *   - the numbered item's state in `MW_games/ROADMAP.md` (MWG strikes an item
 *     through with `~~...~~` when it ships, and the list is append-only)
 *   - the code itself, by name, in `MW_games/src` (an item can be landed in
 *     code before its roadmap note is edited, and vice versa)
 *
 * Usage:
 *   node tools/check-mwg-gaps.mjs [--mwg C:/Users/miche/dev/MW_games] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mwgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultMwg = path.resolve(mwgDir, '..', '..', 'MW_games');

function parseArgs(argv) {
  const options = { mwg: defaultMwg, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mwg') options.mwg = path.resolve(argv[++i]);
    else if (argv[i] === '--json') options.json = true;
  }
  return options;
}

/**
 * Items the port asked MWG for. `needs` is the port file that has to go once
 * the item lands; `evidence` are symbol names to look for in MW_games/src.
 */
const ITEMS = [
  { id: 249, title: 'one save for a whole campaign', needs: [], evidence: ['CampaignSave', 'campaignSave', 'CampaignSnapshot'] },
  { id: 250, title: 'WML action vocabulary in [event]', needs: [], evidence: ['store_unit', 'unstore_unit', 'modify_unit', 'endlevel'] },
  { id: 255, title: 'image modifiers beyond FL/SCALE/GS/CS/CROP', needs: ['src/main.ts (applyAdditionalImageModifiers)', 'src/simulation/image-modifiers.ts'], evidence: ["'BLIT'", "'RC'", "'MASK'", "'CHAN'", "'PAL'"] },
  { id: 256, title: 'team colour by palette remap', needs: ['src/simulation/color-range.ts', 'src/main.ts (teamTexture)'], evidence: ['recolorTexture', 'paletteRemap', 'ColorRemap', 'recolorPalette', 'colorMapping'] },
  { id: 257, title: '[terrain_graphics] rule-driven transitions', needs: ['src/simulation/terrain-codes.ts', 'src/simulation/terrain-graphics.ts'], evidence: ['terrain_graphics', 'TransitionRule', 'TileRule', 'transitionRule', 'TileTransition'] },
  { id: 258, title: 'typographic markup acceptance', needs: ['src/ui/text-markup.ts'], evidence: ['layoutMarkupLines', 'markupAccessibilityText', 'MarkupSpan'] },
  { id: 261, title: 'missing widgets (Slider/Checkbox/Dropdown/TextInput/Table/TreeView/ScrollBox)', needs: [], evidence: ['Slider', 'Checkbox', 'Dropdown', 'TextInput', 'ScrollBox'] },
  { id: 263, title: 'data-driven shell layout and skins (GUI2)', needs: [], evidence: ['WidgetSchema', 'AnchorSpec', 'SkinSpec', 'guiSchema', 'LayoutSpec'] },
  { id: 264, title: 'story screens', needs: [], evidence: ['StoryScreen', 'StoryStage'] },
  { id: 265, title: 'battle UI (attack dialog, unit selector, whiteboard/undo)', needs: [], evidence: ['AttackDialog', 'UnitSelector', 'Whiteboard'] },
  { id: 266, title: 'Wesnoth-compatible RNG', needs: [], evidence: ['mt_rng', 'mtRng', 'random_synced', 'randomSynced'] },
  { id: 267, title: 'turns as Wesnoth counts them', needs: [], evidence: ['TurnSchedule', 'lawfulBonus', 'sideRound'] },
  { id: 269, title: 'Wesnoth-shaped AI and wesnoth.* Lua API', needs: [], evidence: ['wesnothLua', 'wesnoth.ai', 'CandidateAction', 'AIAspect', 'AICandidate'] },
  { id: 270, title: 'gettext .po i18n backend', needs: [], evidence: ['parsePo', 'gettext', 'PoCatalog'] },
  { id: 272, title: 'replays, undo and a multiplayer server', needs: ['src/simulation/replay.ts', 'src/simulation/network.ts'], evidence: ['UndoHistory', 'SyncGuard', 'MultiplayerServer', 'outOfSync'] },
  { id: 273, title: 'achievements and statistics model', needs: [], evidence: ['AchievementCatalog', 'StatisticsModel'] },
  { id: 277, title: 'one side identity in MwlWorld', needs: [], evidence: ['MwlSideRef', 'sideId'] },
  { id: 278, title: 'generalised MultiTurnBeam traversal', needs: [], evidence: ['nextFront', 'FrontResolver'] },
  { id: 281, title: 'tabbed/paginated list primitives', needs: [], evidence: ['TabbedList', 'PaginatedList', 'TabView'] },
  { id: 282, title: 'event-to-presentation sequencing recipe', needs: [], evidence: ['sequencing', 'presentation order'] },
  { id: 283, title: 'per-side victory and defeat conditions', needs: [], evidence: ['sideVictory', 'sideDefeat', 'sideStatus'] },
  { id: 284, title: 'hex/isometric map asset overlap and file loader', needs: [], evidence: ['parseWesnothMap', 'hexagonal map', 'overlapping tile'] },
  { id: 285, title: 'fixed-angle map rotation', needs: [], evidence: ['rotateView', 'viewRotation'] },
  { id: 286, title: 'free map rotation', needs: [], evidence: ['freeRotation', 'cameraRotation'] },
];

function statusFromRoadmap(mwgRoot) {
  const file = path.join(mwgRoot, 'ROADMAP.md');
  const landed = new Map();
  if (!fs.existsSync(file)) return landed;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^(\d+)\.\s+(~~)?\[/.exec(line);
    if (match) landed.set(Number(match[1]), match[2] === '~~');
  }
  return landed;
}

function evidenceInSource(mwgRoot, needles) {
  const root = path.join(mwgRoot, 'src');
  if (!fs.existsSync(root)) return [];
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        for (const needle of needles) {
          if (text.includes(needle)) hits.push(`${path.relative(mwgRoot, full)}: ${needle}`);
        }
      }
    }
  };
  walk(root);
  return hits;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.mwg)) {
    console.error(`check-mwg-gaps: ${options.mwg} not found (pass --mwg)`);
    process.exit(2);
  }
  const landed = statusFromRoadmap(options.mwg);
  const rows = ITEMS.map((item) => {
    const roadmapLanded = landed.get(item.id) ?? null;
    const evidence = evidenceInSource(options.mwg, item.evidence);
    return { ...item, roadmapLanded, evidence, ready: (roadmapLanded === true) || evidence.length > 0 };
  });

  if (options.json) {
    console.log(JSON.stringify({ mwg: options.mwg, checkedAt: new Date().toISOString(), rows }, null, 2));
    return;
  }
  console.log(`MWG ${options.mwg}`);
  console.log(`checked ${new Date().toISOString()}`);
  for (const row of rows) {
    const state = row.roadmapLanded === true ? 'landed' : row.roadmapLanded === false ? 'open' : '?';
    const flag = row.ready ? (row.evidence.length ? 'READY' : 'LANDED') : 'waiting';
    console.log(`  ${flag.padEnd(7)} item ${row.id} (${state}): ${row.title}`);
    if (row.evidence.length) console.log(`          ${row.evidence.slice(0, 4).join(' | ')}`);
    if (row.ready && row.needs.length) console.log(`          drop: ${row.needs.join(', ')}`);
  }
  const waiting = rows.filter((row) => !row.ready).length;
  console.log(waiting === 0 ? 'ALL TRACKED ITEMS LANDED' : `${waiting} of ${rows.length} still waiting`);
}

main();
