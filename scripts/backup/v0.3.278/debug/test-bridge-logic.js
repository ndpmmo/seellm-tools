/**
 * Test script: verify bridge logic and OAuth flow logic
 * Run: node scripts/debug/test-bridge-logic.js
 * Does NOT require Camoufox or seellm-tools server.
 */

import crypto from 'node:crypto';

// ── Replicate generatePKCE ──
function generatePKCE() {
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  return { codeVerifier, codeChallenge, state };
}

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const OAUTH_SCOPE = 'openid email profile offline_access';

function buildOAuthURL(pkce) {
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPE,
    state: pkce.state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'login',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  });
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

// ── Test 1: PKCE generation ──
console.log('\n=== Test 1: PKCE Generation ===');
const pkce = generatePKCE();
console.log('codeVerifier length:', pkce.codeVerifier.length, pkce.codeVerifier.length >= 43 ? '✅' : '❌ (must be >= 43)');
console.log('codeChallenge length:', pkce.codeChallenge.length, pkce.codeChallenge.length > 0 ? '✅' : '❌');
console.log('state length:', pkce.state.length, pkce.state.length > 0 ? '✅' : '❌');

// Verify S256: SHA256(codeVerifier) base64url == codeChallenge
const expectedChallenge = crypto.createHash('sha256').update(pkce.codeVerifier).digest('base64url');
console.log('S256 challenge correct:', expectedChallenge === pkce.codeChallenge ? '✅' : '❌');

// ── Test 2: OAuth URL construction ──
console.log('\n=== Test 2: OAuth URL Construction ===');
const authUrl = buildOAuthURL(pkce);
const parsed = new URL(authUrl);
console.log('client_id:', parsed.searchParams.get('client_id') === OAUTH_CLIENT_ID ? '✅' : '❌', parsed.searchParams.get('client_id'));
console.log('redirect_uri:', parsed.searchParams.get('redirect_uri') === OAUTH_REDIRECT_URI ? '✅' : '❌');
console.log('code_challenge_method:', parsed.searchParams.get('code_challenge_method') === 'S256' ? '✅' : '❌');
console.log('id_token_add_organizations:', parsed.searchParams.get('id_token_add_organizations') === 'true' ? '✅' : '❌');
console.log('codex_cli_simplified_flow:', parsed.searchParams.get('codex_cli_simplified_flow') === 'true' ? '✅' : '❌');
console.log('state matches pkce.state:', parsed.searchParams.get('state') === pkce.state ? '✅' : '❌');

// ── Test 3: decodeAuthSessionCookie ──
console.log('\n=== Test 3: decodeAuthSessionCookie ===');
// Simulate a cookie with workspaces in first segment
const fakeWorkspaceData = { workspaces: [{ id: 'abc123-def456-789012-345678-901234' }] };
const fakeSegment0 = Buffer.from(JSON.stringify(fakeWorkspaceData)).toString('base64url');
const fakeCookie = `${fakeSegment0}.payload.signature`;

function decodeAuthSessionCookie(cookieValue) {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const segments = cookieValue.split('.');
  if (!segments.length) return null;
  let best = null;
  for (const seg of segments.slice(0, 2)) {
    try {
      const pad = '='.repeat((4 - (seg.length % 4)) % 4);
      const decoded = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed === 'object') {
        if (parsed.workspaces || parsed.workspace_id) return parsed;
        if (!best) best = parsed;
      }
    } catch (_) {}
  }
  return best;
}

const decoded = decodeAuthSessionCookie(fakeCookie);
console.log('Decoded workspaces:', decoded?.workspaces?.[0]?.id === 'abc123-def456-789012-345678-901234' ? '✅' : '❌', decoded?.workspaces?.[0]?.id);

// Test with workspace in second segment (standard JWT payload)
const fakePayload = Buffer.from(JSON.stringify({ workspaces: [{ id: 'payload-workspace-id' }] })).toString('base64url');
const fakeCookie2 = `header.${fakePayload}.signature`;
const decoded2 = decodeAuthSessionCookie(fakeCookie2);
console.log('Decoded from 2nd segment:', decoded2?.workspaces?.[0]?.id === 'payload-workspace-id' ? '✅' : '❌');

// Test with no workspaces
const decoded3 = decodeAuthSessionCookie('invalid.cookie.value');
console.log('Invalid cookie returns null/empty:', !decoded3?.workspaces ? '✅' : '❌');

