'use strict';

// 開発用サービスワーカー：キャッシュを持たず、常に最新のファイルを直接読み込む設定

// インストール時は待たずに即座に有効化する
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// 起動時に古いキャッシュがもし残っていれば全て消去する
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.map((key) => caches.delete(key)));
    }).then(() => self.clients.claim())
  );
});

// 通信時：キャッシュを介さず、常にネットワーク（最新のGitHub）へ直接取りに行く
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});