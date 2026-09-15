(() => {
  'use strict';
  if (!location.pathname.startsWith('/sources')) return;

  const FALLBACK = '7.2';
  let label = `Source Fabric · v${FALLBACK} · Beast Adaptive`;

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

  const observer = new MutationObserver(() => {
    if (apply()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadVersion, { once: true });
  } else {
    loadVersion();
  }

  setTimeout(() => { apply(); observer.disconnect(); }, 12000);
})();
