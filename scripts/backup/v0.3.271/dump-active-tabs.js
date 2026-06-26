import { camofoxGet, evalJson } from './lib/camofox.js';

async function run() {
  try {
    const tabs = await camofoxGet('/tabs');
    console.log('Active Camofox Tabs:', JSON.stringify(tabs, null, 2));
    
    if (Array.isArray(tabs)) {
      for (const t of tabs) {
        console.log(`\n--- Tab: ${t.tabId} (${t.url}) ---`);
        try {
          const html = await evalJson(t.tabId, t.userId || 'seellm_warmup_acc_15c0be87', `(() => {
            // Find prompt textarea and its siblings
            const ta = document.querySelector('#prompt-textarea');
            if (!ta) return 'No prompt textarea found';
            
            // Dump outerHTML of parent
            return {
              parentHTML: ta.parentElement?.outerHTML?.slice(0, 1500),
              sendButtonExists: !!document.querySelector('button[data-testid="send-button"]'),
              allButtons: Array.from(document.querySelectorAll('button')).map(b => ({
                id: b.id,
                testid: b.getAttribute('data-testid'),
                ariaLabel: b.getAttribute('aria-label'),
                classes: b.className,
                text: b.textContent?.trim()
              })).slice(0, 15)
            };
          })()`);
          console.dir(html, { depth: null });
        } catch (err) {
          console.error('Error fetching tab details:', err.message);
        }
      }
    }
  } catch (err) {
    console.error('Error listing tabs:', err.message);
  }
}

run();
