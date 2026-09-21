(() => {
  'use strict';

  // One public source entry point. Source Fabric decides what the pasted link is;
  // the old source-pack controls remain internal implementation details.
  const onSourcesRoute = () => /^\/sources(?:\.html)?\/?$/.test(location.pathname);
  const ROOT_ID = 'yomu-source-fabric-command';
  const PACK_ID = 'yomu-source-pack-mode';
  const LEGACY_TOP_ID = 'yomu-community-pack-top';
  const STYLE_ID = 'yomu-unified-source-entry-style';
  const COMMUNITY_RAW = 'https://raw.githubusercontent.com/kumikilongyeyo/Yomu/main/dist-app/source-packs/community.json';

  function classify(value) {
    const raw = String(value || '').trim();
    if (!raw) return { kind: 'empty', value: '' };
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      const path = url.pathname.toLowerCase();
      const parts = url.pathname.split('/').filter(Boolean);
      const jsonLike = /\.json(?:$|[?#])/i.test(url.toString())
        || /\/source-packs\//i.test(path)
        || host === 'raw.githubusercontent.com';
      if (jsonLike) return { kind: 'pack', value: url.toString() };
      if (host === 'github.com' && parts.length >= 2) return { kind: 'repository', value: url.toString() };
      return { kind: 'website', value: url.toString() };
    } catch {
      return { kind: 'invalid', value: raw };
    }
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* There is one visible text box. Bulk/JSON controls are backend helpers. */
      #${ROOT_ID} .sf-mode-switch{display:none!important}
      #${PACK_ID} .sp-json-import{display:none!important}
      #${PACK_ID} textarea,#${PACK_ID} .sp-meta,#${PACK_ID} .sp-clear{display:none!important}
      #${PACK_ID}.is-active{display:block!important;margin-top:10px}
      #${PACK_ID}:not(.is-active){display:none!important}
      #${PACK_ID} .sp-actions{margin-top:0!important}
      #${PACK_ID} .sp-run{min-width:190px}
      #${ROOT_ID} .sf-unified-community{height:48px;background:var(--surface2,var(--surface,#111b25));color:var(--text,#f7f8fa);border:1px solid var(--line,#263747);padding:0 15px}
      #${ROOT_ID} .sf-kind{display:inline-flex;align-items:center;gap:6px;margin-top:7px;padding:4px 8px;border:1px solid var(--hairline,var(--line,#263747));border-radius:999px;color:var(--dim,#8297aa);font-size:10.5px;font-weight:750}
      #${ROOT_ID} .sf-kind[data-kind="repository"],#${ROOT_ID} .sf-kind[data-kind="pack"]{color:var(--accent,#ffc15a);border-color:color-mix(in srgb,var(--accent,#ffc15a) 35%,var(--line,#263747))}
      #yomu-v8-fabric-compact .y8c-source-fabric{border-color:color-mix(in srgb,var(--accent,#ffc15a) 34%,var(--line,#263747));color:var(--text,#f7f8fa)}
      @media(max-width:700px){#${ROOT_ID} .sf-unified-community{width:100%}}
    `;
    document.head.append(style);
  }

  function setInternalMode(root, mode) {
    const button = root?.querySelector(`.sf-mode-switch button[data-mode="${mode}"]`);
    if (button && !button.classList.contains('is-active')) button.click();
  }

  function showPack(root) {
    setInternalMode(root, 'pack');
    document.getElementById(PACK_ID)?.classList.add('is-active');
  }

  function showSingle(root) {
    setInternalMode(root, 'single');
    document.getElementById(PACK_ID)?.classList.remove('is-active');
  }

  function hiddenPackControls() {
    const pack = document.getElementById(PACK_ID);
    return {
      pack,
      jsonInput: pack?.querySelector('.sp-json-import input') || null,
      jsonLoad: pack?.querySelector('.sp-json-load') || null,
      community: pack?.querySelector('.sp-json-community') || null,
      run: pack?.querySelector('.sp-run') || null,
      summary: pack?.querySelector('.sp-summary') || null,
    };
  }

  function loadPackUrl(root, url) {
    const controls = hiddenPackControls();
    if (!controls.pack || !controls.jsonInput || !controls.jsonLoad) return false;
    showPack(root);
    controls.jsonInput.value = url;
    controls.jsonLoad.click();
    return true;
  }

  function loadCommunityPack(root) {
    const controls = hiddenPackControls();
    showPack(root);
    if (controls.community) {
      controls.community.click();
      return true;
    }
    if (controls.jsonInput && controls.jsonLoad) {
      controls.jsonInput.value = COMMUNITY_RAW;
      controls.jsonLoad.click();
      return true;
    }
    return false;
  }

  function addManageSourceFabric(root) {
    const bar = document.querySelector('#yomu-v8-fabric-compact .y8c-bar');
    if (!bar || bar.querySelector('.y8c-source-fabric')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'y8c-btn y8c-source-fabric';
    button.textContent = 'Source Fabric';
    button.title = 'Jump to the universal Source Fabric input';
    button.addEventListener('click', () => {
      root.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => root.querySelector('#yomu-universal-source')?.focus(), 220);
    });
    const label = bar.querySelector('.y8c-label');
    if (label?.nextSibling) bar.insertBefore(button, label.nextSibling);
    else bar.append(button);
  }

  function mount() {
    if (!onSourcesRoute()) return false;
    ensureStyle();
    document.getElementById(LEGACY_TOP_ID)?.remove();

    const root = document.getElementById(ROOT_ID);
    const form = root?.querySelector('.sf-form');
    const input = root?.querySelector('#yomu-universal-source');
    const submit = form?.querySelector('button[type="submit"]');
    if (!root || !form || !input || !submit) return false;

    // Rename the existing field instead of creating another one.
    const label = form.querySelector('label[for="yomu-universal-source"]');
    if (label) label.textContent = 'Website, GitHub repository, or source pack';
    input.placeholder = 'Paste a website or GitHub link';

    let kind = form.querySelector('.sf-kind');
    if (!kind) {
      kind = document.createElement('span');
      kind.className = 'sf-kind';
      kind.dataset.kind = 'empty';
      kind.textContent = 'Auto detect';
      form.querySelector('.sf-field')?.append(kind);
    }

    let communityButton = form.querySelector('.sf-unified-community');
    if (!communityButton) {
      communityButton = document.createElement('button');
      communityButton.type = 'button';
      communityButton.className = 'sf-unified-community';
      communityButton.textContent = 'Community pack';
      communityButton.title = 'Load only new sources from the Yomu Community Pack';
      communityButton.addEventListener('click', () => {
        if (!loadCommunityPack(root)) {
          const status = root.querySelector('.sf-status');
          if (status) status.textContent = 'Community Pack controls are still loading. Try again.';
        }
      });
      submit.insertAdjacentElement('afterend', communityButton);
    }

    const paint = () => {
      const target = classify(input.value);
      kind.dataset.kind = target.kind;
      if (target.kind === 'repository') {
        kind.textContent = 'GitHub repository';
        submit.textContent = 'Add repository';
        showSingle(root);
      } else if (target.kind === 'pack') {
        kind.textContent = 'Source pack';
        submit.textContent = 'Load pack';
      } else if (target.kind === 'website') {
        kind.textContent = 'Website source';
        submit.textContent = 'Add source';
        showSingle(root);
      } else if (target.kind === 'invalid') {
        kind.textContent = 'Check link';
        submit.textContent = 'Add';
        showSingle(root);
      } else {
        kind.textContent = 'Auto detect';
        submit.textContent = 'Add';
        showSingle(root);
      }
    };

    if (form.dataset.unifiedSourceBound !== '1') {
      form.dataset.unifiedSourceBound = '1';
      input.addEventListener('input', paint);
      input.addEventListener('paste', () => setTimeout(paint, 0));

      // Intercept only source-pack URLs. Normal websites and GitHub repositories
      // continue through Source Fabric's existing tested code path unchanged.
      form.addEventListener('submit', (event) => {
        const target = classify(input.value);
        if (target.kind !== 'pack') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const status = root.querySelector('.sf-status');
        if (!loadPackUrl(root, target.value)) {
          if (status) status.textContent = 'Source Pack tools are still loading. Try again.';
          return;
        }
        if (status) status.textContent = 'Source pack detected. Review the count below, then test & add.';
      }, true);

      // When a GitHub repository finishes registering, expose the one useful
      // follow-up: repository management. Website additions remain unchanged.
      const result = root.querySelector('.sf-result');
      if (result) {
        new MutationObserver(() => {
          const target = classify(input.value);
          if (target.kind !== 'repository' || !result.classList.contains('show')) return;
          const title = String(result.querySelector('strong')?.textContent || '');
          if (!/repository/i.test(title)) return;
          const actions = result.querySelector('.sf-actions');
          if (!actions || actions.querySelector('.sf-manage-repo')) return;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'secondary sf-manage-repo';
          button.textContent = 'Manage repository';
          button.addEventListener('click', () => {
            const repoTab = document.querySelector('#yomu-v8-fabric-compact [data-tab="repositories"]');
            repoTab?.click();
            document.getElementById('yomu-v8-fabric-compact')?.scrollIntoView({ behavior:'smooth', block:'center' });
          });
          actions.append(button);
        }).observe(result, { childList:true, subtree:true, attributes:true, attributeFilter:['class'] });
      }
    }

    paint();
    addManageSourceFabric(root);
    return true;
  }

  let timer = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(mount, 80);
  };

  mount();
  new MutationObserver(schedule).observe(document.documentElement, { childList:true, subtree:true });
  window.addEventListener('yomu:route', schedule);
})();
