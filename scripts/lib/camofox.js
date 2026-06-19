/**
 * scripts/lib/camofox.js
 * 
 * Shared Camoufox browser API helpers for all worker scripts.
 * Consolidated from auto-login, auto-connect, and auto-register.
 */

import { CAMOUFOX_API, FORCE_LOCALE_STR, WORKER_AUTH_TOKEN, GATEWAY_URL, USE_PERSISTENT_PROFILES } from '../config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

function getSha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Fetches the global usePersistentProfiles settings from local configuration
 * @returns {Promise<boolean>}
 */
export async function getGlobalUsePersistent() {
  return USE_PERSISTENT_PROFILES;
}

/**
 * Checks if a physical profile directory exists on the disk for a given userId
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function checkProfileExists(userId) {
  if (!userId) return false;
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir() || '';
    const profilesDir = process.env.CAMOFOX_PROFILE_DIR || path.join(homeDir, '.camofox', 'profiles');
    const hash = getSha256(userId);
    const targetDir = path.join(profilesDir, hash);
    const stat = await fs.stat(targetDir);
    return stat.isDirectory();
  } catch (e) {
    return false;
  }
}

/**
 * Helper to fetch with retry for resilient local Camoufox server communication.
 * Retries on connection refuse, reset, or timeout errors.
 * Features:
 *   - Progressive timeout: each retry gets 1.5x more time (server may just be slow)
 *   - Jitter: random ±500ms added to backoff delay to prevent thundering herd
 *     when multiple workers retry simultaneously
 *   - Circuit breaker: if Camofox has been failing consistently, automatically
 *     add a global cooldown to let it recover before hammering it again
 * @param {string} url - Target URL
 * @param {object} options - Fetch options, supports custom timeoutMs field
 * @param {number} maxAttempts - Number of retries
 * @returns {Promise<Response>} Fetch Response
 */
/**
 * Classify whether a fetch error is a transient connection error worth retrying.
 * 'fetch failed' = ECONNREFUSED / ECONNRESET (server not up yet or overloaded)
 * 'TimeoutError' / 'AbortError' = server too slow
 */
function isTransientConnectionError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (msg.includes('fetch failed')) return true;          // ECONNREFUSED / ECONNRESET
  if (msg.includes('econnrefused')) return true;
  if (msg.includes('econnreset')) return true;
  if (msg.includes('timeout') || msg.includes('timed out')) return true;
  if (msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit')) return true;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return true;
  return false;
}

/**
 * Global circuit breaker state — shared across all workers in the same process.
 * Tracks consecutive failures and enforces a cooldown when Camofox is overloaded.
 */
const _circuitBreaker = {
  failures: 0,
  lastFailureTs: 0,
  cooldownUntil: 0,
  // Trip circuit after this many consecutive failures
  threshold: 5,
  // Cooldown duration when circuit is tripped (ms)
  cooldownMs: 8000,
  /** Record a transient failure */
  recordFailure() {
    this.failures++;
    this.lastFailureTs = Date.now();
    if (this.failures >= this.threshold && Date.now() >= this.cooldownUntil) {
      this.cooldownUntil = Date.now() + this.cooldownMs;
      console.warn(`🔴 [camofox-circuit] ${this.failures} lỗi liên tiếp — kích hoạt cooldown ${this.cooldownMs / 1000}s để camofox phục hồi...`);
    }
  },
  /** Record a successful request — reset failure counter */
  recordSuccess() {
    if (this.failures > 0) this.failures = 0;
  },
  /** Returns how many ms we still need to wait (0 = no cooldown) */
  remainingCooldownMs() {
    const remaining = this.cooldownUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  },
};

