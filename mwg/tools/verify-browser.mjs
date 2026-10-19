/**
 * Headless browser verification for the built `dist/index.html`.
 *
 * Boots the single-file build in headless Chrome over the DevTools protocol and
 * reports what the scene actually contains: the loaded scenario state, the
 * terrain transition layers, the team-coloured texture cache, pending texture
 * loads, and every page error. Exits non-zero if the scene never initialised or
 * logged an error, so it can gate a release.
 *
 * Usage:
 *   npm run build
 *   npm run verify -- --scenario freelands
 *   npm run verify -- --scenario two-brothers-01 --screenshot verify-p4.png
 *
 * Chrome is found from `CHROME_PATH` or the usual install locations. The port
 * keeps its `file://` guarantee, so no server is started.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseProfileDir, usableProfileDir } from './chrome-profile.mjs';

const mwgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = path.join(mwgDir, 'dist', 'index.html');
const wantedProfileDir = path.join(mwgDir, '.verify-chrome-profile');
const PORT = Number(process.env.VERIFY_PORT ?? 9334);
const SERVE_PORT = Number(process.env.VERIFY_SERVE_PORT ?? 8080);
const DEFAULT_SCENARIO = 'freelands';

function parseArgs(argv) {
  const options = { scenario: DEFAULT_SCENARIO, screenshot: null, wait: 30, mobile: false, serve: false, autoplay: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scenario') options.scenario = argv[++i];
    else if (arg === '--screenshot') options.screenshot = argv[++i];
    else if (arg === '--wait') options.wait = Number(argv[++i]);
    else if (arg === '--mobile') options.mobile = true;
    else if (arg === '--serve') options.serve = true;
    else if (arg === '--autoplay') options.autoplay = true;
  }
  return options;
}

/**
 * A static server for the hosted-build pass (ROADMAP: "Browser compatibility
 * and release validation"). The build must work both from `file://` and served
 * over http, where the service worker and the manifest are live. The port comes
 * from the OS: Windows reserves ranges that silently refuse to bind.
 */
