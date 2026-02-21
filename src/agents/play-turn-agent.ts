import { BaseAgent, createEvent, createEventActions } from '@google/adk';
import type { InvocationContext, Event } from '@google/adk';
import { takeScreenshot, executeAction } from '../actions.js';
import { askGeminiForAction, isApiBudgetExhausted, PLAY_INSTRUCTION, ACTION_DECLARATIONS } from '../gemini.js';
import { gameState, getElapsedMs, getRemainingMs, isTimeUp } from '../lib/game-state.js';
import { saveScreenshot } from '../lib/logger.js';

export class PlayTurnAgent extends BaseAgent {
  constructor() {
    super({
      name: 'PlayTurnAgent',
      description: 'Executes a single turn of gameplay: screenshot, reason, act.',
    });
  }

  async *runAsyncImpl(ctx: InvocationContext): AsyncGenerator<Event> {
    // Check if time is up or API budget exhausted
    if (isTimeUp()) {
      console.log(`[PlayTurnAgent] Time is up! Elapsed: ${getElapsedMs()}ms`);
      yield createEvent({
        author: this.name,
        actions: createEventActions({ escalate: true }),
      });
      return;
    }

    if (isApiBudgetExhausted()) {
      console.log(`[PlayTurnAgent] API budget exhausted. Stopping gameplay.`);
      yield createEvent({
        author: this.name,
        actions: createEventActions({ escalate: true }),
      });
      return;
    }

    const turnNumber = gameState.actions.length;
    const remaining = getRemainingMs();
    const elapsed = getElapsedMs();

    // Take screenshot
    const screenshot = await takeScreenshot();

    // Save sampled screenshots (every 10th action + milestones)
    if (turnNumber % 10 === 0) {
      saveScreenshot(screenshot, `play_${turnNumber}`);
    }

    // Build context for the model
    const recentActions = gameState.actions
      .slice(-5)
      .map((a) => `${a.action}(${JSON.stringify(a.args)}): ${a.reason}`)
      .join('\n');

    const contextText = [
      `Game type: ${gameState.gameType}`,
      `Strategy: ${gameState.strategy}`,
      `Time remaining: ${Math.round(remaining / 1000)}s (elapsed: ${Math.round(elapsed / 1000)}s)`,
      `Turn: ${turnNumber}`,
      recentActions ? `Recent actions:\n${recentActions}` : 'No previous actions yet.',
      'Look at the screenshot and choose your next action.',
    ].join('\n');

    // Ask Gemini for next action
    let fc: { name: string; args: Record<string, unknown> } | null = null;
    try {
      fc = await askGeminiForAction(screenshot, PLAY_INSTRUCTION, ACTION_DECLARATIONS, contextText);
    } catch (err: any) {
      console.log(`[PlayTurnAgent] Gemini error: ${err.message}. Using fallback.`);
      fc = getFallbackAction(turnNumber);
    }

    if (!fc) {
      console.log(`[PlayTurnAgent] No action returned. Using fallback.`);
      fc = getFallbackAction(turnNumber);
    }

    // Detect repeated actions
    if (isRepeatedAction(fc)) {
      console.log(`[PlayTurnAgent] Repeated action detected. Varying.`);
      fc = getVariedAction(turnNumber);
    }

    // Execute the action
    const result = await executeAction(fc);
    gameState.actions.push(result);
    console.log(
      `[PlayTurnAgent] Turn ${turnNumber} (${Math.round(elapsed / 1000)}s): ${result.action} — ${result.reason} [${result.result}]`
    );

    // Yield event for ADK
    yield createEvent({
      author: this.name,
      actions: createEventActions({
        stateDelta: {
          last_action: `${result.action}: ${result.reason}`,
          turn_count: turnNumber + 1,
        },
      }),
    });
  }

  async *runLiveImpl(ctx: InvocationContext): AsyncGenerator<Event> {
    yield* this.runAsyncImpl(ctx);
  }
}

function isRepeatedAction(fc: { name: string; args: Record<string, unknown> }): boolean {
  const recent = gameState.actions.slice(-3);
  if (recent.length < 3) return false;

  return recent.every(
    (a) =>
      a.action === fc.name &&
      a.args &&
      Math.abs((a.args.x as number) - (fc.args.x as number)) < 0.05 &&
      Math.abs((a.args.y as number) - (fc.args.y as number)) < 0.05
  );
}

function getFallbackAction(
  turnNumber: number
): { name: string; args: Record<string, unknown> } {
  // Cycle through different strategies
  const strategies = [
    { name: 'click', args: { x: 0.5, y: 0.5, reason: 'Fallback: click center' } },
    { name: 'click', args: { x: 0.5, y: 0.7, reason: 'Fallback: click bottom center' } },
    { name: 'drag', args: { startX: 0.3, startY: 0.5, endX: 0.7, endY: 0.5, reason: 'Fallback: swipe right' } },
    { name: 'drag', args: { startX: 0.5, startY: 0.7, endX: 0.5, endY: 0.3, reason: 'Fallback: swipe up' } },
  ];
  return strategies[turnNumber % strategies.length];
}

function getVariedAction(
  turnNumber: number
): { name: string; args: Record<string, unknown> } {
  // Try a different area/gesture
  const x = 0.2 + Math.random() * 0.6; // 0.2 to 0.8
  const y = 0.2 + Math.random() * 0.6;
  const actions = [
    { name: 'click', args: { x, y, reason: 'Varying: try different position' } },
    {
      name: 'drag',
      args: {
        startX: x,
        startY: y,
        endX: clampCoord(x + (Math.random() - 0.5) * 0.4),
        endY: clampCoord(y + (Math.random() - 0.5) * 0.4),
        reason: 'Varying: try drag gesture',
      },
    },
  ];
  return actions[turnNumber % actions.length];
}

function clampCoord(v: number): number {
  return Math.max(0, Math.min(1, v));
}
