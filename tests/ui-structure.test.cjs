'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

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

console.log('ui structure tests: ok');
