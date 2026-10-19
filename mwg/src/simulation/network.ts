import { LockstepClient, type TickEvent, type WebSocketLike } from 'mwg/core';
import type { WesnothAction } from './replay.ts';

export interface WesnothNetworkOptions {
  url: string;
  createSocket?: (url: string) => WebSocketLike;
  onTick?: (tick: number, actions: Readonly<Record<string, WesnothAction | null>>) => void;
  onInitialState?: (state: WesnothInitialState) => void;
  onChat?: (peer: string, text: string) => void;
  onStatus?: (status: 'connected' | 'closed' | 'invalid') => void;
}

/** Deterministic room handshake shared before the first game action. */
export interface WesnothInitialState {
  readonly scenario: string;
  readonly seed: number;
  /** Optional authoritative save payload for a client joining an active room. */
  readonly snapshot?: WesnothNetworkSnapshot;
  readonly authority?: boolean;
}

export interface WesnothChatMessage {
  readonly text: string;
}

/** JSON-safe subset of the game's native save payload used for late join. */
export interface WesnothNetworkSnapshot {
  readonly version: 1;
  readonly scenario: string;
  readonly rngState: readonly number[];
  readonly runtime: string;
  readonly gold: Readonly<Record<string, number>>;
  readonly teams?: readonly [number, string][];
  readonly units: readonly [string, unknown][];
  readonly recallList: readonly unknown[];
  readonly journal: readonly unknown[];
  readonly achievements?: { counts: [string, number][] };
}

/** Typed lockstep transport for the port; game rules remain outside the socket layer. */
export class WesnothNetworkSession {
  private readonly client: LockstepClient;
  private readonly options: WesnothNetworkOptions;

  constructor(options: WesnothNetworkOptions) {
    if (!options.url) throw new Error('multiplayer server URL is required');
    this.options = options;
    this.client = new LockstepClient({
      url: options.url,
      create: options.createSocket,
      // mwg 0.31 requires wss:/https: unless told otherwise; allow plain ws only for a local dev server.
      allowInsecure: /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(options.url) && options.url.startsWith('ws:'),
    });
    this.client.onWelcome.add(() => options.onStatus?.('connected'));
    this.client.onClose.add(() => options.onStatus?.('closed'));
    this.client.onTick.add((event) => this.handleTick(event));
  }

  get connected(): boolean { return this.client.connected; }
  get id(): string | null { return this.client.id; }
  connect(): void { this.client.connect(); }
  close(): void { this.client.close(); }

  /** Submit at most one validated action for the current lockstep tick. */
  submit(action: WesnothAction): void {
    validateAction(action);
    this.client.submitInput({ protocol: 'mwg-wesnoth', version: 1, action });
  }

  /** Broadcast the deterministic scenario header through the same lockstep room. */
  submitInitialState(state: WesnothInitialState): void {
    if (!state.scenario || !Number.isSafeInteger(state.seed)) throw new Error('invalid multiplayer initial state');
    this.client.submitInput({ protocol: 'mwg-wesnoth-sync', version: 1, state });
  }

  /** Send a bounded plain-text message through the room's authoritative tick. */
  sendChat(text: string): void {
    const normalized = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!normalized || normalized.length > 256) throw new Error('chat message must contain 1-256 printable characters');
    this.client.submitInput({ protocol: 'mwg-wesnoth-chat', version: 1, message: { text: normalized } satisfies WesnothChatMessage });
  }

  private handleTick(event: TickEvent): void {
    const actions: Record<string, WesnothAction | null> = {};
    for (const [id, raw] of Object.entries(event.inputs)) {
      if (raw === null) { actions[id] = null; continue; }
      const candidate = (raw as { protocol?: unknown; version?: unknown; action?: unknown });
      if (candidate.protocol === 'mwg-wesnoth-chat' && candidate.version === 1 && isChatMessage((candidate as { message?: unknown }).message)) {
        this.options.onChat?.(id, (candidate as { message: WesnothChatMessage }).message.text);
        continue;
      }
      if (candidate.protocol === 'mwg-wesnoth-sync' && candidate.version === 1 && isInitialState((candidate as { state?: unknown }).state)) {
        this.options.onInitialState?.((candidate as { state: WesnothInitialState }).state);
        actions[id] = null;
        continue;
      }
      if (candidate.protocol !== 'mwg-wesnoth' || candidate.version !== 1 || !isAction(candidate.action)) {
        this.options.onStatus?.('invalid');
        actions[id] = null;
        continue;
      }
      actions[id] = candidate.action;
    }
    this.options.onTick?.(event.tick, actions);
  }
}

function isChatMessage(value: unknown): value is WesnothChatMessage {
  return Boolean(value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string'
    && (value as { text: string }).text.trim().length > 0
    && (value as { text: string }).text.length <= 256
    && !/[\u0000-\u001f\u007f]/.test((value as { text: string }).text));
}

function isAction(value: unknown): value is WesnothAction {
  if (!value || typeof value !== 'object') return false;
  const action = value as Partial<WesnothAction>;
  if (!['move', 'attack', 'recruit', 'end_turn'].includes(String(action.type))) return false;
  const side = (action as { side?: unknown }).side;
  return Number.isSafeInteger(side) && (side as number) > 0;
}

function isInitialState(value: unknown): value is WesnothInitialState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<WesnothInitialState>;
  return typeof state.scenario === 'string' && state.scenario.length > 0 && Number.isSafeInteger(state.seed)
    && (state.snapshot === undefined || isSnapshot(state.snapshot));
}

function isSnapshot(value: unknown): value is WesnothNetworkSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<WesnothNetworkSnapshot>;
  return snapshot.version === 1 && typeof snapshot.scenario === 'string' && typeof snapshot.runtime === 'string'
    && Array.isArray(snapshot.rngState) && snapshot.rngState.length === 4
    && snapshot.rngState.every((entry) => Number.isSafeInteger(entry))
    && Boolean(snapshot.gold && typeof snapshot.gold === 'object')
    && (snapshot.teams === undefined || (Array.isArray(snapshot.teams)
      && snapshot.teams.every((entry) => Array.isArray(entry) && Number.isSafeInteger(entry[0]) && typeof entry[1] === 'string')))
    && Array.isArray(snapshot.units) && Array.isArray(snapshot.recallList) && Array.isArray(snapshot.journal);
}

function validateAction(action: WesnothAction): void {
  if (!isAction(action)) throw new Error('invalid multiplayer action');
}
