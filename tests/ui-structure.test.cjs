'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

assert.match(html, /id=["']toast["']/i, '通知欄がindex.htmlに必要です');
assert.match(app, /if \(!toast\) return;/, '通知欄がなくても主要処理を止めない必要があります');
assert.match(app, /navigate\('history'\);\s*flash\('記録を削除しました'\);/, '削除後は通知より先に一覧へ戻ります');

console.log('ui structure tests: ok');
