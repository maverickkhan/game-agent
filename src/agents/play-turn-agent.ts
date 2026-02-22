import { BaseAgent, createEvent, createEventActions } from '@google/adk';
import type { InvocationContext, Event } from '@google/adk';
import { takeScreenshot, executeAction } from '../actions.js';
import { askGeminiForPlayAction, isApiBudgetExhausted, isAnyModelAvailable } from '../gemini.js';
import { gameState, getElapsedMs, getRemainingMs, isTimeUp, learnFromApiAction } from '../lib/game-state.js';
import { saveScreenshot } from '../lib/logger.js';
import { getPage } from '../browser.js';

// Minimum time between actions — prevents unrealistic spam
const MIN_ACTION_INTERVAL_MS = 1_500;
let lastActionTime = 0;


export class PlayTurnAgent extends BaseAgent {
  constructor() {
    super({
      name: 'PlayTurnAgent',
      description: 'Executes a single turn of gameplay: screenshot, reason, act.',
    });
  }

  async *runAsyncImpl(ctx: InvocationContext): AsyncGenerator<Event> {
    if (isTimeUp()) {
      console.log(`[PlayTurnAgent] Time is up! Elapsed: ${getElapsedMs()}ms`);
      yield createEvent({
        author: this.name,
        actions: createEventActions({ escalate: true }),
      });
      return;
    }

    // Enforce minimum pace between actions
    const now = Date.now();
    const sinceLastAction = now - lastActionTime;
    if (lastActionTime > 0 && sinceLastAction < MIN_ACTION_INTERVAL_MS) {
      await getPage().waitForTimeout(MIN_ACTION_INTERVAL_MS - sinceLastAction);
    }

    const turnNumber = gameState.actions.length;
    const remaining = getRemainingMs();
    const elapsed = getElapsedMs();
    const k = gameState.learned;

    // ALWAYS take a screenshot
    const screenshot = await takeScreenshot();
    if (turnNumber % 8 === 0) {
      saveScreenshot(screenshot, `play_${turnNumber}`);
    }

    const canUseApi = isAnyModelAvailable() && !isApiBudgetExhausted();

    let fc: { name: string; args: Record<string, unknown> } | null = null;
    let source: 'api' | 'fallback' = 'fallback';

    if (canUseApi) {
      // Build rich context with action history and feedback
      const contextParts = [
        `GAME: ${gameState.gameType}`,
        `STRATEGY: ${gameState.strategy}`,
        `TIME: ${Math.round(remaining / 1000)}s remaining (${Math.round(elapsed / 1000)}s elapsed)`,
        `TURN: ${turnNumber}`,
      ];

      if (k.category !== 'unknown') {
        contextParts.push(`DETECTED CONTROLS: ${k.category}`);
      }
      if (k.joystickCenter) {
        contextParts.push(`JOYSTICK LOCATION: (${k.joystickCenter.x.toFixed(2)}, ${k.joystickCenter.y.toFixed(2)}) — DRAG from here to move`);
      } else {
        contextParts.push(`JOYSTICK LOCATION: unknown — try dragging from (~0.75, ~0.75) or (~0.2, ~0.8) to move`);
      }
      if (k.controlScheme) {
        contextParts.push(`CONTROL SCHEME: ${k.controlScheme}`);
      }
      contextParts.push(`⚠️ ARROWS/INDICATORS ON SCREEN = DIRECTION to move, NOT buttons. Use DRAG to move in the direction arrows point.`);

      // Include recent action history with results so model learns what worked
      const recentActions = gameState.actions.slice(-5);
      if (recentActions.length > 0) {
        contextParts.push('');
        contextParts.push('RECENT ACTION HISTORY (learn from what worked/failed):');
        for (const a of recentActions) {
          const coords = a.action === 'drag'
            ? `from (${a.args?.startX}, ${a.args?.startY}) to (${a.args?.endX}, ${a.args?.endY})`
            : `at (${a.args?.x}, ${a.args?.y})`;
          const status = a.result === 'ok' ? 'OK' : `FAILED: ${a.result}`;
          contextParts.push(`  ${a.action} ${coords} — "${a.reason}" → ${status}`);
        }

        // Count repeated clicks on same spot
        const clickActions = recentActions.filter(a => a.action === 'click');
        if (clickActions.length >= 3) {
          const sameSpot = clickActions.every(a =>
            Math.abs((a.args?.x as number) - (clickActions[0].args?.x as number)) < 0.1 &&
            Math.abs((a.args?.y as number) - (clickActions[0].args?.y as number)) < 0.1
          );
          if (sameSpot) {
            contextParts.push('');
            contextParts.push('⚠️ WARNING: You have been clicking the SAME SPOT repeatedly without progress!');
            contextParts.push('STOP clicking there. Try a COMPLETELY DIFFERENT action:');
            contextParts.push('- Use DRAG to move the joystick (if this is a movement game)');
            contextParts.push('- Try interacting with a DIFFERENT element on screen');
            contextParts.push('- Use tap_hold instead of click');
          }
        }
      }

      contextParts.push('');
      contextParts.push('Look at the screenshot. What do you see? What is the game asking you to do? Choose the BEST action.');

      const contextText = contextParts.join('\n');

      try {
        fc = await askGeminiForPlayAction(screenshot, contextText);
        if (fc) {
          source = 'api';
          learnFromApiAction(fc);
        }
      } catch (err: any) {
        const short = err.message?.includes('429') ? '429 rate limited' : err.message?.slice(0, 80);
        console.log(`[PlayTurnAgent] Gemini: ${short}`);
      }
    }

    // Adaptive fallback
    if (!fc) {
      fc = getAdaptiveFallback(turnNumber);
    }

    // Execute the action
    const result = await executeAction(fc);
    result.source = source;
    gameState.actions.push(result);
    lastActionTime = Date.now();

    const tag = source === 'api' ? '' : ` [${k.category}]`;
    console.log(
      `[PlayTurnAgent] Turn ${turnNumber} (${Math.round(elapsed / 1000)}s): ${result.action} — ${result.reason} [${result.result}]${tag}`
    );

    yield createEvent({
      author: this.name,
      actions: createEventActions({
        stateDelta: {
          last_action: `${result.action}: ${result.reason}`,
          turn_count: turnNumber + 1,
          game_category: k.category,
          game_phase: k.phase,
        },
      }),
    });
  }

