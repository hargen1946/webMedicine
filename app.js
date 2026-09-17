'use strict';

// アプリケーション全体の状態管理（UI・画面遷移関連）
const state = {
  view: 'home',
  selected: null,
  qrList: [],
  qrFingerprints: [],
  notice: '',
  historyNotice: ''
};

// 主要なDOM要素の参照
const app = document.querySelector('#app');
const backButton = document.querySelector('#back-button');
const headerTitle = document.querySelector('#header-title');
const dialog = document.querySelector('#scanner-dialog');
const video = document.querySelector('#camera-video');
const statusText = document.querySelector('#scanner-status');
const toast = document.querySelector('#toast');

// 文字列エスケープ処理
const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

// トースト通知の表示
function flash(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => toast.classList.remove('show'), 5000);
}

// 画面遷移の制御
function navigate(view, selected = null) {
  state.view = view;
  state.selected = selected;
  render();
  app.focus();
  scrollTo({ top: 0, behavior: 'smooth' });
}

// 画面全体の描画
function render() {
  // 1. 戻るボタンの表示制御
  backButton.classList.toggle('hidden', state.view === 'home');

  // 2. ヘッダータイトルの制御
  if (state.view === 'home') {
    headerTitle.textContent = '';
  } else if (state.view === 'history') {
    headerTitle.textContent = '記録一覧';
  } else if (state.view === 'help') {
    headerTitle.textContent = '使い方';
  } else {
    headerTitle.textContent = 'お薬の記録';
  }

  // 3. 各画面コンテンツの描画
  if (state.view === 'home') {
    renderHome();
  } else if (state.view === 'history') {
    renderHistory();
  } else if (state.view === 'help') {
    renderHelp();
  } else {
    renderDetail(state.selected);
  }
}

// ホーム画面の描画
function renderHome() {
  const count = state.qrList.length;
  app.innerHTML = `
    <section class="hero"><h1>お 薬 手 帳</h1></section>
    ${count ? `<div class="summary-card"><strong>✓ ${count}件</strong> のQRコードを読み取りました</div>` : ''}
    <div class="button-stack home-actions">
      <button class="button secondary" data-action="history">記 録 を 見 る</button>
      <button class="button ${count ? 'orange' : 'primary'}" data-action="scan">${count ? '次のQRコードを読む' : 'QRコードを読み取る'}</button>
      ${count ? '<button class="button success wide" data-action="finish">読み取り終了・保存</button>' : ''}
    </div>
    ${state.notice ? `<div class="notice">${esc(state.notice)}</div>` : ''}
    <div class="utility-row" style="display: flex; gap: 8px; justify-content: space-between;">
      <button class="button ghost" data-action="export" style="flex: 1; padding: 12px 0; font-size: 15px;">CSV保存</button>
      <button class="button ghost" data-action="backup" style="flex: 1; padding: 12px 0; font-size: 15px;">データ出力</button>
      <label class="button ghost file-button" style="flex: 1; padding: 12px 0; font-size: 15px; text-align: center; margin: 0;">データ復元<input id="json-import" type="file" accept="application/json"></label>
    </div>
    <button class="help-link" data-action="help">使い方・データ保存について</button>
  `;

  app.querySelector('[data-action="history"]').onclick = () => navigate('history');
  app.querySelector('[data-action="scan"]').onclick = openScanner;
  app.querySelector('[data-action="finish"]')?.addEventListener('click', finishReading);
  app.querySelector('[data-action="export"]').onclick = exportCsv;
  app.querySelector('[data-action="backup"]').onclick = () => download(JSON.stringify(getRecords(), null, 2), 'お薬手帳バックアップ.json', 'application/json');
  app.querySelector('#json-import').onchange = importJson;
  app.querySelector('[data-action="help"]').onclick = () => navigate('help');
}

// 使い方画面の描画
function renderHelp() {
  app.innerHTML = `
    <h1 class="page-title">使い方・データ保存について</h1>
    <div class="help-sections">
      <section><h2>CSV保存とは</h2><p>年に一度くらいお薬の記録を、パソコンに保存したりエクセル等で一覧表として見たい場合に使います。その為の（お薬手帳.csv）ファイルとしてスマートフォン本体にダウンロード保存します。スマホのファイルアプリのダウンロードに保存されます。そのファイルをメール等に添付して、ご自身のパソコン宛てに送信してください。</p></section>
      <section><h2>データ出力とは</h2><p>お薬の記録はその度に自動で記録されますので普通は必要ありません。機種変更や故障に備えて（お薬手帳バックアップ.json）ファイルとしてスマホのファイルアプリのダウンロードに保存されます。</p></section>
      <section><h2>データ復元とは</h2><p>古いスマホからデータを移動した新しいスマホの（お薬手帳バックアップ.json）を選び、新しいスマホに記録を戻します。</p></section>
      <section><h2>記録の保存場所</h2><p>記録はサーバーへ送信されず、このスマホのブラウザ内だけに自動保存されます。</p></section>
    </div>
    <div class="bottom-actions"><button class="button secondary" data-action="home">ホームへ戻る</button></div>
  `;
  app.querySelector('[data-action="home"]').onclick = () => navigate('home');
}

