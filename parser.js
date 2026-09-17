'use strict';

const JAHIS_RECORD_CODES = new Set([
  '1', '2', '3', '4', '5', '11', '12', '13', '14', '15', '21', '22', '23', '24', '25',
  '27', '28', '29', '30', '31', '51', '52', '55', '61', '62', '63', '64', '81', '82',
  '101', '102', '111', '181', '201', '211', '221', '231', '241', '281', '291', '301',
  '311', '391', '401', '411', '421', '501', '601', '701', '911'
]);

function normalizeQrData(data) {
  return String(data || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function qrFingerprint(data) {
  const value = normalizeQrData(data)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\ufffd]/g, '')
    .replace(/\s+/g, '');
  if (!value) return '';
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `text:${value.length}:${hash >>> 0}`;
}

function parsePrescription(data) {
  const lines = rebuildLines(data);
  const records = lines.map(line => line.split(',').map(value => value.trim()));
  const isPrintedPrescription = records.some(parts =>
    parts[0] === '101' ||
    parts[0] === '111' ||
    (parts[0] === '51' && /^\d{7,8}$/.test(parts[1] || ''))
  );

  return isPrintedPrescription
    ? parsePrintedPrescription(records)
    : parseMedicineNotebook(records);
}

// 複数のQRを同じ処方箋として連結できるかを判定する。
// 分割QRの後半には医療機関情報が含まれない場合があるため、
// 両方に存在する識別項目だけを比較する。
function prescriptionPartIdentity(data) {
  const lines = rebuildLines(data);
  const records = lines.map(line => line.split(',').map(value => value.trim()));
  const header = records.find(parts => /^JAHIS/i.test(parts[0] || ''))?.[0] || '';
  let format = '';

  if (/^JAHISTC/i.test(header)) {
    format = 'notebook';
  } else if (/^JAHIS\d/i.test(header)) {
    format = 'printed';
  } else if (records.some(parts =>
    parts[0] === '101' || parts[0] === '111' || parts[0] === '181' ||
    (parts[0] === '51' && /^\d{7,8}$/.test(parts[1] || ''))
  )) {
    format = 'printed';
  } else if (records.some(parts =>
    parts[0] === '281' || parts[0] === '301' || parts[0] === '311' ||
    (parts[0] === '51' && !/^\d{7,8}$/.test(parts[1] || ''))
  )) {
    format = 'notebook';
  }

  let prescriptionDate = '';
  let organization = '';
  let doctor = '';

  for (const parts of records) {
    if (format === 'printed') {
      if (parts[0] === '1') organization = [parts[2], parts[3], parts[4]].filter(Boolean).join('|');
      if (parts[0] === '5') doctor = parts[3] || parts[2] || doctor;
      if (parts[0] === '51') prescriptionDate = parts[1] || prescriptionDate;
    } else if (format === 'notebook') {
      if (parts[0] === '5') prescriptionDate = parts[1] || prescriptionDate;
      if (parts[0] === '51') organization = [parts[1], parts[4]].filter(Boolean).join('|');
      if (parts[0] === '55') doctor = parts[1] || doctor;
    }
  }

  const normalizeIdentity = value => String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase();

  return {
    format,
    prescriptionDate: normalizeIdentity(prescriptionDate),
    organization: normalizeIdentity(organization),
    doctor: normalizeIdentity(doctor)
  };
}

function prescriptionIdentitiesConflict(first, second) {
  if (first.format && second.format && first.format !== second.format) return true;
  return ['prescriptionDate', 'organization', 'doctor'].some(key =>
    first[key] && second[key] && first[key] !== second[key]
  );
}

function structuredQrPart(part) {
  return Number.isInteger(part?.sequenceSize) && part.sequenceSize > 1 &&
    Number.isInteger(part?.sequenceIndex) && part.sequenceIndex >= 0;
}

