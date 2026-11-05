let ctx: AudioContext | null = null;

function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

export function unlockSound() {
  const c = getCtx();
  if (c && c.state === 'suspended') c.resume();
}

function tone(freq: number, start: number, dur: number, vol = 0.15) {
  const c = getCtx();
  if (!c) return;
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
}

export const playSendSound = () => { tone(880, 0, 0.09); tone(1175, 0.07, 0.12); };
export const playReceiveSound = () => { tone(660, 0, 0.12); tone(523, 0.1, 0.18); };

export const playIncomingRingTone = () => {
  tone(587.33, 0, 0.18, 0.16);
  tone(880, 0.2, 0.24, 0.16);
};

export const playOutgoingRingbackTone = () => {
  tone(440, 0, 0.35, 0.1);
  tone(480, 0.02, 0.33, 0.08);
};

export const playCallConnectedTone = () => {
  tone(523.25, 0, 0.1, 0.12);
  tone(659.25, 0.09, 0.14, 0.14);
};

export const playCallEndedTone = () => {
  tone(493.88, 0, 0.12, 0.12);
  tone(369.99, 0.11, 0.2, 0.12);
};

