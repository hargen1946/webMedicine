'use strict';

const SCAN_TIMEOUT_MS = 30000;
const SCAN_INTERVAL_MS = 180;
const MAX_CAMERA_FRAME_EDGE = 1800;
const MAX_IMAGE_EDGE = 2600;

const READER_OPTIONS = {
  formats: ['QRCode'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  tryDenoise: true,
  maxNumberOfSymbols: 1,
  characterSet: 'Shift_JIS',
  textMode: 'Plain'
};

// WASM本体もアプリ内から読み込み、外部CDNや通信状態に依存させない。
window.ZXingWASM?.prepareZXingModule?.({
  overrides: {
    locateFile: fileName => new URL(`./vendor/zxing-wasm/${fileName}`, window.location.href).href
  }
});

const scannerState = {
  stream: null,
  scanning: false,
  isProcessing: false,
  scanTimer: null,
  loopTimer: null,
  offscreenCanvas: null,
  offscreenCtx: null,
  worker: null,
  workerFailed: false,
  pendingRequests: new Map(),
  requestId: 0,
  scanGeneration: 0,
  scanPass: 0,
  parts: []
};

function normalizeBytes(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return null;
}

function textQuality(value) {
  const text = String(value || '');
  const japanese = (text.match(/[ぁ-んァ-ヶ一-龠々ー]/g) || []).length;
  const records = (text.match(/(^|\n)(?:1|2|3|4|5|11|15|31|51|55|201|281|291|301|311|391|401|411|421|501|601|701|911),/g) || []).length;
  const replacement = (text.match(/\ufffd/g) || []).length;
  const controls = (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) || []).length;
  return japanese * 2 + records * 8 - replacement * 20 - controls * 8;
}

function decodeReadText(result) {
  const primary = String(result?.text || '');
  const bytes = normalizeBytes(result?.bytes);
  if (!bytes?.length) return primary;

  try {
    const shiftJis = new TextDecoder('shift_jis').decode(bytes);
    return textQuality(shiftJis) > textQuality(primary) ? shiftJis : primary;
  } catch {
    return primary;
  }
}

function bytesFingerprint(value) {
  const bytes = normalizeBytes(value);
  if (!bytes?.length) return '';
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `raw:${bytes.length}:${hash >>> 0}`;
}

function normalizeReadResult(result) {
  if (!result || result.isValid === false) return null;
  const text = decodeReadText(result);
  if (!text) return null;
  return {
    text,
    fingerprint: bytesFingerprint(result.bytes),
    sequenceSize: Number.isInteger(result.sequenceSize) ? result.sequenceSize : -1,
    sequenceIndex: Number.isInteger(result.sequenceIndex) ? result.sequenceIndex : -1,
    sequenceId: String(result.sequenceId ?? '')
  };
}

function rejectPendingWorkerRequests(error) {
  for (const { reject } of scannerState.pendingRequests.values()) reject(error);
  scannerState.pendingRequests.clear();
}

function getDecodeWorker() {
  if (scannerState.workerFailed || typeof Worker === 'undefined') return null;
  if (scannerState.worker) return scannerState.worker;

  try {
    const worker = new Worker('./qrWorker.js?v=10');
    worker.onmessage = event => {
      const { requestId, type, result, error } = event.data || {};
      const pending = scannerState.pendingRequests.get(requestId);
      if (!pending) return;
      scannerState.pendingRequests.delete(requestId);
      if (type === 'ERROR') pending.reject(new Error(error || 'QR解析に失敗しました'));
      else pending.resolve(type === 'SUCCESS' ? result : null);
    };
    worker.onerror = () => {
      scannerState.workerFailed = true;
      rejectPendingWorkerRequests(new Error('QR解析ワーカーを起動できませんでした'));
      worker.terminate();
      scannerState.worker = null;
    };
    scannerState.worker = worker;
    return worker;
  } catch {
    scannerState.workerFailed = true;
    return null;
  }
}

async function decodeOnMainThread(imageData) {
  const engine = window.ZXingWASM;
  if (!engine || typeof engine.readBarcodes !== 'function') {
    throw new Error('QR解析ライブラリを読み込めませんでした');
  }
  const results = await engine.readBarcodes(imageData, READER_OPTIONS);
  return normalizeReadResult(results?.find(result => result?.isValid !== false));
}

