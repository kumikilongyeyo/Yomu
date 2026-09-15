(() => {
  'use strict';
  if (!location.pathname.startsWith('/sources')) return;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));

  let running = false;

  async function inspect() {
    if (running) return;
    const panel = document.getElementById('yomu-source-fabric-command');
    if (!panel) return;
    const status = panel.querySelector('.sf-status');
    const input = panel.querySelector('input');
    if (!status || !input) return;
    if (!/HTTP\s+502/i.test(status.textContent || '')) return;

    let host = '';
    try {
      const raw = String(input.value || '').trim();
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw)
        .hostname.toLowerCase().replace(/^www\./, '');
    } catch { return; }
    if (host !== 'kagane.to' && !host.endsWith('.kagane.to')) return;
    if (status.dataset.fabricDiagnosed === '1') return;

    status.dataset.fabricDiagnosed = '1';
    running = true;
    try {
      const response = await fetch('/api/fabric/source/kagane/health', {
        cache: 'no-store',
        signal: AbortSignal.timeout(20000),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        status.innerHTML = '<span class="sf-ok">✓ Kagane provider is answering now.</span> Press Add source again.';
        return;
      }
      const message = body.error || `Kagane provider returned HTTP ${response.status}.`;
      status.innerHTML = '<span class="sf-bad">' + escapeHtml(message) + '</span>';
      const result = panel.querySelector('.sf-result');
      const note = result?.querySelector('p');
      if (note) note.textContent = message;
      const tags = result?.querySelector('.sf-tags');
      if (tags) {
        tags.innerHTML = [body.provider, body.upstreamStatus ? `upstream HTTP ${body.upstreamStatus}` : '']
          .filter(Boolean)
          .map((x) => `<span class="sf-chip">${escapeHtml(x)}</span>`)
          .join('');
      }
    } catch (error) {
      status.innerHTML = '<span class="sf-bad">Could not read the Kagane diagnostic: ' + escapeHtml(error?.message || error) + '</span>';
    } finally {
      running = false;
    }
  }

  let timer = null;
  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(inspect, 80);
  });
  observer.observe(document.documentElement, { childList:true, subtree:true, characterData:true });
  setTimeout(inspect, 300);
})();
