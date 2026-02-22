import sharp from 'sharp';
import { getPage, getViewport } from './browser.js';
import { denormalize, clamp } from './lib/coords.js';
import { type ActionRecord, gameState } from './lib/game-state.js';
import { logAction, saveScreenshot } from './lib/logger.js';

export async function takeScreenshot(label?: string): Promise<string> {
  const page = getPage();
  const buffer = await page.screenshot({ type: 'jpeg', quality: 80 });
  const base64 = buffer.toString('base64');

  if (label) {
    saveScreenshot(base64, label);
  }

  return base64;
}

/**
 * Compress a screenshot for API calls: resize to maxWidth and lower JPEG quality.
 * Reduces base64 size by ~85% (1024px q80 → 512px q60) for faster uploads.
 */
export async function compressForApi(base64Jpeg: string, maxWidth = 512): Promise<string> {
  const inputBuffer = Buffer.from(base64Jpeg, 'base64');
  const outputBuffer = await sharp(inputBuffer)
    .resize(maxWidth, null, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 60 })
    .toBuffer();
  return outputBuffer.toString('base64');
}

export async function executeAction(
  fc: { name: string; args: Record<string, unknown> }
): Promise<ActionRecord> {
  const { name, args } = fc;
  const reason = (args.reason as string) || '';
  const timestamp = Date.now();

  try {
    switch (name) {
      case 'click': {
        const nx = clamp(args.x as number, 0, 1);
        const ny = clamp(args.y as number, 0, 1);
        await clickAt(nx, ny);
        const record: ActionRecord = {
          action: 'click',
          args: { x: nx, y: ny },
          reason,
          timestamp,
          result: 'ok',
          source: 'fallback',
        };
        logAction(record);
        return record;
      }

      case 'drag': {
        const sx = clamp(args.startX as number, 0, 1);
        const sy = clamp(args.startY as number, 0, 1);
        const ex = clamp(args.endX as number, 0, 1);
        const ey = clamp(args.endY as number, 0, 1);
        await dragFromTo(sx, sy, ex, ey);
        const record: ActionRecord = {
          action: 'drag',
          args: { startX: sx, startY: sy, endX: ex, endY: ey },
          reason,
          timestamp,
          result: 'ok',
          source: 'fallback',
        };
        logAction(record);
        return record;
      }

      case 'tap_hold': {
        const nx = clamp(args.x as number, 0, 1);
        const ny = clamp(args.y as number, 0, 1);
        const dur = clamp(args.durationMs as number, 100, 3000);
        await tapHold(nx, ny, dur);
        const record: ActionRecord = {
          action: 'tap_hold',
          args: { x: nx, y: ny, durationMs: dur },
          reason,
          timestamp,
          result: 'ok',
          source: 'fallback',
        };
        logAction(record);
        return record;
      }

      case 'wait': {
        const ms = clamp(args.ms as number, 100, 5000);
        await waitMs(ms);
        const record: ActionRecord = {
          action: 'wait',
          args: { ms },
          reason,
          timestamp,
          result: 'ok',
          source: 'fallback',
        };
        logAction(record);
        return record;
      }

      case 'done_setup': {
        const record: ActionRecord = {
          action: 'done_setup',
          args: {
            gameType: args.gameType as string,
            strategy: args.strategy as string,
          },
          reason: 'Game setup complete',
          timestamp,
          result: 'ok',
          source: 'fallback',
        };
        logAction(record);
        return record;
      }

      default: {
        const record: ActionRecord = {
          action: name,
          args,
          reason,
          timestamp,
          result: `error: unknown action "${name}"`,
          source: 'fallback',
        };
        logAction(record);
        return record;
      }
    }
  } catch (err: any) {
    const record: ActionRecord = {
      action: name,
      args,
      reason,
      timestamp,
      result: `error: ${err.message}`,
      source: 'fallback',
    };
    logAction(record);
    return record;
  }
}

async function clickAt(nx: number, ny: number): Promise<void> {
  const page = getPage();
  const { width, height } = getViewport();
  const { x, y } = denormalize(nx, ny, width, height);
  await page.mouse.click(x, y);
}

async function dragFromTo(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  durationMs = 500
): Promise<void> {
  const page = getPage();
  const { width, height } = getViewport();
  const start = denormalize(sx, sy, width, height);
  const end = denormalize(ex, ey, width, height);

  const steps = Math.max(5, Math.round(durationMs / 50));

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cx = start.x + (end.x - start.x) * t;
    const cy = start.y + (end.y - start.y) * t;
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(durationMs / steps);
  }

  await page.mouse.up();
}

async function tapHold(nx: number, ny: number, durationMs: number): Promise<void> {
  const page = getPage();
  const { width, height } = getViewport();
  const { x, y } = denormalize(nx, ny, width, height);

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(durationMs);
  await page.mouse.up();
}

async function waitMs(ms: number): Promise<void> {
  const page = getPage();
  await page.waitForTimeout(ms);
}
