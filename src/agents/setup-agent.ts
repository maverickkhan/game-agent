import { BaseAgent, createEvent, createEventActions } from '@google/adk';
import type { InvocationContext, Event } from '@google/adk';
import { getPage } from '../browser.js';
import { takeScreenshot, executeAction } from '../actions.js';
import {
  askGeminiForAction,
  askGeminiForObservation,
  isApiBudgetExhausted,
  SETUP_INSTRUCTION,
  ACTION_DECLARATIONS,
  SETUP_EXTRA_DECLARATIONS,
} from '../gemini.js';
import { gameState } from '../lib/game-state.js';
import { saveScreenshot } from '../lib/logger.js';

const MAX_SETUP_API_CALLS = 3;

/** Extract control info from any Gemini response that has controlType/controlCenter/joystick fields */
function applyControlInfo(args: Record<string, unknown>): void {
  // Try controlCenterX/Y (from done_setup) or joystickX/Y (from game_analysis)
  const cx = (args.controlCenterX as number) ?? (args.joystickX as number);
  const cy = (args.controlCenterY as number) ?? (args.joystickY as number);
  if (typeof cx === 'number' && typeof cy === 'number' && cx >= 0 && cy >= 0) {
    gameState.learned.joystickCenter = { x: cx, y: cy };
    console.log(`[SetupAgent] Control center discovered at (${cx.toFixed(2)}, ${cy.toFixed(2)})`);
  }

  const controlType = args.controlType as string;
  if (controlType) {
    gameState.learned.controlScheme = controlType;
    // Set category from control type
    if (gameState.learned.joystickCenter && controlType.includes('joystick')) {
      gameState.learned.category = 'joystick';
    } else if (controlType.includes('tap')) {
      gameState.learned.category = 'tap';
    } else if (controlType.includes('swipe') || controlType.includes('drag')) {
      gameState.learned.category = 'drag';
    }
    console.log(`[SetupAgent] Control scheme: ${controlType} → category: ${gameState.learned.category}`);
  }
}

export class SetupAgent extends BaseAgent {
  constructor() {
    super({
      name: 'SetupAgent',
      description: 'Opens the game URL, observes the tutorial/loading screens, analyzes the game, then starts playing.',
    });
  }

  async *runAsyncImpl(ctx: InvocationContext): AsyncGenerator<Event> {
    const url = gameState.url;
    const page = getPage();

    // Navigate to game URL
    console.log(`[SetupAgent] Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000); // Let the game bootstrap

    // ── Phase 1: OBSERVE (no clicks — capture tutorial/loading screens) ──
    console.log(`[SetupAgent] Phase 1: Observing game (no clicks)...`);
    const observationScreenshots: string[] = [];

    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(1000);
      const shot = await takeScreenshot(`observe_${i}`);
      saveScreenshot(shot, `observe_${i}`);
      observationScreenshots.push(shot);
      console.log(`[SetupAgent] Captured observation screenshot ${i + 1}/3`);
    }

    // ── Phase 2: ANALYZE (1 API call with all screenshots) ──
    console.log(`[SetupAgent] Phase 2: Analyzing game with ${observationScreenshots.length} screenshots...`);
    let apiCallsUsed = 0;

    if (!isApiBudgetExhausted()) {
      try {
        const analysis = await askGeminiForObservation(observationScreenshots);
        apiCallsUsed++;

        if (analysis?.name === 'game_analysis') {
          const args = analysis.args;
          gameState.gameType = (args.gameType as string) || 'unknown';
          gameState.strategy = (args.strategy as string) || 'Play to win';
          applyControlInfo(args);

          console.log(`[SetupAgent] Game analysis:`);
          console.log(`  Type: ${gameState.gameType}`);
          console.log(`  Strategy: ${gameState.strategy}`);
          console.log(`  First action: ${args.firstAction || 'unknown'}`);
        }
      } catch (err: any) {
        console.log(`[SetupAgent] Observation API error: ${err.message?.slice(0, 80)}. Continuing.`);
      }
    }

    // ── Phase 3: INTERACT (use remaining API calls to dismiss menus/start game) ──
    console.log(`[SetupAgent] Phase 3: Interacting to start game...`);
    const remainingCalls = MAX_SETUP_API_CALLS - apiCallsUsed;
    const allDeclarations = [...ACTION_DECLARATIONS, ...SETUP_EXTRA_DECLARATIONS];

    for (let attempt = 0; attempt < remainingCalls; attempt++) {
      if (isApiBudgetExhausted()) break;

      const screenshot = await takeScreenshot();
      if (attempt === 0) saveScreenshot(screenshot, 'game_start');

      const isLastAttempt = attempt === remainingCalls - 1;
      const contextText = isLastAttempt
        ? `FINAL ATTEMPT. You MUST call done_setup NOW with your best analysis of the game. Describe the game type and strategy based on what you see.`
        : `The game may still be on a menu, tutorial overlay, or loading screen. If the game is running (you can see game elements, characters, items), call done_setup. If there's a menu/overlay/tutorial, click to dismiss it or tap to start. Turn ${attempt + 1}/${remainingCalls}.`;

      try {
        const fc = await askGeminiForAction(screenshot, SETUP_INSTRUCTION, allDeclarations, contextText);

        if (fc?.name === 'done_setup') {
          // Only overwrite game type/strategy if observation didn't already set them
          if (!gameState.gameType || gameState.gameType === 'unknown') {
            gameState.gameType = (fc.args.gameType as string) || 'unknown';
          }
          if (!gameState.strategy) {
            gameState.strategy = (fc.args.strategy as string) || 'Play to win';
          }
          // Extract control info if observation didn't already discover it
          if (!gameState.learned.joystickCenter) {
            applyControlInfo(fc.args);
          }
          console.log(`[SetupAgent] Game ready via done_setup. Type: ${gameState.gameType}`);
          break;
        } else if (fc) {
          const result = await executeAction(fc);
          gameState.actions.push(result);
          console.log(`[SetupAgent] Setup action: ${result.action} — ${result.reason}`);
          await page.waitForTimeout(1000);
        }
      } catch (err: any) {
        console.log(`[SetupAgent] Gemini error: ${err.message?.slice(0, 80)}. Continuing.`);
      }
    }

    // Start the game timer
    gameState.startTime = Date.now();
    if (!gameState.gameType || gameState.gameType === 'unknown') {
      gameState.gameType = 'unknown';
      gameState.strategy = 'Observe the game, follow on-screen instructions, tap interactive elements';
    }

    console.log(`[SetupAgent] Game ready! Type: ${gameState.gameType}`);
    console.log(`[SetupAgent] Strategy: ${gameState.strategy}`);
    if (gameState.learned.joystickCenter) {
      console.log(`[SetupAgent] Joystick at: (${gameState.learned.joystickCenter.x.toFixed(2)}, ${gameState.learned.joystickCenter.y.toFixed(2)})`);
    }

    yield createEvent({
      author: this.name,
      actions: createEventActions({
        stateDelta: {
          game_start_time: gameState.startTime,
          game_type: gameState.gameType,
          game_strategy: gameState.strategy,
        },
      }),
    });
  }

  async *runLiveImpl(ctx: InvocationContext): AsyncGenerator<Event> {
    yield* this.runAsyncImpl(ctx);
  }
}