function canAppendPrescriptionQrPart(existingParts, incomingPart) {
  if (!Array.isArray(existingParts) || !existingParts.length) return true;

  const sequenced = existingParts.filter(structuredQrPart);
  const incomingSequenced = structuredQrPart(incomingPart);

  // 連結QRの構造化連結情報がある場合、同じ組だけを受け付ける。
  if (sequenced.length || incomingSequenced) {
    if (!sequenced.length || !incomingSequenced) return false;
    const reference = sequenced[0];
    if (reference.sequenceSize !== incomingPart.sequenceSize) return false;
    if (reference.sequenceId && incomingPart.sequenceId && reference.sequenceId !== incomingPart.sequenceId) {
      return false;
    }
    if (sequenced.some(part =>
      part.sequenceIndex === incomingPart.sequenceIndex && part.data !== incomingPart.data
    )) return false;
  }

  const existingIdentity = prescriptionPartIdentity(existingParts.map(part => part.data).join('\n'));
  const incomingIdentity = prescriptionPartIdentity(incomingPart?.data || '');
  return !prescriptionIdentitiesConflict(existingIdentity, incomingIdentity);
}

// JAHIS院外処方箋2次元シンボル（JAHIS9/JAHIS10等）
function parsePrintedPrescription(records) {
  let prescriptionDate = '';
  let hospitalName = '';
  let department = '';
  let doctorName = '';
  const rpMap = new Map();
  const medicines = [];

  const rp = number => {
    const key = String(number || '');
    if (!rpMap.has(key)) rpMap.set(key, { usage: [], dispensingQuantity: '' });
    return rpMap.get(key);
  };

  for (const parts of records) {
    switch (parts[0]) {
      case '1':
        hospitalName = display(parts[4] || hospitalName);
        break;
      case '4':
        department = display(parts[3] || department);
        break;
      case '5':
        doctorName = display(parts[3] || parts[2] || doctorName);
        break;
      case '51':
        prescriptionDate = formatDate(parts[1] || prescriptionDate);
        break;
      case '101': {
        const detail = rp(parts[1]);
        const quantity = number(parts[4] || '');
        const dosageForm = parts[2] || '';
        const suffix = dosageForm === '1' ? '日分' : dosageForm === '2' ? '回分' : '';
        detail.dispensingQuantity = quantity ? `${quantity}${suffix}` : '';
        break;
      }
      case '111': {
        const detail = rp(parts[1]);
        addUnique(detail.usage, display(parts[4] || ''));
        break;
      }
      case '181': {
        const detail = rp(parts[1]);
        addUnique(detail.usage, display(parts[4] || ''));
        break;
      }
      case '201': {
        const rpNumber = parts[1] || '';
        const name = display(parts[6] || (parts[5] ? `薬品コード ${parts[5]}` : ''));
        if (!name) break;
        medicines.push({
          rpNumber,
          sequence: Number.parseInt(parts[2], 10) || medicines.length + 1,
          name,
          medicineQuantity: joinAmount(parts[7], parts[9])
        });
        rp(rpNumber);
        break;
      }
    }
  }

  return {
    prescriptionDate,
    hospitalName,
    department,
    doctorName,
    medicines: medicines
      .sort((a, b) => Number(a.rpNumber) - Number(b.rpNumber) || a.sequence - b.sequence)
      .map(medicine => {
        const detail = rp(medicine.rpNumber);
        return {
          name: medicine.name,
          usage: [...detail.usage],
          quantityInfo: combineQuantity(medicine.medicineQuantity, detail.dispensingQuantity)
        };
      })
  };
}

