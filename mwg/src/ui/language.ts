/**
 * The app's language layer: which catalogs the build ships, and the translator
 * for the one in use.
 *
 * `src/ui/i18n.ts` owns the gettext runtime (PO parsing, plural selection,
 * substitution); this module owns the *choices*: the generated catalog table
 * (`tools/compile-i18n.ts` compiles `po/wesnoth/<locale>.po` into
 * `src/generated/i18n.ts`) and the cached translator per locale, so the scene
 * asks for a language once and every content string goes through it.
 *
 * The catalogs are Wesnoth's own, so what gets translated is the game's
 * content: scenario dialogue, objectives, story text and unit names, which the
 * MWL compiler marks with `_ "..."`. The port's own interface strings (menu
 * labels, the HUD) stay English: they have no entries in the game's catalogs,
 * and inventing them would be a translation of the port, not of the game.
 */

import { CATALOGS, LOCALE_NAMES } from '../generated/i18n.ts';
import { createTranslator, isRtlLanguage, type Catalog, type PoEntry } from './i18n.ts';

/** The languages the build ships, in the order the preferences screen lists them. */
export function availableLocales(): { id: string; name: string }[] {
  return Object.entries(LOCALE_NAMES).map(([id, name]) => ({ id, name }));
}

/** The language tag a run should use: the URL parameter, else English. */
export function localeFromLocation(search: string): string {
  const requested = new URLSearchParams(search).get('lang') ?? '';
  if (!requested) return 'en';
  if (requested in CATALOGS) return requested;
  // A regional tag (`fr_CA`) falls back to its base language when that ships.
  const base = requested.split(/[-_]/)[0];
  return base in CATALOGS ? base : 'en';
}

const translators = new Map<string, (text: string, count?: number, vars?: Readonly<Record<string, string | number>>) => string>();

/** The translator for a locale; `en` (or an unknown locale) returns the text as written. */
export function translatorFor(locale: string): (text: string, count?: number, vars?: Readonly<Record<string, string | number>>) => string {
  if (!locale || locale === 'en' || !(locale in CATALOGS)) return (text) => text;
  const cached = translators.get(locale);
  if (cached) return cached;
  const generated = CATALOGS[locale];
  const entries = new Map<string, PoEntry>(
    Object.entries(generated.entries).map(([msgid, translations]) => [msgid, { msgid, translations }]),
  );
  const catalog: Catalog = { language: locale, entries, pluralForms: generated.pluralForms, rtl: isRtlLanguage(locale) };
  const translator = createTranslator(catalog);
  translators.set(locale, translator);
  return translator;
}

/** Whether a locale is written right to left (Arabic ships, so this is a real case). */
export function isRightToLeft(locale: string): boolean {
  return isRtlLanguage(locale);
}

/** A display name for a locale id, for the preferences row. */
export function localeName(locale: string): string {
  return LOCALE_NAMES[locale] ?? 'English';
}
