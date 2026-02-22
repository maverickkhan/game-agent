import { SequentialAgent, LoopAgent } from '@google/adk';
import { SetupAgent } from './setup-agent.js';
import { PlayTurnAgent } from './play-turn-agent.js';
import { FinalizeAgent } from './finalize-agent.js';

export function createGameRunner(): SequentialAgent {
  const setupAgent = new SetupAgent();

  const playTurnAgent = new PlayTurnAgent();

  const gameplayLoop = new LoopAgent({
    name: 'GameplayLoop',
    subAgents: [playTurnAgent],
    maxIterations: 80, // Flash-Lite has 1,000 RPD — time-based exit via escalation
  });

  const finalizeAgent = new FinalizeAgent();

  return new SequentialAgent({
    name: 'GameRunner',
    description: 'Orchestrates game setup, gameplay loop, and finalization.',
    subAgents: [setupAgent, gameplayLoop, finalizeAgent],
  });
}
