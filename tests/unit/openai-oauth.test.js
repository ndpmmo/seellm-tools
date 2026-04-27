/**
 * tests/unit/openai-oauth.test.js
 * 
 * Unit tests for OAuth helpers in scripts/lib/openai-oauth.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';

// Import functions to test
import { generatePKCE, buildOAuthURL, decodeAuthSessionCookie, extractWorkspaceId } from '../../scripts/lib/openai-oauth.js';

describe('OAuth PKCE Helpers', () => {
  it('generatePKCE returns 3 fields with correct structure', () => {
    const pkce = generatePKCE();
    assert.ok(pkce.codeVerifier, 'codeVerifier should exist');
    assert.ok(pkce.codeChallenge, 'codeChallenge should exist');
    assert.ok(pkce.state, 'state should exist');
    assert.strictEqual(typeof pkce.codeVerifier, 'string');
    assert.strictEqual(typeof pkce.codeChallenge, 'string');
    assert.strictEqual(typeof pkce.state, 'string');
  });

  it('generatePKCE codeChallenge is base64url of sha256(codeVerifier)', () => {
    const pkce = generatePKCE();
    // Decode codeChallenge from base64url
    const pad = '='.repeat((4 - (pkce.codeChallenge.length % 4)) % 4);
    const decodedChallenge = Buffer.from(pkce.codeChallenge.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
    const expectedHash = crypto.createHash('sha256').update(pkce.codeVerifier).digest();
    assert.deepStrictEqual(decodedChallenge, expectedHash);
  });

  it('generatePKCE generates unique values each call', () => {
    const pkce1 = generatePKCE();
    const pkce2 = generatePKCE();
    assert.notStrictEqual(pkce1.codeVerifier, pkce2.codeVerifier);
    assert.notStrictEqual(pkce1.codeChallenge, pkce2.codeChallenge);
    assert.notStrictEqual(pkce1.state, pkce2.state);
  });
});

describe('buildOAuthURL', () => {
  it('includes all required OAuth params', () => {
    const pkce = generatePKCE();
    const url = buildOAuthURL(pkce);
    assert.ok(url.includes('client_id=app_EMoamEEZ73f0CkXaXp7hrann'));
    assert.ok(url.includes('response_type=code'));
    assert.ok(url.includes('redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback'));
    // URLSearchParams uses + for spaces in query params
    assert.ok(url.includes('scope=openid+email+profile+offline_access'));
  });

  it('includes PKCE params', () => {
    const pkce = generatePKCE();
    const url = buildOAuthURL(pkce);
    assert.ok(url.includes(`state=${encodeURIComponent(pkce.state)}`));
    assert.ok(url.includes(`code_challenge=${encodeURIComponent(pkce.codeChallenge)}`));
    assert.ok(url.includes('code_challenge_method=S256'));
  });

  it('includes Codex CLI standard params', () => {
    const pkce = generatePKCE();
    const url = buildOAuthURL(pkce);
    assert.ok(url.includes('prompt=login'));
    assert.ok(url.includes('id_token_add_organizations=true'));
    assert.ok(url.includes('codex_cli_simplified_flow=true'));
  });
});

describe('decodeAuthSessionCookie', () => {
  it('returns null for empty or invalid input', () => {
    assert.strictEqual(decodeAuthSessionCookie(null), null);
    assert.strictEqual(decodeAuthSessionCookie(''), null);
    assert.strictEqual(decodeAuthSessionCookie('invalid'), null);
    assert.strictEqual(decodeAuthSessionCookie(123), null);
  });

  it('returns null for malformed JWT (less than 2 segments)', () => {
    assert.strictEqual(decodeAuthSessionCookie('single'), null);
  });

  it('decodes valid JWT payload', () => {
    // OpenAI's oai-client-auth-session cookie uses segment 0 as payload (unusual but consistent with zc-zhangchen)
    const payload = JSON.stringify({ email: 'test@example.com', workspaces: [{ id: 'ws-123', name: 'Personal' }] });
    const encodedPayload = Buffer.from(payload).toString('base64url');
    const token = `${encodedPayload}.signature`; // Only 2 segments for OpenAI cookie
    
    const decoded = decodeAuthSessionCookie(token);
    assert.ok(decoded);
    assert.strictEqual(decoded.email, 'test@example.com');
    assert.ok(decoded.workspaces);
    assert.strictEqual(decoded.workspaces[0].id, 'ws-123');
  });

  it('handles base64url padding correctly', () => {
    const payload = JSON.stringify({ test: 'value' });
    const encodedPayload = Buffer.from(payload).toString('base64url');
    const token = `${encodedPayload}.signature`; // OpenAI format: segment 0 is payload
    
    const decoded = decodeAuthSessionCookie(token);
    assert.ok(decoded);
    assert.strictEqual(decoded.test, 'value');
  });

  it('returns null for invalid base64', () => {
    const token = 'header.invalid!@#.signature';
    const decoded = decodeAuthSessionCookie(token);
    assert.strictEqual(decoded, null);
  });
});

describe('extractWorkspaceId', () => {
  it('returns null for null or undefined input', () => {
    assert.strictEqual(extractWorkspaceId(null), null);
    assert.strictEqual(extractWorkspaceId(undefined), null);
  });

  it('returns null when workspaces field missing', () => {
    assert.strictEqual(extractWorkspaceId({}), null);
    assert.strictEqual(extractWorkspaceId({ email: 'test@example.com' }), null);
  });

  it('returns null when workspaces is not an array', () => {
    assert.strictEqual(extractWorkspaceId({ workspaces: 'invalid' }), null);
    assert.strictEqual(extractWorkspaceId({ workspaces: null }), null);
  });

  it('returns null when workspaces array is empty', () => {
    assert.strictEqual(extractWorkspaceId({ workspaces: [] }), null);
  });

  it('extracts workspace ID from first workspace', () => {
    const decoded = {
      workspaces: [
        { id: 'ws-abc-123', name: 'Personal', role: 'owner' },
        { id: 'ws-def-456', name: 'Team', role: 'member' }
      ]
    };
    assert.strictEqual(extractWorkspaceId(decoded), 'ws-abc-123');
  });

  it('returns null when first workspace has no id', () => {
    const decoded = {
      workspaces: [
        { name: 'Personal', role: 'owner' },
        { id: 'ws-def-456', name: 'Team', role: 'member' }
      ]
    };
    assert.strictEqual(extractWorkspaceId(decoded), null);
  });

  it('returns null when first workspace id is falsy', () => {
    const decoded = {
      workspaces: [
        { id: '', name: 'Personal', role: 'owner' },
        { id: 'ws-def-456', name: 'Team', role: 'member' }
      ]
    };
    assert.strictEqual(extractWorkspaceId(decoded), null);
  });
});
