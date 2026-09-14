'use strict';

// 音声再生専用モジュール
let audioContext = null;

// ユーザー操作時に音声を初期化・アンロックする
function initAudio() {
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
  } catch (e) {
    console.warn('AudioContext init failed:', e);
  }
}

// 読み取り成功時の電子音（ピピッ）を鳴らす
function playBeepSound() {
  try {
    initAudio();
    if (!audioContext) return;

    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, audioContext.currentTime); // 聞き取りやすい高音

    gain.gain.setValueAtTime(0.2, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.12);

    osc.connect(gain);
    gain.connect(audioContext.destination);

    osc.start();
    osc.stop(audioContext.currentTime + 0.12);
  } catch (e) {
    console.warn('Audio play error:', e);
  }
}