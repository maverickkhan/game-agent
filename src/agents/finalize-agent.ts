import { BaseAgent, createEvent, createEventActions } from '@google/adk';
import type { InvocationContext, Event } from '@google/adk';
import { takeScreenshot } from '../actions.js';
import { gameState, getElapsedMs } from '../lib/game-state.js';
import { saveScreenshot, saveSummary, closeLogger } from '../lib/logger.js';

export class FinalizeAgent extends BaseAgent {
  constructor() {
    super({
      name: 'FinalizeAgent',
      description: 'Captures final game state and saves artifacts.',
    });
  }

  async *runAsyncImpl(ctx: InvocationContext): AsyncGenerator<Event> {
    console.log(`\n[FinalizeAgent] Game session complete.`);

    // Final screenshot
    try {
      const screenshot = await takeScreenshot('final');
      saveScreenshot(screenshot, 'final');
    } catch {
      console.log(`[FinalizeAgent] Could not capture final screenshot.`);
    }

    // Save summary
    const summaryPath = saveSummary();
    closeLogger();

    const elapsed = getElapsedMs();
    const totalActions = gameState.actions.length;
    const successActions = gameState.actions.filter((a) => a.result === 'ok').length;
    const errorActions = totalActions - successActions;

    console.log(`\n--- Game Session Summary ---`);
    console.log(`  Run ID:        ${gameState.runId}`);
    console.log(`  Game URL:      ${gameState.url}`);
    console.log(`  Game Type:     ${gameState.gameType}`);
    console.log(`  Duration:      ${Math.round(elapsed / 1000)}s`);
    console.log(`  Total Actions: ${totalActions} (${successActions} ok, ${errorActions} errors)`);
    console.log(`  Screenshots:   ${gameState.screenshots.length}`);
    console.log(`  Artifacts:     ${gameState.artifactDir}/`);
    console.log(`  Summary:       ${summaryPath}`);
    console.log(`----------------------------\n`);

    yield createEvent({
      author: this.name,
      actions: createEventActions({
        stateDelta: {
          session_complete: true,
          total_actions: totalActions,
          actual_duration_ms: elapsed,
        },
      }),
    });
  }

  async *runLiveImpl(ctx: InvocationContext): AsyncGenerator<Event> {
    yield* this.runAsyncImpl(ctx);
  }
}
