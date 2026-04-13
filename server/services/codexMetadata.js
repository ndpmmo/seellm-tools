import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import machineIdModule from 'node-machine-id';

const { machineIdSync } = machineIdModule;
let cachedMachineId = null;

function hash16(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function decodeBase64Url(value) {
  let base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64').toString('utf8');
}

export function parseCodexIdToken(idToken) {
  try {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    const authInfo = payload['https://api.openai.com/auth'] || {};
    const email = payload.email || null;
    const organizations = Array.isArray(authInfo.organizations) ? authInfo.organizations : [];

    let workspaceId = authInfo.chatgpt_account_id || null;
    let workspacePlanType = String(authInfo.chatgpt_plan_type || '').toLowerCase();

    const teamOrg = organizations.find((org) => {
      const title = String(org?.title || '').toLowerCase();
      const role = String(org?.role || '').toLowerCase();
      return (
        !org?.is_default &&
        (title.includes('team') ||
          title.includes('business') ||
          title.includes('workspace') ||
          title.includes('org') ||
          role === 'admin' ||
          role === 'member')
      );
    });

    if (!(workspacePlanType.includes('team') || workspacePlanType.includes('chatgptteam'))) {
      if (teamOrg && (workspacePlanType === 'free' || workspacePlanType === '')) {
        workspaceId = teamOrg.id || workspaceId;
        workspacePlanType = 'team';
      }
    }

    return {
      email,
      workspaceId: workspaceId || null,
      workspacePlanType: workspacePlanType || null,
      chatgptUserId: authInfo.chatgpt_user_id || null,
      organizations: organizations.length ? organizations : null,
    };
  } catch {
    return null;
  }
}

export function getConsistentMachineId() {
  if (cachedMachineId) return cachedMachineId;
  try {
    cachedMachineId = hash16(machineIdSync());
    return cachedMachineId;
  } catch {
    cachedMachineId = hash16(`${os.hostname()}|${process.platform}|${process.arch}|seellm-tools`);
    return cachedMachineId;
  }
}

export function buildStableDeviceId(existingProviderData = null, accountId = null) {
  const existing = existingProviderData && typeof existingProviderData === 'object'
    ? existingProviderData.deviceId
    : null;
  if (typeof existing === 'string' && existing.trim()) return existing.trim();
  if (accountId) return `dev_${hash16(accountId)}`;
  return `dev_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function mergeCodexProviderData(baseData = null, patchData = null) {
  const base = baseData && typeof baseData === 'object' ? baseData : {};
  const patch = patchData && typeof patchData === 'object' ? patchData : {};
  const merged = { ...base, ...patch };
  const cleaned = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
  return Object.keys(cleaned).length ? cleaned : null;
}

