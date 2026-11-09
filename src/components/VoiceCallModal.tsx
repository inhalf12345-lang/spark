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
  Users,
  X,
} from 'lucide-react';
import { VoiceCallState } from '../types';
import { voiceCallManager } from '../lib/callService';
import {
  groupVoiceCallManager,
  GroupVoiceCallState,
} from '../lib/groupCallService';

// Dedicated remote audio player for each participant in a group voice call
const GroupParticipantAudio: React.FC<{
  stream: MediaStream;
  isSpeakerOn: boolean;
}> = ({ stream, isSpeakerOn }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    el.volume = isSpeakerOn ? 1.0 : 0.7;
    el.play().catch(() => {});
  }, [stream, isSpeakerOn]);

  return <audio ref={audioRef} autoPlay playsInline className="hidden" />;
};

export const VoiceCallModal: React.FC = () => {
  const [callState, setCallState] = useState<VoiceCallState>(() =>
    voiceCallManager.getState()
  );
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(() =>
    voiceCallManager.getRemoteStream()
  );
  const [groupState, setGroupState] = useState<GroupVoiceCallState>(() =>
    groupVoiceCallManager.getState()
  );
  const [groupStreams, setGroupStreams] = useState<Map<string, MediaStream>>(() =>
    groupVoiceCallManager.getRemoteStreams()
  );

  const [isMinimized, setIsMinimized] = useState(false);
  const [isGroupMinimized, setIsGroupMinimized] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [groupElapsedSeconds, setGroupElapsedSeconds] = useState(0);
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
    const unsubGroupState = groupVoiceCallManager.subscribeState((nextGroup) => {
      setGroupState(nextGroup);
      if (nextGroup.status === 'idle') {
        setIsGroupMinimized(false);
      }
    });
    const unsubGroupStreams = groupVoiceCallManager.subscribeRemoteStreams((streams) => {
      setGroupStreams(streams);
    });
    return () => {
      unsubState();
      unsubStream();
      unsubGroupState();
      unsubGroupStreams();
    };
  }, []);

  // 1-to-1 Call duration timer when connected
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

  // Group Call duration timer when connected
  useEffect(() => {
    if (groupState.status !== 'connected' || !groupState.connectedAt) {
      setGroupElapsedSeconds(0);
      return;
    }

    const updateGroupTimer = () => {
      const diff = Math.max(
        0,
        Math.floor((Date.now() - (groupState.connectedAt || Date.now())) / 1000)
      );
      setGroupElapsedSeconds(diff);
    };

    updateGroupTimer();
    const timer = setInterval(updateGroupTimer, 1000);
    return () => clearInterval(timer);
  }, [groupState.status, groupState.connectedAt]);

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

  const formatDuration = (totalSecs: number) => {
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  // =========================================================================
  // 1. GROUP VOICE CALL UI (When active)
  // =========================================================================
  if (groupState.status !== 'idle') {
    const streamEntries = Array.from(groupStreams.entries());

    if (
      isGroupMinimized &&
      (groupState.status === 'joining' || groupState.status === 'connected')
    ) {
      return (
        <>
          {streamEntries.map(([peerId, stream]) => (
            <GroupParticipantAudio
              key={peerId}
              stream={stream}
              isSpeakerOn={groupState.isSpeakerOn}
            />
          ))}
          <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[90] w-[94%] max-w-md rounded-2xl bg-slate-900/95 backdrop-blur-md text-white px-4 py-2.5 shadow-xl border border-violet-500/40 flex items-center justify-between gap-3">
            <div
              onClick={() => setIsGroupMinimized(false)}
              className="flex items-center gap-2.5 cursor-pointer flex-1 min-w-0"
            >
              <div className="relative shrink-0 w-9 h-9 rounded-full bg-gradient-to-tr from-[#8B5CF6] to-[#7C3AED] flex items-center justify-center text-white">
                <Users className="w-4 h-4" />
                <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-slate-900 animate-pulse" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold truncate">{groupState.groupName}</p>
                <p className="text-[11px] text-emerald-400 font-mono">
                  {groupState.status === 'connected'
                    ? `${formatDuration(groupElapsedSeconds)} · ${groupState.participants.length} in call`
                    : 'Joining group call...'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => groupVoiceCallManager.toggleMute()}
                className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
                  groupState.isMuted
                    ? 'bg-amber-500 text-white'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                }`}
                title={groupState.isMuted ? 'Unmute microphone' : 'Mute microphone'}
              >
                {groupState.isMuted ? (
                  <MicOff className="w-4 h-4" />
                ) : (
                  <Mic className="w-4 h-4" />
                )}
              </button>

              <button
                type="button"
                onClick={() => groupVoiceCallManager.leaveGroupVoiceCall()}
                className="w-9 h-9 rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center transition-colors cursor-pointer"
                title="Leave Group Call"
              >
                <PhoneOff className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={() => setIsGroupMinimized(false)}
                className="w-9 h-9 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition-colors cursor-pointer"
                title="Expand group call window"
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
        {streamEntries.map(([peerId, stream]) => (
          <GroupParticipantAudio
            key={peerId}
            stream={stream}
            isSpeakerOn={groupState.isSpeakerOn}
          />
        ))}
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md">
          <div className="relative w-full max-w-md max-h-[92dvh] rounded-[32px] bg-gradient-to-b from-slate-900 via-[#171329] to-slate-950 text-white border border-violet-500/30 shadow-2xl p-5 sm:p-6 flex flex-col items-center text-center overflow-y-auto">
            {/* Top bar */}
            <div className="w-full flex items-center justify-between mb-3">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-violet-950/80 border border-violet-500/40 text-[10px] font-semibold text-violet-300">
                <Users className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Group Voice Room · {groupState.participants.length} Active</span>
              </div>

              {groupState.status !== 'ended' ? (
                <button
                  type="button"
                  onClick={() => setIsGroupMinimized(true)}
                  className="w-9 h-9 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition-colors cursor-pointer"
                  title="Minimize group call"
                >
                  <Minimize2 className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => groupVoiceCallManager.dismissEndedScreen()}
                  className="w-9 h-9 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition-colors cursor-pointer"
                  title="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Group Title & Timer */}
            <h2 className="font-display font-black text-lg sm:text-xl tracking-tight text-white truncate max-w-full">
              {groupState.groupName}
            </h2>
            <div className="mt-1 mb-4 flex items-center justify-center gap-2 text-xs">
              {groupState.status === 'connected' ? (
                <>
                  <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="font-mono font-bold text-emerald-400">
                    {formatDuration(groupElapsedSeconds)}
                  </span>
                  <span className="text-slate-400">· Live Audio Mesh</span>
                </>
              ) : groupState.status === 'joining' ? (
                <span className="flex items-center gap-1.5 text-amber-300 font-semibold">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Joining group voice room...</span>
                </span>
              ) : (
                <span className="text-rose-300 font-semibold">
                  {groupState.errorMessage || 'Group call ended'}
                </span>
              )}
            </div>

            {/* Participant Grid */}
            {groupState.status !== 'ended' && (
              <div className="w-full grid grid-cols-2 sm:grid-cols-3 gap-2.5 my-2 max-h-[42dvh] overflow-y-auto p-1">
                {groupState.participants.map((p) => (
                  <div
                    key={p.userId}
                    className="relative rounded-2xl bg-slate-800/75 border border-violet-500/25 p-3 flex flex-col items-center justify-center gap-1.5"
                  >
                    <div className="relative">
                      <img
                        src={
                          p.avatarUrl ||
                          `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(
                            p.username || 'member'
                          )}`
                        }
                        alt={p.displayName}
                        className={`w-13 h-13 rounded-full object-cover bg-slate-900 border-2 ${
                          p.isMuted ? 'border-slate-600' : 'border-emerald-400'
                        }`}
                        referrerPolicy="no-referrer"
                      />
                      <span
                        className={`absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center border-2 border-slate-900 ${
                          p.isMuted
                            ? 'bg-amber-500 text-white'
                            : 'bg-emerald-500 text-white'
                        }`}
                      >
                        {p.isMuted ? (
                          <MicOff className="w-2.5 h-2.5" />
                        ) : (
                          <Mic className="w-2.5 h-2.5" />
                        )}
                      </span>
                    </div>
                    <span className="text-xs font-bold text-white truncate max-w-full">
                      {p.displayName}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono truncate max-w-full">
                      @{p.username}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {groupState.status === 'connected' && groupState.participants.length <= 1 && (
              <p className="text-[11px] text-violet-200/80 bg-violet-950/50 border border-violet-500/20 rounded-xl px-3 py-2 mt-2">
                Group members have been notified and can tap &ldquo;Join Call&rdquo; in the group chat to join you.
              </p>
            )}

            {/* Group Call Controls */}
            {groupState.status !== 'ended' ? (
              <div className="w-full flex items-center justify-center gap-6 mt-6 mb-1">
                {/* Mute */}
                <div className="flex flex-col items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => groupVoiceCallManager.toggleMute()}
                    className={`w-13 h-13 rounded-full flex items-center justify-center transition-all active:scale-95 cursor-pointer ${
                      groupState.isMuted
                        ? 'bg-amber-500 text-white shadow-md shadow-amber-500/25'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
                    }`}
                  >
                    {groupState.isMuted ? (
                      <MicOff className="w-5 h-5" />
                    ) : (
                      <Mic className="w-5 h-5" />
                    )}
                  </button>
                  <span className="text-[11px] font-medium text-slate-400">
                    {groupState.isMuted ? 'Muted' : 'Mute'}
                  </span>
                </div>

                {/* Leave Call */}
                <div className="flex flex-col items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => groupVoiceCallManager.leaveGroupVoiceCall()}
                    className="w-16 h-16 rounded-full bg-rose-600 hover:bg-rose-500 active:scale-95 text-white flex items-center justify-center shadow-lg shadow-rose-600/35 transition-all cursor-pointer"
                    title="Leave Group Call"
                  >
                    <PhoneOff className="w-7 h-7" />
                  </button>
                  <span className="text-[11px] font-semibold text-rose-400">Leave</span>
                </div>

                {/* Speaker */}
                <div className="flex flex-col items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => groupVoiceCallManager.toggleSpeaker()}
                    className={`w-13 h-13 rounded-full flex items-center justify-center transition-all active:scale-95 cursor-pointer ${
                      groupState.isSpeakerOn
                        ? 'bg-[#8B5CF6] text-white shadow-md shadow-violet-500/25'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
                    }`}
                  >
                    {groupState.isSpeakerOn ? (
                      <Volume2 className="w-5 h-5" />
                    ) : (
                      <Volume1 className="w-5 h-5" />
                    )}
                  </button>
                  <span className="text-[11px] font-medium text-slate-400">
                    {groupState.isSpeakerOn ? 'Speaker On' : 'Speaker'}
                  </span>
                </div>
              </div>
            ) : (
              <div className="w-full mt-4">
                <button
                  type="button"
                  onClick={() => groupVoiceCallManager.dismissEndedScreen()}
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
  }

  // =========================================================================
  // 2. ONE-TO-ONE VOICE CALL UI
  // =========================================================================
  if (callState.status === 'idle') {
    return null;
  }

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

  const pendingKeyApproval =
    callState.status === 'ended' ? voiceCallManager.getPendingKeyRotationApproval() : null;

  const handleApproveNewPeerKey = async () => {
    if (isActionPending || !pendingKeyApproval) return;
    setIsActionPending(true);
    try {
      await voiceCallManager.approvePendingPeerKeyAndContinue();
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
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
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
              className="w-9 h-9 rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center transition-colors cursor-pointer"
              title="End Call"
            >
              <PhoneOff className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => setIsMinimized(false)}
              className="w-9 h-9 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition-colors cursor-pointer"
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
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md">
        <div className="relative w-full max-w-sm max-h-[92dvh] rounded-[32px] bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 text-white border border-slate-800 shadow-2xl p-5 sm:p-6 flex flex-col items-center text-center overflow-y-auto">
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
                className="w-9 h-9 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition-colors cursor-pointer"
                title="Minimize call"
              >
                <Minimize2 className="w-4 h-4" />
              </button>
            )}

            {callState.status === 'ended' && (
              <button
                type="button"
                onClick={() => voiceCallManager.dismissEndedCallScreen()}
                className="w-9 h-9 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition-colors cursor-pointer"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Caller / Callee Avatar with Pulse */}
          <div className="relative my-3 sm:my-4">
            {(callState.status === 'incoming' ||
              callState.status === 'outgoing' ||
              callState.status === 'connecting') && (
              <>
                <span className="absolute -inset-3 rounded-full bg-[#ff3b69]/25 animate-ping" />
                <span className="absolute -inset-1.5 rounded-full bg-[#ff3b69]/20 animate-pulse" />
              </>
            )}
            <div
              className={`relative w-22 h-22 sm:w-24 sm:h-24 rounded-full p-1 ${
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
          <h2 className="font-display font-black text-xl tracking-tight text-white truncate max-w-full">
            {peerName}
          </h2>
          <p className="text-xs text-slate-400 font-mono mt-0.5 truncate max-w-full">
            @{peerUsername}
          </p>

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
              <div className="mt-2 w-full max-w-xs space-y-2 text-left">
                <div className="p-3 rounded-2xl bg-rose-950/60 border border-rose-800/70 text-xs text-rose-200 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <span>{callState.errorMessage || callState.statusDetail || 'Call ended.'}</span>
                </div>
                {pendingKeyApproval && (
                  <div className="p-2.5 rounded-xl bg-slate-900/90 border border-amber-500/40 text-[11px] text-amber-200 space-y-1">
                    <div className="font-semibold text-amber-300 flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span>New Device Key Detected (v{pendingKeyApproval.candidateBundle.keyRotationVersion})</span>
                    </div>
                    <p className="text-slate-300 leading-relaxed">
                      {peerName} signed in on another browser or device. Approve this key only if you recognize this change:
                    </p>
                    <div className="font-mono text-[10px] text-emerald-300 bg-slate-950/90 px-2 py-1 rounded border border-slate-800 break-all">
                      SHA-256: {pendingKeyApproval.candidateEcdsaFingerprint.slice(0, 16)}…{pendingKeyApproval.candidateEcdsaFingerprint.slice(-16)}
                    </div>
                  </div>
                )}
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
            <div className="w-full flex items-center justify-around mt-6 sm:mt-8 mb-2 px-4">
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
            <div className="w-full flex items-center justify-center gap-6 mt-6 sm:mt-8 mb-2">
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
            <div className="w-full mt-5 space-y-2.5">
              {pendingKeyApproval && (
                <button
                  type="button"
                  onClick={handleApproveNewPeerKey}
                  disabled={isActionPending}
                  className="w-full py-2.5 px-4 rounded-full bg-emerald-600 hover:bg-emerald-500 active:scale-98 text-white font-bold text-xs shadow-lg shadow-emerald-600/25 transition-all cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>
                    {isActionPending
                      ? 'Approving Key...'
                      : pendingKeyApproval.pendingIncomingInvite
                      ? 'Approve New Device Key & Answer'
                      : 'Approve New Device Key & Call'}
                  </span>
                </button>
              )}
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
