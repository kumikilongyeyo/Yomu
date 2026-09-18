/**
 * Publish a shelf — the You page half of shared shelves.
 *
 * One card: publish, and then the link, Update and Unpublish. The link is
 * read-only and public by design; what goes up is covers, titles, the
 * category and the time-capsule note, and nothing about progress, sources,
 * devices or the circle. The card says so, because "share my library" in an
 * app with a sync feature deserves to be told exactly what that means.
 *
 * The token that allows Update and Unpublish stays in this browser. Lose it
 * and the shelf stays up until it is published again from a device that has
 * it -- so it is worth saying that too.
 */
(() => {
  'use strict';

  const KEY = 'yomu.v1.shelf';
  const HOST_ID = 'yomu-shelf-share';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const CAPSULE_KEY = 'yomu.v1.capsule';
  const CIRCLE_KEY = 'yomu.v1.circle';

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  const state = () => {
    const value = readJSON(KEY, null);
    return value && typeof value === 'object' ? value : {};
  };

  /** What goes on the shelf. Pure over the two stores it reads. */
  function itemsFrom(collection, notes) {
    const rows = Array.isArray(collection?.library) ? collection.library : [];
    return rows
      .filter((r) => r && r.title && !r.hidden)
      .map((r) => {
        const note = notes?.[r.sourceId + ':' + r.id]?.note;
        return {
          title: String(r.title),
          ...(r.cover ? { cover: String(r.cover) } : {}),
          ...(r.category ? { category: String(r.category) } : {}),
          ...(note ? { note } : {}),
        };
      });
  }

  function shelfName() {
    const who = readJSON(CIRCLE_KEY, {})?.name;
    const name = typeof who === 'string' && who.trim() ? who.trim() : '';
    return name ? name + (/s$/i.test(name) ? '’ shelf' : '’s shelf') : 'A Yomu shelf';
  }

  async function api(route, payload) {
    const response = await fetch('/api/shelf/' + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'That did not work.');
    return data;
  }

  const ago = (at) => {
    const days = Math.floor((Date.now() - at) / 86400000);
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    return days + ' days ago';
  };

  let note = '';
  let busy = false;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  async function publish() {
    if (busy) return;
    const items = itemsFrom(readJSON(COLLECTION_KEY, {}), readJSON(CAPSULE_KEY, {}));
    if (!items.length) { note = 'Save a title first; an empty shelf is not worth a link.'; paint(); return; }
    busy = true; paint();
    try {
      const current = state();
      const result = await api('publish', {
        ...(current.code && current.token ? { code: current.code, token: current.token } : {}),
        name: shelfName(),
        items,
      });
      writeJSON(KEY, { code: result.code, token: result.token, at: result.at, count: result.count });
      note = current.code ? 'Updated. The link is the same.' : 'Published. Anyone with the link can see it.';
    } catch (error) {
      if (/gone/i.test(error.message)) { try { localStorage.removeItem(KEY); } catch {} }
      note = error.message;
    }
    busy = false; paint();
  }

  async function unpublish() {
    if (busy) return;
    const current = state();
    if (!current.code) return;
    if (!confirm('Take the shelf down? The link stops working for everyone.')) return;
    busy = true; paint();
    try {
      await api('unpublish', { code: current.code, token: current.token });
      try { localStorage.removeItem(KEY); } catch {}
      note = 'Taken down.';
    } catch (error) { note = error.message; }
    busy = false; paint();
  }

  function paint() {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    const current = state();
    host.textContent = '';
    const card = el('div', 'yss');

    const items = itemsFrom(readJSON(COLLECTION_KEY, {}), readJSON(CAPSULE_KEY, {}));
    const noted = items.filter((i) => i.note).length;

    if (!current.code) {
      card.append(el('p', 'yss__copy',
        `A read-only link to your shelf: ${items.length} cover${items.length === 1 ? '' : 's'} and title${items.length === 1 ? '' : 's'}`
        + (noted ? `, with your ${noted} note${noted === 1 ? '' : 's'}` : '')
        + '. No progress, no sources, no account — nothing that says what you read or where.'));
      const go = el('button', 'yss__go', busy ? 'Publishing…' : 'Publish a shelf link');
      go.type = 'button'; go.disabled = busy;
      go.addEventListener('click', publish);
      card.append(go);
    } else {
      const link = location.origin + '/shelf/' + current.code;
      const a = el('button', 'yss__link', link.replace(/^https?:\/\//, ''));
      a.type = 'button';
      a.title = 'Copy the link';
      a.addEventListener('click', () => {
        navigator.clipboard?.writeText(link).then(() => { note = 'Link copied.'; paint(); }).catch(() => {
          note = link; paint();
        });
      });
      card.append(a);
      card.append(el('p', 'yss__copy', `${current.count} title${current.count === 1 ? '' : 's'} · published ${ago(current.at)}`
        + (items.length !== current.count ? ` · your library has ${items.length} now` : '')));
      const acts = el('div', 'yss__acts');
      const open = el('a', 'yss__go', 'Open');
      open.href = '/shelf/' + current.code; open.target = '_blank'; open.rel = 'noopener';
      const update = el('button', 'yss__go', busy ? 'Working…' : 'Update');
      update.type = 'button'; update.disabled = busy; update.addEventListener('click', publish);
      const down = el('button', 'yss__quiet', 'Unpublish');
      down.type = 'button'; down.disabled = busy; down.addEventListener('click', unpublish);
      acts.append(open, update, down);
      card.append(acts);
    }
    host.append(card);
    const small = el('p', 'ysh-note', note || 'The link is public by design and does not change when you update. Only this browser can update or remove it.');
    host.append(small);
  }

  const api_ = { itemsFrom, shelfName, publish, unpublish, repaint: paint };
  if (typeof window !== 'undefined') window.YomuShelfShare = api_;
  if (typeof module !== 'undefined' && module.exports) module.exports = { itemsFrom };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', paint);
    else paint();
    addEventListener('yomu:capsule', paint);
  }
})();
