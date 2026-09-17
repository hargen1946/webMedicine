'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { console };
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'parser.js'), 'utf8'),
  context
);

const printedPrescription = [
  'JAHIS10',
  '1,1,1234567,13,テスト病院',
  '4,1,,内科',
  '5,,,テスト 医師',
  '51,20260410',
  '101,1,1,,14',
  '111,1,1,,毎食後服用,3',
  '201,1,1,1,1,,テスト錠２．５ｍｇ,4,1,錠'
].join('\n');

const medicineNotebook = [
  'JAHISTC08,1',
  '5,R020410,1',
  '51,テスト病院,13,1,1234567',
  '55,テスト 医師,内科',
  '201,1,テストカプセル5mg,6,C,2,620004992,1,,,',
  '201,1,テスト配合錠,6,錠,2,620425801,1,,,',
  '301,1,分3 毎食後服用,5,日分,1,1,,'
].join('\n');

const printed = context.parsePrescription(printedPrescription);
assert.equal(printed.prescriptionDate, '2026年4月10日');
assert.equal(printed.hospitalName, 'テスト病院');
assert.equal(printed.department, '内科');
assert.equal(printed.doctorName, 'テスト 医師');
assert.deepEqual(JSON.parse(JSON.stringify(printed.medicines)), [
  {
    name: 'テスト錠２．５ｍｇ',
    usage: ['毎食後服用'],
    quantityInfo: '4錠・14日分'
  }
]);

const notebook = context.parsePrescription(medicineNotebook);
assert.equal(notebook.prescriptionDate, '2020年4月10日');
assert.equal(notebook.medicines.length, 2);
assert.equal(notebook.medicines[0].quantityInfo, '6C・5日分');
assert.equal(notebook.medicines[1].quantityInfo, '6錠・5日分');

const otherPrintedPrescription = printedPrescription
  .replace('1234567,13,テスト病院', '7654321,13,別の病院')
  .replace('20260410', '20260411');

assert.equal(
  context.canAppendPrescriptionQrPart(
    [{ data: printedPrescription, sequenceSize: -1, sequenceIndex: -1, sequenceId: '' }],
    { data: otherPrintedPrescription, sequenceSize: -1, sequenceIndex: -1, sequenceId: '' }
  ),
  false,
  '別の医療機関・処方日のQRは連結しない'
);

const splitFirst = {
  data: printedPrescription,
  sequenceSize: 2,
  sequenceIndex: 0,
  sequenceId: '42'
};
const splitSecond = {
  data: '201,2,1,1,1,,追加薬,1,1,錠',
  sequenceSize: 2,
  sequenceIndex: 1,
  sequenceId: '42'
};
assert.equal(context.canAppendPrescriptionQrPart([splitFirst], splitSecond), true);
assert.equal(
  context.canAppendPrescriptionQrPart([splitFirst], { ...splitSecond, sequenceId: '99' }),
  false,
  '別の構造化連結IDは連結しない'
);
assert.equal(
  context.canAppendPrescriptionQrPart(
    [{ data: printedPrescription, sequenceSize: -1, sequenceIndex: -1, sequenceId: '' }],
    splitFirst
  ),
  false,
  '1枚完結QRと分割QRは連結しない'
);

console.log('parser tests: ok');
