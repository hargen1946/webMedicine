'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const savedRecords = [];
const qrHistory = [];
const context = {
  console,
  URL,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
  window: {},
  state: { qrList: [], qrFingerprints: [], notice: '' },
  getQrHistory: () => [...qrHistory],
  getRecords: () => [...savedRecords],
  saveRecord: record => {
    savedRecords.push(JSON.parse(JSON.stringify(record)));
    return true;
  },
  rememberQrFingerprints: fingerprints => {
    for (const fingerprint of fingerprints) {
      if (fingerprint && !qrHistory.includes(fingerprint)) qrHistory.push(fingerprint);
    }
  }
};

vm.createContext(context);
for (const file of ['parser.js', 'camera.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
}

const prescription = (hospitalCode, hospitalName, date, medicine) => [
  'JAHIS10',
  `1,1,${hospitalCode},13,${hospitalName}`,
  '4,1,,内科',
  '5,,,テスト 医師',
  `51,${date}`,
  '101,1,1,,7',
  '111,1,1,,毎食後服用,3',
  `201,1,1,1,1,,${medicine},3,1,錠`
].join('\n');

const first = { text: prescription('1111111', '第一薬局', '20260917', '第一薬'), fingerprint: 'raw:first' };
const second = { text: prescription('2222222', '第二薬局', '20260918', '第二薬'), fingerprint: 'raw:second' };

assert.equal(context.addQrData(first), 'ADDED');
assert.equal(context.scanProgress().canFinish, true);
assert.equal(context.addQrData(second), 'DIFFERENT');

const firstSaved = context.saveCurrentScanRecord();
assert.equal(firstSaved.ok, true);
assert.equal(firstSaved.saved, true);
assert.equal(savedRecords.length, 1);
assert.equal(savedRecords[0].hospitalName, '第一薬局');

assert.equal(context.addQrData(second), 'ADDED');
const secondSaved = context.saveCurrentScanRecord();
assert.equal(secondSaved.ok, true);
assert.equal(savedRecords.length, 2);
assert.equal(savedRecords[1].hospitalName, '第二薬局');

console.log('camera flow tests: ok');
