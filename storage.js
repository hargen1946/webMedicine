'use strict';

const STORAGE_KEY = 'medicine-notebook.records.v1';
const QR_HISTORY_KEY = 'medicine-notebook.qr-fingerprints.v1';

function getRecords() {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    const arr = Array.isArray(v) ? v : [];
    return arr.sort((a, b) => {
      const getNum = (d) => {
        if (!d) return 0;
        const m = d.match(/(\d+)年(\d+)月(\d+)日/);
        return m ? Number(m[1].padStart(4, '0') + m[2].padStart(2, '0') + m[3].padStart(2, '0')) : 0;
      };
      return getNum(b.prescriptionDate) - getNum(a.prescriptionDate);
    });
  } catch {
    return [];
  }
}

function writeRecords(records) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function getQrHistory() {
  try {
    const v = JSON.parse(localStorage.getItem(QR_HISTORY_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function rememberQrFingerprints(fingerprints) {
  const history = new Set(getQrHistory());
  fingerprints.filter(Boolean).forEach(f => history.add(f));
  localStorage.setItem(QR_HISTORY_KEY, JSON.stringify([...history].slice(-1000)));
}

function rebuildQrHistory(records) {
  const fingerprints = records.flatMap(r => Array.isArray(r.qrFingerprints) ? r.qrFingerprints : []).filter(Boolean);
  if (fingerprints.length) {
    localStorage.setItem(QR_HISTORY_KEY, JSON.stringify([...new Set(fingerprints)].slice(-1000)));
  } else {
    localStorage.removeItem(QR_HISTORY_KEY);
  }
}

function norm(s) {
  return String(s || '').replace(/\s+/g, '').trim();
}

function score(r) {
  return (r.prescriptionDate ? 10 : 0) +
         (r.hospitalName ? 10 : 0) +
         (r.department ? 3 : 0) +
         (r.doctorName ? 3 : 0) +
         r.medicines.length * 20 +
         r.medicines.reduce((n, m) => n + (m.name ? 5 : 0) + m.usage.filter(Boolean).length * 2 + (m.quantityInfo ? 3 : 0), 0);
}

function sameRecord(first, second) {
  const firstFingerprints = Array.isArray(first.qrFingerprints) ? first.qrFingerprints : [];
  const secondFingerprints = Array.isArray(second.qrFingerprints) ? second.qrFingerprints : [];
  if (firstFingerprints.some(value => secondFingerprints.includes(value))) return true;

  const firstMedicines = (first.medicines || []).map(medicine => norm(medicine.name)).filter(Boolean).sort();
  const secondMedicines = (second.medicines || []).map(medicine => norm(medicine.name)).filter(Boolean).sort();
  if (!firstMedicines.length || firstMedicines.length !== secondMedicines.length) return false;

  return norm(first.prescriptionDate) === norm(second.prescriptionDate) &&
    norm(first.hospitalName) === norm(second.hospitalName) &&
    norm(first.doctorName) === norm(second.doctorName) &&
    firstMedicines.every((name, index) => name === secondMedicines[index]);
}

function saveRecord(record) {
  const records = getRecords();
  const i = records.findIndex(saved => sameRecord(saved, record));
  if (i >= 0) {
    if (score(record) <= score(records[i])) return false;
    records[i] = record;
  } else {
    records.unshift(record);
  }
  records.sort((a, b) => {
    const getNum = (d) => {
      if (!d) return 0;
      const m = d.match(/(\d+)年(\d+)月(\d+)日/);
      return m ? Number(m[1].padStart(4, '0') + m[2].padStart(2, '0') + m[3].padStart(2, '0')) : 0;
    };
    return getNum(b.prescriptionDate) - getNum(a.prescriptionDate);
  });
  writeRecords(records);
  return true;
}

function csvCell(v) {
  return '"' + String(v ?? '').replaceAll('"', '""') + '"';
}

function exportCsv() {
  const records = getRecords();
  if (!records.length) {
    flash('出力する記録がありません');
    return;
  }
  const rows = [['処方日', '医療機関', '診療科', '医師名', '薬品名', '用法', '数量']];
  for (const r of records) {
    for (const m of r.medicines) {
      rows.push([r.prescriptionDate, r.hospitalName, r.department, r.doctorName, m.name, m.usage.join(' / '), m.quantityInfo]);
    }
  }
  const csvContent = '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  download(csvContent, 'お薬手帳.csv', 'text/csv;charset=utf-8');
  flash('「お薬手帳.csv」をダウンロードしました。');
}

function download(content, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importJson(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data)) throw 0;
      if (confirm(`${data.length}件の記録を読み込み、現在の記録と統合しますか？`)) {
        for (const r of data) {
          if (r && Array.isArray(r.medicines)) saveRecord(r);
        }
        flash('記録を読み込みました');
        render();
      }
    } catch {
      flash('JSONファイルの形式が正しくありません');
    }
  };
  reader.readAsText(file);
}