function decodeImageData(imageData) {
  const worker = getDecodeWorker();
  if (!worker) return decodeOnMainThread(imageData);

  return new Promise((resolve, reject) => {
    const requestId = ++scannerState.requestId;
    scannerState.pendingRequests.set(requestId, { resolve, reject });
    try {
      // ワーカー起動失敗時に同じ画像をメイン側で再解析できるよう、
      // バッファの所有権は移さず構造化コピーする。
      worker.postMessage({ requestId, imageData });
    } catch (error) {
      scannerState.pendingRequests.delete(requestId);
      reject(error);
    }
  }).catch(() => decodeOnMainThread(imageData));
}

// 読み取り段階では、生データ由来の指紋が一致した場合だけ重複とする。
function matchesStoredQr(_data, fingerprints = []) {
  const records = typeof getRecords === 'function' ? getRecords() : [];
  return records.some(record =>
    Array.isArray(record.qrFingerprints) &&
    fingerprints.some(fingerprint => record.qrFingerprints.includes(fingerprint))
  );
}

function isLikelyPrescriptionData(data) {
  if (data.length < 10 || !data.includes(',')) return false;
  return /(^|\n)\s*(?:JAHIS\d*|1|2|3|4|5|11|15|31|51|55|201|281|291|301|311|391|401|411|421|501|601|701|911),?/m.test(data);
}

function orderedParts() {
  const parts = [...scannerState.parts];
  const sequenced = parts.filter(part => part.sequenceIndex >= 0 && part.sequenceSize > 1);
  if (sequenced.length < 2) return parts;

  const sequenceIds = new Set(sequenced.map(part => part.sequenceId).filter(Boolean));
  if (sequenceIds.size > 1) return parts;

  return parts.sort((a, b) => {
    if (a.sequenceIndex < 0) return 1;
    if (b.sequenceIndex < 0) return -1;
    return a.sequenceIndex - b.sequenceIndex;
  });
}

function syncQrListFromParts() {
  state.qrList = orderedParts().map(part => part.data);
}

function clearCurrentScan() {
  state.qrList = [];
  state.qrFingerprints = [];
  scannerState.parts = [];
  state.notice = '';
}

function saveCurrentScanRecord() {
  if (!state.qrList.length) return { ok: false, saved: false };
  if (scannerState.parts.length) syncQrListFromParts();
  const record = typeof parsePrescription === 'function' ? parsePrescription(state.qrList.join('\n')) : null;
  if (!record || !record.medicines.length) return { ok: false, saved: false };

  const readFingerprints = [...new Set(state.qrFingerprints)];
  record.qrFingerprints = readFingerprints;
  const saved = typeof saveRecord === 'function' ? saveRecord(record) : false;
  if (typeof rememberQrFingerprints === 'function') rememberQrFingerprints(readFingerprints);
  clearCurrentScan();
  return { ok: true, saved };
}

function scanProgress() {
  const sequenced = scannerState.parts.filter(part =>
    Number.isInteger(part.sequenceSize) && part.sequenceSize > 1 &&
    Number.isInteger(part.sequenceIndex) && part.sequenceIndex >= 0
  );
  if (!sequenced.length) {
    return {
      count: scannerState.parts.length,
      expected: null,
      canContinue: true,
      canFinish: scannerState.parts.length > 0
    };
  }

  const expected = sequenced[0].sequenceSize;
  const count = new Set(sequenced.map(part => part.sequenceIndex)).size;
  const complete = count >= expected;
  return { count, expected, canContinue: !complete, canFinish: complete };
}

