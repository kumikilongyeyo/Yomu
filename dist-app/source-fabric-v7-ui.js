(() => {
  'use strict';
  if (!location.pathname.startsWith('/sources')) return;

  const FALLBACK = '7.4';
  const MAX_SMART_INPUTS = 25;
  let label = `Source Fabric · v${FALLBACK} · Recipe Adaptive`;

  function apply() {
    const kicker = document.querySelector('#yomu-source-fabric-command .sf-kicker');
    if (!kicker) return false;
    if (kicker.textContent !== label) kicker.textContent = label;
    const panel = document.getElementById('yomu-source-fabric-command');
    if (panel) panel.dataset.fabricVersion = label.match(/v([0-9.]+)/)?.[1] || FALLBACK;
    return true;
  }

  async function loadVersion() {
    try {
      const response = await fetch('/api/fabric/status', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const status = response.ok ? await response.json() : null;
      if (status?.version) {
        label = `Source Fabric · v${status.version}${status.generation ? ` · ${status.generation}` : ''}`;
      }
    } catch {}
    apply();
  }

  function splitSmartInput(raw) {
    // Names may contain spaces. Only a newline or comma starts a new candidate.
    return String(raw || '')
      .split(/\r?\n|,/)
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, MAX_SMART_INPUTS);
  }

  function directUrl(value) {
    const raw = String(value || '').trim();
    if (!raw || /\s/.test(raw)) return '';
    const looksLikeHost = /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(raw);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !looksLikeHost) return '';
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (!/^https?:$/.test(url.protocol)) return '';
      url.hash = '';
      return url.toString();
    } catch {
      return '';
    }
  }

  async function resolveMaintainedName(name) {
    try {
      const response = await fetch(`/api/fabric/stores/search?q=${encodeURIComponent(name)}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) return null;
      const payload = await response.json().catch(() => null);
      if (!payload?.best?.baseUrl) return null;
      return payload.best;
    } catch {
      return null;
    }
  }

  function armSmartSourcePack() {
    const pack = document.getElementById('yomu-source-pack-mode');
    const textarea = pack?.querySelector('textarea');
    const run = pack?.querySelector('.sp-run');
    const summary = pack?.querySelector('.sp-summary');
    const meta = pack?.querySelector('.sp-meta b');
    if (!pack || !textarea || !run || run.dataset.yomuSmartInput === '1') return !!(pack && textarea && run);

    run.dataset.yomuSmartInput = '1';
    textarea.placeholder = 'https://site.example\nComicHubFree\nRead Comics Online';
    if (meta) meta.textContent = 'Paste one site URL or maintained source name per line';

    run.addEventListener('click', async (event) => {
      if (run.dataset.yomuSmartBypass === '1') return;
      const entries = splitSmartInput(textarea.value);
      if (!entries.length) return;

      const names = entries.filter((entry) => !directUrl(entry));
      if (!names.length) return; // Plain URLs continue through the existing fast path.

      event.preventDefault();
      event.stopImmediatePropagation();

      run.disabled = true;
      if (summary) summary.textContent = `Resolving ${names.length} maintained source name${names.length === 1 ? '' : 's'}…`;

      const resolved = await Promise.all(entries.map(async (entry) => {
        const url = directUrl(entry);
        if (url) return { input: entry, url, resolvedBy: 'url' };
        const match = await resolveMaintainedName(entry);
        return match?.baseUrl
          ? { input: entry, url: match.baseUrl, resolvedBy: match.storeName || match.ecosystem || 'federation', name: match.name }
          : { input: entry, url: '', resolvedBy: '' };
      }));

      const urls = [];
      const seen = new Set();
      const unresolved = [];
      let namesResolved = 0;
      for (const row of resolved) {
        if (!row.url) {
          unresolved.push(row.input);
          continue;
        }
        let key = row.url;
        try { key = new URL(row.url).origin.toLowerCase(); } catch {}
        if (seen.has(key)) continue;
        seen.add(key);
        urls.push(row.url);
        if (row.resolvedBy !== 'url') namesResolved += 1;
      }

      const originalInput = textarea.value;
      textarea.value = urls.join('\n');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      run.disabled = false;

      if (!urls.length) {
        textarea.value = originalInput;
        if (summary) summary.textContent = `No maintained source names could be resolved. ${unresolved.join(', ')}`;
        return;
      }

      if (summary) {
        summary.textContent = unresolved.length
          ? `${namesResolved} name${namesResolved === 1 ? '' : 's'} resolved · ${unresolved.length} unresolved and skipped`
          : `${namesResolved} maintained source name${namesResolved === 1 ? '' : 's'} resolved · testing real site URLs…`;
      }

      // The old bulk runner still consumes canonical URLs. Feed those to it
      // synchronously, then restore what the user actually pasted so the UI
      // does not appear to mutate their source names.
      run.dataset.yomuSmartBypass = '1';
      try {
        run.click();
        textarea.value = originalInput;
      } finally {
        delete run.dataset.yomuSmartBypass;
      }
    }, true);

    return true;
  }

  const observer = new MutationObserver(() => {
    apply();
    armSmartSourcePack();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      loadVersion();
      armSmartSourcePack();
    }, { once: true });
  } else {
    loadVersion();
    armSmartSourcePack();
  }

  setTimeout(() => {
    apply();
    armSmartSourcePack();
    observer.disconnect();
  }, 12000);
})();