// JAHIS電子版お薬手帳データ（JAHISTC等）も従来どおり読み取る。
function parseMedicineNotebook(records) {
  let prescriptionDate = '';
  let hospitalName = '';
  let department = '';
  let doctorName = '';
  const rpMap = new Map();
  const medicines = [];

  const rp = number => {
    const key = String(number || '');
    if (!rpMap.has(key)) rpMap.set(key, { usage: [], dispensingQuantity: '' });
    return rpMap.get(key);
  };

  for (const parts of records) {
    switch (parts[0]) {
      case '5':
        prescriptionDate = formatDate(parts[1] || prescriptionDate);
        break;
      case '51':
        hospitalName = display(parts[1] || hospitalName);
        break;
      case '55':
        doctorName = display(parts[1] || doctorName);
        department = display(String(parts[2] || department).replace(/^【|】$/g, ''));
        break;
      case '201': {
        const rpNumber = parts[1] || '';
        const name = display(parts[2] || '');
        if (!name) break;
        medicines.push({
          rpNumber,
          sequence: medicines.length + 1,
          name,
          medicineQuantity: joinAmount(parts[3], parts[4])
        });
        rp(rpNumber);
        break;
      }
      case '281':
        addUnique(rp(parts[1]).usage, display(parts[2] || ''));
        break;
      case '301': {
        const detail = rp(parts[1]);
        addUnique(detail.usage, display(parts[2] || ''));
        detail.dispensingQuantity = joinAmount(parts[3], parts[4]);
        break;
      }
      case '311':
        addUnique(rp(parts[1]).usage, display(parts[2] || ''));
        break;
    }
  }

  return {
    prescriptionDate,
    hospitalName,
    department,
    doctorName,
    medicines: medicines.map(medicine => {
      const detail = rp(medicine.rpNumber);
      return {
        name: medicine.name,
        usage: [...detail.usage],
        quantityInfo: combineQuantity(medicine.medicineQuantity, detail.dispensingQuantity)
      };
    })
  };
}

function rebuildLines(data) {
  const output = [];
  for (const line of normalizeQrData(data).split('\n')) {
    const firstField = line.split(',')[0].trim();
    if (JAHIS_RECORD_CODES.has(firstField) || /^JAHIS/i.test(firstField)) {
      output.push(line);
    } else if (output.length) {
      output[output.length - 1] += line;
    } else {
      output.push(line);
    }
  }
  return output;
}

function addUnique(values, value) {
  if (value && !values.includes(value)) values.push(value);
}

function combineQuantity(medicineQuantity, dispensingQuantity) {
  return [medicineQuantity, dispensingQuantity].filter(Boolean).join('・');
}

function joinAmount(rawAmount, rawUnit) {
  const amount = number(rawAmount || '');
  const unit = display(rawUnit || '');
  return amount && unit ? `${amount}${unit}` : amount || unit;
}

function display(value) {
  return String(value || '')
    .replaceAll('﨑', '崎')
    .replaceAll('髙', '高')
    .replaceAll('神', '神')
    .replaceAll('塚', '塚')
    .trim();
}

function number(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/[０-９]/g, character => String(character.charCodeAt(0) - 65248))
    .replaceAll('．', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? String(parsed) : normalized;
}

function formatDate(value) {
  const raw = String(value || '').trim().toUpperCase();
  let year;
  let month;
  let day;

  if (/^\d{8}$/.test(raw)) {
    year = Number(raw.slice(0, 4));
    month = Number(raw.slice(4, 6));
    day = Number(raw.slice(6, 8));
  } else if (/^\d{7}$/.test(raw)) {
    const eraStarts = { 1: 1868, 2: 1912, 3: 1926, 4: 1989, 5: 2019 };
    const startYear = eraStarts[Number(raw[0])];
    if (!startYear) return value;
    year = startYear + Number(raw.slice(1, 3)) - 1;
    month = Number(raw.slice(3, 5));
    day = Number(raw.slice(5, 7));
  } else if (/^[MTSHR]\d{6}$/.test(raw)) {
    const eraStarts = { M: 1868, T: 1912, S: 1926, H: 1989, R: 2019 };
    year = eraStarts[raw[0]] + Number(raw.slice(1, 3)) - 1;
    month = Number(raw.slice(3, 5));
    day = Number(raw.slice(5, 7));
  } else {
    return value;
  }

  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? `${year}年${month}月${day}日`
    : value;
}