function addQrData(scanResult) {
  const raw = scanResult?.text || '';
  const data = typeof normalizeQrData === 'function' ? normalizeQrData(raw) : String(raw).trim();
  if (!data) return 'EMPTY';
  if (!isLikelyPrescriptionData(data)) return 'INVALID';

  if (!scannerState.parts.length && state.qrList.length) {
    scannerState.parts = state.qrList.map(existing => ({
      data: existing,
      fingerprint: typeof qrFingerprint === 'function' ? qrFingerprint(existing) : '',
      sequenceSize: -1,
      sequenceIndex: -1,
      sequenceId: ''
    }));
  }

  const textFingerprint = typeof qrFingerprint === 'function' ? qrFingerprint(data) : '';
  const fingerprints = [...new Set([textFingerprint, scanResult?.fingerprint || ''].filter(Boolean))];

  if (
    fingerprints.some(f => state.qrFingerprints.includes(f)) ||
    scannerState.parts.some(part => fingerprints.includes(part.fingerprint) || part.data === data)
  ) return 'DUPLICATE';

  const history = typeof getQrHistory === 'function' ? getQrHistory() : [];
  if (fingerprints.some(f => history.includes(f)) || matchesStoredQr(data, fingerprints)) return 'PREVIOUS';

  const incomingPart = {
    data,
    fingerprint: fingerprints[0] || '',
    sequenceSize: scanResult?.sequenceSize ?? -1,
    sequenceIndex: scanResult?.sequenceIndex ?? -1,
    sequenceId: scanResult?.sequenceId || ''
  };
  if (
    typeof canAppendPrescriptionQrPart === 'function' &&
    !canAppendPrescriptionQrPart(scannerState.parts, incomingPart)
  ) return 'DIFFERENT';

  scannerState.parts.push(incomingPart);
  state.qrFingerprints.push(...fingerprints.filter(f => !state.qrFingerprints.includes(f)));
  syncQrListFromParts();
  state.notice = '';
  return 'ADDED';
}

function showScanChoice(canContinue, canFinish = state.qrList.length > 0) {
  const choice = document.querySelector('#scan-choice');
  const nextBtn = document.querySelector('#scanner-next');
  const finishBtn = document.querySelector('#scanner-finish');
  const backBtn = document.querySelector('#scanner-back');

  choice?.classList.remove('hidden');
  nextBtn?.classList.toggle('hidden', !canContinue);
  finishBtn?.classList.toggle('hidden', !canFinish);
  backBtn?.classList.toggle('hidden', canContinue || canFinish);
}

function hideScanChoice() {
  document.querySelector('#scan-choice')?.classList.add('hidden');
}

function setScannerToolsVisible(visible) {
  document.querySelector('#scanner-tools')?.classList.toggle('hidden', !visible);
}

async function acceptQr(scanResult) {
  await stopCamera();

  const result = addQrData(scanResult);
  const statusEl = document.querySelector('#scanner-status');
  const cameraFrame = document.querySelector('.camera-frame');
  if (cameraFrame) cameraFrame.style.display = 'none';
  setScannerToolsVisible(false);
  if (!statusEl) return;

  if (result === 'ADDED') {
    if (typeof playBeepSound === 'function') playBeepSound();
    const progress = scanProgress();
    statusEl.style.color = '#1b5e20';
    statusEl.innerHTML = progress.expected
      ? `（ <span class="scan-count">${progress.count}</span> / ${progress.expected} 件読み取り成功 ）`
      : `（ <span class="scan-count">${state.qrList.length}</span> 件読み取り成功 ）`;
    showScanChoice(progress.canContinue, progress.canFinish);
  } else if (result === 'DUPLICATE' || result === 'PREVIOUS') {
    statusEl.style.color = '#c62828';
    statusEl.textContent = result === 'PREVIOUS'
      ? 'すでに保存済みのQRコードです。'
      : 'この読み取り中に同じQRコードを読み取りました。';
    const progress = scanProgress();
    showScanChoice(result === 'DUPLICATE' && progress.canContinue, progress.canFinish);
  } else if (result === 'DIFFERENT') {
    const currentProgress = scanProgress();
    if (currentProgress.canFinish) {
      const previous = saveCurrentScanRecord();
      const nextResult = previous.ok ? addQrData(scanResult) : 'INVALID';
      if (nextResult === 'ADDED') {
        if (typeof playBeepSound === 'function') playBeepSound();
        const nextProgress = scanProgress();
        statusEl.style.color = '#1b5e20';
        statusEl.innerHTML = `${previous.saved ? '前の処方箋を保存しました。' : '前の処方箋は保存済みでした。'}<br>` +
          (nextProgress.expected
            ? `新しい処方箋：<span class="scan-count">${nextProgress.count}</span> / ${nextProgress.expected} 件読み取り成功`
            : '新しい処方箋：1件読み取り成功');
        showScanChoice(nextProgress.canContinue, nextProgress.canFinish);
        return;
      }
    }

    statusEl.style.color = '#c62828';
    statusEl.textContent = '別の処方箋のQRです。現在の分割QRがまだ揃っていないため、続きのQRを読み取ってください。';
    const progress = scanProgress();
    showScanChoice(progress.canContinue, progress.canFinish);
  } else {
    statusEl.style.color = '#c62828';
    statusEl.textContent = '処方箋のQRデータとして認識できませんでした。';
    setScannerToolsVisible(true);
    const progress = scanProgress();
    showScanChoice(progress.canContinue, progress.canFinish);
  }
}

