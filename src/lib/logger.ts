import fs from 'fs';
import path from 'path';
import { type ActionRecord, gameState } from './game-state.js';

let actionsStream: fs.WriteStream | null = null;

export function initLogger(): void {
  const dir = gameState.artifactDir;
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'screens'), { recursive: true });

  actionsStream = fs.createWriteStream(path.join(dir, 'actions.jsonl'), { flags: 'a' });
}

export function logAction(record: ActionRecord): void {
  if (actionsStream) {
    actionsStream.write(JSON.stringify(record) + '\n');
  }
}

export function saveScreenshot(base64: string, label: string): string {
  const dir = path.join(gameState.artifactDir, 'screens');
  const filename = `${String(gameState.screenshots.length).padStart(4, '0')}_${label}.jpg`;
  const filepath = path.join(dir, filename);

  fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
  gameState.screenshots.push({ timestamp: Date.now(), path: filepath });
  return filepath;
}

export function saveSummary(): string {
  const summary = {
    runId: gameState.runId,
    url: gameState.url,
    gameType: gameState.gameType,
    strategy: gameState.strategy,
    duration: gameState.duration,
    actualDurationMs: gameState.startTime ? Date.now() - gameState.startTime : 0,
    totalActions: gameState.actions.length,
    screenshotCount: gameState.screenshots.length,
    actions: gameState.actions,
  };

  const filepath = path.join(gameState.artifactDir, 'summary.json');
  fs.writeFileSync(filepath, JSON.stringify(summary, null, 2));
  return filepath;
}

export function closeLogger(): void {
  if (actionsStream) {
    actionsStream.end();
    actionsStream = null;
  }
}
