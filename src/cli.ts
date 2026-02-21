import 'dotenv/config';
import { InMemoryRunner, stringifyContent } from '@google/adk';
import { createUserContent } from '@google/genai';
import { createGameRunner } from './agents/game-runner.js';
import { launchBrowser, closeBrowser } from './browser.js';
import { resetGameState } from './lib/game-state.js';
import { initLogger } from './lib/logger.js';

interface CliArgs {
  url: string;
  duration: number;
  headless: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let url = '';
  let duration = 120;
  let headless = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--url' && args[i + 1]) {
      url = args[++i];
    } else if (arg === '--duration' && args[i + 1]) {
      duration = parseInt(args[++i], 10);
    } else if (arg === '--headless') {
      headless = true;
    } else if (arg === '--headed') {
      headless = false;
    } else if (!arg.startsWith('--') && !url) {
      url = arg;
    }
  }

  if (!url) {
    console.error('Usage: npm run play -- --url <game_url> [--duration 120] [--headless]');
    process.exit(1);
  }

  return { url, duration, headless };
}

async function main(): Promise<void> {
  const { url, duration, headless } = parseArgs();
  const runId = `run_${Date.now()}`;

  console.log(`\n=== Game Agent ===`);
  console.log(`  URL:      ${url}`);
  console.log(`  Duration: ${duration}s`);
  console.log(`  Mode:     ${headless ? 'headless' : 'headed'}`);
  console.log(`  Run ID:   ${runId}`);
  console.log(`==================\n`);

  // Initialize state and logger
  resetGameState(url, duration * 1000, runId);
  initLogger();

  // Launch browser
  await launchBrowser({ headless });

  // Create ADK runner
  const rootAgent = createGameRunner();
  const runner = new InMemoryRunner({ agent: rootAgent, appName: 'game-agent' });

  const session = await runner.sessionService.createSession({
    appName: runner.appName,
    userId: 'player',
    state: {
      game_url: url,
      duration_ms: duration * 1000,
    },
  });

  try {
    // Run the agent
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: createUserContent(`Play the game at ${url} for ${duration} seconds.`),
    })) {
      // Events are processed by the runner; agents log their own output.
      // We only log final/important events here.
      if (event?.content?.parts?.length) {
        const text = stringifyContent(event);
        if (text) {
          console.log(`[Event] ${event.author}: ${text}`);
        }
      }
    }
  } catch (err: any) {
    console.error(`\n[Fatal] Agent error: ${err.message}`);
    console.error(err.stack);
  } finally {
    await closeBrowser();
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