async function openScanner() {
  const dialogEl = document.querySelector('#scanner-dialog');
  const statusEl = document.querySelector('#scanner-status');
  const cameraFrame = document.querySelector('.camera-frame');

  if (dialogEl && !dialogEl.open) dialogEl.showModal();
  hideScanChoice();
  if (typeof initAudio === 'function') initAudio();
  if (cameraFrame) cameraFrame.style.display = 'block';
  setScannerToolsVisible(true);

  if (statusEl) {
    statusEl.style.color = '#222';
    statusEl.textContent = 'カメラを起動中...';
  }
  await startCamera();
}

async function applyCameraCapabilities(track) {
  try {
    const caps = track?.getCapabilities?.() || {};
    const advanced = {};
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
      advanced.focusMode = 'continuous';
    }
    // 自動ズームは高密度QRの端を欠けさせるため行わない。
    if (Object.keys(advanced).length) await track.applyConstraints({ advanced: [advanced] });
  } catch {
    // 詳細制約に非対応の端末でも通常の読取を続行する。
  }
}

async function startCamera() {
  await stopCamera();

  const videoEl = document.querySelector('#camera-video');
  const statusEl = document.querySelector('#scanner-status');
  if (!videoEl) return;

  if (!scannerState.offscreenCanvas) {
    scannerState.offscreenCanvas = document.createElement('canvas');
    scannerState.offscreenCtx = scannerState.offscreenCanvas.getContext('2d', { willReadFrequently: true });
  }

  try {
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 2560 },
        height: { ideal: 1440 }
      },
      audio: false
    };

    scannerState.stream = await navigator.mediaDevices.getUserMedia(constraints);
    videoEl.srcObject = scannerState.stream;
    await videoEl.play();

    scannerState.scanning = true;
    scannerState.isProcessing = false;
    scannerState.scanPass = 0;
    const generation = ++scannerState.scanGeneration;

    if (statusEl) {
      statusEl.style.color = '#222';
      statusEl.textContent = state.qrList.length
        ? '次のQRコードを枠に合わせてください'
        : 'QRコードを枠に合わせてください';
    }

    scannerState.scanTimer = setTimeout(handleScanTimeout, SCAN_TIMEOUT_MS);
    await applyCameraCapabilities(scannerState.stream.getVideoTracks()[0]);
    scheduleDecodeLoop(videoEl, generation);
  } catch {
    scannerState.scanning = false;
    if (statusEl) {
      statusEl.style.color = '#c62828';
      statusEl.textContent = location.protocol === 'https:' || location.hostname === 'localhost'
        ? 'カメラを使用できません。権限をご確認いただくか、QR画像から読み取ってください。'
        : 'カメラ利用にはHTTPSが必要です。QR画像からの読み取りは利用できます。';
    }
  }
}

function captureFrame(videoEl) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return null;

  // 全画面と中央の高解像度領域を交互に解析する。
  const useCenterCrop = scannerState.scanPass++ % 3 !== 0;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = vw;
  let sourceHeight = vh;

  if (useCenterCrop) {
    const side = Math.floor(Math.min(vw, vh) * 0.94);
    sourceX = Math.floor((vw - side) / 2);
    sourceY = Math.floor((vh - side) / 2);
    sourceWidth = side;
    sourceHeight = side;
  }

  const scale = Math.min(1, MAX_CAMERA_FRAME_EDGE / Math.max(sourceWidth, sourceHeight));
  const outputWidth = Math.max(1, Math.round(sourceWidth * scale));
  const outputHeight = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = scannerState.offscreenCanvas;
  const context = scannerState.offscreenCtx;
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  context.imageSmoothingEnabled = false;
  context.drawImage(videoEl, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
  return context.getImageData(0, 0, outputWidth, outputHeight);
}

