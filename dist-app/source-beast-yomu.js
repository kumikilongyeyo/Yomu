(() => {
  'use strict';

  if (typeof document === 'undefined') return;
  if (!/\/add-sources\.html$/.test(location.pathname)) return;

  const params = new URLSearchParams(location.search);
  // After Source Beast publishes an extension, Source Forge returns here with
  // ?auto=1. Let the existing registry importer finish that final enable step.
  if (params.get('auto') === '1') return;

  const BEAST = 'http://127.0.0.1:4173';
  const $ = (id) => document.getElementById(id);
  const form = $('add-form');
  const sourceInput = $('source');
  const submitButton = $('add');
  const statusHost = $('status');
  const success = $('success');
  const failure = $('failure');

  if (!form || !sourceInput || !submitButton || !statusHost || !success || !failure) return;

  let currentRun = null;
  let busy = false;

  const style = document.createElement('style');
  style.textContent = `
    #beast-mode{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;font-size:12px;color:var(--dim)}
    #beast-mode .beast-dot{width:8px;height:8px;border-radius:50%;background:#79808f;box-shadow:0 0 0 4px color-mix(in srgb,#79808f 14%,transparent)}
    #beast-mode.ready .beast-dot{background:#55cf8e;box-shadow:0 0 0 4px color-mix(in srgb,#55cf8e 14%,transparent)}
    #beast-mode.warn .beast-dot{background:#e8b04b;box-shadow:0 0 0 4px color-mix(in srgb,#e8b04b 14%,transparent)}
    #beast-mode.bad .beast-dot{background:#e56a72;box-shadow:0 0 0 4px color-mix(in srgb,#e56a72 14%,transparent)}
    #beast-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:15px}
    #beast-actions button{margin:0}
    .beast-code{display:block;margin-top:10px;padding:11px 12px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--text);font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow:auto}
    .beast-state{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:5px 9px;font-size:11px;color:var(--muted);margin:4px 4px 0 0}
  `;
  document.head.appendChild(style);

  const topEyebrow = document.querySelector('main > .eyebrow');
  if (topEyebrow) topEyebrow.textContent = 'Yomu Source Beast · web source mode';
  const heading = document.querySelector('main > h1');
  if (heading) heading.textContent = 'Paste. Test. Verify. Add.';
  const intro = document.querySelector('main > h1 + p');
  if (intro) intro.textContent = 'Paste a manga, manhwa, manhua, webtoon or comic website. Source Beast tests the full reading path, asks for your verification only when the site requires it, then publishes it as a normal Yomu web source. This flow does not promote the site to a native provider.';

  submitButton.textContent = 'Test source';
  const stepFind = $('step-find');
  const stepTest = $('step-test');
  const stepAdd = $('step-add');
  if (stepFind) stepFind.innerHTML = '<b>1 · Test</b><span>Catalog → title → chapters → pages</span>';
  if (stepTest) stepTest.innerHTML = '<b>2 · Verify</b><span>Only when the website asks</span>';
  if (stepAdd) stepAdd.innerHTML = '<b>3 · Add</b><span>Publish as a Yomu web source</span>';

  const existingHint = form.querySelector('.hint');
  if (existingHint) existingHint.textContent = 'Web-source mode is locked to Source Beast for this form. Native-provider routing is skipped.';

  const mode = document.createElement('div');
  mode.id = 'beast-mode';
  mode.innerHTML = '<span class="beast-dot"></span><span id="beast-mode-text">Checking local Source Beast…</span>';
  form.appendChild(mode);

  let actionHost = $('beast-actions');
  if (!actionHost) {
    actionHost = document.createElement('div');
    actionHost.id = 'beast-actions';
    const details = failure.querySelector('details');
    if (details) details.before(actionHost);
    else failure.appendChild(actionHost);
  }

  function cleanUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('Paste a website link.');
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Paste a normal http/https website link.');
    }
    url.hash = '';
    return url.toString();
  }

  function setMode(state, text) {
    mode.classList.remove('ready', 'warn', 'bad');
    if (state) mode.classList.add(state);
    const label = $('beast-mode-text');
    if (label) label.textContent = text;
  }

  function setStage(name, state) {
    const el = $(`step-${name}`);
    if (!el) return;
    el.classList.remove('active', 'done', 'bad');
    if (state) el.classList.add(state);
  }

  function resetStages() {
    ['find', 'test', 'add'].forEach((name) => setStage(name, ''));
  }

  function spin(text) {
    statusHost.innerHTML = `<span class="spinner"></span>${text}`;
  }

  function setStatus(text) {
    statusHost.textContent = text || '';
  }

  function resetPanels() {
    success.classList.remove('show');
    failure.classList.remove('show');
    actionHost.replaceChildren();
  }

  function addAction(label, handler, secondary = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (secondary) button.classList.add('secondary');
    button.addEventListener('click', handler);
    actionHost.appendChild(button);
    return button;
  }

  function evidenceFor(run) {
    const bits = [];
    if (run.provider) bits.push(`Provider: ${run.provider}`);
    if (Number.isFinite(run.score)) bits.push(`Gauntlet: ${run.score}/100${run.grade ? ` · ${run.grade}` : ''}`);
    if (Array.isArray(run.signals) && run.signals.length) bits.push(`Signals: ${run.signals.join(', ')}`);
    if (run.publish?.error) bits.push(`Publish: ${run.publish.error}`);
    return bits.join('\n');
  }

  function renderFailure(title, note, run = currentRun) {
    success.classList.remove('show');
    failure.classList.add('show');
    $('failure-title').textContent = title;
    $('failure-note').textContent = note || '';
    const evidence = $('failure-evidence');
    const text = run ? evidenceFor(run) : '';
    if (text) {
      evidence.classList.remove('hidden');
      evidence.textContent = text;
    } else {
      evidence.classList.add('hidden');
      evidence.textContent = '';
    }
  }

  function renderReady(run) {
    failure.classList.remove('show');
    success.classList.add('show');
    $('result-name').textContent = new URL(run.url).hostname;
    $('result-note').textContent = run.message;
    $('result-score').textContent = Number.isFinite(run.score) ? `${run.score}/100` : 'Ready';
    const tags = $('result-tags');
    tags.innerHTML = `<span class="beast-state">web extension</span>${run.grade ? `<span class="beast-state">${escapeHtml(run.grade)}</span>` : ''}<span class="beast-state">no native promotion</span>`;
    const evidence = $('result-evidence');
    const text = evidenceFor(run);
    if (text) {
      evidence.classList.remove('hidden');
      evidence.textContent = text;
    } else {
      evidence.classList.add('hidden');
      evidence.textContent = '';
    }

    const builtInActions = success.querySelector('.actions');
    builtInActions.replaceChildren();
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = 'Add source';
    add.addEventListener('click', addSource);
    builtInActions.appendChild(add);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'secondary';
    retry.textContent = 'Re-test';
    retry.addEventListener('click', testSource);
    builtInActions.appendChild(retry);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
    })[char]);
  }

  async function request(path, options = {}, timeout = 150000) {
    const response = await fetch(`${BEAST}${path}`, {
      ...options,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; }
    catch { data = { error: text || `HTTP ${response.status}` }; }
    if (!response.ok) throw new Error(data.error || `Source Beast returned HTTP ${response.status}`);
    return data;
  }

  async function health({ quiet = false } = {}) {
    try {
      const info = await request('/api/source-beast/status', {}, 10000);
      if (info.ok && info.forge?.connected) {
        setMode('ready', `Source Beast ready · Source Forge ${info.forge.version || 'connected'}`);
        return true;
      }
      setMode('warn', 'Source Beast is running, but Source Forge is offline.');
      if (!quiet) {
        renderOffline('Source Forge is not running.', info.forge?.error);
      }
      return false;
    } catch (error) {
      setMode('bad', 'Local Source Beast is offline.');
      if (!quiet) renderOffline('Source Beast is not running.', error.message);
      return false;
    }
  }

  function renderOffline(title, detail = '') {
    resetPanels();
    resetStages();
    setStage('find', 'bad');
    setStatus(title);
    renderFailure(title, 'Start both local helpers, then press Test source again.', null);
    const evidence = $('failure-evidence');
    evidence.classList.remove('hidden');
    evidence.innerHTML = `${detail ? `${escapeHtml(detail)}\n\n` : ''}<span class="beast-code"># Terminal 1 — Yomu/tools/source-forge\nnpm start\n\n# Terminal 2 — universal-challenge-lab\nnpm start</span>`;
    addAction('Check again', () => health());
  }

  function renderRun(run) {
    currentRun = run;
    resetPanels();
    resetStages();
    actionHost.replaceChildren();
    setStatus(run.message || run.state);

    if (run.publish?.ok === false) {
      setStage('find', 'done');
      setStage('test', 'done');
      setStage('add', 'bad');
      renderFailure('Source passed, but publishing failed.', run.publish.error || run.message, run);
      addAction('Try Add source again', addSource);
      addAction('Re-test', testSource, true);
      return;
    }

    switch (run.state) {
      case 'ready':
        setStage('find', 'done');
        setStage('test', 'done');
        setStage('add', 'active');
        renderReady(run);
        break;
      case 'verification-required':
        setStage('find', 'done');
        setStage('test', 'active');
        renderFailure('Verification required.', run.message, run);
        addAction('Open verification', openVerification);
        addAction('I finished — verify & retry', verifyAndRetest, true);
        break;
      case 'verification-in-progress':
        setStage('find', 'done');
        setStage('test', 'active');
        renderFailure('Finish verification in the opened browser.', run.message, run);
        addAction('Verify & retry', verifyAndRetest);
        addAction('Open browser again', openVerification, true);
        break;
      case 'needs-review':
        setStage('find', 'done');
        setStage('test', 'bad');
        renderFailure('The source is not strong enough yet.', run.message, run);
        addAction('Re-test source', testSource);
        break;
      case 'temporarily-blocked':
        setStage('find', 'done');
        setStage('test', 'bad');
        renderFailure('The website is temporarily blocking the test.', run.message, run);
        addAction('Try again', testSource);
        break;
      case 'added':
        setStage('find', 'done');
        setStage('test', 'done');
        setStage('add', 'done');
        success.classList.add('show');
        $('result-name').textContent = new URL(run.url).hostname;
        $('result-note').textContent = run.message;
        $('result-score').textContent = 'Added';
        break;
      default:
        setStage('find', 'bad');
        renderFailure('Source test failed.', run.message || 'Source Beast could not finish the test.', run);
        addAction('Try again', testSource);
    }
  }

  async function withBusy(label, fn) {
    if (busy) return;
    busy = true;
    submitButton.disabled = true;
    const original = submitButton.textContent;
    submitButton.textContent = label;
    try {
      return await fn();
    } finally {
      busy = false;
      submitButton.disabled = false;
      submitButton.textContent = original === 'Add source' ? 'Test source' : original;
    }
  }

  async function testSource() {
    await withBusy('Testing…', async () => {
      let url;
      try { url = cleanUrl(sourceInput.value); }
      catch (error) {
        resetPanels();
        resetStages();
        setStage('find', 'bad');
        renderFailure('Paste a valid website URL.', error.message, null);
        return;
      }

      sourceInput.value = url;
      resetPanels();
      resetStages();
      setStage('find', 'active');
      spin('Connecting to local Source Beast…');
      if (!await health({ quiet: true })) {
        renderOffline('Source Beast or Source Forge is not ready.');
        return;
      }

      setStage('find', 'done');
      setStage('test', 'active');
      spin('Testing catalog → title → chapters → reader pages…');
      try {
        const run = await request('/api/source-beast/test', {
          method: 'POST',
          body: JSON.stringify({ url }),
        });
        renderRun(run);
      } catch (error) {
        renderOffline('Source Beast could not complete the test.', error.message);
      }
    });
  }

  async function openVerification() {
    if (!currentRun?.id) return;
    await withBusy('Opening…', async () => {
      spin('Opening the website in your assisted browser…');
      try {
        renderRun(await request(`/api/source-beast/runs/${encodeURIComponent(currentRun.id)}/verification/open`, { method: 'POST' }, 60000));
      } catch (error) {
        renderFailure('Could not open verification.', error.message, currentRun);
      }
    });
  }

  async function verifyAndRetest() {
    if (!currentRun?.id) return;
    await withBusy('Re-testing…', async () => {
      spin('Checking your verified session and re-running the full gauntlet…');
      try {
        renderRun(await request(`/api/source-beast/runs/${encodeURIComponent(currentRun.id)}/verification/check`, { method: 'POST' }, 180000));
      } catch (error) {
        renderFailure('Verification is not ready yet.', error.message, currentRun);
      }
    });
  }

  async function addSource() {
    if (!currentRun?.id) return;
    await withBusy('Adding…', async () => {
      setStage('add', 'active');
      spin('Publishing the web-source descriptor and refreshing Yomu…');
      try {
        const run = await request(`/api/source-beast/runs/${encodeURIComponent(currentRun.id)}/add`, { method: 'POST' }, 180000);
        currentRun = run;
        if (run.state === 'added' && run.publish?.sourceUrl) {
          setStage('add', 'done');
          setStatus('Published. Enabling the new source in Yomu…');
          location.assign(run.publish.sourceUrl);
          return;
        }
        renderRun(run);
      } catch (error) {
        setStage('add', 'bad');
        renderFailure('Could not add the source.', error.message, currentRun);
        addAction('Try Add source again', addSource);
      }
    });
  }

  // Capture phase intentionally wins over the legacy Add Source handler. This
  // page is now Source Beast web-source mode; native-provider selection is not
  // part of this form's path.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    testSource();
  }, true);

  health({ quiet: true });
})();