  async *runLiveImpl(ctx: InvocationContext): AsyncGenerator<Event> {
    yield* this.runAsyncImpl(ctx);
  }
}

/**
 * Adaptive fallback: replays learned patterns or uses game-category-specific heuristics.
 *
 * For joystick games: ALWAYS use joystick drags in varied directions.
 * Clicking arrows/indicators doesn't work in joystick games — movement is the primary action.
 * Mix in occasional clicks on interactive areas only after moving there.
 */
function getAdaptiveFallback(
  turnNumber: number
): { name: string; args: Record<string, unknown> } {
  const k = gameState.learned;

  // Joystick games: primarily drag the joystick, occasionally click interactive spots
  if (k.category === 'joystick' || k.joystickCenter) {
    // Every 4th turn, click a known interactive area (if any) — we may have walked to something
    if (turnNumber % 4 === 3 && k.interactiveAreas.length > 0) {
      const area = k.interactiveAreas[turnNumber % k.interactiveAreas.length];
      return {
        name: 'click',
        args: {
          x: clamp(area.x + (Math.random() - 0.5) * 0.08),
          y: clamp(area.y + (Math.random() - 0.5) * 0.08),
          reason: 'Joystick game: tap nearby object after moving',
        },
      };
    }
    return joystickFallback(turnNumber);
  }

  // Non-joystick games: replay learned actions if available
  if (k.successfulActions.length > 0) {
    const base = k.successfulActions[turnNumber % k.successfulActions.length];
    return replayWithVariation(base);
  }

  // Category-specific exploration
  switch (k.category) {
    case 'tap': return tapFallback(turnNumber);
    case 'drag': return dragFallback(turnNumber);
    case 'puzzle': return puzzleFallback(turnNumber);
    default: return explorationFallback(turnNumber);
  }
}

function replayWithVariation(
  base: { name: string; args: Record<string, unknown> }
): { name: string; args: Record<string, unknown> } {
  const jitter = () => (Math.random() - 0.5) * 0.06;
  const args = { ...base.args };

  // Only jitter coordinates that exist for this action type
  if (base.name === 'click' || base.name === 'tap_hold') {
    if (typeof args.x === 'number') args.x = clamp(args.x + jitter());
    if (typeof args.y === 'number') args.y = clamp(args.y + jitter());
  } else if (base.name === 'drag') {
    if (typeof args.startX === 'number') args.startX = clamp(args.startX + jitter());
    if (typeof args.startY === 'number') args.startY = clamp(args.startY + jitter());
    if (typeof args.endX === 'number') args.endX = clamp(args.endX + jitter());
    if (typeof args.endY === 'number') args.endY = clamp(args.endY + jitter());
  }

  args.reason = `Replay: ${(base.args.reason as string)?.slice(0, 60) || base.name} (varied)`;
  return { name: base.name, args };
}

// 8 cardinal + diagonal directions, cycled systematically so the character
// explores the entire map instead of getting stuck moving in one direction.
const JOYSTICK_DIRECTIONS = [
  { dx:  0.10, dy:  0.00, name: 'right' },
  { dx:  0.07, dy:  0.07, name: 'down-right' },
  { dx:  0.00, dy:  0.10, name: 'down' },
  { dx: -0.07, dy:  0.07, name: 'down-left' },
  { dx: -0.10, dy:  0.00, name: 'left' },
  { dx: -0.07, dy: -0.07, name: 'up-left' },
  { dx:  0.00, dy: -0.10, name: 'up' },
  { dx:  0.07, dy: -0.07, name: 'up-right' },
];

