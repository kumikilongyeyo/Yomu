(() => {
  'use strict';
  if (!location.pathname.startsWith('/sources')) return;

  const RAW_PACK = 'https://raw.githubusercontent.com/kumikilongyeyo/Yomu/main/dist-app/source-packs/community.json';
  const PACK_ID = 'yomu-source-pack-mode';

  function arm() {
    const pack = document.getElementById(PACK_ID);
    const button = pack?.querySelector('.sp-json-community');
    if (!pack || !button || button.dataset.yomuLivePack === '1') return !!(pack && button);

    button.dataset.yomuLivePack = '1';
    button.title = 'Loads the latest Yomu Community Core directly from GitHub';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const input = pack.querySelector('.sp-json-import input');
      const load = pack.querySelector('.sp-json-load');
      if (!input || !load) return;
      input.value = RAW_PACK;
      load.click();
    }, true);
    return true;
  }

  if (arm()) return;
  const observer = new MutationObserver(() => {
    if (arm()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 12000);
})();
