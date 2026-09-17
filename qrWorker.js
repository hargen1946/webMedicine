'use strict';

// バージョンを固定し、メイン画面と同じZXing-C++を使用する。
importScripts('./vendor/zxing-wasm/index.js');

self.ZXingWASM?.prepareZXingModule?.({
  overrides: {
    locateFile: fileName => new URL(`./vendor/zxing-wasm/${fileName}`, self.location.href).href
  }
});

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

function asBytes(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return null;
}

function quality(value) {
  const text = String(value || '');
  const japanese = (text.match(/[ぁ-んァ-ヶ一-龠々ー]/g) || []).length;
  const records = (text.match(/(^|\n)(?:1|2|3|4|5|11|15|31|51|55|201|281|291|301|311|391|401|411|421|501|601|701|911),/g) || []).length;
  const replacement = (text.match(/\ufffd/g) || []).length;
  const controls = (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) || []).length;
  return japanese * 2 + records * 8 - replacement * 20 - controls * 8;
}

function decodedText(result) {
  const primary = String(result?.text || '');
  const bytes = asBytes(result?.bytes);
  if (!bytes?.length) return primary;
  try {
    const shiftJis = new TextDecoder('shift_jis').decode(bytes);
    return quality(shiftJis) > quality(primary) ? shiftJis : primary;
  } catch {
    return primary;
  }
}

function fingerprint(value) {
  const bytes = asBytes(value);
  if (!bytes?.length) return '';
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `raw:${bytes.length}:${hash >>> 0}`;
}

self.onmessage = async event => {
  const { requestId, imageData } = event.data || {};
  try {
    if (!self.ZXingWASM?.readBarcodes) throw new Error('ZXing-WASMを読み込めませんでした');
    const results = await self.ZXingWASM.readBarcodes(imageData, READER_OPTIONS);
    const found = results?.find(result => result?.isValid !== false && (result.text || asBytes(result.bytes)?.length));
    if (!found) {
      self.postMessage({ requestId, type: 'EMPTY' });
      return;
    }

    const text = decodedText(found);
    if (!text) {
      self.postMessage({ requestId, type: 'EMPTY' });
      return;
    }

    self.postMessage({
      requestId,
      type: 'SUCCESS',
      result: {
        text,
        fingerprint: fingerprint(found.bytes),
        sequenceSize: Number.isInteger(found.sequenceSize) ? found.sequenceSize : -1,
        sequenceIndex: Number.isInteger(found.sequenceIndex) ? found.sequenceIndex : -1,
        sequenceId: String(found.sequenceId ?? '')
      }
    });
  } catch (error) {
    self.postMessage({ requestId, type: 'ERROR', error: error?.message || String(error) });
  }
};