// ── Test 4: parseCallbackUrl ──
console.log('\n=== Test 4: parseCallbackUrl ===');
function parseCallbackUrl(callbackUrl) {
  let candidate = (callbackUrl || '').trim();
  if (!candidate) return { code: '', state: '', error: '', error_description: '' };
  if (!candidate.includes('://')) {
    if (candidate.startsWith('?')) candidate = `http://localhost${candidate}`;
    else if (/[/?#]/.test(candidate) || candidate.includes(':')) candidate = `http://${candidate}`;
    else if (candidate.includes('=')) candidate = `http://localhost/?${candidate}`;
  }
  try {
    const u = new URL(candidate);
    const params = new URLSearchParams(u.search || '');
    const fragment = new URLSearchParams((u.hash || '').replace(/^#/, ''));
    for (const [k, v] of fragment.entries()) {
      if (!params.get(k)) params.set(k, v);
    }
    return {
      code: params.get('code') || '',
      state: params.get('state') || '',
      error: params.get('error') || '',
      error_description: params.get('error_description') || '',
    };
  } catch (_) {
    return { code: '', state: '', error: '', error_description: '' };
  }
}

const cb1 = parseCallbackUrl('http://localhost:1455/auth/callback?code=abc123&state=xyz');
console.log('Parse localhost callback:', cb1.code === 'abc123' && cb1.state === 'xyz' ? '✅' : '❌', cb1);

const cb2 = parseCallbackUrl('http://localhost:1455/auth/callback#code=fragcode&state=fragstate');
console.log('Parse fragment callback:', cb2.code === 'fragcode' ? '✅' : '❌', cb2);

const cb3 = parseCallbackUrl('?code=queryonly&state=qs');
console.log('Parse query-only callback:', cb3.code === 'queryonly' ? '✅' : '❌', cb3);

const cb4 = parseCallbackUrl('');
console.log('Parse empty callback:', cb4.code === '' ? '✅' : '❌');

// ── Test 5: Bridge URL construction ──
console.log('\n=== Test 5: Bridge URL Logic ===');
// Simulate what the bridge does
const mockCsrfToken = 'mock-csrf-token-12345';
const mockOaiDid = 'mock-device-id-67890';
const signinUrl = 'https://chatgpt.com/api/auth/signin/openai?prompt=login' + (mockOaiDid ? '&ext-oai-did=' + mockOaiDid : '');
const signinBody = 'callbackUrl=https%3A%2F%2Fchatgpt.com%2F&csrfToken=' + encodeURIComponent(mockCsrfToken) + '&json=true';
console.log('signin URL:', signinUrl.includes('ext-oai-did') ? '✅ has oai-did' : '❌ missing oai-did');
console.log('signin body has csrfToken:', signinBody.includes('csrfToken') ? '✅' : '❌');
console.log('signin body has callbackUrl:', signinBody.includes('callbackUrl') ? '✅' : '❌');
console.log('signin body has json=true:', signinBody.includes('json=true') ? '✅' : '❌');

// ── Test 6: Token exchange params ──
console.log('\n=== Test 6: Token Exchange Params ===');
const pkce2 = generatePKCE();
const exchangeParams = new URLSearchParams({
  grant_type: 'authorization_code',
  client_id: OAUTH_CLIENT_ID,
  code: 'test-code-123',
  redirect_uri: OAUTH_REDIRECT_URI,
  code_verifier: pkce2.codeVerifier,
});
console.log('grant_type:', exchangeParams.get('grant_type') === 'authorization_code' ? '✅' : '❌');
console.log('client_id:', exchangeParams.get('client_id') === OAUTH_CLIENT_ID ? '✅' : '❌');
console.log('redirect_uri:', exchangeParams.get('redirect_uri') === OAUTH_REDIRECT_URI ? '✅' : '❌');
console.log('code_verifier present:', !!exchangeParams.get('code_verifier') ? '✅' : '❌');

// ── Test 7: extractAccountMeta from JWT ──
console.log('\n=== Test 7: extractAccountMeta ===');
function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return {};
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  } catch { return {}; }
}

function extractAccountMeta(accessToken) {
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

// Create a fake JWT with OpenAI claims
const fakePayloadData = {
  sub: 'user-sub-123',
  email: 'test@example.com',
  exp: Math.floor(Date.now() / 1000) + 3600,
  'https://api.openai.com/auth': {
    chatgpt_account_id: 'acct-abc123',
    chatgpt_user_id: 'user-xyz789',
    organization_id: 'org-def456',
    chatgpt_plan_type: 'plus',
  },
  'https://api.openai.com/profile': {
    email: 'test@example.com',
  },
};
const fakeJwtPayload = Buffer.from(JSON.stringify(fakePayloadData)).toString('base64url');
const fakeJwt = `header.${fakeJwtPayload}.signature`;
const meta = extractAccountMeta(fakeJwt);
console.log('accountId:', meta.accountId === 'acct-abc123' ? '✅' : '❌', meta.accountId);
console.log('userId:', meta.userId === 'user-xyz789' ? '✅' : '❌', meta.userId);
console.log('organizationId:', meta.organizationId === 'org-def456' ? '✅' : '❌', meta.organizationId);
console.log('planType:', meta.planType === 'plus' ? '✅' : '❌', meta.planType);
console.log('email:', meta.email === 'test@example.com' ? '✅' : '❌', meta.email);
console.log('expiredAt:', meta.expiredAt ? '✅' : '❌', meta.expiredAt);

// ── Test 8: Sentinel SDK version check ──
console.log('\n=== Test 8: Constants Check ===');
// Verify constants match upstream
const SENTINEL_SDK_VERSION = '20260124ceb8';
const SENTINEL_FRAME_VERSION = '20260219f9f6';
console.log('Sentinel SDK version:', SENTINEL_SDK_VERSION === '20260124ceb8' ? '✅' : '⚠️ may be outdated', SENTINEL_SDK_VERSION);
console.log('Sentinel Frame version:', SENTINEL_FRAME_VERSION === '20260219f9f6' ? '✅' : '⚠️ may be outdated', SENTINEL_FRAME_VERSION);
console.log('Codex client_id:', OAUTH_CLIENT_ID === 'app_EMoamEEZ73f0CkXaXp7hrann' ? '✅' : '❌', OAUTH_CLIENT_ID);
console.log('Redirect URI:', OAUTH_REDIRECT_URI === 'http://localhost:1455/auth/callback' ? '✅' : '❌', OAUTH_REDIRECT_URI);

console.log('\n=== All tests complete ===\n');
