/**
 * scripts/lib/camofox.js
 * 
 * Shared Camoufox browser API helpers for all worker scripts.
 * Consolidated from auto-login, auto-connect, and auto-register.
 */

import { CAMOUFOX_API } from '../config.js';

/**
 * POST request to Camoufox API
 * @param {string} endpoint - API path (e.g., '/tabs', '/tabs/:id/click')
 * @param {object} body - JSON body
 * @param {object} options - { timeoutMs = 30000 }
 * @returns {Promise<object>} JSON response
 */
export async function camofoxPost(endpoint, body, { timeoutMs = 30000 } = {}) {
  const res = await fetch(`${CAMOUFOX_API}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Camofox ${endpoint} → ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * GET request to Camoufox API
 * @param {string} endpoint - API path
 * @param {object} options - { timeoutMs = 10000 }
 * @returns {Promise<object>} JSON response
 */
export async function camofoxGet(endpoint, { timeoutMs = 10000 } = {}) {
  const res = await fetch(`${CAMOUFOX_API}${endpoint}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Camofox GET ${endpoint} → ${res.status}`);
  return res.json();
}

/**
 * DELETE request to Camoufox API (silently ignores errors)
 * @param {string} endpoint - API path
 * @param {object} options - { timeoutMs = 8000 }
 * @returns {Promise<void>}
 */
export async function camofoxDelete(endpoint, { timeoutMs = 8000 } = {}) {
  await fetch(`${CAMOUFOX_API}${endpoint}`, { method: 'DELETE', signal: AbortSignal.timeout(timeoutMs) }).catch(() => { });
}

/**
 * Navigate tab to URL (alias for camofoxPost('/tabs/:id/navigate'))
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} url - Target URL
 * @param {object} options - { timeoutMs = 15000 }
 * @returns {Promise<object>}
 */
export async function camofoxGoto(tabId, userId, url, { timeoutMs = 15000 } = {}) {
  return camofoxPost(`/tabs/${tabId}/navigate`, { userId, url }, { timeoutMs });
}

/**
 * Execute JavaScript in tab and return result
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} expression - JavaScript expression to execute
 * @param {object} options - { timeoutMs = 8000 }
 * @returns {Promise<any>} Result of expression execution
 */
export async function camofoxEval(tabId, userId, expression, { timeoutMs = 8000 } = {}) {
  return camofoxPost(`/tabs/${tabId}/eval`, { userId, expression }, { timeoutMs });
}

/**
 * Convenience alias for camofoxEval that extracts .result field
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} expression - JavaScript expression
 * @param {object} options - { timeoutMs = 8000 }
 * @returns {Promise<any>} result field from response, or null
 */
export async function evalJson(tabId, userId, expression, { timeoutMs = 8000 } = {}) {
  try {
    const res = await camofoxPost(`/tabs/${tabId}/eval`, { userId, expression }, { timeoutMs });
    return res?.result ?? null;
  } catch (e) {
    console.log(`[camofox] eval failed: ${e.message.slice(0, 80)}`);
    return null;
  }
}

/**
 * Navigate tab to URL (alias for camofoxGoto with different signature)
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {string} url - Target URL
 * @param {object} options - { timeoutMs = 15000 }
 * @returns {Promise<void>}
 */
export async function navigate(tabId, userId, url, { timeoutMs = 15000 } = {}) {
  try {
    await camofoxPost(`/tabs/${tabId}/navigate`, { userId, url }, { timeoutMs });
  } catch (e) {
    console.log(`[camofox] navigate failed: ${e.message.slice(0, 80)}`);
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
export async function waitForSelector(tabId, userId, selector, { timeoutMs = 15000, state = 'visible' } = {}) {
  try {
    await camofoxPost(`/tabs/${tabId}/wait`, { userId, selector, state }, { timeoutMs });
    return true;
  } catch (e) {
    console.log(`[camofox] waitForSelector(${selector}) timeout: ${e.message.slice(0, 60)}`);
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
    console.log(`[camofox] pressKey(${key}) failed: ${e.message.slice(0, 60)}`);
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

/**
 * Wait for a custom state condition by polling eval
 * @param {string} tabId - Tab ID
 * @param {string} userId - User ID
 * @param {object} condition - Object with key-value pairs to check in eval result
 * @param {object} options - { timeoutMs = 30000, intervalMs = 500, evalExpression = null }
 * @returns {Promise<object>} Final eval result when condition met
 */
export async function waitForState(tabId, userId, condition, { timeoutMs = 30000, intervalMs = 500, evalExpression = null } = {}) {
  const startTime = Date.now();
  const conditionKeys = Object.keys(condition);

  // Default eval expression for looksLoggedIn check
  const defaultEval = '({ looksLoggedIn: typeof window !== "undefined" && !document.body.innerText.includes("Sign up") })';
  const expression = evalExpression || defaultEval;

  while (Date.now() - startTime < timeoutMs) {
    const result = await evalJson(tabId, userId, expression, { timeoutMs: intervalMs });

    if (result) {
      const matches = conditionKeys.every(key => result[key] === condition[key]);
      if (matches) return result;
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error(`waitForState timeout after ${timeoutMs}ms`);
}
