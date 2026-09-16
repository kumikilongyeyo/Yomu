(() => {
  'use strict';
  if (!location.pathname.startsWith('/sources')) return;

  const PACK_ID = 'yomu-source-pack-mode';

  function host(value) {
    try { return new URL(value).hostname.replace(/^www\./, '').toLowerCase(); }
    catch { return ''; }
  }

  function urlsFrom(textarea) {
    return String(textarea?.value || '')
      .split(/[\n,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function mount() {
    const pack = document.getElementById(PACK_ID);
    if (!pack || pack.dataset.communityCompactMounted === '1') return !!pack;
    pack.dataset.communityCompactMounted = '1';

    const style = document.createElement('style');
    style.textContent = `
      #${PACK_ID}[data-community-pack="1"] .sp-meta,
      #${PACK_ID}[data-community-pack="1"] textarea,
      #${PACK_ID}[data-community-pack="1"] .sp-json-import input,
      #${PACK_ID}[data-community-pack="1"] .sp-json-load,
      #${PACK_ID}[data-community-pack="1"] .sp-clear,
      #${PACK_ID}[data-community-pack="1"] .sp-results{display:none!important}
      #${PACK_ID}[data-community-pack="1"] .sp-json-import{display:flex!important;align-items:center;gap:10px;margin-bottom:10px}
      #${PACK_ID}[data-community-pack="1"] .sp-json-community{min-width:0}
      #${PACK_ID}[data-community-pack="1"] .sp-actions{margin-top:8px}
      #${PACK_ID}[data-community-pack="1"] .sp-run{min-width:190px}
    `;
    document.head.append(style);

    const textarea = pack.querySelector('textarea');
    const summary = pack.querySelector('.sp-summary');
    const run = pack.querySelector('.sp-run');
    const status = pack.querySelector('.sp-json-status');
    if (!textarea || !summary || !run) return true;

    let pending = [];
    let handledFinal = false;

    const syncLabel = () => {
      const community = pack.dataset.communityPack === '1';
      const want = community ? 'Test & add new sources' : 'Test & add source pack';
      // Guarded: this runs from an observer watching pack's own subtree, and
      // .sp-run is inside it. Assigning textContent replaces the node's child
      // even when the string is identical, so an unguarded write is a fresh
      // childList mutation that re-fires this callback -- forever.
      if (run.textContent !== want) run.textContent = want;
      if (!community) handledFinal = false;
    };

    document.addEventListener('click', (event) => {
      const button = event.target.closest('.sp-json-community');
      if (button) {
        handledFinal = false;
        queueMicrotask(syncLabel);
        return;
      }

      if (event.target.closest('.sp-run') && pack.dataset.communityPack === '1') {
        pending = urlsFrom(textarea);
        handledFinal = false;
      }
    }, true);

    const observer = new MutationObserver(() => {
      syncLabel();
      if (pack.dataset.communityPack !== '1' || handledFinal) return;

      const text = summary.textContent || '';
      const final = text.match(/^(\d+) added ·/);
      if (!final) return;

      handledFinal = true;
      const addedCount = Number(final[1]) || 0;
      const rows = [...pack.querySelectorAll('.sp-row')];
      const successfulHosts = new Set(
        rows
          .filter((row) => ['added', 'already'].includes(row.dataset.state || ''))
          .map((row) => row.querySelector('.sp-site b')?.textContent?.trim().toLowerCase())
          .filter(Boolean)
      );
      const successfulUrls = pending.filter((url) => successfulHosts.has(host(url)));

      summary.textContent = addedCount
        ? `${addedCount} Community Pack source${addedCount === 1 ? '' : 's'} added.`
        : 'No new Community Pack sources were added.';

      window.dispatchEvent(new CustomEvent('yomu:community-pack-added', {
        detail: {
          urls: successfulUrls,
          version: pack.dataset.communityVersion || '',
          added: addedCount,
        }
      }));
    });

    observer.observe(pack, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-community-pack']
    });

    if (status) {
      const statusObserver = new MutationObserver(syncLabel);
      statusObserver.observe(status, { childList: true, characterData: true, subtree: true });
    }

    syncLabel();
    return true;
  }

  if (mount()) return;
  const observer = new MutationObserver(() => {
    if (mount()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 12000);
})();
