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
    maxIterations: 25, // Conservative: stays within API budget
  });

  const finalizeAgent = new FinalizeAgent();

  return new SequentialAgent({
    name: 'GameRunner',
    description: 'Orchestrates game setup, gameplay loop, and finalization.',
    subAgents: [setupAgent, gameplayLoop, finalizeAgent],
  });
}
