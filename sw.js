// 德州扑克 AI 对战 · Service Worker
// 作用：把 app 外壳缓存到本地，手机"添加到主屏幕"后离线也能打。
// 注意：Service Worker 只在 http/https 下生效（file:// 双击打开时不注册）。

const CACHE = 'poker-ai-v1';
const ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'icon.svg',
  'css/style.css',
  'js/cards.js',
  'js/handEval.js',
  'js/equity.js',
  'js/icm.js',
  'js/ai/personalities.js',
  'js/ai/brain.js',
  'js/game.js',
  'js/coach.js',
  'js/review.js',
  'js/ui.js',
  'js/main.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k !== CACHE;
      }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 导航请求：网络优先，失败回退到缓存的 index.html（离线也能进游戏）
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        caches.open(CACHE).then(function (c) {
          c.put('index.html', res.clone());
        });
        return res;
      }).catch(function () {
        return caches.match('index.html');
      })
    );
    return;
  }

  // 静态资源：缓存优先，失败再走网络
  e.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) {
            c.put(req, copy);
          });
        }
        return res;
      }).catch(function () {
        return cached;
      });
    })
  );
});
