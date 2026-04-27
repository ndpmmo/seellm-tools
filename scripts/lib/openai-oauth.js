/**
 * scripts/lib/openai-oauth.js
 * 
 * Shared OAuth PKCE helpers for OpenAI/Codex authentication.
 * Used by auto-connect-worker and auto-register-worker.
 */

import crypto from 'node:crypto';

// ============================================
// OAUTH CONSTANTS (Codex CLI standard)
// ============================================
export const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const OAUTH_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
export const OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const OAUTH_SCOPE = 'openid email profile offline_access';
export const CODEX_CONSENT_URL = 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent';

// ============================================
// PKCE HELPERS
// ============================================
export function generatePKCE() {
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  return { codeVerifier, codeChallenge, state };
}

export function buildOAuthURL(pkce) {
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPE,
    state: pkce.state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    // Codex CLI standard params (from zc-zhangchen/any-auto-register)
    prompt: 'login',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  });
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

// ============================================
// TOKEN EXCHANGE
// ============================================
export async function exchangeCodeForTokens(code, pkce, proxyUrl = null) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: OAUTH_CLIENT_ID,
    code,
    redirect_uri: OAUTH_REDIRECT_URI,
    code_verifier: pkce.codeVerifier,
  });
  const postData = params.toString();

  // ── Nếu có proxy: dùng curl để đồng bộ IP với trình duyệt ──
  if (proxyUrl) {
    try {
      const { execSync } = await import('node:child_process');
      const curlCmd = [
        'curl', '-s', '-X', 'POST',
        '-H', '"Content-Type: application/x-www-form-urlencoded"',
        '-H', '"Accept: application/json"',
        '--proxy', `"${proxyUrl}"`,
        '--data', `"${postData}"`,
        `"${OAUTH_TOKEN_URL}"`
      ].join(' ');

      const responseText = execSync(curlCmd, { encoding: 'utf8', timeout: 15000 });
      const data = JSON.parse(responseText);
      if (data.error) throw new Error(data.error_description || JSON.stringify(data.error));
      return data;
    } catch (err) {
      console.warn(`[OAuth] Proxy exchange failed, falling back to direct: ${err.message}`);
    }
  }

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: postData,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${err.slice(0, 200)}`);
  }
  return res.json();
}

// ============================================
// COOKIE DECODING
// ============================================
/**
 * Decode oai-client-auth-session cookie (JWT) to extract workspaces
 * @param {string} cookieValue - Cookie value (JWT format)
 * @returns {object|null} - Decoded payload or null if invalid
 */
export function decodeAuthSessionCookie(cookieValue) {
  if (!cookieValue || typeof cookieValue !== 'string') {
    return null;
  }

  try {
    // JWT format: header.payload.signature
    const segments = cookieValue.split('.');
    if (segments.length < 2) {
      return null;
    }

    // Decode the payload (second segment)
    const payload = segments[0]; // Note: zc-zhangchen uses first segment for workspace
    const pad = '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);

    return parsed;
  } catch (err) {
    console.warn(`[OAuth] Failed to decode auth session cookie: ${err.message}`);
    return null;
  }
}

/**
 * Extract workspace ID from decoded cookie payload
 * @param {object} decoded - Decoded cookie payload
 * @returns {string|null} - Workspace ID or null
 */
export function extractWorkspaceId(decoded) {
  if (!decoded || !decoded.workspaces || !Array.isArray(decoded.workspaces)) {
    return null;
  }
  const ws = decoded.workspaces[0];
  return (ws && ws.id) ? ws.id : null;
}
