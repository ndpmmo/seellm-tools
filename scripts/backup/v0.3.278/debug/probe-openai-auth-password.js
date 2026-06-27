import { setTimeout as sleep } from 'node:timers/promises';

const CAMOUFOX_API = process.env.CAMOUFOX_API || 'http://localhost:3144';
const PROBE_EMAIL = process.env.PROBE_EMAIL || '';
const userId = `probe_openai_password_${Date.now()}`;
const sessionKey = `probe_openai_password_${Date.now()}`;

if (!PROBE_EMAIL) {
  console.error('PROBE_EMAIL is required');
  process.exit(1);
}

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${CAMOUFOX_API}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function post(path, body) {
  return request(path, { method: 'POST', body });
}

async function del(path) {
  return request(path, { method: 'DELETE' });
}

async function evalJson(tabId, expression) {
  const out = await post(`/tabs/${tabId}/evaluate`, { userId, expression });
  return out.result ?? out;
}

async function dumpState(tabId, label) {
  const state = await evalJson(tabId, `(() => {
    const norm = (v) => (v || '').trim();
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return {
      href: location.href,
      title: document.title,
      bodyText: norm((document.body?.innerText || '').slice(0, 1200)),
      fields: Array.from(document.querySelectorAll('input, button, a, [role="button"], form'))
        .filter((el) => el.tagName.toLowerCase() === 'form' || isVisible(el))
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type'),
          name: el.getAttribute('name'),
          id: el.id || null,
          placeholder: el.getAttribute('placeholder'),
          autocomplete: el.getAttribute('autocomplete'),
          aria: el.getAttribute('aria-label'),
          testId: el.getAttribute('data-testid'),
          text: norm(el.innerText || el.textContent || el.value || ''),
        }))
        .slice(0, 40),
    };
  })()`);
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(state, null, 2));
}

async function main() {
  const created = await post('/tabs', {
    userId,
    sessionKey,
    url: 'https://auth.openai.com/log-in',
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
    await sleep(2500);
    await post(`/tabs/${tabId}/evaluate`, {
      userId,
      expression: `(() => {
        const setValue = (el, value) => {
          if (!el) return false;
          el.focus();
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        const input = document.querySelector('input[type="email"], input[name="username"], input[name="email"]');
        if (!input) return { ok: false, reason: 'no-email-input' };
        setValue(input, ${JSON.stringify(PROBE_EMAIL)});
        const submit = document.querySelector('button[type="submit"], input[type="submit"]');
        if (submit) submit.click();
        return { ok: true, clicked: !!submit, inputName: input.getAttribute('name'), inputType: input.getAttribute('type') };
      })()`,
    });
    await sleep(3500);
    await dumpState(tabId, 'OPENAI_PASSWORD_OR_NEXT_STEP');
  } finally {
    await del(`/tabs/${tabId}?userId=${userId}`).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
