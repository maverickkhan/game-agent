import { BaseAgent, createEvent, createEventActions } from '@google/adk';
import type { InvocationContext, Event } from '@google/adk';
import { takeScreenshot, executeAction, compressForApi } from '../actions.js';
import { askGeminiForPlayAction, isApiBudgetExhausted, isAnyModelAvailable } from '../gemini.js';
import { gameState, getElapsedMs, getRemainingMs, isTimeUp, learnFromApiAction, computeScreenHash, detectScreenChange, type ActionRecord } from '../lib/game-state.js';
import { saveScreenshot } from '../lib/logger.js';
import { getPage } from '../browser.js';

// Minimum time between actions — prevents unrealistic spam
const MIN_ACTION_INTERVAL_MS = 1_500;
let lastActionTime = 0;

// Direction memory: how many fallback turns to hold the last API-directed direction
// 15 turns × ~1.5s each ≈ 22 seconds of sustained movement per API direction
const DIRECTION_STALE_TURNS = 15;

// Screen change tracking — how many consecutive turns with no visible change
let unchangedTurns = 0;

// Sliding window of compressed screenshots for temporal context (last 3 turns)
const MAX_SCREENSHOT_HISTORY = 3;
const screenshotHistory: string[] = [];

// Progress tracking: last known score/observations from model
let lastObservations: string | null = null;


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

    // Compress for API use (512px wide, JPEG q60 — ~85% smaller)
    const compressed = await compressForApi(screenshot);

    // Track screen changes between turns
    const screenHash = computeScreenHash(screenshot);
    const screenChanged = detectScreenChange(screenHash);
    if (screenChanged) {
      unchangedTurns = 0;
    } else if (turnNumber > 0) {
      unchangedTurns++;
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

      // Rich, game-type-specific control guidance
      contextParts.push('');
      if (k.joystickCenter || k.category === 'joystick') {
        const jx = k.joystickCenter?.x.toFixed(2) ?? '~0.75';
        const jy = k.joystickCenter?.y.toFixed(2) ?? '~0.75';
        contextParts.push(`CONTROLS (drag-to-move game):`);
        contextParts.push(`- DRAG from (${jx}, ${jy}) in the direction you want to move.`);
        contextParts.push(`- Arrows on screen = DIRECTION to move, NOT buttons. Do NOT click arrows.`);
        contextParts.push(`- Arrow RIGHT → drag right (increase X). Arrow LEFT → decrease X. Arrow UP → decrease Y.`);
        contextParts.push(`- To REACH a target: DRAG toward it until your character arrives.`);
        contextParts.push(`- To INTERACT with something: WALK INTO it. If that fails, CLICK it only after you are next to it.`);
        contextParts.push(`- If clicking a spot 2+ times has no effect, you need to WALK INTO it instead.`);
      } else if (k.category === 'tap') {
        contextParts.push(`CONTROLS (tap game):`);
        contextParts.push(`- TAP/CLICK on game objects to interact.`);
        contextParts.push(`- Look for highlighted, glowing, or animated elements — those are interactive.`);
        contextParts.push(`- If tapping has no effect, try DRAGGING or SWIPING instead.`);
      } else if (k.category === 'drag') {
        contextParts.push(`CONTROLS (drag/swipe game):`);
        contextParts.push(`- DRAG objects or SWIPE in directions to interact.`);
        contextParts.push(`- If dragging has no effect, try CLICKING on objects instead.`);
      } else if (k.category === 'puzzle') {
        contextParts.push(`CONTROLS (puzzle game):`);
        contextParts.push(`- CLICK or DRAG puzzle pieces/elements to solve.`);
        contextParts.push(`- Look for patterns: matching colors, shapes, or sequences.`);
      } else {
        contextParts.push(`CONTROLS (not yet determined):`);
        contextParts.push(`- Try BOTH clicking objects AND dragging to move.`);
        contextParts.push(`- Observe what causes visible changes and repeat what works.`);
        contextParts.push(`- Arrows on screen usually show DIRECTION to move, not things to click.`);
      }
      contextParts.push(`🚫 NEVER click "Install", "Download", "Get it now", "Play Store", "App Store" — they END the game.`);

      // Explicit last-action feedback — did it work or not?
      const lastAction = gameState.actions.length > 0 ? gameState.actions[gameState.actions.length - 1] : null;
      if (lastAction) {
        const lastCoords = lastAction.action === 'drag'
          ? `from (${(lastAction.args?.startX as number)?.toFixed(2)}, ${(lastAction.args?.startY as number)?.toFixed(2)}) to (${(lastAction.args?.endX as number)?.toFixed(2)}, ${(lastAction.args?.endY as number)?.toFixed(2)})`
          : `at (${(lastAction.args?.x as number)?.toFixed(2)}, ${(lastAction.args?.y as number)?.toFixed(2)})`;
        contextParts.push('');
        if (unchangedTurns > 0) {
          contextParts.push(`LAST ACTION FEEDBACK: ❌ FAILED — "${lastAction.action} ${lastCoords}" had NO visible effect. The screen looks the SAME as before.`);
          contextParts.push('Compare the PREVIOUS and CURRENT screenshots — they should look identical, proving your action did nothing.');
          contextParts.push('You MUST choose a DIFFERENT action or position this turn.');
        } else {
          contextParts.push(`LAST ACTION FEEDBACK: ✅ SUCCESS — "${lastAction.action} ${lastCoords}" caused a visible change on screen.`);
          contextParts.push('Compare the PREVIOUS and CURRENT screenshots to see what changed, and build on this progress.');
        }
      }

      // Include recent action history
      const recentActions = gameState.actions.slice(-8);
      if (recentActions.length > 0) {
        contextParts.push('');
        contextParts.push('RECENT ACTION HISTORY (learn from what worked/failed):');
        for (const a of recentActions) {
          const coords = a.action === 'drag'
            ? `from (${(a.args?.startX as number)?.toFixed(2)}, ${(a.args?.startY as number)?.toFixed(2)}) to (${(a.args?.endX as number)?.toFixed(2)}, ${(a.args?.endY as number)?.toFixed(2)})`
            : `at (${(a.args?.x as number)?.toFixed(2)}, ${(a.args?.y as number)?.toFixed(2)})`;
          contextParts.push(`  ${a.action} ${coords} — "${a.reason}"`);
        }

        // Detect repeated action patterns (same action type + similar coords)
        const stuckAnalysis = detectStuckPattern(recentActions);
        if (stuckAnalysis) {
          contextParts.push('');
          contextParts.push(stuckAnalysis);
        }
      }

      // Screen change feedback — tell the model if its actions are having no effect
      if (unchangedTurns >= 2) {
        contextParts.push('');
        contextParts.push(`🚨 SCREEN HAS NOT CHANGED in ${unchangedTurns} turns! Your actions are having NO VISIBLE EFFECT.`);
        contextParts.push('You are likely BLOCKED by an obstacle (wall, fence, object).');
        contextParts.push('To get around it, move in a PERPENDICULAR direction first:');
        contextParts.push('- If you were moving LEFT/RIGHT, try moving UP or DOWN first, then resume.');
        contextParts.push('- If you were moving UP/DOWN, try moving LEFT or RIGHT first, then resume.');
        contextParts.push('- Try a DIFFERENT action type (click instead of drag, or vice versa)');
      } else if (unchangedTurns >= 1) {
        contextParts.push('');
        contextParts.push(`⚠️ Screen unchanged — you may be blocked by an obstacle. Try moving in a DIFFERENT direction to go around it.`);
      }

      // Feed last known observations for progress tracking
      if (lastObservations) {
        contextParts.push('');
        contextParts.push(`LAST OBSERVED STATE: ${lastObservations}`);
        contextParts.push('Report any changes in numbers, score, money, or progress in the "observations" field.');
      } else {
        contextParts.push('');
        contextParts.push('Report any visible numbers (score, money, level, timer) in the "observations" field so we can track progress.');
      }

      contextParts.push('');
      contextParts.push('IMPORTANT: Look at the screenshot CAREFULLY. What EXACTLY is on screen right now?');
      contextParts.push('- Read ALL text and numbers visible on screen');
      contextParts.push('- If there is a button, icon, or highlighted area you have NOT tried, interact with it');
      contextParts.push('- Do NOT repeat the same action if the screen has not changed');

      const contextText = contextParts.join('\n');

      try {
        fc = await askGeminiForPlayAction(compressed, contextText, screenshotHistory);
        if (fc) {
          source = 'api';
          learnFromApiAction(fc, turnNumber);
          // Track observations for progress
          if (fc.args.observations && typeof fc.args.observations === 'string') {
            const obs = fc.args.observations as string;
            if (obs !== lastObservations) {
              console.log(`[Progress] ${lastObservations ? lastObservations + ' → ' : ''}${obs}`);
              lastObservations = obs;
            }
          }
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

    // Add compressed screenshot to sliding window for temporal context
    screenshotHistory.push(compressed);
    if (screenshotHistory.length > MAX_SCREENSHOT_HISTORY) {
      screenshotHistory.shift();
    }

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

  // Joystick games: primarily drag the joystick, occasionally tap interactive spots
  if (k.category === 'joystick' || k.joystickCenter) {
    if (shouldTapNow(turnNumber) && k.interactiveAreas.length > 0) {
      const target = pickBestTapTarget(turnNumber);
      if (target) {
        target.lastTappedTurn = turnNumber;
        return {
          name: 'click',
          args: {
            x: clamp(target.x + (Math.random() - 0.5) * 0.08),
            y: clamp(target.y + (Math.random() - 0.5) * 0.08),
            reason: `Joystick game: tap target (last tapped turn ${target.lastTappedTurn === turnNumber ? 'now' : target.lastTappedTurn})`,
          },
        };
      }
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

  const jitter = (Math.random() - 0.5) * 0.02;

  // Direction memory: continue API-directed movement when fresh
  if (k.lastApiDirection) {
    const turnsSinceSet = turnNumber - k.lastApiDirection.setAtTurn;
    if (turnsSinceSet < DIRECTION_STALE_TURNS) {
      // Fresh: continue in the API-directed direction
      const hold = turnsSinceSet + 1;
      const dirName = vectorToDirectionName(k.lastApiDirection.dx, k.lastApiDirection.dy);
      return {
        name: 'drag',
        args: {
          startX: jx, startY: jy,
          endX: clamp(jx + k.lastApiDirection.dx + jitter),
          endY: clamp(jy + k.lastApiDirection.dy + jitter),
          reason: `Joystick: move ${dirName} (API-directed, hold ${hold}/${DIRECTION_STALE_TURNS})`,
        },
      };
    }
  }

  // No fresh API direction: cycle through 8 directions, 2 turns each
  const dirIndex = Math.floor(turnNumber / 2) % JOYSTICK_DIRECTIONS.length;
  const dir = JOYSTICK_DIRECTIONS[dirIndex];

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
    const target = pickBestTapTarget(turnNumber);
    if (target) {
      target.lastTappedTurn = turnNumber;
      return {
        name: 'click',
        args: {
          x: clamp(target.x + (Math.random() - 0.5) * 0.1),
          y: clamp(target.y + (Math.random() - 0.5) * 0.1),
          reason: `Adaptive: tap target (priority-based)`,
        },
      };
    }
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

/** Detect if the agent is stuck repeating similar actions */
function detectStuckPattern(actions: ActionRecord[]): string | null {
  if (actions.length < 4) return null;

  // Count action types
  const clickCount = actions.filter(a => a.action === 'click').length;
  const dragCount = actions.filter(a => a.action === 'drag').length;

  // Check for repeated clicks near same spot
  const clicks = actions.filter(a => a.action === 'click');
  if (clicks.length >= 2) {
    const clusters: { x: number; y: number; count: number }[] = [];
    for (const c of clicks) {
      const cx = c.args?.x as number;
      const cy = c.args?.y as number;
      const existing = clusters.find(cl => Math.abs(cl.x - cx) < 0.15 && Math.abs(cl.y - cy) < 0.15);
      if (existing) {
        existing.count++;
      } else {
        clusters.push({ x: cx, y: cy, count: 1 });
      }
    }
    const bigCluster = clusters.find(c => c.count >= 2);
    if (bigCluster) {
      return `🚨 STUCK: You clicked near (${bigCluster.x.toFixed(2)}, ${bigCluster.y.toFixed(2)}) ${bigCluster.count} times with no effect.\n` +
        `You MUST try something COMPLETELY DIFFERENT:\n` +
        `- Try DRAGGING to move your character to a new position first\n` +
        `- Try a DIFFERENT part of the screen entirely\n` +
        `- Look for NEW interactive elements you haven't tried`;
    }
  }

  // Check for repeated drags in the same direction (wall/obstacle detection)
  const drags = actions.filter(a => a.action === 'drag');
  if (drags.length >= 2) {
    // Check last 2+ drags for same direction
    const lastDrags = drags.slice(-3);
    const directions = lastDrags.map(d => {
      const dx = (d.args?.endX as number) - (d.args?.startX as number);
      const dy = (d.args?.endY as number) - (d.args?.startY as number);
      const angle = Math.atan2(dy, dx);
      return Math.round(angle / (Math.PI / 4)); // Quantize to 8 directions
    });
    // If last 2+ drags are in the same direction
    if (directions.length >= 2 && directions.slice(-2).every(d => d === directions[directions.length - 1])) {
      const dirNames = ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'];
      const dirIdx = ((directions[directions.length - 1] % 8) + 8) % 8;
      const perpDirs = dirIdx % 2 === 0
        ? [dirNames[(dirIdx + 2) % 8], dirNames[(dirIdx + 6) % 8]]
        : [dirNames[(dirIdx + 2) % 8], dirNames[(dirIdx + 6) % 8]];
      return `⚠️ BLOCKED: You dragged ${dirNames[dirIdx]} ${directions.length} times but the screen didn't change.\n` +
        `You are likely hitting a wall or obstacle. To get AROUND it:\n` +
        `- Try moving ${perpDirs[0]} or ${perpDirs[1]} first, THEN resume toward your target.`;
    }

    // Also check for drags from same start position
    const startClusters: { x: number; y: number; count: number }[] = [];
    for (const d of drags) {
      const sx = d.args?.startX as number;
      const sy = d.args?.startY as number;
      const existing = startClusters.find(c => Math.abs(c.x - sx) < 0.15 && Math.abs(c.y - sy) < 0.15);
      if (existing) {
        existing.count++;
      } else {
        startClusters.push({ x: sx, y: sy, count: 1 });
      }
    }
    const bigCluster = startClusters.find(c => c.count >= 3);
    if (bigCluster) {
      return `🚨 STUCK: ${bigCluster.count} drags all starting from (~${bigCluster.x.toFixed(2)}, ~${bigCluster.y.toFixed(2)}) with no progress.\n` +
        `Your drag starting position is not working. Try something different:\n` +
        `- Drag from a DIFFERENT area of the screen\n` +
        `- Try CLICKING on objects/buttons instead of dragging\n` +
        `- Look at the screenshot — what interactive elements do you see?`;
    }
  }

  // Check if mixing clicks and drags without progress (oscillating)
  if (clickCount >= 2 && dragCount >= 2 && actions.length >= 6) {
    const pattern = actions.map(a => a.action === 'click' ? 'C' : 'D').join('');
    if (pattern.includes('CDCD') || pattern.includes('DCDC')) {
      return `⚠️ WARNING: You are alternating between click and drag without making progress.\n` +
        `STOP and OBSERVE the screenshot carefully. What has ACTUALLY changed on screen?\n` +
        `If nothing changed, you need a completely new approach.`;
    }
  }

  return null;
}

/** Convert a direction vector to a human-readable name */
function vectorToDirectionName(dx: number, dy: number): string {
  const angle = Math.atan2(dy, dx); // radians, 0=right, PI/2=down
  const dirs = ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'];
  const idx = Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return dirs[idx];
}

/** Pick the best tap target: prioritize untapped, then least recently tapped */
function pickBestTapTarget(turnNumber: number): { x: number; y: number; count: number; lastTappedTurn: number } | null {
  const k = gameState.learned;
  if (k.interactiveAreas.length === 0) return null;

  // Filter out areas tapped within last 2 turns (avoid spam)
  const candidates = k.interactiveAreas.filter(a => turnNumber - a.lastTappedTurn >= 2 || a.lastTappedTurn === -1);

  // If all were tapped recently, use the full list but deprioritize
  const pool = candidates.length > 0 ? candidates : k.interactiveAreas;

  // Sort: never-tapped first (lastTappedTurn === -1), then least recently tapped
  const sorted = [...pool].sort((a, b) => {
    if (a.lastTappedTurn === -1 && b.lastTappedTurn !== -1) return -1;
    if (b.lastTappedTurn === -1 && a.lastTappedTurn !== -1) return 1;
    return a.lastTappedTurn - b.lastTappedTurn;
  });

  return sorted[0];
}

/** Decide whether this fallback turn should be a tap (vs movement) */
function shouldTapNow(turnNumber: number): boolean {
  const k = gameState.learned;
  if (k.interactiveAreas.length === 0) return false;

  // If all areas have been tapped: less frequent (every 8th turn)
  const untapped = k.interactiveAreas.filter(a => a.lastTappedTurn === -1);
  if (untapped.length === 0) return turnNumber % 8 === 7;

  // Normal: tap every 5th turn
  return turnNumber % 5 === 4;
}
