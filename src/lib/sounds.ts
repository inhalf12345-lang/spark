let ctx: AudioContext | null = null;
let ringAudioEl: HTMLAudioElement | null = null;
let ringWavUrl: string | null = null;
let gestureListenersAttached = false;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  return ctx;
}

/**
 * Generates an in-memory PCM WAV phone ringtone (classic dual-tone warble bell)
 * so mobile browsers (Android Chrome / iOS Safari) route the incoming ring through
 * the media/ringer audio channel reliably alongside Web Audio API.
 */
function getOrCreateRingAudioElement(): HTMLAudioElement | null {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') return null;
  if (ringAudioEl) return ringAudioEl;

  try {
    const sampleRate = 22050;
    const durationSec = 1.2;
    const numSamples = Math.floor(sampleRate * durationSec);
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    const writeStr = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      // Two bright phone ring bursts (0.00-0.45s and 0.55-1.05s)
      const inBurst1 = t >= 0.0 && t <= 0.45;
      const inBurst2 = t >= 0.55 && t <= 1.05;
      let sample = 0;
      if (inBurst1 || inBurst2) {
        const localT = inBurst1 ? t : t - 0.55;
        const burstDur = inBurst1 ? 0.45 : 0.5;
        const env =
          Math.min(1, localT / 0.015) * Math.min(1, (burstDur - localT) / 0.04);
        const f1 = inBurst1 ? 587.33 : 659.25;
        const f2 = inBurst1 ? 880.0 : 987.77;
        const wave =
          0.55 * Math.sin(2 * Math.PI * f1 * t) +
          0.45 * Math.sin(2 * Math.PI * f2 * t);
        sample = wave * env * 0.65;
      }
      const pcm = Math.max(-1, Math.min(1, sample));
      view.setInt16(44 + i * 2, pcm < 0 ? pcm * 0x8000 : pcm * 0x7fff, true);
    }

    const blob = new Blob([buffer], { type: 'audio/wav' });
    ringWavUrl = URL.createObjectURL(blob);
    const audio = new Audio(ringWavUrl);
    audio.preload = 'auto';
    audio.volume = 1.0;
    ringAudioEl = audio;
    return audio;
  } catch {
    return null;
  }
}

export function unlockSound() {
  if (typeof window === 'undefined') return;
  const c = getCtx();
  if (c && c.state === 'suspended') {
    c.resume().catch(() => {});
  }
  const el = getOrCreateRingAudioElement();
  if (el && !(el as any)._sparkUnlocked) {
    const prevMuted = el.muted;
    el.muted = true;
    el.play()
      .then(() => {
        el.pause();
        el.currentTime = 0;
        el.muted = prevMuted;
        (el as any)._sparkUnlocked = true;
      })
      .catch(() => {
        el.muted = prevMuted;
      });
  }
}

function attachGlobalAudioUnlockListeners() {
  if (typeof window === 'undefined' || gestureListenersAttached) return;
  gestureListenersAttached = true;

  const handleFirstGesture = () => {
    unlockSound();
  };

  window.addEventListener('pointerdown', handleFirstGesture, { passive: true });
  window.addEventListener('touchstart', handleFirstGesture, { passive: true });
  window.addEventListener('click', handleFirstGesture, { passive: true });
  window.addEventListener('keydown', handleFirstGesture, { passive: true });
}

attachGlobalAudioUnlockListeners();

function tone(freq: number, start: number, dur: number, vol = 0.15) {
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') {
    c.resume().catch(() => {});
  }
  try {
    const osc = c.createOscillator();
    const gain = c.createGain();
    const t = c.currentTime + start;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  } catch {}
}

export const playSendSound = () => {
  tone(880, 0, 0.09);
  tone(1175, 0.07, 0.12);
};
export const playReceiveSound = () => {
  tone(660, 0, 0.12);
  tone(523, 0.1, 0.18);
};

export const playIncomingRingTone = () => {
  // 1. Web Audio API phone bell burst
  tone(587.33, 0, 0.25, 0.32);
  tone(880, 0.02, 0.25, 0.28);
  tone(659.25, 0.32, 0.3, 0.32);
  tone(987.77, 0.34, 0.3, 0.28);
  tone(587.33, 0.7, 0.25, 0.32);
  tone(880, 0.72, 0.25, 0.28);

  // 2. HTMLAudioElement WAV ringtone playback for mobile ringer/media channel
  const el = getOrCreateRingAudioElement();
  if (el) {
    try {
      el.muted = false;
      el.volume = 1.0;
      el.currentTime = 0;
      el.play().catch(() => {});
    } catch {}
  }

  // 3. Mobile vibration pattern (supported on Android Chrome/WebView)
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate([400, 180, 400]);
    } catch {}
  }
};

export const stopRingTonePlayback = () => {
  if (ringAudioEl) {
    try {
      ringAudioEl.pause();
      ringAudioEl.currentTime = 0;
    } catch {}
  }
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(0);
    } catch {}
  }
};

export const playOutgoingRingbackTone = () => {
  tone(440, 0, 0.4, 0.18);
  tone(480, 0.02, 0.38, 0.15);
};

export const playCallConnectedTone = () => {
  stopRingTonePlayback();
  tone(523.25, 0, 0.1, 0.16);
  tone(659.25, 0.09, 0.14, 0.18);
};

export const playCallEndedTone = () => {
  stopRingTonePlayback();
  tone(493.88, 0, 0.12, 0.16);
  tone(369.99, 0.11, 0.2, 0.16);
};


