'use strict';

// WebAssembly版 ZXing-C++ をワーカー内に読み込む
importScripts('https://cdn.jsdelivr.net/npm/zxing-wasm@1/dist/iife/full/index.js');

self.onmessage = async (event) => {
  const { imageData } = event.data;

  try {
    if (!self.ZXingWASM) {
      self.postMessage({ type: 'EMPTY' });
      return;
    }

    // 高密度処方箋QRコード・Shift_JISに対応した徹底探索
    const results = await self.ZXingWASM.readBarcodes(imageData, {
      formats: ['QRCode'],
      tryHarder: true,          // 微細セル・歪みの深層解析
      maxNumberOfSymbols: 1,    // 1フレームにつき1コードを確実に検出
      characterSet: 'Shift_JIS' // JAHIS処方箋の標準文字コード
    });

    if (results && results.length > 0) {
      const res = results[0];
      let text = res.text || '';

      // Shift_JISの文字化け対策（バイナリからの復元）
      if (res.bytes && (!text || text.includes(''))) {
        try {
          const decoder = new TextDecoder('shift-jis');
          text = decoder.decode(res.bytes);
        } catch (e) {}
      }

      self.postMessage({ type: 'SUCCESS', text: text });
    } else {
      self.postMessage({ type: 'EMPTY' });
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', error: err.message });
  }
};