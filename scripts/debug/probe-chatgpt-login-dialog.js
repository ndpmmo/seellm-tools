import { setTimeout as sleep } from 'node:timers/promises';

const CAMOUFOX_API = process.env.CAMOUFOX_API || 'http://localhost:3144';
const userId = `probe_chatgpt_${Date.now()}`;
const sessionKey = `probe_chatgpt_modal_${Date.now()}`;

async function post(path, body) {
  const res = await fetch(`${CAMOUFOX_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function del(path) {
  await fetch(`${CAMOUFOX_API}${path}`, { method: 'DELETE' });
}

async function main() {
  const created = await post('/tabs', {
    userId,
    sessionKey,
    url: 'https://chatgpt.com/',
    persistent: false,
    os: 'macos',
    screen: { width: 1440, height: 900 },
    humanize: true,
    headless: false,
    randomFonts: true,
    canvas: 'random',
  });
  const tabId = created.tabId;
  try {
    await sleep(3000);
    await post(`/tabs/${tabId}/eval`, {
      userId,
      expression: `(() => {
        const btn = document.querySelector('[data-testid="login-button"]');
        if (!btn) return { ok: false, reason: 'no-login-button' };
        btn.click();
        return { ok: true, text: (btn.innerText || btn.textContent || '').trim(), testId: btn.getAttribute('data-testid') };
      })()`,
    });
    await sleep(3000);
    const result = await post(`/tabs/${tabId}/eval`, {
      userId,
      expression: `(() => {
        const norm = (v) => (v || '').trim();
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]')).filter(isVisible);
        return {
          href: location.href,
          title: document.title,
          dialogs: dialogs.map((dialog) => ({
            text: norm((dialog.innerText || dialog.textContent || '').slice(0, 300)),
            fields: Array.from(dialog.querySelectorAll('input, button, a, [role="button"]'))
              .filter(isVisible)
              .map((el) => ({
                tag: el.tagName.toLowerCase(),
                type: el.getAttribute('type'),
                name: el.getAttribute('name'),
                placeholder: el.getAttribute('placeholder'),
                aria: el.getAttribute('aria-label'),
                testId: el.getAttribute('data-testid'),
                text: norm(el.innerText || el.textContent || el.value || ''),
              }))
              .slice(0, 20),
          })),
        };
      })()`,
    });
    console.log(JSON.stringify(result.result || result, null, 2));
  } finally {
    await del(`/tabs/${tabId}?userId=${userId}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
