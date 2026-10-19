/**
 * Compiles a real `[campaign]` definition into `src/generated/campaigns.ts`.
 *
 * A campaign's own file owns its identity, its scenario chain and its difficulty
 * list:
 *
 * - `_main.cfg`'s `[campaign]` supplies id, name, abbreviation, icon,
 *   description and `first_scenario` (after the core macros expand the
 *   `{CAMPAIGN_DIFFICULTY}`/`{DEFAULT_DIFFICULTY}` helpers into `[difficulty]`).
 * - The chain then follows each scenario's `next_scenario` from `first_scenario`
 *   to its end, so the order is the campaign's, not the alphabet's.
 *
 * Scenario ids are mapped to the port's scenario names by the `NN_` prefix the
 * data tool already uses (`01_Rooting_Out_a_Mage` -> `two-brothers-01`).
 *
 * Run with `npm run data` (after `compile-scenario.ts`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WmlPreprocessor, parseWml, type WmlNode } from '../src/simulation/wml.ts';
import { CAMPAIGN_DIRS, disambiguateScenarioNames } from './campaign-dirs.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const mwgDir = path.resolve(here, '..');
const wesnothRoot = path.resolve(mwgDir, '..');
const dataDir = path.join(wesnothRoot, 'data');
const generatedDir = path.join(mwgDir, 'src', 'generated');

interface CampaignDifficulty {
  id: string;
  label: string;
  description: string;
  icon: string;
  default: boolean;
}

interface CampaignDefinition {
  id: string;
  title: string;
  abbrev: string;
  icon: string;
  description: string;
  firstScenario: string;
  scenarios: string[];
  difficulties: CampaignDifficulty[];
  defaultDifficulty: string;
}

/** An identifier, path or icon: strip the `_` marker and any surrounding quotes. */
function cleanId(value: string | undefined): string {
  if (!value) return '';
  let text = value.trim();
  if (text.startsWith('_ ')) text = text.slice(2).trim();
  if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  return text.trim();
}

/**
 * Human text. The real files concatenate gettext strings (`_ "a" + "b" + _ "c"`)
 * and pass macro arguments wrapped in parentheses (`( _ "Horseman")`), which the
 * subset leaves literal; unfold both so the labels read normally.
 */
function cleanText(value: string | undefined): string {
  if (!value) return '';
  const text = value.trim();
  const wrapped = /^\(\s*(?:_\s*)?(?:"([\s\S]*)"|'([\s\S]*)')\s*\)$/.exec(text);
  if (wrapped) return (wrapped[1] ?? wrapped[2] ?? '').trim();
  return text
    .replace(/_\s*"/g, '"')
    .replace(/"\s*\+\s*"/g, '')
    .replace(/"/g, '')
    .replace(/<\/?small>/g, '')
    .replace(/<\/?b>/g, '')
    .trim();
}

function attribute(node: WmlNode | undefined, name: string): string | undefined {
  return node?.attributes[name];
}

function compileCampaign(campaignDir: string, prefix: string): CampaignDefinition | null {
  const mainFile = path.join(campaignDir, '_main.cfg');
  if (!fs.existsSync(mainFile)) return null;

  const preprocessor = new WmlPreprocessor({ dataDir, onFile: () => {} });
  const coreMacros = path.join(dataDir, 'core', 'macros');
  preprocessor.loadMacros(
    fs.readdirSync(coreMacros).filter((name) => name.endsWith('.cfg')).map((name) => path.join(coreMacros, name)),
  );
  const nodes = parseWml(preprocessor.preprocessFile(mainFile), mainFile);
  const campaign = nodes.find((node) => node.tag === 'campaign');
  if (!campaign) return null;

  const first = attribute(campaign, 'first_scenario') ?? '';
  // Walk the real scenario chain: id -> next_scenario.
  const scenariosDir = path.join(campaignDir, 'scenarios');
  const chain = new Map<string, string | null>();
  // Scenarios may sit in subdirectories (`Legend_of_Wesmere/scenarios/chapterN/`).
  for (const file of listScenarioFiles(scenariosDir)) {
    const source = path.join(scenariosDir, file);
    const scenario = parseWml(preprocessor.preprocessFile(source), source).find((node) => node.tag === 'scenario');
    if (!scenario) continue;
    // A scenario may omit `id=` (or write a blank one), in which case Wesnoth
    // uses the filename stem; `next_scenario` links refer to that (HttT relies
    // on it).
    const declaredId = (scenario.attributes.id ?? '').trim();
    const id = declaredId !== '' ? declaredId : path.basename(file, '.cfg');
    chain.set(id, scenario.attributes.next_scenario && scenario.attributes.next_scenario !== 'null' ? scenario.attributes.next_scenario : null);
  }
  // Name every scenario up front so a campaign-wide collision (`2_Tutorial` vs
  // `02_Blackwater_Port`) is broken the same way the MWL emitter breaks it.
  const scenarioNames = disambiguateScenarioNames(prefix, [...chain.keys()]);
  const scenarios: string[] = [];
  const seen = new Set<string>();
  let current: string | null = first;
  while (current && !seen.has(current)) {
    seen.add(current);
    const name = scenarioNames.get(current) ?? null;
    if (!name) break;
    scenarios.push(name);
    current = chain.get(current) ?? null;
  }
  if (!scenarios.length) return null;

  const difficulties: CampaignDifficulty[] = [];
  for (const node of campaign.children) {
    if (node.tag !== 'difficulty') continue;
    const id = cleanId(attribute(node, 'define'));
    if (!id) continue;
    difficulties.push({
      id,
      label: cleanText(attribute(node, 'label')) || id,
      description: cleanText(attribute(node, 'description')),
      icon: cleanId(attribute(node, 'image')),
      default: attribute(node, 'default') === 'yes',
    });
  }
  const chosen = difficulties.find((entry) => entry.default) ?? difficulties[0];
  const definition: CampaignDefinition = {
    id: cleanId(attribute(campaign, 'id')),
    title: cleanText(attribute(campaign, 'name')),
    abbrev: cleanText(attribute(campaign, 'abbrev')),
    icon: cleanId(attribute(campaign, 'icon')),
    description: cleanText(attribute(campaign, 'description')),
    firstScenario: scenarios[0],
    scenarios,
    difficulties,
    defaultDifficulty: chosen?.id ?? '',
  };
  void prefix;
  return definition;
}

/** Every `.cfg` under a campaign's `scenarios/`, recursively, as relative paths sorted. */
function listScenarioFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...listScenarioFiles(path.join(dir, entry.name)).map((rel) => `${entry.name}/${rel}`));
    } else if (entry.name.endsWith('.cfg')) {
      out.push(entry.name);
    }
  }
  return out.sort();
}

