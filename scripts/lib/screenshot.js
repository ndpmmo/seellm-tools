/**
 * scripts/lib/screenshot.js
 * 
 * Screenshot capture helper with step model, before/after moments, and deduplication.
 * Eliminates race conditions from global counters in multi-threaded workers.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CAMOUFOX_API } from '../config.js';

/**
 * Create a step recorder with structured naming and deduplication
 * @param {string} runDir - Directory to save screenshots
 * @param {object} options - { tabId, userId, camofoxApi, enableDedupe = true }
 * @returns {object} Step recorder with before(), after(), error(), checkpoint(), and legacy saveStep()
 */
export function createStepRecorder(runDir, {
  tabId,
  userId,
  camofoxApi = CAMOUFOX_API,
  enableDedupe = true,
} = {}) {
  let stepCount = 0;
  const capturedKeys = new Set(); // Track dedupe keys

  /**
   * Capture screenshot with structured naming
   * @param {object} params - { phase, step, moment, slug, dedupeKey }
   * @returns {Promise<string|null>} Filename or null if skipped
   */
  async function capture({ phase, step, moment, slug, dedupeKey = null } = {}) {
    const key = dedupeKey || `${phase}_${step}_${moment}_${slug}`;
    
    // Deduplication check
    if (enableDedupe && capturedKeys.has(key)) {
      console.log(`[Screenshot] Skipped duplicate: ${key}`);
      return null;
    }
    
    stepCount++;
    capturedKeys.add(key);
    
    // Structured filename: 01_phase1_open_login_before.png
    const phaseNum = String(phase).padStart(2, '0');
    const stepNum = String(step).padStart(2, '0');
    const filename = `${phaseNum}_phase${phaseNum}_step${stepNum}_${slug}_${moment}.png`;
    
    try {
      const res = await fetch(`${camofoxApi}/tabs/${tabId}/screenshot?userId=${userId}&fullPage=true`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        await fs.writeFile(path.join(runDir, filename), buffer);
        console.log(`[Screenshot] ${filename}`);
        return filename;
      }
    } catch (e) {
      console.log(`[Screenshot] Capture failed: ${e.message}`);
    }
    return null;
  }

  /**
   * Capture before action
   * @param {string} phase - Phase number
   * @param {string} step - Step number
   * @param {string} slug - Action slug (e.g., 'open_login', 'fill_email')
   * @param {string} dedupeKey - Optional custom dedupe key
   * @returns {Promise<string|null>} Filename or null
   */
  async function before(phase, step, slug, dedupeKey = null) {
    return capture({ phase, step, moment: 'before', slug, dedupeKey });
  }

  /**
   * Capture after action
   * @param {string} phase - Phase number
   * @param {string} step - Step number
   * @param {string} slug - Action slug
   * @param {string} dedupeKey - Optional custom dedupe key
   * @returns {Promise<string|null>} Filename or null
   */
  async function after(phase, step, slug, dedupeKey = null) {
    return capture({ phase, step, moment: 'after', slug, dedupeKey });
  }

  /**
   * Capture error state
   * @param {string} phase - Phase number
   * @param {string} step - Step number
   * @param {string} slug - Error context slug
   * @param {string} dedupeKey - Optional custom dedupe key
   * @returns {Promise<string|null>} Filename or null
   */
  async function error(phase, step, slug, dedupeKey = null) {
    return capture({ phase, step, moment: 'error', slug, dedupeKey });
  }

  /**
   * Capture checkpoint (mid-flow verification)
   * @param {string} phase - Phase number
   * @param {string} step - Step number
   * @param {string} slug - Checkpoint slug
   * @param {string} dedupeKey - Optional custom dedupe key
   * @returns {Promise<string|null>} Filename or null
   */
  async function checkpoint(phase, step, slug, dedupeKey = null) {
    return capture({ phase, step, moment: 'checkpoint', slug, dedupeKey });
  }

  /**
   * Legacy saveStep for backward compatibility
   * @param {string} label - Simple label (will be converted to structured format)
   * @returns {Promise<void>}
   */
  async function saveStep(label) {
    const legacyKey = `legacy_${label}`;
    if (enableDedupe && capturedKeys.has(legacyKey)) {
      console.log(`[Screenshot] Skipped legacy duplicate: ${label}`);
      return;
    }
    capturedKeys.add(legacyKey);
    
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
  }

  return {
    before,
    after,
    error,
    checkpoint,
    saveStep, // Legacy compatibility
    get stepCount() { return stepCount; },
  };
}

/**
 * Legacy alias for backward compatibility
 * @deprecated Use createStepRecorder() instead
 */
export function createSaveStep(runDir, options = {}) {
  const recorder = createStepRecorder(runDir, options);
  return recorder.saveStep.bind(recorder);
}