function scheduleDecodeLoop(videoEl, generation) {
  if (!scannerState.scanning || generation !== scannerState.scanGeneration) return;

  scannerState.loopTimer = setTimeout(async () => {
    if (!scannerState.scanning || generation !== scannerState.scanGeneration) return;

    if (!scannerState.isProcessing && videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const imageData = captureFrame(videoEl);
      if (imageData) {
        scannerState.isProcessing = true;
        try {
          const result = await decodeImageData(imageData);
          if (result && scannerState.scanning && generation === scannerState.scanGeneration) {
            scannerState.scanning = false;
            await acceptQr(result);
            return;
          }
        } catch {
          // 次のフレームで再試行する。
        } finally {
          scannerState.isProcessing = false;
        }
      }
    }

    scheduleDecodeLoop(videoEl, generation);
  }, SCAN_INTERVAL_MS);
}

function clearScanTimers() {
  clearTimeout(scannerState.scanTimer);
  clearTimeout(scannerState.loopTimer);
  scannerState.scanTimer = null;
  scannerState.loopTimer = null;
}

function handleScanTimeout() {
  scannerState.scanTimer = null;
  if (!scannerState.scanning) return;
  const statusEl = document.querySelector('#scanner-status');
  if (statusEl) {
    statusEl.style.color = '#8a4b08';
    statusEl.textContent = 'まだ読み取れていません。少し離して静止するか、QR画像から読み取ってください。';
  }
}

async function stopCamera() {
  clearScanTimers();
  scannerState.scanning = false;
  scannerState.isProcessing = false;
  scannerState.scanGeneration++;

  if (scannerState.stream) {
    scannerState.stream.getTracks().forEach(track => {
      try { track.stop(); } catch {}
    });
    scannerState.stream = null;
  }

  const videoEl = document.querySelector('#camera-video');
  if (videoEl?.srcObject) videoEl.srcObject = null;
}

async function closeScanner() {
  await stopCamera();
  const dialogEl = document.querySelector('#scanner-dialog');
  if (dialogEl?.open) dialogEl.close();
}

async function scanQrImageFile(file) {
  const statusEl = document.querySelector('#scanner-status');
  const cameraFrame = document.querySelector('.camera-frame');
  hideScanChoice();
  await stopCamera();
  if (statusEl) {
    statusEl.style.color = '#222';
    statusEl.textContent = 'QR画像を解析しています...';
  }

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const result = await decodeImageData(context.getImageData(0, 0, width, height));
    if (result) {
      await acceptQr(result);
      return;
    }
    if (cameraFrame) cameraFrame.style.display = 'none';
    if (statusEl) {
      statusEl.style.color = '#c62828';
      statusEl.textContent = '画像からQRコードを読み取れませんでした。QR全体と周囲の余白が写った画像を選んでください。';
    }
    setScannerToolsVisible(true);
    showScanChoice(false);
  } catch {
    if (statusEl) {
      statusEl.style.color = '#c62828';
      statusEl.textContent = '画像を解析できませんでした。別の画像をお試しください。';
    }
    setScannerToolsVisible(true);
    showScanChoice(false);
  }
}

async function finishReading() {
  if (!state.qrList.length) return;
  const statusEl = document.querySelector('#scanner-status');
  const outcome = saveCurrentScanRecord();
  if (!outcome.ok) {
    if (statusEl) statusEl.textContent = 'お薬の情報を読み取れませんでした。残りのQRコードがないかご確認ください。';
    return;
  }
  await closeScanner();
  if (typeof navigate === 'function') navigate('home');
  if (typeof flash === 'function') flash(outcome.saved ? '記録を保存しました' : '同じ処方の記録がすでにあります');
}