const campaigns: CampaignDefinition[] = [];
for (const name of CAMPAIGN_DIRS) {
  const dir = path.join(dataDir, 'campaigns', name);
  if (!fs.existsSync(dir)) continue;
  try {
    const prefix = name === 'Two_Brothers'
      ? 'two-brothers'
      : name === 'The_South_Guard'
        ? 'the-south-guard'
        : name === 'Liberty'
          ? 'liberty'
          : name === 'Dusk_of_Dawn'
            ? 'dusk-of-dawn'
            : name === 'Of_Pearls_and_Pirates'
              ? 'of-pearls-and-pirates'
              : name === 'The_Hammer_of_Thursagan'
                ? 'the-hammer-of-thursagan'
                : name === 'Dead_Water'
                  ? 'dead-water'
                  : name === 'Descent_Into_Darkness'
                    ? 'descent-into-darkness'
                    : name === 'Sceptre_of_Fire'
                      ? 'sceptre-of-fire'
                      : name === 'Northern_Rebirth'
                        ? 'northern-rebirth'
                        : name === 'Son_Of_The_Black_Eye'
                          ? 'son-of-the-black-eye'
                          : name === 'The_Rise_Of_Wesnoth'
                            ? 'the-rise-of-wesnoth'
                            : name === 'Winds_of_Fate'
                              ? 'winds-of-fate'
                              : name === 'Secrets_of_the_Ancients'
                                ? 'secrets-of-the-ancients'
                                : name.toLowerCase().replaceAll('_', '-');
    const compiled = compileCampaign(dir, prefix);
    if (compiled) campaigns.push(compiled);
  } catch (error) {
    console.warn(`compile-campaign: skipped ${name}: ${(error as Error).message}`);
  }
}

// World Conquest (`data/campaigns/World_Conquest`) generates its scenarios from Lua
// (`scenario_generation=lua`), so there is no scenario chain to compile. The entry only lists
// it in the campaign menu; choosing it starts the real Lua through `src/scripting/world-conquest.ts`
// (faction, difficulty, five generated maps). Its player count is fixed at one.
if (fs.existsSync(path.join(dataDir, 'campaigns', 'World_Conquest'))) {
  campaigns.push({
    id: 'World_Conquest',
    title: 'World Conquest II (1 player)',
    abbrev: 'WC1p',
    icon: 'units/random-dice.png',
    description: 'A randomly generated campaign for 1 player. It has 6 levels of difficulty. (Expert level, 5 scenarios.) The maps, the armies, the heroes, the bonus points and the items are produced by the campaign’s own Lua.',
    firstScenario: 'wc-lua',
    scenarios: ['wc-lua'],
    difficulties: [],
    defaultDifficulty: '',
  });
}

campaigns.sort((a, b) => a.id.localeCompare(b.id));

const lines: string[] = [];
lines.push('// Generated by tools/compile-campaign.ts - do not edit.');
lines.push('import type { CampaignDefinition } from \'../campaign.ts\';');
lines.push('');
lines.push(`export const CAMPAIGNS: readonly CampaignDefinition[] = ${JSON.stringify(campaigns, null, '\t')};`);
lines.push('');
lines.push(`export const DEFAULT_CAMPAIGN = ${JSON.stringify(campaigns.find((campaign) => campaign.id === 'Two_Brothers')?.id ?? campaigns[0]?.id ?? '')};`);

fs.mkdirSync(generatedDir, { recursive: true });
fs.writeFileSync(path.join(generatedDir, 'campaigns.ts'), lines.join('\n'), 'utf8');
console.log(`compile-campaign: ${campaigns.length} campaign(s) -> src/generated/campaigns.ts`);
for (const campaign of campaigns) {
  console.log(`  ${campaign.id}: ${campaign.scenarios.length} scenarios [${campaign.scenarios.join(', ')}], difficulties [${campaign.difficulties.map((entry) => entry.id).join(', ')}]`);
}
