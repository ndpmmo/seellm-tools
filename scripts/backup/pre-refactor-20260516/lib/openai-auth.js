/**
 * scripts/lib/openai-auth.js
 * 
 * OpenAI OAuth JWT decoding and account metadata extraction.
 * Consolidated from auto-connect and auto-login.
 */

/**
 * Decode JWT payload (no signature verification needed for metadata)
 * @param {string} token - JWT token
 * @returns {object} Decoded payload
 */
export function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return {};
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  } catch { return {}; }
}

/**
 * Extract account metadata from OpenAI access token
 * @param {string} accessToken - OpenAI access token
 * @returns {object} Account metadata
 */
export function extractAccountMeta(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload['https://api.openai.com/auth'] || {};
  const profile = payload['https://api.openai.com/profile'] || {};
  return {
    accountId: auth.chatgpt_account_id || auth.account_id || payload.sub || '',
    userId: auth.chatgpt_user_id || auth.user_id || payload.sub || '',
    organizationId: auth.organization_id || '',
    planType: auth.chatgpt_plan_type || 'free',
    expiredAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : '',
    email: profile.email || payload.email || '',
  };
}

/**
 * Parse UUID matches from text (for workspace/organization detection)
 * @param {string} input - Text to search
 * @returns {string[]} Array of UUIDs
 */
export function parseUuidMatches(input = '') {
  return Array.from(new Set(String(input).match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi) || []));
}
