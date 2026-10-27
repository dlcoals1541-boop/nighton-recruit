self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
// Operational data is intentionally never cached. Offline writes are unsafe.
self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(fetch(e.request).catch(()=>new Response('<meta charset="utf-8"><body style="background:#0e0e0e;color:#c9a66c;font-family:sans-serif;padding:40px"><h1>NIGHTON</h1><p>인터넷 연결을 확인한 후 다시 열어주세요.</p></body>',{headers:{'Content-Type':'text/html;charset=utf-8'}})));});
