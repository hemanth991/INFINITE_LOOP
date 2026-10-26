const CACHE='goalpulse-v1.0.2';
const FILES=['/','/index.html','/style.css','/app.js','/engine/core.js','/engine/advanced.js','/engine/worker.js','/data/config.js','/data/personas.js','/data/illustrative-monthly.json'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)));self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||new URL(e.request.url).origin!==location.origin)return;e.respondWith(fetch(e.request).catch(()=>caches.match(e.request).then(r=>r||(e.request.mode==='navigate'?caches.match('/index.html'):Response.error()))))});