async function fetchWithRetry(url, options = {}, maxAttempts = 3) {
  // --- Circuit breaker check: wait out any active cooldown before trying ---
  const cooldown = _circuitBreaker.remainingCooldownMs();
  if (cooldown > 0) {
    console.log(`⏳ [camofox-circuit] Đang chờ cooldown ${Math.ceil(cooldown / 1000)}s trước khi thử lại...`);
    await new Promise(r => setTimeout(r, cooldown));
  }

  let lastError = null;
  const baseTimeoutMs = options.timeoutMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let finalOptions = { ...options };
      if (baseTimeoutMs !== undefined) {
        // Progressive timeout: multiply by 1.5x each retry attempt
        // attempt=1 → 1.0x, attempt=2 → 1.5x, attempt=3 → 2.25x
        const progressiveTimeout = Math.round(baseTimeoutMs * Math.pow(1.5, attempt - 1));
        finalOptions.signal = AbortSignal.timeout(progressiveTimeout);
        delete finalOptions.timeoutMs;
      }
      const result = await fetch(url, finalOptions);
      if (result.status === 429 || result.status === 502 || result.status === 503 || result.status === 504) {
        throw new Error(`HTTP ${result.status}: Temporary server error or rate limit`);
      }
      _circuitBreaker.recordSuccess();
      return result;
    } catch (err) {
      lastError = err;
      const transient = isTransientConnectionError(err);
      if (attempt < maxAttempts && transient) {
        _circuitBreaker.recordFailure();
        // Exponential backoff + jitter: (1.5s * attempt) ± random 0–500ms
        // This prevents all 3 workers from retrying at exactly the same moment
        const jitter = Math.floor(Math.random() * 500);
        const delay = 1500 * attempt + jitter;
        console.log(`⚠️ [camofox-api] Lỗi kết nối (lần ${attempt}/${maxAttempts}): ${err.message || err}. Thử lại sau ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else if (!transient) {
        // Non-transient errors (HTTP 4xx, 5xx from server) — fail fast, no retry
        throw err;
      } else {
        // Final attempt also failed — record it
        _circuitBreaker.recordFailure();
      }
    }
  }
  throw lastError;
}

/**
 * Lightweight Camofox health check — ping GET /tabs to see if server is up.
 * Returns true if Camofox is responding, false otherwise.
 * Used as pre-flight guard before workers accept new tasks.
 * @param {number} timeoutMs - How long to wait (default 3000ms)
 * @returns {Promise<boolean>}
 */
export async function checkCamofoxReady(timeoutMs = 3000) {
  try {
    const res = await fetch(`${CAMOUFOX_API}/tabs`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok || res.status === 200;
  } catch (_) {
    return false;
  }
}

/**
 * POST request to Camoufox API.
 * Auto-injects `sessionKey` (v1.8.15+) and `locale` (v1.8.15+) when needed.
 *
 * @param {string} endpoint - API path (e.g., '/tabs', '/tabs/:id/click')
 * @param {object} body - JSON body
 * @param {object} options - { timeoutMs = 30000 }
 * @returns {Promise<object>} JSON response
 */
export async function camofoxPost(endpoint, body, { timeoutMs = 45000 } = {}) {
  // Inject sessionKey cho v1.8.15+ (yêu cầu trong tất cả requests)
  let finalBody = body || {};
  if (WORKER_AUTH_TOKEN && finalBody.sessionKey === undefined) {
    finalBody = { ...finalBody, sessionKey: WORKER_AUTH_TOKEN };
  }

  // Inject locale chỉ khi tạo tab mới (POST /tabs hoặc /tabs/open)
  if (FORCE_LOCALE_STR && (endpoint === '/tabs' || endpoint === '/tabs/open')) {
    if (finalBody.locale === undefined && finalBody.forceLocale === undefined) {
      finalBody = { ...finalBody, locale: FORCE_LOCALE_STR };
    }
  }

  const res = await fetchWithRetry(`${CAMOUFOX_API}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(finalBody),
    timeoutMs,
  }, 3);
  if (!res.ok) throw new Error(`Camofox ${endpoint} → ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * GET request to Camoufox API
 * @param {string} endpoint - API path
 * @param {object} options - { timeoutMs = 10000 }
 * @returns {Promise<object>} JSON response
 */
export async function camofoxGet(endpoint, { timeoutMs = 20000 } = {}) {
  const res = await fetchWithRetry(`${CAMOUFOX_API}${endpoint}`, { timeoutMs }, 3);
  if (!res.ok) throw new Error(`Camofox GET ${endpoint} → ${res.status}`);
  return res.json();
}

/**
 * DELETE request to Camoufox API (silently ignores errors)
 * @param {string} endpoint - API path
 * @param {object} options - { timeoutMs = 8000 }
 * @returns {Promise<void>}
 */
export async function camofoxDelete(endpoint, { timeoutMs = 12000 } = {}) {
  await fetchWithRetry(`${CAMOUFOX_API}${endpoint}`, { method: 'DELETE', timeoutMs }, 3).catch(() => { });
}

export async function camofoxGoto(tabId, userId, url, options = {}) {
  let timeoutMs = 95000; // Increased to 95s to exceed server's 90s navigateTimeoutMs and prevent client-side premature timeout
  if (typeof options === 'number') {
    timeoutMs = options;
  } else if (options && typeof options === 'object' && options.timeoutMs !== undefined) {
    timeoutMs = options.timeoutMs;
  }
  return camofoxPost(`/tabs/${tabId}/navigate`, { userId, url }, { timeoutMs: timeoutMs + 2000 });
}

/**
 * Execute JavaScript in tab and return result
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} expression - JavaScript expression to execute
 * @param {object} options - { timeoutMs = 8000 }
 * @returns {Promise<any>} Result of expression execution
 */
export async function camofoxEval(tabId, userId, expression, { timeoutMs = 12000 } = {}) {
  return camofoxPost(`/tabs/${tabId}/evaluate`, { userId, expression }, { timeoutMs });
}

/**
 * Convenience alias for camofoxEval that extracts .result field
 * Uses retry logic for transient errors and logs full error messages
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} expression - JavaScript expression
 * @param {object} options - { timeoutMs = 8000, maxRetries = 2, retryDelayMs = 500 }
 * @returns {Promise<any>} result field from response, or null
 */
export async function evalJson(tabId, userId, expression, { timeoutMs = 8000, maxRetries = 2, retryDelayMs = 500 } = {}) {
  return camofoxEvalRetry(tabId, userId, expression, { timeoutMs, maxRetries, retryDelayMs, behavior: 'returnNull' });
}

/**
 * Navigate tab to URL
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} url - Target URL
 * @param {object} options - Options or legacy timeout number
 * @returns {Promise<void>}
 */
export async function navigate(tabId, userId, url, options = {}) {
  let timeoutMs = 95000; // Increased to 95s to exceed server's 90s navigateTimeoutMs and prevent client-side premature timeout
  if (typeof options === 'number') {
    timeoutMs = options;
  } else if (options && typeof options === 'object' && options.timeoutMs !== undefined) {
    timeoutMs = options.timeoutMs;
  }
  try {
    await camofoxPost(`/tabs/${tabId}/navigate`, { userId, url }, { timeoutMs: timeoutMs + 2000 });
  } catch (e) {
    console.log(`[camofox] navigate failed: ${e.message}`);
    throw e;
  }
}

/**
 * Wait for element to appear/disappear using Camofox wait endpoint
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} selector - CSS selector
 * @param {object} options - { timeoutMs = 15000, state = 'visible' }
 * @returns {Promise<boolean>} true if element found, false on timeout
 */
export async function waitForSelector(tabId, userId, selector, options = {}) {
  let timeoutMs = 15000;
  let state = 'visible';
  if (typeof options === 'number') {
    timeoutMs = options;
  } else if (options && typeof options === 'object') {
    if (options.timeoutMs !== undefined) timeoutMs = options.timeoutMs;
    if (options.state !== undefined) state = options.state;
  }
  try {
    await camofoxPost(`/tabs/${tabId}/wait-for-selector`, { userId, selector, state, timeout: timeoutMs }, { timeoutMs: timeoutMs + 2000 });
    return true;
  } catch (e) {
    console.log(`[camofox] waitForSelector(${selector}) timeout: ${e.message}`);
    return false;
  }
}

/**
 * Wait for page URL to match a pattern (string, glob, or regex)
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} url - URL pattern (string, glob, or regex)
 * @param {object} options - { timeoutMs = 15000 }
 * @returns {Promise<boolean>} true if URL matched, false on timeout
 */
export async function waitForUrl(tabId, userId, url, options = {}) {
  let timeoutMs = 15000;
  if (typeof options === 'number') {
    timeoutMs = options;
  } else if (options && typeof options === 'object' && options.timeoutMs !== undefined) {
    timeoutMs = options.timeoutMs;
  }
  try {
    await camofoxPost(`/tabs/${tabId}/wait-for-url`, { userId, url, timeout: timeoutMs }, { timeoutMs: timeoutMs + 2000 });
    return true;
  } catch (e) {
    console.log(`[camofox] waitForUrl(${url}) timeout: ${e.message}`);
    return false;
  }
}

/**
 * Press keyboard key
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} key - Key name (Enter, Tab, Escape, etc)
 * @param {object} options - { timeoutMs = 5000 }
 * @returns {Promise<void>}
 */
export async function pressKey(tabId, userId, key, { timeoutMs = 5000 } = {}) {
  try {
    await camofoxPost(`/tabs/${tabId}/press`, { userId, key }, { timeoutMs });
  } catch (e) {
    console.log(`[camofox] pressKey(${key}) failed: ${e.message}`);
  }
}

/**
 * Get snapshot with optional screenshot
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {object} options - { includeScreenshot = false, offset = 0, timeoutMs = 10000 }
 * @returns {Promise<object>} Snapshot data
 */
export async function getSnapshot(tabId, userId, { includeScreenshot = false, offset = 0, timeoutMs = 10000 } = {}) {
  const params = new URLSearchParams({ userId });
  if (includeScreenshot) params.set('includeScreenshot', 'true');
  if (offset > 0) params.set('offset', offset.toString());
  const endpoint = `/tabs/${tabId}/snapshot?${params.toString()}`;
  return camofoxGet(endpoint, { timeoutMs });
}

/**
 * Click element by ref (accessibility tree)
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} ref - Element ref (e1, e2, etc)
 * @param {object} options - { timeoutMs = 5000 }
 * @returns {Promise<object>} Click response
 */
export async function clickRef(tabId, userId, ref, { timeoutMs = 5000 } = {}) {
  return camofoxPost(`/tabs/${tabId}/click`, { userId, ref }, { timeoutMs });
}

/**
 * Type text into element by ref
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} ref - Element ref (e1, e2, etc)
 * @param {string} text - Text to type
 * @param {object} options - { pressEnter = false, timeoutMs = 8000 }
 * @returns {Promise<object>} Type response
 */
export async function typeByRef(tabId, userId, ref, text, { pressEnter = false, timeoutMs = 8000 } = {}) {
  return camofoxPost(`/tabs/${tabId}/type`, { userId, ref, text, pressEnter }, { timeoutMs });
}

/**
 * Triple-click for select-all-and-replace pattern
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} selector - CSS selector
 * @param {object} options - { timeoutMs = 5000 }
 * @returns {Promise<object>} Click response
 */
export async function tripleClick(tabId, userId, selector, { timeoutMs = 5000 } = {}) {
  return camofoxPost(`/tabs/${tabId}/click`, { userId, selector, clickCount: 3 }, { timeoutMs });
}

// ============================================================================
// EVALUATE ERROR CLASSIFICATION & RETRY LOGIC
// ============================================================================

/**
 * Classify Camofox evaluate errors into categories for retry decision
 * @param {Error|string} error - Error object or message
 * @returns {object} { type, transient, message }
 */
export function classifyEvaluateError(error) {
  const msg = String(error?.message || error || '').toLowerCase();

  // Transient errors - safe to retry
  if (msg.includes('execution context') && (msg.includes('destroyed') || msg.includes('not found'))) {
    return { type: 'execution_context_destroyed', transient: true, message: String(error?.message || error) };
  }
  if (msg.includes('frame was detached') || msg.includes('frame detached')) {
    return { type: 'frame_detached', transient: true, message: String(error?.message || error) };
  }
  if (msg.includes('page closed') || msg.includes('target page') || msg.includes('target closed')) {
    return { type: 'page_closed', transient: false, message: String(error?.message || error) };
  }
  if (msg.includes('timeout') || msg.includes('timed out')) {
    return { type: 'timeout', transient: true, message: String(error?.message || error) };
  }

  // Unknown - treat as transient for retry
  return { type: 'unknown', transient: true, message: String(error?.message || error) };
}

/**
 * Evaluate with retry for transient errors
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} expression - JavaScript expression
 * @param {object} options - { timeoutMs = 8000, maxRetries = 2, retryDelayMs = 500, behavior = 'retry' }
 * @returns {Promise<any>} Result or null based on behavior
 */
export async function camofoxEvalRetry(tabId, userId, expression, {
  timeoutMs = 8000,
  maxRetries = 2,
  retryDelayMs = 500,
  behavior = 'retry', // 'retry' | 'silent' | 'throw' | 'returnNull'
} = {}) {
  let lastError = null;
  let lastClassification = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await camofoxPost(`/tabs/${tabId}/evaluate`, { userId, expression }, { timeoutMs });
      return res?.result ?? null;
    } catch (e) {
      lastError = e;
      lastClassification = classifyEvaluateError(e);

      if (attempt < maxRetries && lastClassification.transient && behavior === 'retry') {
        console.log(`[camofox] eval retry (${attempt + 1}/${maxRetries}): ${lastClassification.type} - ${lastClassification.message.slice(0, 120)}`);
        await new Promise(r => setTimeout(r, retryDelayMs * (attempt + 1))); // Exponential backoff
        continue;
      }
    }
  }

  // All retries exhausted or non-transient error
  const fullMsg = `[camofox] eval failed: ${lastClassification?.type} - ${lastClassification?.message}`;

  switch (behavior) {
    case 'silent':
      return null;
    case 'throw':
      throw new Error(fullMsg);
    case 'returnNull':
      console.log(fullMsg);
      return null;
    case 'retry':
    default:
      console.log(fullMsg);
      return null;
  }
}

/**
 * Strict evaluate - throws on error (for critical operations)
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} expression - JavaScript expression
 * @param {object} options - { timeoutMs = 8000, maxRetries = 2 }
 * @returns {Promise<any>} Result
 */
export async function evalStrict(tabId, userId, expression, { timeoutMs = 8000, maxRetries = 2 } = {}) {
  return camofoxEvalRetry(tabId, userId, expression, { timeoutMs, maxRetries, behavior: 'throw' });
}

// ============================================================================
// NEW FEATURES FROM CAMOFOX v1.8.15
// ============================================================================

/**
 * Extract structured data from page using JSON Schema
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {object} schema - JSON Schema for extraction
 * @param {object} options - { timeoutMs = 30000 }
 * @returns {Promise<object>} Extracted data matching schema
 */
export async function extractData(tabId, userId, schema, { timeoutMs = 30000 } = {}) {
  try {
    return await camofoxPost(`/tabs/${tabId}/extract`, { userId, schema }, { timeoutMs });
  } catch (e) {
    console.log(`[camofox] extractData failed: ${e.message}`);
    return null;
  }
}

/**
 * List trace files for a user session
 * @param {string} userId - User ID
 * @param {object} options - { timeoutMs = 10000 }
 * @returns {Promise<object>} List of trace files
 */
export async function getTraces(userId, { timeoutMs = 10000 } = {}) {
  try {
    return await camofoxGet(`/sessions/${userId}/traces`, { timeoutMs });
  } catch (e) {
    console.log(`[camofox] getTraces failed: ${e.message}`);
    return null;
  }
}

/**
 * Download a trace file
 * @param {string} userId - User ID
 * @param {string} filename - Trace filename
 * @param {object} options - { timeoutMs = 60000 }
 * @returns {Promise<Blob>} Trace file as blob
 */
export async function getTrace(userId, filename, { timeoutMs = 60000 } = {}) {
  const res = await fetch(`${CAMOUFOX_API}/sessions/${userId}/traces/${filename}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Camofox getTrace -> ${res.status}`);
  return res.blob();
}

/**
 * Delete a trace file
 * @param {string} userId - User ID
 * @param {string} filename - Trace filename
 * @param {object} options - { timeoutMs = 10000 }
 * @returns {Promise<object>} Delete result
 */
export async function deleteTrace(userId, filename, { timeoutMs = 10000 } = {}) {
  try {
    return await camofoxDelete(`/sessions/${userId}/traces/${filename}`, { timeoutMs });
  } catch (e) {
    console.log(`[camofox] deleteTrace failed: ${e.message}`);
    return null;
  }
}

/**
 * Get Prometheus metrics from Camofox
 * Requires PROMETHEUS_ENABLED=1 on Camofox server
 * @param {object} options - { timeoutMs = 10000 }
 * @returns {Promise<string>} Prometheus metrics text
 */
export async function getMetrics({ timeoutMs = 10000 } = {}) {
  const res = await fetch(`${CAMOUFOX_API}/metrics`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Camofox getMetrics -> ${res.status}`);
  return res.text();
}

