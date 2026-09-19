(() => {
  'use strict';
  if (!location.pathname.startsWith('/sources')) return;

  const KEYS = {
    repositories: 'yomu.v8.repositories',
    updates: 'yomu.v8.repository-updates',
  };
  const state = {
    repositories: read(KEYS.repositories, []),
    updates: read(KEYS.updates, []),
    catalog: [],
    status: null,
    activeTab: 'sources',
  };

  function read(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  }

  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, className = '') {
    const node = el('button', `y8-btn ${className}`.trim(), text);
    node.type = 'button';
    return node;
  }

  function relativeTime(value) {
    if (!value) return 'Unknown';
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return 'Unknown';
    const delta = Date.now() - time;
    const abs = Math.abs(delta);
    if (abs < 60_000) return 'just now';
    if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ago`;
    if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ago`;
    if (abs < 2_592_000_000) return `${Math.round(abs / 86_400_000)}d ago`;
    return new Date(value).toLocaleDateString();
  }

  function repoState(repo) {
    if (repo.lastError) return 'needs-action';
    if (!repo.verifiedFormat || repo.compatibility === 'review') return 'degraded';
    return 'healthy';
  }

  function humanState(value) {
    if (value === 'needs-action') return 'Needs action';
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function recordUpdate(repo, type, message) {
    state.updates.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      repositoryId: repo.id,
      repositoryName: repo.name,
      type,
      message,
      at: new Date().toISOString(),
    });
    state.updates = state.updates.slice(0, 80);
    write(KEYS.updates, state.updates);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      cache: 'no-store',
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  async function detectRepository(input) {
    const payload = await api('/api/fabric/repositories/detect', {
      method: 'POST',
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(30_000),
    });
    return payload.repository;
  }

  function formatCount(value) {
    return Number.isFinite(Number(value)) ? `${Number(value).toLocaleString()} sources` : 'Source count unavailable';
  }

  function runtimeCopy(repo) {
    const map = {
      DIRECT_HTTP: 'Ready',
      AIDOKU_WASM: 'Uses Aidoku runtime',
      MANGAYOMI_SCRIPT: 'Uses script runtime',
      MIHON_ANDROID: 'Uses Mihon/Suwayomi runtime',
      PAPERBACK: 'Uses Paperback runtime',
      BROWSER_REQUIRED: 'Needs verification',
      AUTH_REQUIRED: 'Sign in required',
      BROKEN: 'Unavailable',
    };
    return map[repo.runtimeClass] || 'Compatibility review';
  }

  function sourceSystemLabel() {
    const kicker = document.querySelector('#yomu-source-fabric-command .sf-kicker');
    if (kicker) kicker.textContent = 'Source system ready';
  }

  function focusAddSource() {
    const textarea = document.querySelector('#yomu-source-pack-mode textarea');
    if (textarea) {
      textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
      textarea.focus();
      return;
    }
    const add = [...document.querySelectorAll('button,a')].find((node) => /add source/i.test(node.textContent || ''));
    if (add) add.click();
  }

  function makeShell() {
    if (document.getElementById('yomu-v8-fabric')) return document.getElementById('yomu-v8-fabric');
    const shell = el('section', 'y8-shell');
    shell.id = 'yomu-v8-fabric';

    const header = el('div', 'y8-header');
    const titleWrap = el('div', 'y8-title-wrap');
    titleWrap.append(el('div', 'y8-eyebrow', 'SOURCES'), el('h2', 'y8-title', 'Source system ready'));
    const summary = el('div', 'y8-summary');
    summary.id = 'y8-summary';
    titleWrap.append(summary);

    const actions = el('div', 'y8-actions');
    const addSource = button('+ Add Source', 'y8-secondary');
    addSource.addEventListener('click', focusAddSource);
    const addRepo = button('+ Add Repository', 'y8-primary');
    addRepo.addEventListener('click', () => openRepositoryDialog());
    const check = button('↻ Check Updates', 'y8-secondary');
    check.id = 'y8-check-updates';
    check.addEventListener('click', () => checkAllRepositories(check));
    actions.append(addSource, addRepo, check);
    header.append(titleWrap, actions);

    const tabs = el('div', 'y8-tabs');
    tabs.setAttribute('role', 'tablist');
    const tabData = [
      ['sources', 'My Sources'],
      ['repositories', 'Repositories'],
      ['updates', 'Updates'],
      ['advanced', 'Advanced'],
    ];
    for (const [id, label] of tabData) {
      const tab = button(label, 'y8-tab');
      tab.dataset.tab = id;
      tab.setAttribute('role', 'tab');
      tab.addEventListener('click', () => setTab(id));
      tabs.append(tab);
    }

    const pane = el('div', 'y8-pane');
    pane.id = 'y8-pane';
    shell.append(header, tabs, pane);

    const anchor = document.getElementById('yomu-source-fabric-command');
    if (anchor?.parentNode) anchor.parentNode.insertBefore(shell, anchor);
    else {
      const root = document.querySelector('main') || document.querySelector('#root') || document.body;
      root.prepend(shell);
    }
    return shell;
  }

  function updateSummary() {
    const summary = document.getElementById('y8-summary');
    if (!summary) return;
    if (!state.repositories.length) {
      summary.textContent = 'Add a website/source or a community repository. Yomu handles the engine choice.';
      return;
    }
    const counts = { healthy: 0, degraded: 0, 'needs-action': 0 };
    for (const repo of state.repositories) counts[repoState(repo)] += 1;
    summary.textContent = `${counts.healthy} healthy · ${counts.degraded} degraded · ${counts['needs-action']} needs action · ${state.repositories.length} repositories`;
  }

  function setTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('.y8-tab').forEach((node) => {
      const active = node.dataset.tab === tab;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderPane();
    if (tab === 'sources') {
      const legacy = document.getElementById('yomu-source-fabric-command');
      legacy?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function renderPane() {
    const pane = document.getElementById('y8-pane');
    if (!pane) return;
    pane.replaceChildren();
    if (state.activeTab === 'sources') {
      const callout = el('div', 'y8-source-callout');
      callout.append(
        el('strong', '', 'One input, one mental model.'),
        el('span', '', ' Paste a site URL or maintained source name below. Runtime details stay hidden unless you open Advanced.'),
      );
      pane.append(callout);
      return;
    }
    if (state.activeTab === 'repositories') return renderRepositories(pane);
    if (state.activeTab === 'updates') return renderUpdates(pane);
    return renderAdvanced(pane);
  }

  function renderRepositories(pane) {
    const toolbar = el('div', 'y8-pane-toolbar');
    const text = el('div', '');
    text.append(el('strong', '', 'Community repositories'), el('span', 'y8-muted', ' · registered feeds, health, freshness and safe update state'));
    const browse = button('Browse recommended', 'y8-secondary');
    browse.addEventListener('click', () => openRecommendedDialog());
    toolbar.append(text, browse);
    pane.append(toolbar);

    if (!state.repositories.length) {
      const empty = el('div', 'y8-empty');
      empty.append(el('strong', '', 'No repositories yet'), el('p', '', 'Paste a normal GitHub repository URL. Yomu will find the manifest and ecosystem for you.'));
      const add = button('Add Repository', 'y8-primary');
      add.addEventListener('click', () => openRepositoryDialog());
      empty.append(add);
      pane.append(empty);
      return;
    }

    const grid = el('div', 'y8-repo-grid');
    for (const repo of state.repositories) grid.append(repositoryCard(repo));
    pane.append(grid);
  }

  function repositoryCard(repo) {
    const card = el('article', 'y8-repo-card');
    const top = el('div', 'y8-repo-top');
    const nameWrap = el('div', 'y8-repo-name-wrap');
    nameWrap.append(el('strong', 'y8-repo-name', repo.name), el('span', 'y8-chip', String(repo.ecosystem || 'unknown').toUpperCase()));
    const health = el('span', `y8-health y8-${repoState(repo)}`, humanState(repoState(repo)));
    top.append(nameWrap, health);

    const meta = el('div', 'y8-repo-meta');
    meta.append(
      el('span', '', formatCount(repo.sourceCount)),
      el('span', '', `Updated ${relativeTime(repo.lastRepositoryUpdate || repo.lastChecked)}`),
      el('span', '', runtimeCopy(repo)),
    );

    const trust = el('div', 'y8-trust');
    trust.textContent = repo.trust === 'community-maintained'
      ? 'Community maintained · recognized ecosystem'
      : repo.trust === 'verified-format'
        ? 'Verified repository format'
        : 'Custom repository · review before enabling sources';

    if (repo.updateState) {
      const update = el('div', `y8-update-state y8-update-${repo.updateState}`);
      update.textContent = repo.updateState === 'available'
        ? 'Repository update available'
        : repo.updateState === 'rolled-back'
          ? 'Newest update rejected · previous metadata kept'
          : repo.updateState === 'failed'
            ? 'Update check failed'
            : 'Up to date';
      card.append(update);
    }

    const actions = el('div', 'y8-card-actions');
    const check = button('Check update', 'y8-secondary');
    check.addEventListener('click', () => checkRepository(repo.id, check));
    const pause = button(repo.paused ? 'Resume updates' : 'Pause updates', 'y8-ghost');
    pause.addEventListener('click', () => {
      repo.paused = !repo.paused;
      repo.autoUpdate = !repo.paused;
      saveRepositories();
      recordUpdate(repo, repo.paused ? 'paused' : 'resumed', repo.paused ? 'Automatic checks paused.' : 'Automatic checks resumed.');
      renderPane();
    });
    const remove = button('Remove', 'y8-danger');
    remove.addEventListener('click', () => {
      if (!confirm(`Remove ${repo.name} from Yomu? Installed source data is not touched.`)) return;
      state.repositories = state.repositories.filter((row) => row.id !== repo.id);
      saveRepositories();
      recordUpdate(repo, 'removed', 'Repository removed from the manager.');
      updateSummary();
      renderPane();
    });
    actions.append(check, pause, remove);

    card.append(top, meta, trust);
    if (repo.lastError) card.append(el('div', 'y8-error', repo.lastError));
    card.append(actions);
    return card;
  }

  function renderUpdates(pane) {
    const toolbar = el('div', 'y8-pane-toolbar');
    toolbar.append(el('strong', '', 'Update history'));
    const clear = button('Clear history', 'y8-ghost');
    clear.addEventListener('click', () => {
      state.updates = [];
      write(KEYS.updates, state.updates);
      renderPane();
    });
    toolbar.append(clear);
    pane.append(toolbar);

    if (!state.updates.length) {
      pane.append(el('div', 'y8-empty', 'No repository updates or incidents yet.'));
      return;
    }
    const list = el('div', 'y8-update-list');
    for (const item of state.updates) {
      const row = el('div', 'y8-update-row');
      const icon = el('span', `y8-update-dot y8-dot-${item.type}`);
      const copy = el('div', '');
      copy.append(el('strong', '', item.repositoryName), el('div', 'y8-muted', item.message));
      row.append(icon, copy, el('time', 'y8-update-time', relativeTime(item.at)));
      list.append(row);
    }
    pane.append(list);
  }

  function renderAdvanced(pane) {
    const note = el('div', 'y8-advanced-note');
    note.append(el('strong', '', 'Developer diagnostics'), el('span', '', ' Runtime classes, broker state and repository probe details live here so the normal Sources view can stay boring.'));
    pane.append(note);
    const pre = el('pre', 'y8-json');
    pre.textContent = state.status ? JSON.stringify(state.status, null, 2) : 'Loading diagnostics…';
    pane.append(pre);
    if (!state.status) loadStatus().then(() => { if (state.activeTab === 'advanced') renderPane(); });
  }

  function saveRepositories() {
    write(KEYS.repositories, state.repositories);
  }

  async function checkRepository(id, control) {
    const repo = state.repositories.find((row) => row.id === id);
    if (!repo) return;
    if (repo.paused) {
      recordUpdate(repo, 'paused', 'Update check skipped because updates are paused.');
      return;
    }
    const previousText = control?.textContent;
    if (control) { control.disabled = true; control.textContent = 'Testing…'; }
    try {
      const candidate = await detectRepository(repo.repositoryUrl);
      const changed = candidate.fingerprint !== repo.fingerprint;
      repo.lastChecked = new Date().toISOString();
      repo.lastError = '';
      if (!changed) {
        repo.updateState = 'current';
        recordUpdate(repo, 'current', 'Repository checked · already up to date.');
      } else if (!candidate.verifiedFormat || candidate.compatibility === 'review') {
        repo.updateState = 'rolled-back';
        repo.lastRejectedCandidate = candidate;
        recordUpdate(repo, 'rolled-back', 'New metadata failed the compatibility gate. Previous known-good metadata was kept.');
      } else {
        repo.lastKnownGood = { ...repo };
        Object.assign(repo, candidate, {
          paused: repo.paused,
          autoUpdate: repo.autoUpdate !== false,
          lastChecked: new Date().toISOString(),
          updateState: 'current',
          lastError: '',
        });
        recordUpdate(repo, 'updated', 'Repository metadata changed, passed the format gate, and became the active known-good version.');
      }
      saveRepositories();
    } catch (error) {
      repo.lastChecked = new Date().toISOString();
      repo.lastError = error.message || String(error);
      repo.updateState = 'failed';
      recordUpdate(repo, 'failed', `Update check failed: ${repo.lastError}`);
      saveRepositories();
    } finally {
      if (control) { control.disabled = false; control.textContent = previousText || 'Check update'; }
      updateSummary();
      if (state.activeTab === 'repositories') renderPane();
    }
  }

  async function checkAllRepositories(control) {
    const runnable = state.repositories.filter((repo) => !repo.paused);
    if (!runnable.length) {
      if (!state.repositories.length) openRepositoryDialog();
      return;
    }
    const original = control.textContent;
    control.disabled = true;
    for (let i = 0; i < runnable.length; i += 1) {
      control.textContent = `Checking ${i + 1}/${runnable.length}…`;
      await checkRepository(runnable[i].id, null);
    }
    control.disabled = false;
    control.textContent = original;
  }

  function dialogFrame(title, subtitle) {
    const overlay = el('div', 'y8-dialog-overlay');
    overlay.setAttribute('role', 'presentation');
    const dialog = el('div', 'y8-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const head = el('div', 'y8-dialog-head');
    const words = el('div', '');
    words.append(el('h3', '', title), el('p', '', subtitle));
    const close = button('×', 'y8-close');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => overlay.remove());
    head.append(words, close);
    const body = el('div', 'y8-dialog-body');
    dialog.append(head, body);
    overlay.append(dialog);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.remove(); });
    document.body.append(overlay);
    return { overlay, dialog, body };
  }

  function previewBlock(repo) {
    const box = el('div', 'y8-preview');
    const line = (label, value) => {
      const row = el('div', 'y8-preview-row');
      row.append(el('span', 'y8-muted', label), el('strong', '', value));
      box.append(row);
    };
    line('Repository', repo.owner ? `${repo.owner} / ${repo.name}` : repo.name);
    line('Detected ecosystem', String(repo.ecosystem || 'unknown'));
    line('Inventory', formatCount(repo.sourceCount));
    line('Freshness', repo.lastRepositoryUpdate ? relativeTime(repo.lastRepositoryUpdate) : 'Unknown');
    line('Trust', String(repo.trust || 'custom-unverified').replaceAll('-', ' '));
    line('Compatibility', runtimeCopy(repo));
    if (repo.warnings?.length) {
      const warnings = el('div', 'y8-preview-warnings');
      for (const warning of repo.warnings) warnings.append(el('div', '', warning));
      box.append(warnings);
    }
    return box;
  }

  function openRepositoryDialog(prefill = '') {
    const { overlay, body } = dialogFrame('Add Repository', 'Paste a normal GitHub or supported repository URL. Yomu will hunt for the manifest.');
    const field = el('input', 'y8-input');
    field.type = 'url';
    field.placeholder = 'https://github.com/owner/repository';
    field.value = prefill;
    const status = el('div', 'y8-dialog-status');
    const actions = el('div', 'y8-dialog-actions');
    const inspect = button('Inspect Repository', 'y8-primary');
    actions.append(inspect);
    body.append(field, status, actions);
    setTimeout(() => field.focus(), 0);

    let preview = null;
    inspect.addEventListener('click', async () => {
      const input = field.value.trim();
      if (!input) return;
      inspect.disabled = true;
      inspect.textContent = 'Finding manifest…';
      status.replaceChildren(el('div', 'y8-loading', 'Detecting ecosystem, source count and compatibility…'));
      try {
        preview = await detectRepository(input);
        status.replaceChildren(previewBlock(preview));
        inspect.textContent = 'Add Repository';
        inspect.disabled = false;
        const add = button('Add Repository', 'y8-primary');
        actions.replaceChildren(add);
        add.addEventListener('click', () => {
          const existing = state.repositories.find((repo) => repo.repositoryUrl === preview.repositoryUrl);
          if (existing) {
            Object.assign(existing, preview, { lastChecked: new Date().toISOString() });
            recordUpdate(existing, 'refreshed', 'Repository registration refreshed.');
          } else {
            const record = {
              ...preview,
              autoUpdate: preview.trust !== 'custom-unverified',
              paused: false,
              updateState: 'current',
              lastChecked: new Date().toISOString(),
              lastKnownGood: null,
              lastError: '',
            };
            state.repositories.push(record);
            recordUpdate(record, 'added', 'Repository registered. Sources are discoverable but are not bulk-enabled automatically.');
          }
          saveRepositories();
          updateSummary();
          overlay.remove();
          setTab('repositories');
        });
      } catch (error) {
        status.replaceChildren(el('div', 'y8-error', error.message || String(error)));
        inspect.disabled = false;
        inspect.textContent = 'Try Again';
      }
    });
  }

  async function openRecommendedDialog() {
    const { overlay, body } = dialogFrame('Recommended repositories', 'Curated community feeds that expand coverage. Nothing is enabled in bulk without your choice.');
    const loading = el('div', 'y8-loading', 'Loading repository catalog…');
    body.append(loading);
    try {
      if (!state.catalog.length) {
        const payload = await api('/api/fabric/repositories/catalog', { signal: AbortSignal.timeout(15_000) });
        state.catalog = payload.repositories || [];
      }
      const list = el('div', 'y8-recommended-list');
      for (const item of state.catalog) {
        const row = el('div', 'y8-recommended-row');
        const copy = el('div', '');
        copy.append(el('strong', '', item.name), el('div', 'y8-muted', `${String(item.ecosystem).toUpperCase()} · ${(item.pack || []).join(' · ')}`));
        const add = button('Inspect', 'y8-secondary');
        add.addEventListener('click', () => { overlay.remove(); openRepositoryDialog(item.url); });
        row.append(copy, add);
        list.append(row);
      }
      body.replaceChildren(list);
    } catch (error) {
      body.replaceChildren(el('div', 'y8-error', error.message || String(error)));
    }
  }

  async function loadStatus() {
    try { state.status = await api('/api/fabric/status', { signal: AbortSignal.timeout(15_000) }); }
    catch (error) { state.status = { ok: false, error: error.message || String(error) }; }
  }

  function init() {
    sourceSystemLabel();
    makeShell();
    updateSummary();
    setTab('sources');
    loadStatus();

    const observer = new MutationObserver(() => sourceSystemLabel());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 12_000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
