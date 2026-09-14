const SHELL='yomu-shell-v1';
self.addEventListener('install',event=>{event.waitUntil(caches.open(SHELL).then(cache=>cache.add('/')).then(()=>self.skipWaiting()))});
self.addEventListener('activate',event=>{event.waitUntil(self.clients.claim())});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);if(url.origin!==self.location.origin||event.request.method!=='GET')return;
  if(url.pathname.startsWith('/__offline/')){event.respondWith(caches.open('yomu-downloads-v1').then(cache=>cache.match(event.request)).then(r=>r||new Response('Download unavailable',{status:404})));return}
  if(url.pathname.startsWith('/api/'))return;
  if(event.request.mode==='navigate'||url.pathname.startsWith('/_expo/')||url.pathname.startsWith('/assets/')||url.pathname.startsWith('/fixtures/')){
    event.respondWith(fetch(event.request).then(async response=>{if(response.ok){const cache=await caches.open(SHELL);await cache.put(event.request,response.clone())}return response}).catch(async()=>await caches.match(event.request)||(event.request.mode==='navigate'?await caches.match('/'):null)||new Response('Offline',{status:503})));
  }
});