/**
 * Unified action endpoint - click, type, press, scroll, wait
 * Replaces multiple individual function calls
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} kind - Action kind: click, type, press, scroll, wait
 * @param {object} params - Action parameters
 * @param {object} options - { timeoutMs = 30000 }
 * @returns {Promise<object>} Action result
 */
export async function act(tabId, userId, kind, params, { timeoutMs = 30000 } = {}) {
  const validKinds = ['click', 'type', 'press', 'scroll', 'wait'];
  if (!validKinds.includes(kind)) {
    throw new Error(`Invalid kind: ${kind}. Valid: ${validKinds.join(', ')}`);
  }
  return camofoxPost(`/act`, { kind, targetId: tabId, userId, ...params }, { timeoutMs });
}

/**
 * Act: Click element by ref or selector
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {object} params - { ref?, selector?, doubleClick? }
 * @param {object} options - { timeoutMs = 5000 }
 * @returns {Promise<object>}
 */
export async function actClick(tabId, userId, params, { timeoutMs = 5000 } = {}) {
  return act(tabId, userId, 'click', params, { timeoutMs });
}

/**
 * Act: Type text into element
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {object} params - { ref?, selector?, text, mode?, delay?, submit? }
 * @param {object} options - { timeoutMs = 8000 }
 * @returns {Promise<object>}
 */
export async function actType(tabId, userId, params, { timeoutMs = 8000 } = {}) {
  return act(tabId, userId, 'type', params, { timeoutMs });
}

/**
 * Act: Press keyboard key
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {object} params - { key }
 * @param {object} options - { timeoutMs = 5000 }
 * @returns {Promise<object>}
 */
export async function actPress(tabId, userId, params, { timeoutMs = 5000 } = {}) {
  return act(tabId, userId, 'press', params, { timeoutMs });
}

/**
 * Act: Scroll page
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {object} params - { direction, amount? }
 * @param {object} options - { timeoutMs = 5000 }
 * @returns {Promise<object>}
 */
export async function actScroll(tabId, userId, params, { timeoutMs = 5000 } = {}) {
  return act(tabId, userId, 'scroll', params, { timeoutMs });
}

/**
 * Act: Wait (timeout, text, or loadState)
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {object} params - { timeMs?, text?, loadState? }
 * @param {object} options - { timeoutMs = 30000 }
 * @returns {Promise<object>}
 */
export async function actWait(tabId, userId, params, { timeoutMs = 30000 } = {}) {
  return act(tabId, userId, 'wait', params, { timeoutMs });
}
