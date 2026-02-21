import { BaseAgent, createEvent, createEventActions } from '@google/adk';
import type { InvocationContext, Event } from '@google/adk';
import { getPage } from '../browser.js';
import { takeScreenshot, executeAction } from '../actions.js';
import {
  askGeminiForAction,
  isApiBudgetExhausted,
  SETUP_INSTRUCTION,
  ACTION_DECLARATIONS,
  SETUP_EXTRA_DECLARATIONS,
} from '../gemini.js';
import { gameState } from '../lib/game-state.js';
import { saveScreenshot } from '../lib/logger.js';

const MAX_SETUP_TURNS = 8; // Reduced to conserve API budget

export class SetupAgent extends BaseAgent {
  constructor() {
    super({
      name: 'SetupAgent',
      description: 'Opens the game URL and navigates through menus/overlays until the game is playable.',
    });
  }

  async *runAsyncImpl(ctx: InvocationContext): AsyncGenerator<Event> {
    const url = gameState.url;
    const page = getPage();

    // Navigate to game URL
    console.log(`[SetupAgent] Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000); // Let the game bootstrap (al_renderHtml)

    const allDeclarations = [...ACTION_DECLARATIONS, ...SETUP_EXTRA_DECLARATIONS];

    for (let turn = 0; turn < MAX_SETUP_TURNS; turn++) {
      if (isApiBudgetExhausted()) {
        console.log(`[SetupAgent] API budget exhausted. Starting game as-is.`);
        break;
      }

      const screenshot = await takeScreenshot(turn === 0 ? 'setup_initial' : undefined);

      // Save a setup screenshot every 5 turns
      if (turn > 0 && turn % 5 === 0) {
        saveScreenshot(screenshot, `setup_${turn}`);
      }

      const contextText = `Turn ${turn + 1}/${MAX_SETUP_TURNS}. The game URL has been loaded. Look at the screenshot and decide what to do to get the game started.`;

      let fc: { name: string; args: Record<string, unknown> } | null = null;
      try {
        fc = await askGeminiForAction(screenshot, SETUP_INSTRUCTION, allDeclarations, contextText);
      } catch (err: any) {
        console.log(`[SetupAgent] Gemini error: ${err.message}. Clicking center as fallback.`);
        fc = { name: 'click', args: { x: 0.5, y: 0.5, reason: 'Fallback: click center' } };
      }

      if (!fc) {
        console.log(`[SetupAgent] No action returned. Clicking center.`);
        fc = { name: 'click', args: { x: 0.5, y: 0.5, reason: 'No action from model' } };
      }

      // Check if setup is done
      if (fc.name === 'done_setup') {
        gameState.gameType = (fc.args.gameType as string) || 'unknown';
        gameState.strategy = (fc.args.strategy as string) || 'Play to win';
        gameState.startTime = Date.now();

        const finalScreenshot = await takeScreenshot('setup_done');
        saveScreenshot(finalScreenshot, 'game_start');

        console.log(`[SetupAgent] Game ready! Type: ${gameState.gameType}`);
        console.log(`[SetupAgent] Strategy: ${gameState.strategy}`);

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
        return;
      }

      // Execute the action
      const result = await executeAction(fc);
      gameState.actions.push(result);
      console.log(`[SetupAgent] Turn ${turn + 1}: ${result.action} — ${result.reason}`);

      // Wait after action for the game to respond
      await page.waitForTimeout(1500);
    }

    // If we exhausted setup turns, start anyway
    console.log(`[SetupAgent] Max setup turns reached. Starting game anyway.`);
    gameState.startTime = Date.now();
    gameState.gameType = 'unknown';
    gameState.strategy = 'Try clicking and dragging on game elements';

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
