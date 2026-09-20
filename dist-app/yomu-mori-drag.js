/** Make Mori's minimized + puck obey the same drag contract as Mori. */
(() => {
  'use strict';
  if (typeof document === 'undefined') return;

  const PREFS_KEY = 'yomu.v1.pet';
  const ROOT_ID = 'yomu-pet';
  let bound = null;
  let suppressClick = false;

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  function savePosition(x, y) {
    try {
      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, position: { x: Math.round(x), y: Math.round(y) } }));
      // Keep yomu-pet.js's in-memory prefs aligned with the same stored value.
      window.YomuPet?.set?.({ position: { x: Math.round(x), y: Math.round(y) } });
    } catch {}
  }

  function bind() {
    const root = document.getElementById(ROOT_ID);
    const puck = root?.querySelector('.yp-puck');
    if (!root || !puck || puck === bound) return;
    bound = puck;

    let active = false;
    let dragged = false;
    let startX = 0;
    let startY = 0;
    let baseX = 0;
    let baseY = 0;

    puck.dataset.yomuDraggable = '1';
    puck.style.touchAction = 'none';

    puck.addEventListener('pointerdown', (event) => {
      if (event.button != null && event.button !== 0) return;
      const box = root.getBoundingClientRect();
      active = true;
      dragged = false;
      suppressClick = false;
      startX = event.clientX;
      startY = event.clientY;
      baseX = box.left;
      baseY = box.top;
      try { puck.setPointerCapture(event.pointerId); } catch {}
    });

    puck.addEventListener('pointermove', (event) => {
      if (!active) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!dragged && Math.hypot(dx, dy) < 5) return;
      dragged = true;
      suppressClick = true;
      const box = root.getBoundingClientRect();
      const width = Math.max(28, box.width || puck.offsetWidth || 28);
      const height = Math.max(28, box.height || puck.offsetHeight || 28);
      root.style.left = clamp(baseX + dx, 0, Math.max(0, innerWidth - width)) + 'px';
      root.style.top = clamp(baseY + dy, 0, Math.max(0, innerHeight - height)) + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      dispatchEvent(new CustomEvent('yomu:pet-moved', { detail: { dragging: true } }));
    });

    const release = (event) => {
      if (!active) return;
      active = false;
      try { puck.releasePointerCapture(event.pointerId); } catch {}
      if (!dragged) return;
      const box = root.getBoundingClientRect();
      savePosition(box.left, box.top);
      dispatchEvent(new CustomEvent('yomu:pet-moved', { detail: { dragging: false, saved: true } }));
      // The browser emits click after pointerup. Keep that click from toggling
      // Mori open when the gesture was a drag; the next real click works.
      setTimeout(() => { suppressClick = false; }, 0);
    };
    puck.addEventListener('pointerup', release);
    puck.addEventListener('pointercancel', release);

    puck.addEventListener('click', (event) => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  const start = () => {
    bind();
    new MutationObserver(bind).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