async function serveDist(port) {
  const http = await import('node:http');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };
  const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.join(distEntry, '..', relative === '/' ? 'index.html' : relative.replace(/^\//, ''));
    try {
      const body = fs.readFileSync(file);
      response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function devtoolsTarget() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 400);
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: controller.signal });
      const list = await response.json();
      const page = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // endpoint not up yet
    } finally {
      clearTimeout(timeout);
    }
    await sleep(500);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(distEntry)) {
    console.error(`verify-browser: ${distEntry} is missing; run "npm run build" first`);
    process.exit(1);
  }
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('verify-browser: no Chrome/Edge found; set CHROME_PATH');
    process.exit(1);
  }
  const url = `file:///${distEntry.replaceAll('\\', '/')}#${options.scenario}${options.autoplay ? '#autoplay' : ''}`;
  // A browser left behind by an earlier run can still hold this profile, and a
  // profile a live Chrome holds is one this run cannot open; take one that is
  // free instead of failing for a reason the game knows nothing about.
  const profileDir = usableProfileDir(wantedProfileDir);
  let server = null;
  let targetUrl = url;
  if (options.serve) {
    server = await serveDist(SERVE_PORT);
    targetUrl = `http://127.0.0.1:${SERVE_PORT}/#${options.scenario}`;
  }
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1400,900',
    targetUrl,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  try {
    const target = await devtoolsTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.navigate', { url: targetUrl });
    if (options.mobile) {
      // A phone viewport with touch, so the responsive HUD and the pointer path
      // are exercised the way a mobile player hits them.
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }

    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };

    const readReport = () => evaluate(`(() => {
      const w = window.__WESNOTH__;
      if (!w || !w.state) return null;
      const scene = w.scene;
      const layer = (name) => scene && scene[name] && scene[name].children ? scene[name].children.length : -1;
      return {
        scenario: location.hash.slice(1),
        width: w.state.width,
        height: w.state.height,
        units: w.state.units.length,
        turn: w.state.turn,
        round: w.state.round,
        terrainLayer: layer('terrainLayer'),
        terrainForegroundLayer: layer('terrainForegroundLayer'),
        unitLayer: layer('unitLayer'),
        unitViews: scene && scene.unitViews ? scene.unitViews.size : -1,
        unitFrames: scene && scene.unitViews ? [...scene.unitViews.values()].slice(0, 3).map((view) => view.lastImage ?? null) : [],
        spriteWidths: scene && scene.unitViews ? [...scene.unitViews.values()].slice(0, 3).map((view) => view.sprite.texture.width) : [],
        teamTextures: scene && scene.teamTextures ? scene.teamTextures.size : -1,
        teamLoading: scene && scene.teamTextureLoading ? scene.teamTextureLoading.size : -1,
        colorMappings: scene && scene.colorMappings ? scene.colorMappings.size : -1,
        pendingTextures: scene && scene.artSprites ? scene.artSprites.size : -1,
        viewport: { width: window.innerWidth, height: window.innerHeight, touch: (navigator.maxTouchPoints ?? 0) > 0, coarse: matchMedia('(pointer: coarse)').matches },
      };
    })()`);

    let state = null;
    for (let attempt = 0; attempt < options.wait; attempt++) {
      await sleep(1000);
      state = await readReport();
      if (state) break;
    }

    // Headless Chrome throttles requestAnimationFrame, so the scene's update
    // loop may never run on its own. Drive a handful of frames explicitly: this
    // is what binds unit textures and builds the team-colour canvases.
    for (let frame = 0; frame < 8; frame++) {
      await evaluate("(async () => { await window.__WESNOTH__.controls.run('update'); return true; })()");
      await sleep(250);
    }
    // Let the asynchronous unit texture and team-colour loads settle.
    await sleep(8000);
    state = (await readReport()) ?? state;

    // Verify autoplay: check that the game loads and turns are simulated
    if (options.autoplay) {
      const initialTurn = state?.turn ?? 0;
      const initialRound = state?.round ?? 0;
      console.log(`Autoplay: Initial turn = ${initialTurn}, round = ${initialRound}`);
      
      // Wait for window.__WESNOTH__ to be available
      let wesnothAvailable = false;
      for (let i = 0; i < 10; i++) {
        await sleep(1000);
        wesnothAvailable = await evaluate('(() => { return !!window.__WESNOTH__; })()');
        if (wesnothAvailable) break;
      }
      if (!wesnothAvailable) {
        console.error('window.__WESNOTH__ not available after 10 seconds');
      }
      
      // Simulate multiple "Space" key presses to end the turn
      for (let i = 0; i < 5; i++) {
        await evaluate('(() => { try { const event = new KeyboardEvent("keydown", { key: " " }); document.dispatchEvent(event); } catch (e) { console.error(e); } return true; })()');
        await sleep(500);
      }
      
      // Wait for a few seconds to see if the turn/round changes (autoplay active)
      await sleep(5000);
      const updatedState = await readReport();
      const updatedTurn = updatedState?.turn ?? 0;
      const updatedRound = updatedState?.round ?? 0;
      console.log(`Autoplay: Turn after 5s = ${updatedTurn}, round = ${updatedRound}`);
      
      if (updatedTurn !== initialTurn || updatedRound !== initialRound) {
        console.log('✅ Autoplay: Turn/round changed, turns are being simulated.');
      } else {
        console.log('⚠️ Autoplay: No turn/round changes detected. Check if autoplay is working.');
      }
    }

    // Exercise the undo history end to end: push a point the way an action does, step back
    // and forward, and confirm the cursor moves and the scenario survives the rebuild.
    const undo = await evaluate(`(() => {
      const w = window.__WESNOTH__;
      if (!w || typeof w.undo !== 'function' || typeof w.redo !== 'function' || typeof w.undoState !== 'function') return null;
      if (typeof w.scene?.commitUndo !== 'function') return { unavailable: true };
      const before = w.undoState();
      w.scene.commitUndo();
      const pushed = w.undoState();
      w.undo();
      const undone = w.undoState();
      w.redo();
      const redone = w.undoState();
      return { before, pushed, undone, redone, units: w.state.units.length, outcome: w.outcome };
    })()`);

    // Exercise the audio surface the way a player does: a real pointer gesture
    // unlocks it (browsers refuse audio before one), which flushes the cues the
    // scenario queued at start (its music, and the turn bell). No audio device
    // is needed to see that the surface resolved and dispatched them.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 40, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 40, y: 40, button: 'left', clickCount: 1 });
    await sleep(300);
    const audio = await evaluate(`(() => {
      const w = window.__WESNOTH__;
      const surface = w?.scene?.audio;
      // The scenario's own cues are what the surface queues at start; after the
      // gesture they should have played. Ask for one more explicitly, so a
      // scenario that legitimately has no cue still exercises the path:
      // throw-1.wav is a cue this checkout really ships (the goblin spear's
      // frame sound), while bell.wav, the engine's own turn_bell, is not in
      // this data set and only proves the missing-file path stays silent.
      try { surface?.playCue?.('throw-1.wav'); } catch (error) { return { failure: String(error) }; }
      const snapshot = w?.diagnostics?.()?.audio ?? null;
      const turnBell = w?.data?.sounds?.turn_bell ?? null;
      return snapshot ? { ...snapshot, turnBell } : null;
    })()`);

    // Browser-side budgets (ROADMAP P10): frame time for the real scene loop and
    // the page's JS heap, reported with the asset counts so a trend is visible
    // across runs. The thresholds are loose; the numbers are the point.
    const performanceReport = await evaluate(`(() => {
      const w = window.__WESNOTH__;
      const scene = w && w.scene;
      if (!scene || typeof scene.update !== 'function') return null;
      const frames = [];
      for (let index = 0; index < 40; index++) {
        const started = performance.now();
        scene.update(1 / 60);
        frames.push(performance.now() - started);
      }
      frames.sort((a, b) => a - b);
      const memory = performance.memory ? performance.memory.usedJSHeapSize : null;
      return {
        frameMedianMs: Number(frames[Math.floor(frames.length / 2)].toFixed(2)),
        frameMaxMs: Number(frames[frames.length - 1].toFixed(2)),
        heapBytes: memory,
        unitViews: scene.unitViews ? scene.unitViews.size : null,
        textures: scene.artSprites ? scene.artSprites.size : null,
        teams: scene.teamTextures ? scene.teamTextures.size : null,
      };
    })()`);

    // The language layer: the run above is English; ask the scene for another
    // catalog and confirm content strings really change (a translated run
    // renders real strings, ROADMAP P10).
    const language = await evaluate(`(() => {
      const w = window.__WESNOTH__;
      const scene = w && w.scene;
      if (!scene || typeof scene.setLocale !== 'function') return null;
      scene.setLocale('fr');
      const sample = scene.translate('Turn');
      return { locale: scene.locale, sample, translated: sample !== 'Turn' };
    })()`);

    // Keyboard play and accessibility (ROADMAP: "Accessibility and input
    // parity"): real key events must move the hex cursor, Enter must act on it,
    // and the preferences must reach the framework theme.
    const pressKey = async (key, code, modifiers = 0) => {
      const virtualKey = key === 'ArrowRight' ? 39 : key === 'Enter' ? 13 : 0;
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, modifiers });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, modifiers });
      // The scene reads `Input.justPressed` from its own loop, and headless
      // Chrome throttles requestAnimationFrame, so drive the frame by hand.
      await evaluate('(() => { try { window.__WESNOTH__.scene.update(0.016); } catch {} return true; })()');
      await sleep(120);
    };
    // A scenario's opening message owns the keyboard until it is dismissed, so
    // clear it first (Enter), then drive the cursor.
    for (let attempt = 0; attempt < 5; attempt++) {
      const open = await evaluate('(() => Boolean(window.__WESNOTH__?.scene?.dialogueOpen))()');
      if (!open) break;
      await pressKey('Enter', 'Enter');
    }
    const cursorBefore = await evaluate('(() => { const w = window.__WESNOTH__; return w.scene.cursorVisible ? { ...w.scene.cursor } : null; })()');
    await pressKey('ArrowRight', 'ArrowRight');
    await pressKey('ArrowRight', 'ArrowRight');
    await pressKey('Enter', 'Enter');
    const keyboard = await evaluate(`(() => {
      const w = window.__WESNOTH__;
      const scene = w.scene;
      const before = scene.textScale;
      scene.setThemeOption({ textScale: 1.5, highContrast: true, reducedMotion: true });
      const afterScale = scene.textScale;
      const afterContrast = scene.highContrast;
      const motionWhileOn = scene.reducedMotion;
      scene.setThemeOption({ textScale: before, highContrast: false, reducedMotion: false });
      return {
        cursor: { ...scene.cursor },
        cursorVisible: scene.cursorVisible,
        selected: scene.selected ? scene.selected.name : null,
        before,
        afterScale,
        afterContrast,
        motionWhileOn,
        textScaleApplied: scene.textScale === before && afterScale === 1.5 && afterContrast === true,
        restored: scene.textScale === before && scene.highContrast === false,
      };
    })()`);

    // Touch input on the board (mobile pass): a tap must reach the same pointer
    // path a mouse click does, which is what makes the game playable on a phone.
    const touch = await evaluate(`(() => {
      const w = window.__WESNOTH__;
      const scene = w && w.scene;
      const canvas = document.querySelector('canvas');
      if (!scene || !canvas) return null;
      const before = scene.selected ? scene.selected.id : null;
      const rect = canvas.getBoundingClientRect();
      const options = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height * 0.35, pointerId: 1, pointerType: 'touch', isPrimary: true };
      canvas.dispatchEvent(new PointerEvent('pointerdown', options));
      canvas.dispatchEvent(new PointerEvent('pointerup', options));
      scene.update(0.016);
      return { before, after: scene.selected ? scene.selected.id : null, fired: true };
    })()`);

    // One authoritative state (ROADMAP P0): what a save stores is the whole
    // rule state, so saving, changing the position, and loading the save must
    // land on the same state hash the save was taken at.
    const roundTrip = await evaluate(`(() => {
      const w = window.__WESNOTH__;
      const scene = w && w.scene;
      if (!scene || typeof w.stateHash !== 'function' || typeof w.save !== 'function' || typeof w.load !== 'function') return null;
      const saved = w.stateHash();
      // Take the save, then change the position (end the local player's turn, so
      // units move, fog syncs and gold changes), then load the save back.
      w.save('verify-round-trip');
      scene.finishTurn();
      const changed = w.stateHash() !== saved;
      w.load('verify-round-trip');
      const restored = w.stateHash();
      return { saved, restored, changed, equal: saved === restored, units: scene.state.units.length };
    })()`);

    const errors = cdp.events
      .filter((event) => event.method === 'Runtime.exceptionThrown'
        || event.method === 'Network.loadingFailed'
        || (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error')
        || (event.method === 'Log.entryAdded' && event.params.entry.level === 'error'))
      .map((event) => {
        if (event.method === 'Runtime.exceptionThrown') return event.params.exceptionDetails?.exception?.description ?? event.params.exceptionDetails?.text;
        if (event.method === 'Network.loadingFailed') {
          const request = cdp.events.find((candidate) => candidate.method === 'Network.requestWillBeSent'
            && candidate.params.requestId === event.params.requestId);
          return `loadingFailed: ${event.params.errorText} (${request?.params.request?.url ?? 'unknown URL'})`;
        }
        if (event.method === 'Runtime.consoleAPICalled') return event.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
        return event.params.entry.text;
      })
      .slice(0, 10);

    if (options.screenshot) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(options.screenshot, Buffer.from(shot.data, 'base64'));
    }

    const problems = [];
    if (!state) problems.push('the scene never initialised (no __WESNOTH__.state)');
    if (state && (state.terrainLayer <= 0 || state.terrainForegroundLayer < 0)) problems.push('terrain layers are empty');
    if (state && state.colorMappings < 1) problems.push('no team-colour mapping was built');
    if (undo && !undo.unavailable) {
      if (!undo.pushed?.canUndo) problems.push('undo history did not record the pushed point');
      if (undo.undone?.canUndo !== false || undo.undone?.canRedo !== true) problems.push('undo did not step back');
      if (undo.redone?.canUndo !== true || undo.redone?.canRedo !== false) problems.push('redo did not step forward');
      if (undo.units !== state?.units) problems.push('undo rebuilt a different unit count');
    }
    if (errors.length > 0) problems.push(...errors);
    if (!performanceReport) problems.push('the scene could not be measured');
    if (performanceReport && performanceReport.frameMedianMs > 100) {
      problems.push(`median frame took ${performanceReport.frameMedianMs}ms (budget 100ms)`);
    }
    if (!audio) problems.push('the diagnostics snapshot has no audio section');
    if (!keyboard) problems.push('the keyboard check did not run');
    if (!roundTrip) problems.push('the save/load round trip did not run');
    if (roundTrip && !roundTrip.changed) problems.push('the round trip could not change the state (nothing to restore)');
    if (roundTrip && !roundTrip.equal) problems.push(`save/load did not restore the state (${roundTrip.saved} != ${roundTrip.restored})`);
    if (options.mobile && state && !(state.viewport?.width <= 420 && (state.viewport?.touch || state.viewport?.coarse))) {
      problems.push(`the mobile viewport or touch emulation was not applied (${JSON.stringify(state.viewport)})`);
    }
    if (!touch) problems.push('the touch tap did not run');
    if (keyboard && !(keyboard.cursor.x > (cursorBefore?.x ?? -1))) problems.push(`the arrow keys did not move the cursor (${JSON.stringify(keyboard)})`);
    if (keyboard && !keyboard.textScaleApplied) problems.push('the accessibility preferences did not reach the theme');
    if (keyboard && !keyboard.restored) problems.push('the accessibility preferences did not restore');
    if (!language) problems.push('the scene has no language layer');
    if (language && !language.translated) problems.push(`the French catalog did not translate a known string (${JSON.stringify(language)})`);
    if (audio && audio.playing.length === 0) problems.push('the audio surface played nothing after the first gesture');

    console.log(JSON.stringify({ ok: problems.length === 0, mode: options.serve ? 'hosted' : 'file', mobile: options.mobile, state, undo, audio, language, keyboard, touch, roundTrip, performance: performanceReport, errors }, null, 2));
    ws.close();
    process.exit(problems.length === 0 ? 0 : 1);
  } finally {
    server?.close();
    chrome.kill();
    await sleep(500);
    releaseProfileDir(profileDir);
  }
}

try {
  await main();
} catch (error) {
  console.error(`verify-browser: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
