'use strict';

function normalizeQrData(data) {
  return String(data || '').replace(/\r\n?/g, '\n').split('\n').map(s => s.trim()).filter(Boolean).join('\n').trim();
}

function qrFingerprint(data) {
  const value = normalizeQrData(data).normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\ufffd]/g, '').replace(/\s+/g, '');
  if (!value) return '';
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `text:${value.length}:${hash >>> 0}`;
}

function decodeZxingResult(result) {
  const text = result.getText?.() || String(result.text || '');
  try {
    const bytes = result.getRawBytes?.();
    if (!bytes?.length) return text;
    const sjis = new TextDecoder('shift_jis').decode(new Uint8Array(bytes));
    // 日本語の自然さ採点（ひらがな・カタカナ・漢字をカウント）
    const quality = value => ((value.match(/[ぁ-んァ-ヶ一-龠]/g) || []).length * 2) - ((value.match(/\ufffd/g) || []).length * 12) + ((value.match(/(^|\n)(5|51|55|201|301|311),/g) || []).length * 5);
    return quality(sjis) > quality(text) ? sjis : text;
  } catch {
    return text;
  }
}

function zxingFingerprint(result) {
  try {
    const bytes = result.getRawBytes?.();
    if (!bytes?.length) return '';
    let hash = 2166136261;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 16777619);
    }
    return `raw:${bytes.length}:${hash >>> 0}`;
  } catch {
    return '';
  }
}

function parsePrescription(data) {
  const lines = rebuildLines(data);
  let prescriptionDate = '', hospitalName = '', department = '', doctorName = '';
  const map = new Map();
  const get = n => {
    if (!map.has(n)) map.set(n, { name: '', usage: [], medicineQuantity: '', dispensingQuantity: '' });
    return map.get(n);
  };

  for (const line of lines) {
    const p = line.split(',').map(x => x.trim());
    if (p[0] === '5') prescriptionDate = formatDate(p[1] || '');
    else if (p[0] === '51') hospitalName = p[1] || '';
    else if (p[0] === '55') {
      doctorName = display(p[1] || '');
      department = display((p[2] || '').replace(/^【|】$/g, ''));
    } else if (p[0] === '201') {
      const n = Number.parseInt(p[1], 10);
      if (Number.isNaN(n)) continue;
      const d = get(n);
      if (p[2]) d.name = display(p[2]);
      if (p[3] && p[4]) d.medicineQuantity = number(p[3]) + display(p[4]);
    } else if (p[0] === '301') {
      const n = Number.parseInt(p[1], 10);
      if (Number.isNaN(n)) continue;
      const d = get(n), u = display(p[2] || '');
      if (u && !d.usage.includes(u)) d.usage.push(u);
      if (p[3] && p[4]) d.dispensingQuantity = number(p[3]) + display(p[4]);
    } else if (p[0] === '311') {
      const n = Number.parseInt(p[1], 10);
      if (Number.isNaN(n)) continue;
      const d = get(n), u = display(p[2] || '');
      if (u && !d.usage.includes(u)) d.usage.push(u);
    }
  }

  const medicines = [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, d]) => ({
    name: d.name.trim(),
    usage: d.usage,
    quantityInfo: d.dispensingQuantity.endsWith('日分') ? d.dispensingQuantity : (d.medicineQuantity || d.dispensingQuantity)
  })).filter(m => m.name);

  return { prescriptionDate, hospitalName, department, doctorName, medicines };
}

function rebuildLines(data) {
  const codes = new Set(['1', '2', '3', '4', '5', '11', '15', '31', '51', '55', '201', '281', '291', '301', '311', '391', '401', '411', '421', '501', '601', '701', '911']);
  const out = [];
  for (const line of normalizeQrData(data).split('\n')) {
    if (codes.has(line.split(',')[0].trim())) out.push(line);
    else if (out.length) out[out.length - 1] += line;
    else out.push(line);
  }
  return out;
}

function display(v) {
  return String(v).replaceAll('﨑', '崎').replaceAll('髙', '高').replaceAll('神', '神').replaceAll('塚', '塚').trim();
}

function number(v) {
  const n = String(v).trim().replace(/[０-９]/g, c => String(c.charCodeAt(0) - 65248)).replaceAll('．', '.');
  const x = Number(n);
  return Number.isFinite(x) ? String(x) : n;
}

function formatDate(v) {
  if (!/^\d{8}$/.test(v)) return v;
  const y = +v.slice(0, 4), m = +v.slice(4, 6), d = +v.slice(6, 8), dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? `${y}年${m}月${d}日` : v;
}