import { schema01, type MwlTagSchema } from 'mwg/mwl';

/**
 * MWL's `while`/`foreach`/`switch`/`if`/`else` child lists omit `dialogue` and
 * `say`, but the framework runtime runs control-flow bodies through `runBlock`,
 * which handles both (`MW_games/src/mwl/runtime.ts` `case 'while'`). Wesnoth
 * allows a `[message]` with `[option]` there, and HttT's
 * `29_Digging_for_Dwarves` and `00_The_Great_Continent` use it, so the port's
 * scenario-compile schema adds them. This lives here rather than in the
 * framework so no Wesnoth-shaped change reaches `MW_games`.
 */
function controlFlow(tag: string): MwlTagSchema {
  const base = schema01[tag];
  const children = [...(base?.children ?? [])];
  for (const extra of ['dialogue', 'say']) if (!children.includes(extra)) children.push(extra);
  return { ...base, children };
}

export const scenarioSchema: Readonly<Record<string, MwlTagSchema>> = {
  ...schema01,
  // Wesnoth filters spell numeric fields as ranges and lists
  // (`level=0-2`, `x=1-5,8`); MWL types them as integers. Keep the spelling
  // Wesnoth wrote so documents compile; the runtime matches the keys it
  // evaluates and ignores the rest.
  filter: {
    ...(schema01.filter ?? {}),
    attributes: {
      ...(schema01.filter?.attributes ?? {}),
      x: 'string',
      y: 'string',
      level: 'string',
    },
  },
  while: controlFlow('while'),
  foreach: controlFlow('foreach'),
  switch: controlFlow('switch'),
  if: controlFlow('if'),
  else: controlFlow('else'),
};
