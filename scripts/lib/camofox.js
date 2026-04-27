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
