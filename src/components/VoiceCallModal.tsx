import React, { useEffect, useRef, useState } from 'react';
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  Volume2,
  Volume1,
  Minimize2,
  Maximize2,
  ShieldCheck,
  AlertCircle,
  Loader2,
  X,
} from 'lucide-react';
import { VoiceCallState } from '../types';
import { voiceCallManager } from '../lib/callService';

export const VoiceCallModal: React.FC = () => {
  const [callState, setCallState] = useState<VoiceCallState>(() =>
    voiceCallManager.getState()
  );
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(() =>
    voiceCallManager.getRemoteStream()
  );
  const [isMinimized, setIsMinimized] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isActionPending, setIsActionPending] = useState(false);

  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);

  useEffect(() => {
    const unsubState = voiceCallManager.subscribeState((nextState) => {
      setCallState(nextState);
      if (nextState.status === 'idle' || nextState.status === 'incoming') {
        setIsMinimized(false);
      }
    });
    const unsubStream = voiceCallManager.subscribeRemoteStream((stream) => {
      setRemoteStream(stream);
    });
    return () => {
      unsubState();
      unsubStream();
    };
  }, []);

  // Call duration timer when connected
  useEffect(() => {
    if (callState.status !== 'connected' || !callState.connectedAt) {
      setElapsedSeconds(0);
      return;
    }

    const updateTimer = () => {
      const diff = Math.max(
        0,
        Math.floor((Date.now() - (callState.connectedAt || Date.now())) / 1000)
      );
      setElapsedSeconds(diff);
    };

    updateTimer();
    const timer = setInterval(updateTimer, 1000);
    return () => clearInterval(timer);
  }, [callState.status, callState.connectedAt]);

  // Bind remote MediaStream to the <audio> element and optional Web Audio GainNode for Speaker boost
  useEffect(() => {
    const audioEl = remoteAudioRef.current;
    if (!audioEl) return;

    if (!remoteStream) {
      audioEl.srcObject = null;
      if (sourceNodeRef.current) {
        try {
          sourceNodeRef.current.disconnect();
        } catch {}
        sourceNodeRef.current = null;
      }
      return;
    }

    audioEl.srcObject = remoteStream;
    audioEl.volume = 1.0;
    audioEl.play().catch((err) => {
      console.warn('[VoiceCall] Remote audio autoplay notice:', err);
    });

    // Set up Web Audio GainNode so toggling Speaker boosts audio output cleanly on Android Chrome
    try {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (AC) {
        if (!audioCtxRef.current) {
          audioCtxRef.current = new AC();
        }
        const ctx = audioCtxRef.current;
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
        if (sourceNodeRef.current) {
          try {
            sourceNodeRef.current.disconnect();
          } catch {}
        }
        if (!gainNodeRef.current) {
          gainNodeRef.current = ctx.createGain();
          gainNodeRef.current.connect(ctx.destination);
        }
        gainNodeRef.current.gain.value = callState.isSpeakerOn ? 0.85 : 0.0;
        const src = ctx.createMediaStreamSource(remoteStream);
        src.connect(gainNodeRef.current);
        sourceNodeRef.current = src;
      }
    } catch {}
  }, [remoteStream]);

  // Adjust Speaker output (setSinkId where supported + GainNode boost)
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = callState.isSpeakerOn ? 0.85 : 0.0;
    }

    const applyAudioOutputDevice = async () => {
      const audioEl = remoteAudioRef.current as any;
      if (
        !audioEl ||
        typeof audioEl.setSinkId !== 'function' ||
        !navigator.mediaDevices?.enumerateDevices
      ) {
        return;
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter((d) => d.kind === 'audiooutput');
        if (outputs.length <= 1) return;

        if (callState.isSpeakerOn) {
          const speakerDevice = outputs.find((d) =>
            /speaker|hands-free|built-in/i.test(d.label)
          );
          if (speakerDevice?.deviceId) {
            await audioEl.setSinkId(speakerDevice.deviceId);
          }
        } else {
          await audioEl.setSinkId('default');
        }
      } catch {}
    };

    applyAudioOutputDevice();
  }, [callState.isSpeakerOn]);

  // Cleanup AudioContext on unmount
  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        try {
          audioCtxRef.current.close();
        } catch {}
        audioCtxRef.current = null;
      }
    };
  }, []);

  if (callState.status === 'idle') {
    return null;
  }

  const formatDuration = (totalSecs: number) => {
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const peerName =
    callState.peerUser?.display_name || callState.peerUser?.username || 'Spark User';
  const peerUsername = callState.peerUser?.username || 'user';
  const peerAvatar =
    callState.peerUser?.avatar_url ||
    `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(peerUsername)}`;

  const handleAccept = async () => {
    if (isActionPending) return;
    setIsActionPending(true);
    try {
      await voiceCallManager.acceptIncomingCall();
    } finally {
      setIsActionPending(false);
    }
  };

  const handleReject = async () => {
    if (isActionPending) return;
    setIsActionPending(true);
    try {
      await voiceCallManager.rejectIncomingCall();
    } finally {
      setIsActionPending(false);
    }
  };

  const handleEndCall = async () => {
    if (isActionPending) return;
    setIsActionPending(true);
    try {
      await voiceCallManager.endVoiceCall('Call ended.');
    } finally {
      setIsActionPending(false);
    }
  };

  // Minimized floating bar during active/outgoing call
  if (
    isMinimized &&
    (callState.status === 'outgoing' ||
      callState.status === 'connecting' ||
      callState.status === 'connected')
  ) {
    return (
      <>
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[90] w-[94%] max-w-md rounded-2xl bg-slate-900/95 backdrop-blur-md text-white px-4 py-2.5 shadow-xl border border-slate-700/80 flex items-center justify-between gap-3">
          <div
            onClick={() => setIsMinimized(false)}
            className="flex items-center gap-2.5 cursor-pointer flex-1 min-w-0"
          >
            <div className="relative shrink-0">
              <img
                src={peerAvatar}
                alt={peerName}
                className="w-9 h-9 rounded-full object-cover bg-slate-800 border border-[#ff3b69]"
                referrerPolicy="no-referrer"
              />
              <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-slate-900 animate-pulse" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold truncate">{peerName}</p>
              <p className="text-[11px] text-emerald-400 font-mono">
                {callState.status === 'connected'
                  ? formatDuration(elapsedSeconds)
                  : callState.statusDetail || 'Connecting...'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => voiceCallManager.toggleMute()}
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
                callState.isMuted
                  ? 'bg-amber-500 text-white'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
              }`}
              title={callState.isMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {callState.isMuted ? (
                <MicOff className="w-4 h-4" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
            </button>

            <button
              type="button"
              onClick={handleEndCall}
              className="w-8 h-8 rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center transition-colors cursor-pointer"
              title="End Call"
            >
              <PhoneOff className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => setIsMinimized(false)}
              className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition-colors cursor-pointer"
              title="Expand call window"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
        <div className="relative w-full max-w-sm rounded-[32px] bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 text-white border border-slate-800 shadow-2xl p-6 flex flex-col items-center text-center overflow-hidden">
          {/* Top security & minimize bar */}
          <div className="w-full flex items-center justify-between mb-4">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800/90 border border-slate-700/70 text-[10px] font-semibold text-emerald-400">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
              <span>1-to-1 P2P Voice (STUN)</span>
            </div>

            {callState.status !== 'incoming' && callState.status !== 'ended' && (
              <button
                type="button"
                onClick={() => setIsMinimized(true)}
                className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition-colors cursor-pointer"
                title="Minimize call"
              >
                <Minimize2 className="w-4 h-4" />
              </button>
            )}

            {callState.status === 'ended' && (
              <button
                type="button"
                onClick={() => voiceCallManager.dismissEndedCallScreen()}
                className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition-colors cursor-pointer"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Caller / Callee Avatar with Pulse */}
          <div className="relative my-4">
            {(callState.status === 'incoming' ||
              callState.status === 'outgoing' ||
              callState.status === 'connecting') && (
              <>
                <span className="absolute -inset-3 rounded-full bg-[#ff3b69]/25 animate-ping" />
                <span className="absolute -inset-1.5 rounded-full bg-[#ff3b69]/20 animate-pulse" />
              </>
            )}
            <div
              className={`relative w-24 h-24 rounded-full p-1 ${
                callState.status === 'connected'
                  ? 'bg-gradient-to-tr from-emerald-400 to-teal-500'
                  : 'bg-gradient-to-tr from-[#ff3b69] to-[#fb7185]'
              } shadow-lg`}
            >
              <img
                src={peerAvatar}
                alt={peerName}
                className="w-full h-full rounded-full object-cover bg-slate-900"
                referrerPolicy="no-referrer"
              />
            </div>
          </div>

          {/* Peer Name & Username */}
          <h2 className="font-display font-black text-xl tracking-tight text-white">
            {peerName}
          </h2>
          <p className="text-xs text-slate-400 font-mono mt-0.5">@{peerUsername}</p>

          {/* Call Status / Timer */}
          <div className="mt-3 min-h-[44px] flex flex-col items-center justify-center">
            {callState.status === 'connected' ? (
              <>
                <span className="font-mono font-bold text-lg text-emerald-400 tracking-wider">
                  {formatDuration(elapsedSeconds)}
                </span>
                <span className="text-[11px] text-slate-400 mt-0.5">
                  {callState.isPeerMuted
                    ? `${peerName} muted their microphone`
                    : 'Crystal Voice Active'}
                </span>
              </>
            ) : callState.status === 'connecting' ? (
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{callState.statusDetail || 'Connecting P2P audio...'}</span>
              </div>
            ) : callState.status === 'ended' ? (
              <div className="mt-2 p-3 rounded-2xl bg-rose-950/60 border border-rose-800/70 text-xs text-rose-200 flex items-start gap-2 text-left max-w-xs">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <span>{callState.errorMessage || callState.statusDetail || 'Call ended.'}</span>
              </div>
            ) : (
              <span className="text-xs font-semibold text-rose-300 animate-pulse">
                {callState.statusDetail ||
                  (callState.status === 'incoming' ? 'Incoming Voice Call...' : 'Calling...')}
              </span>
            )}
          </div>

          {/* Controls: Incoming Call (Accept / Reject) */}
          {callState.status === 'incoming' && (
            <div className="w-full flex items-center justify-around mt-8 mb-2 px-4">
              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={handleReject}
                  disabled={isActionPending}
                  className="w-16 h-16 rounded-full bg-rose-600 hover:bg-rose-500 active:scale-95 text-white flex items-center justify-center shadow-lg shadow-rose-600/30 transition-all cursor-pointer disabled:opacity-50"
                  title="Reject Call"
                >
                  <PhoneOff className="w-7 h-7" />
                </button>
                <span className="text-xs font-semibold text-slate-300">Decline</span>
              </div>

              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={handleAccept}
                  disabled={isActionPending}
                  className="w-16 h-16 rounded-full bg-emerald-500 hover:bg-emerald-400 active:scale-95 text-white flex items-center justify-center shadow-lg shadow-emerald-500/30 transition-all cursor-pointer disabled:opacity-50"
                  title="Accept Call"
                >
                  <Phone className="w-7 h-7" />
                </button>
                <span className="text-xs font-semibold text-slate-300">Accept</span>
              </div>
            </div>
          )}

          {/* Controls: Outgoing / Connecting / Connected (Mute, Speaker, End Call) */}
          {(callState.status === 'outgoing' ||
            callState.status === 'connecting' ||
            callState.status === 'connected') && (
            <div className="w-full flex items-center justify-center gap-6 mt-8 mb-2">
              {/* Mute Control */}
              <div className="flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => voiceCallManager.toggleMute()}
                  className={`w-13 h-13 rounded-full flex items-center justify-center transition-all active:scale-95 cursor-pointer ${
                    callState.isMuted
                      ? 'bg-amber-500 text-white shadow-md shadow-amber-500/25'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
                  }`}
                  title={callState.isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
                >
                  {callState.isMuted ? (
                    <MicOff className="w-5 h-5" />
                  ) : (
                    <Mic className="w-5 h-5" />
                  )}
                </button>
                <span className="text-[11px] font-medium text-slate-400">
                  {callState.isMuted ? 'Muted' : 'Mute'}
                </span>
              </div>

              {/* End Call Control */}
              <div className="flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleEndCall}
                  disabled={isActionPending}
                  className="w-16 h-16 rounded-full bg-rose-600 hover:bg-rose-500 active:scale-95 text-white flex items-center justify-center shadow-lg shadow-rose-600/35 transition-all cursor-pointer disabled:opacity-50"
                  title="End Call"
                >
                  <PhoneOff className="w-7 h-7" />
                </button>
                <span className="text-[11px] font-semibold text-rose-400">End</span>
              </div>

              {/* Speaker Control */}
              <div className="flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => voiceCallManager.toggleSpeaker()}
                  className={`w-13 h-13 rounded-full flex items-center justify-center transition-all active:scale-95 cursor-pointer ${
                    callState.isSpeakerOn
                      ? 'bg-[#ff3b69] text-white shadow-md shadow-pink-500/25'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
                  }`}
                  title={callState.isSpeakerOn ? 'Speaker Boost On' : 'Speaker Boost Off'}
                >
                  {callState.isSpeakerOn ? (
                    <Volume2 className="w-5 h-5" />
                  ) : (
                    <Volume1 className="w-5 h-5" />
                  )}
                </button>
                <span className="text-[11px] font-medium text-slate-400">
                  {callState.isSpeakerOn ? 'Speaker On' : 'Speaker'}
                </span>
              </div>
            </div>
          )}

          {/* Controls: Ended / Diagnostic Screen */}
          {callState.status === 'ended' && (
            <div className="w-full mt-6">
              <button
                type="button"
                onClick={() => voiceCallManager.dismissEndedCallScreen()}
                className="w-full py-2.5 rounded-full bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
};
