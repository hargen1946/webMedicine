const CACHE='medicine-notebook-v22';
const ASSETS=['./','index.html','styles.css?v=6','help.css?v=1','app.js?v=21','zxing-browser.min.js?v=0.2.1','manifest.webmanifest?v=3','icon.svg?v=3','icon-192.png?v=2','icon-512.png?v=2','icon-maskable-512.png?v=2'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).then(res=>{
      const copy=res.clone();
      caches.open(CACHE).then(c=>c.put('./',copy));
      return res;
    }).catch(()=>caches.match('./')));
    return;
  }
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{
    const copy=res.clone();
    caches.open(CACHE).then(c=>c.put(e.request,copy));
    return res;
  })));
});
