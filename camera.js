'use strict';

// スキャナー設定値
const SCAN_TIMEOUT_MS = 15000;     // 映像表示後、落ち着いて合わせられる15秒に延長
const SCAN_RETURN_DELAY_MS = 4000; // ホーム自動復帰時間

const scannerState = {
  stream: null,
  scanning: false,
  scanTimer: null,
  returnTimer: null,
  animFrameId: null,
  barcodeDetector: null,
  zxingReader: null,
  zxingControls: null
};

// 過去の記録との重複チェック
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

// 読み取りデータ受付
function addQrData(raw, sourceFingerprint = '') {
  const data = typeof normalizeQrData === 'function' ? normalizeQrData(raw) : String(raw || '').trim();
  if (!data) return 'EMPTY';
  if (data.length < 20 || !data.includes(',')) return 'INVALID';

  const fingerprints = [typeof qrFingerprint === 'function' ? qrFingerprint(data) : '', sourceFingerprint].filter(Boolean);

  if (fingerprints.some(f => state.qrFingerprints.includes(f)) || state.qrList.some(q => (typeof qrFingerprint === 'function' ? qrFingerprint(q) : '') === fingerprints[0])) {
    return 'DUPLICATE';
  }

  const storedMatch = matchesStoredQr(data, fingerprints);
  const history = typeof getQrHistory === 'function' ? getQrHistory() : [];
  if (storedMatch && fingerprints.some(f => history.includes(f))) return 'PREVIOUS';

  const isFirstItem = state.qrList.length === 0;
  const hasHospitalHeader = data.split('\n').some(l => l.trimStart().startsWith('51,'));

  if (isFirstItem && !hasHospitalHeader) {
    return 'MISSING';
  }

  if (isFirstItem && storedMatch) return 'PREVIOUS';

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

// スキャン結果処理
async function acceptQr(raw, sourceFingerprint = '') {
  scannerState.scanning = false;
  clearScanTimers();
  await stopCamera();

  const result = addQrData(raw, sourceFingerprint);
  const statusEl = document.querySelector('#scanner-status');
  const cameraFrame = document.querySelector('.camera-frame');

  if (cameraFrame) cameraFrame.style.display = 'none';
  if (!statusEl) return;

  if (result === 'ADDED') {
    if (typeof playBeepSound === 'function') playBeepSound();
    statusEl.style.color = '#1b5e20';
    statusEl.innerHTML = `（ <span class="scan-count">${state.qrList.length}</span> 件読み取り成功 ）`;
    showScanChoice(true);
  } else if (result === 'MISSING') {
    statusEl.style.color = '#c62828';
    statusEl.textContent = '読み取る順番が違います（1枚目から読み取ってください）。';
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

// スキャナーUIオープン
async function openScanner() {
  const dialogEl = document.querySelector('#scanner-dialog');
  const statusEl = document.querySelector('#scanner-status');
  const cameraFrame = document.querySelector('.camera-frame');

  if (dialogEl && !dialogEl.open) dialogEl.showModal();
  hideScanChoice();
  if (typeof initAudio === 'function') initAudio();

  if (cameraFrame) cameraFrame.style.display = 'block';

  if (statusEl) {
    statusEl.style.color = '#222';
    statusEl.textContent = 'カメラを起動中...';
  }

  await startCamera();
}

// カメラ起動・認識処理
async function startCamera() {
  await stopCamera();
  await new Promise(resolve => setTimeout(resolve, 150));

  const videoEl = document.querySelector('#camera-video');
  const statusEl = document.querySelector('#scanner-status');
  if (!videoEl) return;

  try {
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920, min: 1280 },
        height: { ideal: 1080, min: 720 }
      },
      audio: false
    };

    scannerState.stream = await navigator.mediaDevices.getUserMedia(constraints);
    videoEl.srcObject = scannerState.stream;
    await videoEl.play();

    const track = scannerState.stream.getVideoTracks()[0];

    // 自然な距離感で合焦する1.4倍ズームとピント追従
    if (track) {
      try {
        const caps = track.getCapabilities?.() || {};
        const advanced = {};

        if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
          advanced.focusMode = 'continuous';
        }
        if (caps.zoom) {
          const targetZoom = Math.min(Math.max(1.4, caps.zoom.min), caps.zoom.max);
          advanced.zoom = targetZoom;
        }

        if (Object.keys(advanced).length) {
          await track.applyConstraints({ advanced: [advanced] });
        }
      } catch (err) {}
    }

    // 映像の準備が完了してからスキャン判定とタイマーを起動
    videoEl.onloadedmetadata = () => {
      scannerState.scanning = true;

      if (statusEl) {
        statusEl.style.color = '#222';
        statusEl.textContent = state.qrList.length ? '次のQRコードを枠に合わせてください' : 'QRコードを枠に合わせてください';
      }

      // 映像が映ってから15秒の計測を開始
      scannerState.scanTimer = setTimeout(handleScanTimeout, SCAN_TIMEOUT_MS);

      // エンジンの起動
      if ('BarcodeDetector' in window) {
        scannerState.barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
        runBarcodeDetectorLoop(videoEl);
      } else if (typeof ZXingBrowser !== 'undefined') {
        runZxingFallback(videoEl);
      }
    };

    // すでにメタデータ取得済みの場合の即時発火
    if (videoEl.readyState >= HTMLMediaElement.HAVE_METADATA) {
      videoEl.onloadedmetadata();
    }
  } catch (e) {
    scannerState.scanning = false;
    if (statusEl) {
      statusEl.textContent = location.protocol === 'https:' ? 'カメラを使用できません。権限をご確認ください。' : 'カメラ利用にはHTTPSが必要です。';
    }
  }
}

