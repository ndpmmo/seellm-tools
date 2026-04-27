/**
 * scripts/lib/screenshot.js
 * 
 * Screenshot capture helper with per-flow counter.
 * Eliminates race conditions from global counters in multi-threaded workers.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { CAMOUFOX_API } from '../config.js';

/**
 * Create a saveStep function with isolated counter per flow
 * @param {string} runDir - Directory to save screenshots
 * @param {object} options - { tabId, userId, camofoxApi }
 * @returns {(label: string) => Promise<void>} saveStep function
 */
export function createSaveStep(runDir, { tabId, userId, camofoxApi = CAMOUFOX_API } = {}) {
  let stepCount = 0;

  return async (label) => {
    stepCount++;
    const filename = `${String(stepCount).padStart(2, '0')}_${label}.png`;
    try {
      const res = await fetch(`${camofoxApi}/tabs/${tabId}/screenshot?userId=${userId}&fullPage=true`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        await fs.writeFile(path.join(runDir, filename), Buffer.from(await res.arrayBuffer()));
        console.log(`[Screenshot] ${filename}`);
      }
    } catch (_) {}
  };
}