// 記録一覧画面の描画
function renderHistory() {
  const records = getRecords();
  const historyNotice = state.historyNotice;
  state.historyNotice = '';
  app.innerHTML = `
    <h1 class="page-title">記録を見る</h1>
    ${historyNotice ? `<div class="history-notice" role="status">${esc(historyNotice)}</div>` : ''}
    <p class="page-subtitle">見たい記録を選んでください</p>
    ${records.length ? `<div class="record-list">${records.map((r, i) => `
      <button class="record-card" data-index="${i}">
        <div class="record-date">${esc(r.prescriptionDate || '日付なし')}</div>
        <div class="record-hospital">${esc(r.hospitalName || '医療機関名なし')}</div>
        <div class="record-doctor">${esc([r.department, r.doctorName && r.doctorName + ' 先生'].filter(Boolean).join(' '))}</div>
        <div class="record-meta">お薬 ${r.medicines.length}件</div>
      </button>`).join('')}</div>` : '<div class="empty">保存された記録はまだありません。</div>'}
    <div class="bottom-actions"><button class="button secondary" data-action="home">ホームへ戻る</button></div>
  `;
  app.querySelectorAll('.record-card').forEach(b => b.onclick = () => navigate('detail', Number(b.dataset.index)));
  app.querySelector('[data-action="home"]').onclick = () => navigate('home');
}

// 記録詳細画面の描画
function renderDetail(index) {
  const r = getRecords()[index];
  if (!r) {
    navigate('history');
    return;
  }
  app.innerHTML = `
    <div class="detail-head">
      <h1>お薬の記録</h1>
      <div class="hospital">${esc([r.prescriptionDate, r.hospitalName].filter(Boolean).join(' '))}</div>
      <p>${esc([r.department, r.doctorName && r.doctorName + ' 先生'].filter(Boolean).join(' '))}</p>
    </div>
    <div class="medicine-list">${r.medicines.map(m => `
      <article class="medicine">
        <h2>${esc(m.name)}</h2>
        ${m.usage.map(u => `<p>${esc(u)}</p>`).join('')}
        ${m.quantityInfo ? `<p class="quantity">${esc(m.quantityInfo)}</p>` : ''}
      </article>`).join('')}
    </div>
    <div class="bottom-actions">
      <button class="button secondary" data-action="back">記録一覧へ戻る</button>
      <button class="button ghost danger" data-action="delete">この記録を削除</button>
      <div id="delete-confirmation" class="delete-confirmation hidden" role="alert">
        <p>この記録を削除しますか？<br><strong>削除後は元に戻せません。</strong></p>
        <button class="button danger-solid" data-action="confirm-delete">削除して一覧へ戻る</button>
        <button class="button secondary" data-action="cancel-delete">キャンセル</button>
      </div>
    </div>
  `;
  app.querySelector('[data-action="back"]').onclick = () => navigate('history');
  const deleteButton = app.querySelector('[data-action="delete"]');
  const confirmation = app.querySelector('#delete-confirmation');
  const confirmDeleteButton = app.querySelector('[data-action="confirm-delete"]');
  const cancelDeleteButton = app.querySelector('[data-action="cancel-delete"]');

  deleteButton.onclick = () => {
    deleteButton.classList.add('hidden');
    confirmation.classList.remove('hidden');
    confirmDeleteButton.focus();
  };
  cancelDeleteButton.onclick = () => {
    confirmation.classList.add('hidden');
    deleteButton.classList.remove('hidden');
    deleteButton.focus();
  };
  confirmDeleteButton.onclick = () => {
    try {
      const records = getRecords();
      const removed = records.splice(index, 1);
      if (!removed.length) throw new Error('削除対象が見つかりません');
      writeRecords(records);
      rebuildQrHistory(records);
      state.historyNotice = '記録を削除しました。';
      flash('記録を削除しました');
      navigate('history');
    } catch {
      confirmation.classList.add('hidden');
      deleteButton.classList.remove('hidden');
      flash('記録を削除できませんでした');
    }
  };
}

// イベントリスナーの登録
backButton.onclick = () => state.view === 'detail' ? navigate('history') : navigate('home');
document.querySelector('#scanner-next').onclick = async () => {
  hideScanChoice();

  // 1件目で隠したカメラ枠を画面に再表示する
  const cameraFrame = document.querySelector('.camera-frame');
  if (cameraFrame) {
    cameraFrame.style.display = 'block';
  }
  setScannerToolsVisible(true);

  statusText.textContent = '次のQRコードを枠に合わせてください';
  await startCamera();
};
document.querySelector('#scanner-finish').onclick = finishReading;
document.querySelector('#scanner-back').onclick = closeScanner;
document.querySelector('#close-scanner').onclick = closeScanner;
document.querySelector('#scanner-file').onclick = () => {
  document.querySelector('#qr-image-input').click();
};
document.querySelector('#qr-image-input').onchange = async event => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = '';
  if (file) await scanQrImageFile(file);
};
dialog.addEventListener('cancel', e => {
  e.preventDefault();
  closeScanner();
});

// PWAインストール機能の制御
let installPrompt = null;
const installButton = document.querySelector('#install-button');
const installGuide = document.querySelector('#install-guide-dialog');
const installGuideNext = document.querySelector('#install-guide-next');
const installGuideBack = document.querySelector('#install-guide-back');

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  installButton.classList.remove('hidden');
});

installButton.onclick = () => {
  if (!installPrompt) {
    installButton.classList.add('hidden');
    return;
  }
  installGuide.showModal();
};

installGuideBack.onclick = () => installGuide.close();
installGuide.addEventListener('cancel', () => installGuide.close());
installGuideNext.onclick = async () => {
  installGuide.close();
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null;
  installButton.classList.add('hidden');
  await prompt.prompt();
};

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  installButton.classList.add('hidden');
  if (installGuide.open) installGuide.close();
});

// サービスワーカー登録
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(reg => reg.update()).catch(() => {});
}

// アプリケーション起動時の初回描画
render();
