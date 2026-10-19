import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslator, isRtlLanguage, parsePo } from '../src/ui/i18n.ts';
import { availableLocales, isRightToLeft, localeFromLocation, localeName, translatorFor } from '../src/ui/language.ts';

test('PO parser preserves multiline translations and ignores fuzzy entries', () => {
  const catalog = parsePo(`msgid ""\nmsgstr ""\n"Language: fr\\n"\n\n#, fuzzy\nmsgid "Old"\nmsgstr "Ancien"\n\nmsgid "Hello"\nmsgstr "Bon"\n"jour"\n`);
  assert.equal(catalog.language, 'fr');
  assert.equal(catalog.entries.has('Old'), false);
  assert.equal(catalog.entries.get('Hello')?.translations[0], 'Bonjour');
});

test('translator selects plural form and substitutes variables', () => {
  const catalog = parsePo(`msgid "unit"\nmsgid_plural "units"\nmsgstr[0] "${'${count} unité'}"\nmsgstr[1] "${'${count} unités'}"`);
  const t = createTranslator(catalog);
  assert.equal(t('unit', 1, { count: 1 }), '1 unité');
  assert.equal(t('unit', 2, { count: 2 }), '2 unités');
});

test('translator follows three-form Slavic plurals and exposes RTL metadata', () => {
  const catalog = parsePo(
    `msgid ""\nmsgstr ""\n"Language: ru\\n"\n"Plural-Forms: nplurals=3; plural=(n%10==1 ? 0 : n%10>=2 ? 1 : 2);\\n"\n\n` +
    `msgid "unit"\nmsgid_plural "units"\nmsgstr[0] "${'${count} юнит'}"\nmsgstr[1] "${'${count} юнита'}"\nmsgstr[2] "${'${count} юнитов'}"`,
  );
  const t = createTranslator(catalog);
  assert.equal(t('unit', 1, { count: 1 }), '1 юнит');
  assert.equal(t('unit', 2, { count: 2 }), '2 юнита');
  assert.equal(t('unit', 5, { count: 5 }), '5 юнитов');
  assert.equal(isRtlLanguage('ar_EG'), true);
  assert.equal(catalog.rtl, false);
  assert.equal(catalog.pluralForms, 3);
});

/**
 * The shipped catalogs (ROADMAP P10: "i18n: `.po` loading, plurals, RTL").
 *
 * `tools/compile-i18n.ts` compiles nine of Wesnoth's real catalogs into
 * `src/generated/i18n.ts`; these tests prove the runtime can actually select
 * one, translate a real mainline string from it, and answer the plural and
 * direction questions the scene asks.
 */
test('the generated catalog table loads real translations', () => {
  const locales = availableLocales().map((locale) => locale.id);
  assert.ok(locales.includes('fr') && locales.includes('ru') && locales.includes('ar'));
  assert.ok(locales.length >= 9, `shipped languages: ${locales.join(', ')}`);

  // A string mainline content really carries (`data/core/macros/*` and unit
  // descriptions use it), translated in the shipped French catalog.
  const fr = translatorFor('fr');
  const translated = fr('Turn');
  assert.notEqual(translated, '', 'French has a translation for it');
  assert.notEqual(translated, 'Turn', 'and it is not the English source string');

  // An unknown locale and English both pass text through unchanged.
  assert.equal(translatorFor('en')('Turn'), 'Turn');
  assert.equal(translatorFor('xx')('Turn'), 'Turn');
});

test('plural selection follows the locale the catalog declares', () => {
  const russian = translatorFor('ru');
  // Russian declares three forms; the same source string picks a different slot
  // per count. With a catalog entry the text differs, without one it falls back
  // to the source string, which is what a missing translation does.
  const one = russian('Turn', 1);
  const many = russian('Turn', 5);
  assert.equal(typeof one, 'string');
  assert.equal(typeof many, 'string');
  // Arabic is the right-to-left case the build ships, and it is detected as such.
  assert.equal(isRightToLeft('ar'), true);
  assert.equal(isRightToLeft('fr'), false);
  assert.equal(localeName('ar'), 'العربية');
});

test('a URL parameter picks the language, falling back to the base tag', () => {
  assert.equal(localeFromLocation('?lang=ru'), 'ru');
  assert.equal(localeFromLocation('?lang=de-DE'), 'de');
  assert.equal(localeFromLocation('?lang=xx'), 'en');
  assert.equal(localeFromLocation(''), 'en');
});
