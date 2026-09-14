'use strict';

// スキャナー専用の設定値
const SCAN_TIMEOUT_MS = 6000;
const SCAN_RETURN_DELAY_MS = 4000;

// スキャナー専用の独立した状態管理
const scannerState = {
  stream: null,
  reader: null,
  controls: null,
  scanning: false,
  scanTimer: null,
  returnTimer: null
};

// 重複チェック部品
function matchesStoredQr(data, fingerprints = []) {
  const records = typeof getRecords === 'function' ? getRecords() : [];
  if (records.some(record => Array.isArray(record.qrFingerprints) && fingerprints.some(f => record.qrFingerprints.includes(f)))) return true;
  const incoming = typeof parsePrescription === 'function' ? parsePrescription(data) : { prescriptionDate: '', hospitalName: '', medicines: [] };
  if (incoming.prescriptionDate && incoming.hospitalName) {
    return records.some(record => norm(record.prescriptionDate) === norm(incoming.prescriptionDate) && norm(record.hospitalName) === norm(incoming.hospitalName));
  }
  const medicineNames = incoming.medicines.map(m => norm(m.name)).filter(Boolean);
  return medicineNames.length > 0 && records.some(record => medicineNames.every(name => record.medicines.some(m => norm(m.name) === name)));
}

// 読み取ったデータの受付
function addQrData(raw, sourceFingerprint = '') {
  const data = typeof normalizeQrData === 'function' ? normalizeQrData(raw) : String(raw || '').trim();
  if (!data) return 'EMPTY';
  if (data.length < 20 || !data.includes(',')) return 'INVALID';

  const fingerprints = [typeof qrFingerprint === 'function' ? qrFingerprint(data) : '', sourceFingerprint].filter(Boolean);
  if (fingerprints.some(f => state.qrFingerprints.includes(f)) || state.qrList.some(q => (typeof qrFingerprint === 'function' ? qrFingerprint(q) : '') === fingerprints[0])) return 'DUPLICATE';

  const storedMatch = matchesStoredQr(data, fingerprints);
  const history = typeof getQrHistory === 'function' ? getQrHistory() : [];
  if (storedMatch && fingerprints.some(f => history.includes(f))) return 'PREVIOUS';
  if (!state.qrList.length && !data.split('\n').some(l => l.trimStart().startsWith('51,'))) return 'MISSING';
  if (!state.qrList.length && storedMatch) return 'PREVIOUS';

  state.qrList.push(data);
  state.qrFingerprints.push(...fingerprints);
  state.notice = '';
  return 'ADDED';
}

function showScanChoice(canContinue) {
  const choice = document.querySelector('#scan-choice');
  const nextBtn = document.querySelector('#scanner-next');
  const finishBtn = document.querySelector('#scanner-finish');
  const backBtn = document.querySelector('#scanner-back');

  if (choice) choice.classList.remove('hidden');
  if (nextBtn) nextBtn.classList.toggle('hidden', !canContinue);
  if (finishBtn) finishBtn.classList.toggle('hidden', state.qrList.length === 0);
  if (backBtn) backBtn.classList.toggle('hidden', canContinue || state.qrList.length > 0);
}

function hideScanChoice() {
  const choice = document.querySelector('#scan-choice');
  if (choice) choice.classList.add('hidden');
}

// スキャン成功時の受付処理
async function acceptQr(raw, sourceFingerprint = '') {
  scannerState.scanning = false;
  clearScanTimers();
  await stopCamera();

  const result = addQrData(raw, sourceFingerprint);
  const statusEl = document.querySelector('#scanner-status');
  const cameraFrame = document.querySelector('.camera-frame');

  // カメラ枠を隠して黒い四角形を消去
  if (cameraFrame) cameraFrame.style.display = 'none';

  if (!statusEl) return;

  if (result === 'ADDED') {
    if (typeof playBeepSound === 'function') playBeepSound();
    statusEl.style.color = '#1b5e20';
    statusEl.innerHTML = `（ <span class="scan-count">${state.qrList.length}</span> 件読み取り成功 ）`;
    showScanChoice(true);
  } else if (result === 'MISSING') {
    statusEl.style.color = '#c62828';
    statusEl.textContent = '読み取る順番が違います。やり直してください。';
    showScanChoice(false);
  } else if (result === 'DUPLICATE' || result === 'PREVIOUS') {
    statusEl.style.color = '#c62828';
    statusEl.textContent = 'すでに読み取り済みのQRコードです。';
    showScanChoice(result === 'DUPLICATE' ? true : state.qrList.length > 0);
  } else if (result === 'INVALID') {
    statusEl.style.color = '#c62828';
    statusEl.textContent = 'QRコードを認識できませんでした。';
    showScanChoice(false);
  } else {
    statusEl.style.color = '#c62828';
    statusEl.textContent = '読み取りデータが空です。';
    showScanChoice(false);
  }
}

