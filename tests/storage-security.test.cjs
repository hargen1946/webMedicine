'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const saved = new Map();
const context = {
  console,
  URL,
  Blob,
  setTimeout,
  localStorage: {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, String(value)),
    removeItem: key => saved.delete(key)
  },
  flash: () => {},
  confirm: () => true,
  render: () => {}
};

vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'storage.js'), 'utf8'),
  context
);

const valid = [{
  prescriptionDate: '2026年9月19日',
  hospitalName: 'テスト病院',
  department: '内科',
  doctorName: 'テスト医師',
  medicines: [{ name: 'テスト薬', usage: ['毎食後'], quantityInfo: '7日分', unwanted: '削除' }],
  qrFingerprints: ['abc123', 'abc123'],
  unwanted: '削除'
}];
const clean = context.validateBackup(valid);
assert.equal(clean.length, 1);
assert.deepEqual(
  JSON.parse(JSON.stringify(clean[0])),
  {
    prescriptionDate: '2026年9月19日',
    hospitalName: 'テスト病院',
    department: '内科',
    doctorName: 'テスト医師',
    medicines: [{ name: 'テスト薬', usage: ['毎食後'], quantityInfo: '7日分' }],
    qrFingerprints: ['abc123']
  },
  '必要な項目だけを新しい記録へ移します'
);

assert.throws(
  () => context.validateBackup([{ ...valid[0], prescriptionDate: [] }]),
  /形式が正しくありません/,
  '日付などは文字列だけを許可します'
);
assert.throws(
  () => context.validateBackup([{ ...valid[0], medicines: [{ name: '薬', usage: 1 }] }]),
  /用法が正しくありません/,
  '用法は一覧だけを許可します'
);
assert.throws(
  () => context.validateBackup([{ ...valid[0], hospitalName: 'あ'.repeat(501) }]),
  /形式が正しくありません/,
  '極端に長い文字列を拒否します'
);
assert.throws(
  () => context.validateBackup(Array.from({ length: 1001 }, () => valid[0])),
  /記録件数が上限/,
  '極端に多い記録を拒否します'
);

console.log('storage security tests: ok');