function joystickFallback(turnNumber: number): { name: string; args: Record<string, unknown> } {
  const k = gameState.learned;

  // Use discovered joystick position, then learned drag average, then default
  let jx = 0.5, jy = 0.75;

  if (k.joystickCenter) {
    jx = k.joystickCenter.x;
    jy = k.joystickCenter.y;
  } else {
    const dragActions = k.successfulActions.filter((a) => a.name === 'drag');
    if (dragActions.length > 0) {
      jx = dragActions.reduce((s, a) => s + (a.args.startX as number), 0) / dragActions.length;
      jy = dragActions.reduce((s, a) => s + (a.args.startY as number), 0) / dragActions.length;
    }
  }

  // Cycle through 8 directions, hold each direction for 2 turns before rotating.
  // This gives the character time to actually travel in one direction before switching.
  const dirIndex = Math.floor(turnNumber / 2) % JOYSTICK_DIRECTIONS.length;
  const dir = JOYSTICK_DIRECTIONS[dirIndex];
  // Add slight jitter so we don't repeat exact pixel coords
  const jitter = (Math.random() - 0.5) * 0.02;

  return {
    name: 'drag',
    args: {
      startX: jx, startY: jy,
      endX: clamp(jx + dir.dx + jitter),
      endY: clamp(jy + dir.dy + jitter),
      reason: `Joystick: move ${dir.name}`,
    },
  };
}

function tapFallback(turnNumber: number): { name: string; args: Record<string, unknown> } {
  const k = gameState.learned;
  if (k.interactiveAreas.length > 0) {
    const sorted = [...k.interactiveAreas].sort((a, b) => b.count - a.count);
    const area = sorted[turnNumber % sorted.length];
    return {
      name: 'click',
      args: {
        x: clamp(area.x + (Math.random() - 0.5) * 0.1),
        y: clamp(area.y + (Math.random() - 0.5) * 0.1),
        reason: `Adaptive: tap known area`,
      },
    };
  }
  return explorationFallback(turnNumber);
}

function dragFallback(turnNumber: number): { name: string; args: Record<string, unknown> } {
  const sx = 0.2 + Math.random() * 0.6;
  const sy = 0.2 + Math.random() * 0.4;
  const dirs = [{ dx: 0.2, dy: 0 }, { dx: -0.2, dy: 0 }, { dx: 0, dy: -0.2 }, { dx: 0, dy: 0.2 }];
  const d = dirs[turnNumber % dirs.length];
  return {
    name: 'drag',
    args: { startX: sx, startY: sy, endX: clamp(sx + d.dx), endY: clamp(sy + d.dy), reason: 'Adaptive: swipe' },
  };
}

function puzzleFallback(turnNumber: number): { name: string; args: Record<string, unknown> } {
  const col = turnNumber % 4;
  const row = Math.floor(turnNumber / 4) % 4;
  return {
    name: 'click',
    args: { x: 0.15 + (col / 3) * 0.7, y: 0.15 + (row / 3) * 0.5, reason: `Adaptive: grid [${col},${row}]` },
  };
}

/**
 * Exploration fallback for unknown games.
 * Primarily tests drag actions from common joystick positions — works for
 * joystick games, swipe games, and drag games without any API guidance.
 * Clicks are mixed in every 5th turn to test tap-based games.
 */
function explorationFallback(turnNumber: number): { name: string; args: Record<string, unknown> } {
  // Common joystick/control positions to probe
  const probePositions = [
    { x: 0.75, y: 0.75, label: 'bottom-right' },  // Many games put joystick here
    { x: 0.20, y: 0.80, label: 'bottom-left' },    // Classic joystick position
    { x: 0.50, y: 0.50, label: 'center' },          // Swipe-from-center games
  ];

  // Every 5th turn, try a click on the game center area
  if (turnNumber % 5 === 4) {
    return {
      name: 'click',
      args: {
        x: 0.3 + Math.random() * 0.4,
        y: 0.3 + Math.random() * 0.3,
        reason: 'Explore: tap game area',
      },
    };
  }

  // Cycle through probe positions, trying different directions from each
  const posIdx = Math.floor(turnNumber / 4) % probePositions.length;
  const pos = probePositions[posIdx];
  const dirIdx = turnNumber % 4;
  const dirs = [
    { dx:  0.10, dy:  0.00, name: 'right' },
    { dx:  0.00, dy:  0.10, name: 'down' },
    { dx: -0.10, dy:  0.00, name: 'left' },
    { dx:  0.00, dy: -0.10, name: 'up' },
  ];
  const dir = dirs[dirIdx];

  return {
    name: 'drag',
    args: {
      startX: pos.x,
      startY: pos.y,
      endX: clamp(pos.x + dir.dx),
      endY: clamp(pos.y + dir.dy),
      reason: `Explore: drag ${dir.name} from ${pos.label}`,
    },
  };
}

function clamp(v: number): number { return Math.max(0.05, Math.min(0.95, v)); }

function directionName(angle: number): string {
  const dirs = ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'];
  return dirs[Math.round(((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI / 4)) % 8];
}
