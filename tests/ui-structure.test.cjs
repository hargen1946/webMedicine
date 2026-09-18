'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const camera = fs.readFileSync(path.join(root, 'camera.js'), 'utf8');
const style = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
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
assert.match(app, /上の3個のボタンの説明/, 'ホームに3個の補助ボタンの説明リンクが必要です');
assert.match(app, /data-action="delete">この記録を削除する/, '説明書と同じ削除ボタン名が必要です');
assert.doesNotMatch(app, /data-action="help">使い方・データ保存について/, 'ホームの説明リンクは3個のボタンを明示します');
assert.match(camera, /前の処方箋を保存しました。/, '前の処方箋を保存した案内が必要です');
assert.match(camera, /別の処方箋の1件目を読み取りました。/, '別の処方箋の1件目を読み取った案内が必要です');
assert.doesNotMatch(camera, /新しい処方箋：/, '別の処方箋という統一表記を使います');
assert.match(style, /\.button-stack\.home-actions[\s\S]*margin-bottom:\s*44px/, 'QR読み取りボタンと3ボタンの間隔を広くします');
assert.match(style, /\.utility-row[\s\S]*margin-bottom:\s*8px/, '3ボタンと説明文の間隔を近づけます');
assert.match(style, /\.help-link[\s\S]*margin-top:\s*0/, '説明文側に余分な上余白を設けません');

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
