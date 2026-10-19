/**
 * The port's thin layer over `mwg/two-d/ui`.
 *
 * Everything here is a factory over the framework's `Window`, `Button`,
 * `ListView` and `Label`; the port supplies the Wesnoth palette, the strings
 * and the callbacks, the framework supplies the widgets. Nothing in this file
 * knows about Wesnoth data, the simulation or the renderer: the widget types
 * come from MWG, so no `pixi.js` import is needed.
 */

import type { Container2D } from 'mwg/two-d/render';
import { Button, Label, ListView, Window, setTheme, theme, type ListItem } from 'mwg/two-d/ui';

/**
 * The port's theme options (ROADMAP: accessibility and input parity).
 *
 * `textScale` multiplies every font size the theme declares, so a player who
 * needs larger text gets it everywhere the framework draws text. `highContrast`
 * swaps the Wesnoth parchment palette for one with far more separation between
 * text, panels and highlights, for players who cannot read the warm low-contrast
 * original (WCAG AA wants 4.5:1 for body text; the dark palette sits near 12:1,
 * the high-contrast one near 19:1).
 */
export interface ThemeOptions {
  /** 1 = the shipped size, 1.25 and 1.5 for larger text */
  textScale?: number;
  highContrast?: boolean;
}

export const TEXT_SCALES: readonly number[] = [1, 1.25, 1.5];

/** The game's dark panel / gold highlight palette, applied at startup and on a preference change. */
export function applyWesnothTheme(options: ThemeOptions = {}): void {
  const scale = options.textScale && options.textScale > 0 ? options.textScale : 1;
  const palette = options.highContrast
    ? {
        text: 0xffffff,
        textDim: 0xd8d8d8,
        textHighlight: 0xffe066,
        panelFill: 0x000000,
        panelBorder: 0xffffff,
        selection: 0x2a4a7f,
        overlay: 0x000000,
      }
    : {
        text: 0xf4edd9, // Wesnoth parchment text
        textDim: 0x9a927f, // Dimmed text
        textHighlight: 0xf0d27a, // Gold highlight
        panelFill: 0x1a1714, // Dark brown/black
        panelBorder: 0xc9a227, // Gold border
        selection: 0x4a3b1f, // Dark gold selection
        overlay: 0x05070b, // Dark overlay
      };
  setTheme({
    padding: 12,
    spacing: 6,
    panelBorder: 6,
    overlayAlpha: options.highContrast ? 0.85 : 0.7,
    font: { family: '"DejaVu Sans", "Oldania ADF", serif', size: Math.round(14 * scale), lineHeight: 1.5 },
    color: palette,
  });
}

/** One row of an `actionWindow`. */
export interface MenuEntry {
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * A window holding a vertical stack of buttons, sized to its entries. The
 * window's own chrome (`content.x`/`content.y`) is measured rather than guessed,
 * so a theme change reflows it correctly.
 */
export function actionWindow(title: string, entries: readonly MenuEntry[], width = 280): Window {
  const window = new Window({ width, height: 1, title });
  const row = 34;
  entries.forEach((entry, index) => {
    const button = new Button({
      width: width - 24,
      height: 28,
      text: entry.label,
      disabled: entry.disabled,
      onClick: entry.onSelect,
    });
    button.position.set(0, index * row);
    window.content.addChild(button);
  });
  const content = Math.max(0, entries.length * row - 6);
  window.resize(width, content + window.content.y + window.content.x);
  return window;
}

export interface ListWindowOptions {
  title: string;
  width: number;
  height: number;
  items: ListItem[];
  onSelect: (item: ListItem, index: number) => void;
  footer?: string;
  initialIndex?: number;
}

/** A window wrapping a scrolling `ListView`, with an optional footer hint. */
export function listWindow(options: ListWindowOptions): { window: Window; list: ListView } {
  const window = new Window({ width: options.width, height: options.height, title: options.title });
  const footer = options.footer ? 18 : 0;
  const list = new ListView({
    width: window.contentWidth,
    height: Math.max(40, window.contentHeight - footer),
    items: options.items,
    onSelect: options.onSelect,
  });
  list.position.set(0, 0);
  window.content.addChild(list);
  window.delegate = list;
  if (options.footer) {
    const label = new Label({ text: options.footer, size: 11, color: theme().color.textDim, wrapWidth: window.contentWidth });
    label.position.set(0, window.contentHeight - 15);
    window.content.addChild(label);
  }
  if (options.initialIndex !== undefined) list.select(options.initialIndex);
  return { window, list };
}

/** A read-only window of wrapped text, sized to its content. */
export function textWindow(title: string, lines: readonly string[], width = 440): Window {
  const window = new Window({ width, height: 1, title });
  const label = new Label({ text: lines.join('\n'), wrapWidth: window.contentWidth });
  label.position.set(0, 0);
  window.content.addChild(label);
  window.resize(width, label.height + window.content.y + window.content.x + 4);
  return window;
}

/**
 * Wrap a widget that owns its own input (a `RebindScreen`, a `HelpScreen`) in a
 * window and make it the window's delegate, so the widget sees every action
 * before the window's own close-on-cancel handling.
 */
export function widgetWindow(
  title: string,
  widget: Container2D & { handleAction(action: string): boolean },
  width: number,
  height: number,
): Window {
  const window = new Window({ width, height, title });
  window.content.addChild(widget);
  window.delegate = widget;
  return window;
}
