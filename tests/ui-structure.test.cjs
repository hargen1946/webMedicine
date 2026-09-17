'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const camera = fs.readFileSync(path.join(root, 'camera.js'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

assert.match(html, /id=["']toast["']/i, '通知欄がindex.htmlに必要です');
assert.match(app, /if \(!toast\) return;/, '通知欄がなくても主要処理を止めない必要があります');
assert.doesNotMatch(app, /navigate\('history'\);\s*flash\('記録を削除しました'\);/, '削除後の通知を二重表示しません');
assert.match(
  app,
  /function renderHistory[\s\S]*history-home-button[\s\S]*function renderDetail/,
  '記録一覧のホームボタンに専用スタイルが必要です'
);
assert.match(app, /← ホーム/, '一覧上部にホームへ戻る表示が必要です');
assert.match(app, /← 記録一覧/, '詳細上部に記録一覧へ戻る表示が必要です');

const assetVersion = serviceWorker.match(/CACHE_NAME = 'medicine-notebook-v(\d+)'/)?.[1];
assert.ok(assetVersion, 'サービスワーカーのキャッシュ番号が必要です');
for (const asset of ['style.css', 'audio.js', 'storage.js', 'parser.js', 'camera.js', 'app.js']) {
  assert.ok(
    html.includes(`./${asset}?v=${assetVersion}`),
    `${asset}の更新番号をキャッシュ番号と揃える必要があります`
  );
  assert.ok(
    serviceWorker.includes(`./${asset}?v=${assetVersion}`),
    `${asset}を更新番号付きで事前キャッシュする必要があります`
  );
}
assert.ok(
  camera.includes(`new Worker('./qrWorker.js?v=${assetVersion}')`),
  'QRワーカーの更新番号をキャッシュ番号と揃える必要があります'
);
assert.ok(
  serviceWorker.includes(`./qrWorker.js?v=${assetVersion}`),
  'QRワーカーを更新番号付きで事前キャッシュする必要があります'
);

console.log('ui structure tests: ok');