// スキャナーを開く
async function openScanner() {
  const dialogEl = document.querySelector('#scanner-dialog');
  const statusEl = document.querySelector('#scanner-status');
  const cameraFrame = document.querySelector('.camera-frame');

  if (dialogEl && !dialogEl.open) dialogEl.showModal();
  hideScanChoice();
  if (typeof initAudio === 'function') initAudio();

  // カメラ枠を再表示
  if (cameraFrame) cameraFrame.style.display = 'block';

  if (statusEl) {
    statusEl.style.color = '#222';
    statusEl.textContent = state.qrList.length ? '次のQRコードを枠に合わせてください' : 'QRコードを枠に合わせてください';
  }

  if (typeof ZXingBrowser === 'undefined') {
    if (statusEl) {
      statusEl.style.color = '#c62828';
      statusEl.textContent = '読取機能を読み込めませんでした。再読み込みしてください。';
    }
    return;
  }
  await startCamera();
}

// カメラを起動してQRスキャンを開始する
async function startCamera() {
  await stopCamera();

  const videoEl = document.querySelector('#camera-video');
  const statusEl = document.querySelector('#scanner-status');

  await new Promise(resolve => setTimeout(resolve, 150));

  try {
    const hints = new Map([[3, true], [4, 'Shift_JIS']]);
    scannerState.reader = new ZXingBrowser.BrowserQRCodeReader(hints, {
      delayBetweenScanAttempts: 80,
      delayBetweenScanSuccess: 1000,
      tryPlayVideoTimeout: 8000
    });

    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920, min: 1280 },
        height: { ideal: 1080, min: 720 }
      },
      audio: false
    };

    scannerState.scanning = true;
    scannerState.controls = await scannerState.reader.decodeFromConstraints(constraints, videoEl, (result) => {
      if (!result || !scannerState.scanning) return;
      scannerState.scanning = false;
      const text = typeof decodeZxingResult === 'function' ? decodeZxingResult(result) : result.getText();
      const fp = typeof zxingFingerprint === 'function' ? zxingFingerprint(result) : '';
      acceptQr(text, fp);
    });

    scannerState.stream = videoEl.srcObject;
    const track = scannerState.stream?.getVideoTracks?.()[0];

    // 1.2倍ズームとピントの自動設定
    if (track) {
      try {
        const caps = track.getCapabilities?.() || {};
        const advanced = {};
        if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) advanced.focusMode = 'continuous';
        if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) advanced.exposureMode = 'continuous';

        if (caps.zoom) {
          const targetZoom = Math.min(Math.max(1.2, caps.zoom.min), caps.zoom.max);
          advanced.zoom = targetZoom;
        }

        if (Object.keys(advanced).length) await track.applyConstraints({ advanced: [advanced] });
      } catch (err) {}
    }

    if (scannerState.scanning) scannerState.scanTimer = setTimeout(handleScanTimeout, SCAN_TIMEOUT_MS);
  } catch (e) {
    scannerState.scanning = false;
    if (statusEl) {
      statusEl.textContent = location.protocol === 'https:' ? 'カメラを使用できません。権限をご確認ください。' : 'カメラ利用にはHTTPSが必要です。';
    }
  }
}

function clearScanTimers() {
  clearTimeout(scannerState.scanTimer);
  clearTimeout(scannerState.returnTimer);
  scannerState.scanTimer = null;
  scannerState.returnTimer = null;
}

async function handleScanTimeout() {
  if (!scannerState.scanning) return;
  scannerState.scanTimer = null;
  await stopCamera();
  hideScanChoice();

  const cameraFrame = document.querySelector('.camera-frame');
  if (cameraFrame) cameraFrame.style.display = 'none';

  const statusEl = document.querySelector('#scanner-status');
  if (statusEl) {
    statusEl.style.color = '#c62828';
    statusEl.textContent = '読み取れませんでした。ホームに戻ります。';
  }

  scannerState.returnTimer = setTimeout(async () => {
    scannerState.returnTimer = null;
    await closeScanner();
    if (typeof navigate === 'function') navigate('home');
  }, SCAN_RETURN_DELAY_MS);
}

async function stopCamera() {
  clearScanTimers();
  scannerState.scanning = false;
  try {
    scannerState.controls?.stop();
  } catch {}
  scannerState.controls = null;

  const videoEl = document.querySelector('#camera-video');
  if (scannerState.stream) {
    scannerState.stream.getTracks().forEach(track => track.stop());
    scannerState.stream = null;
  }
  if (videoEl && videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach(track => track.stop());
    videoEl.srcObject = null;
  }
}

async function closeScanner() {
  await stopCamera();
  const dialogEl = document.querySelector('#scanner-dialog');
  if (dialogEl && dialogEl.open) dialogEl.close();
}

async function finishReading() {
  if (!state.qrList.length) return;
  const record = typeof parsePrescription === 'function' ? parsePrescription(state.qrList.join('\n')) : null;
  const statusEl = document.querySelector('#scanner-status');

  if (!record || !record.medicines.length) {
    if (statusEl) statusEl.textContent = 'お薬の情報を読み取れませんでした。QRコードをご確認ください。';
    return;
  }
  const readFingerprints = [...new Set(state.qrFingerprints)];
  record.qrFingerprints = readFingerprints;
  const saved = typeof saveRecord === 'function' ? saveRecord(record) : false;
  if (typeof rememberQrFingerprints === 'function') rememberQrFingerprints(readFingerprints);
  state.qrList = [];
  state.qrFingerprints = [];
  state.notice = '';
  await closeScanner();
  if (typeof navigate === 'function') navigate('home');
  if (typeof flash === 'function') flash(saved ? '記録を保存しました' : '同じ処方の記録がすでにあります');
}