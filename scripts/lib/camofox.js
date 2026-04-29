/**
 * scripts/lib/camofox.js
 * 
 * Shared Camoufox browser API helpers for all worker scripts.
 * Consolidated from auto-login, auto-connect, and auto-register.
 */

import { CAMOUFOX_API, FORCE_LOCALE_STR } from '../config.js';

/**
 * POST request to Camoufox API.
 * Auto-injects `locale: <FORCE_LOCALE_STR>` (default 'en-US') khi tạo tab mới
 * (POST /tabs) nếu setting `forceEnLocale` bật. Caller có thể override bằng
 * cách truyền `locale` trong body — body có ưu tiên cao hơn.
 *
 * @param {string} endpoint - API path (e.g., '/tabs', '/tabs/:id/click')
 * @param {object} body - JSON body
 * @param {object} options - { timeoutMs = 30000 }
 * @returns {Promise<object>} JSON response
 */
export async function camofoxPost(endpoint, body, { timeoutMs = 30000 } = {}) {
  // Inject locale chỉ khi tạo tab mới (POST /tabs hoặc /tabs/open)
  let finalBody = body;
  if (FORCE_LOCALE_STR && (endpoint === '/tabs' || endpoint === '/tabs/open')) {
    if (body && body.locale === undefined && body.forceLocale === undefined) {
      finalBody = { ...body, locale: FORCE_LOCALE_STR };
    }
  }
  const res = await fetch(`${CAMOUFOX_API}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(finalBody),
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
  return camofoxPost(`/tabs/${tabId}/evaluate`, { userId, expression }, { timeoutMs });
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
    const res = await camofoxPost(`/tabs/${tabId}/evaluate`, { userId, expression }, { timeoutMs });
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
    await camofoxPost(`/tabs/${tabId}/wait-for-selector`, { userId, selector, state }, { timeoutMs });
    return true;
  } catch (e) {
    console.log(`[camofox] waitForSelector(${selector}) timeout: ${e.message.slice(0, 60)}`);
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
export async function waitForUrl(tabId, userId, url, { timeoutMs = 15000 } = {}) {
  try {
    await camofoxPost(`/tabs/${tabId}/wait-for-url`, { userId, url }, { timeoutMs });
    return true;
  } catch (e) {
    console.log(`[camofox] waitForUrl(${url}) timeout: ${e.message.slice(0, 60)}`);
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
    console.log(`[camofox] extractData failed: ${e.message.slice(0, 80)}`);
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
    console.log(`[camofox] getTraces failed: ${e.message.slice(0, 80)}`);
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
    console.log(`[camofox] deleteTrace failed: ${e.message.slice(0, 80)}`);
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
  return camofoxPost(`/tabs/${tabId}/act`, { kind, userId, ...params }, { timeoutMs });
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
