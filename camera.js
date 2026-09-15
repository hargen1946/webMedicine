'use strict';

// スキャナー設定値
const SCAN_TIMEOUT_MS = 15000;     // 15秒待機
const SCAN_RETURN_DELAY_MS = 4000; // ホーム自動復帰時間
const SCAN_INTERVAL_MS = 150;      // 安定した解析間隔

const scannerState = {
  stream: null,
  scanning: false,
  isProcessing: false,
  scanTimer: null,
  returnTimer: null,
  loopTimer: null,
  offscreenCanvas: null,
  offscreenCtx: null
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
async function acceptQr(raw) {
  scannerState.scanning = false;
  clearScanTimers();
  await stopCamera();

  const fp = typeof qrFingerprint === 'function' ? qrFingerprint(raw) : '';
  const result = addQrData(raw, fp);
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

// カメラ起動処理
async function startCamera() {
  await stopCamera();
  await new Promise(resolve => setTimeout(resolve, 80));

  const videoEl = document.querySelector('#camera-video');
  const statusEl = document.querySelector('#scanner-status');
  if (!videoEl) return;

  // オフスクリーンCanvasの準備
  if (!scannerState.offscreenCanvas) {
    scannerState.offscreenCanvas = document.createElement('canvas');
    scannerState.offscreenCtx = scannerState.offscreenCanvas.getContext('2d', { willReadFrequently: true });
  }

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

    scannerState.scanning = true;
    scannerState.isProcessing = false;

    if (statusEl) {
      statusEl.style.color = '#222';
      statusEl.textContent = state.qrList.length ? '次のQRコードを枠に合わせてください' : 'QRコードを枠に合わせてください';
    }

    scannerState.scanTimer = setTimeout(handleScanTimeout, SCAN_TIMEOUT_MS);

    // ピント追従と緩やかなズーム（1.3倍）の適用
    const track = scannerState.stream.getVideoTracks()[0];
    if (track) {
      setTimeout(async () => {
        try {
          const caps = track.getCapabilities?.() || {};
          const advanced = {};
          if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
            advanced.focusMode = 'continuous';
          }
          if (caps.zoom) {
            advanced.zoom = Math.min(Math.max(1.3, caps.zoom.min), caps.zoom.max);
          }
          if (Object.keys(advanced).length) {
            await track.applyConstraints({ advanced: [advanced] });
          }
        } catch (err) {}
      }, 200);
    }

    // WASMスキャンループの開始
    scheduleDirectWasmLoop(videoEl);

  } catch (e) {
    scannerState.scanning = false;
    if (statusEl) {
      statusEl.textContent = location.protocol === 'https:' ? 'カメラを使用できません。権限をご確認ください。' : 'カメラ利用にはHTTPSが必要です。';
    }
  }
}

// ZXing-C++ (WebAssembly) 直接解析ループ
function scheduleDirectWasmLoop(videoEl) {
  if (!scannerState.scanning) return;

  scannerState.loopTimer = setTimeout(async () => {
    if (!scannerState.scanning) return;

    if (!scannerState.isProcessing && videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;

      if (vw > 0 && vh > 0 && window.ZXingWASM) {
        scannerState.isProcessing = true;

        try {
          // 全画面を適正解像度でCanvasに描画（欠けを完全に防止）
          scannerState.offscreenCanvas.width = vw;
          scannerState.offscreenCanvas.height = vh;
          scannerState.offscreenCtx.drawImage(videoEl, 0, 0, vw, vh);

          const imageData = scannerState.offscreenCtx.getImageData(0, 0, vw, vh);

          // C++ WASM による高密度QRコードの深層解析
          const results = await window.ZXingWASM.readBarcodes(imageData, {
            formats: ['QRCode'],
            tryHarder: true,          // 高密度セルの精密探索
            maxNumberOfSymbols: 1,
            characterSet: 'Shift_JIS' // JAHIS処方箋文字コード
          });

          if (results && results.length > 0 && scannerState.scanning) {
            const res = results[0];
            let text = res.text || '';

            // Shift_JISデコード化け対策（バイナリ復元）
            if (res.bytes && (!text || text.includes(''))) {
              try {
                const decoder = new TextDecoder('shift-jis');
                text = decoder.decode(res.bytes);
              } catch (e) {}
            }

            if (text) {
              scannerState.scanning = false;
              acceptQr(text);
              return;
            }
          }
        } catch (err) {
          // 次のフレームで再試行
        } finally {
          scannerState.isProcessing = false;
        }
      }
    }

    scheduleDirectWasmLoop(videoEl);
  }, SCAN_INTERVAL_MS);
}

function clearScanTimers() {
  clearTimeout(scannerState.scanTimer);
  clearTimeout(scannerState.returnTimer);
  clearTimeout(scannerState.loopTimer);
  scannerState.scanTimer = null;
  scannerState.returnTimer = null;
  scannerState.loopTimer = null;
}

// タイムアウト復帰
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
  scannerState.isProcessing = false;

  if (scannerState.stream) {
    scannerState.stream.getTracks().forEach(track => {
      try { track.stop(); } catch {}
    });
    scannerState.stream = null;
  }

  const videoEl = document.querySelector('#camera-video');
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