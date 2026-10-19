/**
 * The mainline campaign source directories whose scenarios the port compiles
 * from their own files. Shared by the three data tools so the unit registry,
 * the scenario registry and the campaign menu stay in step: a campaign added
 * here gets its `units/` compiled, its numbered scenarios converted, and its
 * `[campaign]` definition emitted.
 *
 * `Two_Brothers` is first and is also emitted by its own `emitTwoBrothers`,
 * which handles a generated map; the rest derive their port prefix as
 * `name.toLowerCase().replaceAll('_', '-')`.
 *
 * `Heir_To_The_Throne` joined once the scenario modules were emitted compactly:
 * its 35 scenarios, unit types and specials all compile, and the generated
 * `scenarios.ts` is ~34 MB rather than the ~82 MB the pretty printer produced.
 * `npm run build` raises the Node heap for the single-bundle `file://` build;
 * true per-scenario lazy loading is still the P10 asset-budget item.
 */
export const CAMPAIGN_DIRS: readonly string[] = [
  'Two_Brothers',
  'Heir_To_The_Throne',
  'The_South_Guard',
  'Liberty',
  'Dusk_of_Dawn',
  'Of_Pearls_and_Pirates',
  'The_Hammer_of_Thursagan',
  'Dead_Water',
  'Descent_Into_Darkness',
  'Sceptre_of_Fire',
  'Northern_Rebirth',
  'Son_Of_The_Black_Eye',
  'The_Rise_Of_Wesnoth',
  'Winds_of_Fate',
  'Secrets_of_the_Ancients',
  'The_Deceivers_Gambit',
  'Eastern_Invasion',
  'Under_the_Burning_Suns',
  'Legend_of_Wesmere',
  'Heir_To_The_Throne_Classic',
];

/** The port's scenario-id prefix for a campaign directory. */
export function campaignPrefix(name: string): string {
  return name.toLowerCase().replaceAll('_', '-');
}

/** A lowercase hyphenated slug, safe to appear in a scenario name. */
function slug(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The port scenario name for one Wesnoth scenario id. A numbered id keeps its number
 * (`01_The_Elves_Besieged` -> `prefix-01`, `08b_X` -> `prefix-08b`, `2_Tutorial` -> `prefix-02`);
 * an id with no leading number falls back to a slug (`tutorial` -> `prefix-tutorial`), which
 * Heir to the Throne Classic's tutorial uses. Returns null for an id that yields nothing.
 */
export function scenarioPortName(realId: string, prefix: string): string | null {
  const match = /^(\d{1,2}(?:[a-z]\d?)?(?:_\d{1,2})?)_/i.exec(realId);
  if (match) {
    const number = /^\d$/.test(match[1]) ? `0${match[1]}` : match[1];
    return `${prefix}-${number.replaceAll('_', '-').toLowerCase()}`;
  }
  const fallback = slug(realId);
  return fallback === '' ? null : `${prefix}-${fallback}`;
}

/**
 * Names for every scenario of one campaign, with a collision broken by appending the id slug.
 * `2_Tutorial` and `02_Blackwater_Port` both reduce to `prefix-02` (Heir to the Throne Classic),
 * and the emitter writes one `.mwl` per name, so the second would overwrite the first.
 */
export function disambiguateScenarioNames(prefix: string, realIds: readonly string[]): Map<string, string> {
  const base = new Map<string, string>();
  for (const id of realIds) {
    const name = scenarioPortName(id, prefix);
    if (name !== null) base.set(id, name);
  }
  const counts = new Map<string, number>();
  for (const name of base.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const [id, name] of base) {
    let candidate = (counts.get(name) ?? 0) <= 1 ? name : `${name}-${slug(id)}`;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${name}-${suffix++}`;
    used.add(candidate);
    names.set(id, candidate);
  }
  return names;
}