// Android ネイティブの BarcodeDetector ループ
async function runBarcodeDetectorLoop(videoEl) {
  if (!scannerState.scanning) return;

  try {
    if (videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const barcodes = await scannerState.barcodeDetector.detect(videoEl);
      if (barcodes && barcodes.length > 0 && scannerState.scanning) {
        scannerState.scanning = false;
        const rawValue = barcodes[0].rawValue || '';
        const fp = typeof qrFingerprint === 'function' ? qrFingerprint(rawValue) : '';
        acceptQr(rawValue, fp);
        return;
      }
    }
  } catch (err) {}

  if (scannerState.scanning) {
    scannerState.animFrameId = requestAnimationFrame(() => runBarcodeDetectorLoop(videoEl));
  }
}

// ZXing フォールバック
async function runZxingFallback(videoEl) {
  try {
    const hints = new Map([[4, 'Shift_JIS']]);
    scannerState.zxingReader = new ZXingBrowser.BrowserQRCodeReader(hints, { delayBetweenScanAttempts: 50 });
    scannerState.zxingControls = await scannerState.zxingReader.decodeFromVideoElement(videoEl, (result) => {
      if (!result || !scannerState.scanning) return;
      scannerState.scanning = false;
      const text = typeof decodeZxingResult === 'function' ? decodeZxingResult(result) : result.getText();
      const fp = typeof zxingFingerprint === 'function' ? zxingFingerprint(result) : '';
      acceptQr(text, fp);
    });
  } catch (err) {}
}

function clearScanTimers() {
  clearTimeout(scannerState.scanTimer);
  clearTimeout(scannerState.returnTimer);
  scannerState.scanTimer = null;
  scannerState.returnTimer = null;
  if (scannerState.animFrameId) {
    cancelAnimationFrame(scannerState.animFrameId);
    scannerState.animFrameId = null;
  }
}

// タイムアウト時の自動復帰
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

// カメラ停止
async function stopCamera() {
  clearScanTimers();
  scannerState.scanning = false;

  const videoEl = document.querySelector('#camera-video');
  if (videoEl) {
    videoEl.onloadedmetadata = null;
  }

  try {
    scannerState.zxingControls?.stop();
  } catch {}
  scannerState.zxingControls = null;
  scannerState.zxingReader = null;

  if (scannerState.stream) {
    scannerState.stream.getTracks().forEach(track => {
      try { track.stop(); } catch {}
    });
    scannerState.stream = null;
  }
  if (videoEl && videoEl.srcObject) {
    videoEl.srcObject = null;
  }
}

// スキャナーダイアログを閉じる
async function closeScanner() {
  await stopCamera();
  const dialogEl = document.querySelector('#scanner-dialog');
  if (dialogEl && dialogEl.open) dialogEl.close();
}

// 読み取り完了・保存
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