/** Small gettext catalog runtime kept in the Wesnoth adapter layer. */

export interface PoEntry {
  msgid: string;
  msgidPlural?: string;
  translations: readonly string[];
  fuzzy?: boolean;
}

export interface Catalog {
  language: string;
  entries: ReadonlyMap<string, PoEntry>;
  /** Number of plural slots expected by the locale's gettext rules. */
  pluralForms?: number;
  /** Whether the locale is written right-to-left. */
  rtl?: boolean;
}

const RTL_LANGUAGES = new Set(['ar', 'arc', 'dv', 'fa', 'he', 'ku', 'ps', 'syr', 'ur', 'yi']);

export function isRtlLanguage(language: string): boolean {
  return RTL_LANGUAGES.has(language.toLowerCase().split(/[-_]/)[0]);
}

/** Select a gettext plural slot for the common mainline locale families. */
export function pluralIndex(language: string, count: number, forms = 2): number {
  const n = Math.abs(Math.trunc(count));
  const lang = language.toLowerCase().split(/[-_]/)[0];
  if (forms <= 1) return 0;
  if (lang === 'ar' && forms >= 6) {
    if (n === 0) return 0;
    if (n === 1) return 1;
    if (n === 2) return 2;
    if (n % 100 >= 3 && n % 100 <= 10) return 3;
    if (n % 100 >= 11 && n % 100 <= 99) return 4;
    return 5;
  }
  if (lang === 'ru' || lang === 'uk' || lang === 'be') {
    if (n % 10 === 1 && n % 100 !== 11) return 0;
    if (forms >= 3 && n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return 1;
    return Math.min(forms - 1, 2);
  }
  if (lang === 'pl' && forms >= 3) {
    if (n === 1) return 0;
    if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return 1;
    return 2;
  }
  if ((lang === 'cs' || lang === 'sk') && forms >= 3) {
    if (n === 1) return 0;
    if (n >= 2 && n <= 4) return 1;
    return 2;
  }
  // French and the other two-form locales treat zero and one as singular
  // only where gettext's standard rule says so. French is the bundled case.
  return n === 1 ? 0 : Math.min(forms - 1, 1);
}

function unquote(value: string): string {
  const quoted = value.trim();
  if (!quoted.startsWith('"')) return '';
  try {
    return JSON.parse(quoted) as string;
  } catch {
    return quoted.slice(1, quoted.endsWith('"') ? -1 : undefined);
  }
}

/** Parse the subset of GNU PO needed by mainline WML strings. */
export function parsePo(source: string, language = ''): Catalog {
  const entries: PoEntry[] = [];
  let flags = '';
  let msgid: string | undefined;
  let msgidPlural: string | undefined;
  let translations: string[] = [];
  let field: 'msgid' | 'msgid_plural' | 'msgstr' | string | undefined;
  let headerTranslation = '';

  const finish = (): void => {
    if (msgid === undefined || msgid === '') {
      if (msgid === '' && translations[0]) headerTranslation = translations[0];
      msgid = undefined;
      msgidPlural = undefined;
      translations = [];
      flags = '';
      field = undefined;
      return;
    }
    entries.push({ msgid, msgidPlural, translations: [...translations], fuzzy: /(^|,)\s*fuzzy\s*(,|$)/.test(flags) });
    msgid = undefined;
    msgidPlural = undefined;
    translations = [];
    flags = '';
    field = undefined;
  };

  for (const line of source.replaceAll('\r\n', '\n').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') { finish(); continue; }
    if (trimmed.startsWith('#,')) { flags += `${flags ? ',' : ''}${trimmed.slice(2).trim()}`; continue; }
    if (trimmed.startsWith('#')) continue;
    const match = /^(msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+(".*")$/.exec(trimmed);
    if (match) {
      field = match[1] === 'msgid_plural' ? 'msgid_plural' : match[1].startsWith('msgstr[') ? `msgstr[${Number(match[2])}]` : match[1] as 'msgid' | 'msgstr';
      const value = unquote(match[3]);
      if (field === 'msgid') msgid = value;
      else if (field === 'msgid_plural') msgidPlural = value;
      else {
        const index = field === 'msgstr' ? 0 : Number(field.slice(7, -1));
        translations[index] = value;
      }
      continue;
    }
    if (trimmed.startsWith('"') && field) {
      const value = unquote(trimmed);
      if (field === 'msgid') msgid = `${msgid ?? ''}${value}`;
      else if (field === 'msgid_plural') msgidPlural = `${msgidPlural ?? ''}${value}`;
      else {
        const index = field === 'msgstr' ? 0 : Number(field.slice(7, -1));
        translations[index] = `${translations[index] ?? ''}${value}`;
      }
    }
  }
  finish();
  const map = new Map<string, PoEntry>();
  for (const entry of entries) if (!entry.fuzzy && entry.translations.some(Boolean)) map.set(entry.msgid, entry);
  const languageLine = headerTranslation.match(/(?:^|\n)Language:\s*([^\n]+)/i)?.[1]?.trim() || language;
  const pluralLine = headerTranslation.match(/(?:^|\n)Plural-Forms:\s*nplurals\s*=\s*(\d+)/i);
  const pluralForms = pluralLine ? Math.max(1, Number(pluralLine[1])) : undefined;
  return { language: languageLine, entries: map, pluralForms, rtl: isRtlLanguage(languageLine) };
}

/** How many plural slots a parsed catalog declares (gettext's `nplurals`). */
export function pluralFormsOf(catalog: Catalog): number {
  return catalog.pluralForms ?? Math.max(1, ...([...catalog.entries.values()].map((entry) => entry.translations.length)));
}

export function createTranslator(catalog?: Catalog): (text: string, count?: number, vars?: Readonly<Record<string, string | number>>) => string {
  return (text, count, vars) => {
    const entry = catalog?.entries.get(text);
    const index = count === undefined
      ? 0
      : pluralIndex(catalog?.language ?? '', count, catalog?.pluralForms ?? entry?.translations.length ?? 2);
    let result = entry?.translations[index] || entry?.translations.at(-1) || text;
    if (vars) result = result.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (match, name: string) => vars[name] === undefined ? match : String(vars[name]));
    return result;
  };
}
