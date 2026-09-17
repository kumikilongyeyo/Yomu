(() => {
  'use strict';
  if (!location.pathname.startsWith('/sources')) return;

  const TOP_ID = 'yomu-community-pack-top';
  const INNER_SELECTOR = '#yomu-source-pack-mode .sp-json-community';
  let syncing = false;

  function headerLine() {
    const lines = [...document.querySelectorAll('main.g-main .section-line, .g-main .section-line')];
    return lines.find((line) => [...line.querySelectorAll('button')]
      .some((button) => /check sources/i.test(button.textContent || ''))) || lines[0] || null;
  }

  function innerButton() {
    return document.querySelector(INNER_SELECTOR);
  }

  function sync() {
    if (syncing) return;
    syncing = true;
    queueMicrotask(() => {
      syncing = false;
      const top = document.getElementById(TOP_ID);
      if (!top) return;
      const inner = innerButton();
      const count = inner?.dataset?.new ?? '0';
      top.dataset.new = count;
      top.textContent = String(inner?.textContent || 'Community pack').trim() || 'Community pack';
      top.title = inner?.title || 'Load and test new sources from the Yomu Community Pack';
      top.disabled = !!inner?.disabled;
    });
  }

  function triggerCommunityPack() {
    const existing = innerButton();
    if (existing) {
      existing.click();
      return;
    }

    // Source Fabric may still be mounting or may currently be in Single source
    // mode. Switch to Source pack, then proxy the click once its real control
    // exists. The real button remains the owner of all pack-loading logic.
    document.querySelector('#yomu-source-fabric-command .sf-mode-switch button[data-mode="pack"]')?.click();
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      const inner = innerButton();
      if (inner) {
        clearInterval(timer);
        inner.click();
        sync();
      } else if (attempts >= 20) {
        clearInterval(timer);
      }
    }, 100);
  }

  function mount() {
    if (document.getElementById(TOP_ID)) return true;
    const line = headerLine();
    if (!line) return false;

    if (!document.getElementById('yomu-community-pack-top-style')) {
      const style = document.createElement('style');
      style.id = 'yomu-community-pack-top-style';
      style.textContent = `
        #${TOP_ID}{order:99;white-space:nowrap}
        #${TOP_ID}[data-new]:not([data-new="0"]){
          border-color:color-mix(in srgb,var(--accent,#ffc15a) 56%,var(--line,#263747));
          box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent,#ffc15a) 20%,transparent),0 0 18px color-mix(in srgb,var(--accent,#ffc15a) 10%,transparent)
        }
        /* The Community Pack belongs in the Sources action row. Keep the
           Source Pack panel focused on custom JSON packs and testing. */
        #yomu-source-pack-mode .sp-json-community{display:none!important}
      `;
      document.head.append(style);
    }

    const button = document.createElement('button');
    button.id = TOP_ID;
    button.type = 'button';
    button.dataset.new = '0';
    button.textContent = 'Community pack';
    button.title = 'Load and test new sources from the Yomu Community Pack';
    button.addEventListener('click', triggerCommunityPack);
    line.append(button);
    sync();
    return true;
  }

  const observer = new MutationObserver(() => {
    mount();
    sync();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-new', 'disabled', 'data-community-pack'],
  });

  mount();
  setTimeout(sync, 500);
})();
