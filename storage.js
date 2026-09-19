'use strict';

const STORAGE_KEY = 'medicine-notebook.records.v1';
const QR_HISTORY_KEY = 'medicine-notebook.qr-fingerprints.v1';
const BACKUP_LIMITS = Object.freeze({
  fileBytes: 5 * 1024 * 1024,
  records: 1000,
  medicinesPerRecord: 100,
  usagePerMedicine: 50,
  textLength: 500,
  fingerprintsPerRecord: 100,
  fingerprintLength: 256
});

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

function sortRecords(records) {
  records.sort((a, b) => {
    const getNum = (d) => {
      if (!d) return 0;
      const m = d.match(/(\d+)年(\d+)月(\d+)日/);
      return m ? Number(m[1].padStart(4, '0') + m[2].padStart(2, '0') + m[3].padStart(2, '0')) : 0;
    };
    return getNum(b.prescriptionDate) - getNum(a.prescriptionDate);
  });
  return records;
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

function mergeRecordInto(records, record) {
  const i = records.findIndex(saved => sameRecord(saved, record));
  if (i >= 0) {
    if (score(record) <= score(records[i])) return false;
    records[i] = record;
  } else {
    records.unshift(record);
  }
  return true;
}

function saveRecord(record) {
  const records = getRecords();
  if (!mergeRecordInto(records, record)) return false;
  sortRecords(records);
  writeRecords(records);
  return true;
}

function exportBackup() {
  const records = getRecords();
  if (!records.length) {
    flash('保存する記録がありません');
    return;
  }
  if (!confirm('バックアップファイルには、お薬・医療機関・医師名などの個人情報が含まれます。安全な場所に保存し、他人へ送らないでください。\n\nバックアップファイルを保存しますか？')) return;
  download(JSON.stringify(records, null, 2), 'お薬手帳バックアップ.json', 'application/json');
  flash('「お薬手帳バックアップ.json」をダウンロードしました。');
}

function download(content, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function backupText(value, fieldName, maxLength = BACKUP_LIMITS.textLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(`${fieldName}の形式が正しくありません`);
  }
  return value;
}

function validateBackup(data) {
  if (!Array.isArray(data) || data.length > BACKUP_LIMITS.records) {
    throw new Error('記録件数が上限を超えています');
  }

  return data.map((record, recordIndex) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`${recordIndex + 1}件目の記録形式が正しくありません`);
    }
    if (!Array.isArray(record.medicines) || record.medicines.length > BACKUP_LIMITS.medicinesPerRecord) {
      throw new Error(`${recordIndex + 1}件目のお薬情報が正しくありません`);
    }

    const medicines = record.medicines.map((medicine, medicineIndex) => {
      if (!medicine || typeof medicine !== 'object' || Array.isArray(medicine)) {
        throw new Error(`${recordIndex + 1}件目のお薬情報が正しくありません`);
      }
      if (medicine.usage !== undefined && !Array.isArray(medicine.usage)) {
        throw new Error(`${recordIndex + 1}件目の用法が正しくありません`);
      }
      const usage = medicine.usage || [];
      if (usage.length > BACKUP_LIMITS.usagePerMedicine) {
        throw new Error(`${recordIndex + 1}件目の用法数が上限を超えています`);
      }
      return {
        name: backupText(medicine.name, `${medicineIndex + 1}番目の薬品名`),
        usage: usage.map((item, usageIndex) => backupText(item, `${usageIndex + 1}番目の用法`)),
        quantityInfo: backupText(medicine.quantityInfo, `${medicineIndex + 1}番目の数量`)
      };
    });

    if (record.qrFingerprints !== undefined && !Array.isArray(record.qrFingerprints)) {
      throw new Error(`${recordIndex + 1}件目のQR情報が正しくありません`);
    }
    const fingerprints = record.qrFingerprints || [];
    if (fingerprints.length > BACKUP_LIMITS.fingerprintsPerRecord) {
      throw new Error(`${recordIndex + 1}件目のQR情報が上限を超えています`);
    }

    const cleanRecord = {
      prescriptionDate: backupText(record.prescriptionDate, '処方日'),
      hospitalName: backupText(record.hospitalName, '医療機関名'),
      department: backupText(record.department, '診療科'),
      doctorName: backupText(record.doctorName, '医師名'),
      medicines
    };
    const cleanFingerprints = fingerprints.map((value, index) =>
      backupText(value, `${index + 1}番目のQR情報`, BACKUP_LIMITS.fingerprintLength)
    ).filter(Boolean);
    if (cleanFingerprints.length) cleanRecord.qrFingerprints = [...new Set(cleanFingerprints)];
    return cleanRecord;
  });
}

function importJson(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > BACKUP_LIMITS.fileBytes) {
    flash('バックアップファイルが大きすぎます（5MBまで）');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = validateBackup(JSON.parse(reader.result));
    } catch {
      flash('このバックアップファイルは形式が正しくないため、復元できませんでした');
      e.target.value = '';
      return;
    }

    if (confirm(`${data.length}件の記録を読み込み、現在の記録と統合しますか？`)) {
      const records = getRecords();
      data.forEach(record => mergeRecordInto(records, record));
      sortRecords(records);
      try {
        writeRecords(records);
      } catch {
        flash('スマホの保存容量が不足しているため、復元できませんでした');
        e.target.value = '';
        return;
      }
      try {
        rebuildQrHistory(records);
      } catch {
        // 記録本体の復元は完了しているため、補助的なQR履歴の失敗では中断しない。
      }
      flash('記録を読み込みました');
      render();
    }
    e.target.value = '';
  };
  reader.onerror = () => {
    flash('バックアップファイルを読み込めませんでした');
    e.target.value = '';
  };
  reader.readAsText(file);
}
