import { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabase, isSupabaseConfigured } from './supabase';
import { PublicUserProfile, UserProfile } from '../types';
import { FREE_STUN_ICE_SERVERS } from './callService';
import {
  playCallConnectedTone,
  playCallEndedTone,
  unlockSound,
} from './sounds';

export interface GroupCallParticipant {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  isMuted: boolean;
  joinedAt: number;
  isConnectedAudio?: boolean;
}

export interface GroupVoiceCallState {
  status: 'idle' | 'joining' | 'connected' | 'ended';
  conversationId: string | null;
  groupName: string;
  groupAvatar: string;
  isMuted: boolean;
  isSpeakerOn: boolean;
  connectedAt: number | null;
  participants: GroupCallParticipant[];
  errorMessage: string | null;
}

type GroupSignalType =
  | 'group-peer-join'
  | 'group-peer-leave'
  | 'group-peer-mute'
  | 'group-room-query'
  | 'group-room-announce'
  | 'group-webrtc-offer'
  | 'group-webrtc-answer'
  | 'group-webrtc-ice';

interface GroupSignalPayload {
  type: GroupSignalType;
  conversationId: string;
  senderId: string;
  targetUserId?: string;
  participant?: GroupCallParticipant;
  isMuted?: boolean;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  timestamp: number;
}

const INITIAL_GROUP_CALL_STATE: GroupVoiceCallState = {
  status: 'idle',
  conversationId: null,
  groupName: 'Group Call',
  groupAvatar: '',
  isMuted: false,
  isSpeakerOn: false,
  connectedAt: null,
  participants: [],
  errorMessage: null,
};

class GroupVoiceCallManager {
  private state: GroupVoiceCallState = { ...INITIAL_GROUP_CALL_STATE };
  private stateListeners = new Set<(state: GroupVoiceCallState) => void>();
  private remoteStreams = new Map<string, MediaStream>();
  private streamListeners = new Set<(streams: Map<string, MediaStream>) => void>();

  private localStream: MediaStream | null = null;
  private localParticipant: GroupCallParticipant | null = null;
  private roomChannel: RealtimeChannel | null = null;
  private peerConnections = new Map<string, RTCPeerConnection>();
  private pendingIceByPeer = new Map<string, RTCIceCandidateInit[]>();
  private participantsMap = new Map<string, GroupCallParticipant>();

  public getState(): GroupVoiceCallState {
    return this.state;
  }

  public getRemoteStreams(): Map<string, MediaStream> {
    return new Map(this.remoteStreams);
  }

  public subscribeState(listener: (state: GroupVoiceCallState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  public subscribeRemoteStreams(
    listener: (streams: Map<string, MediaStream>) => void
  ): () => void {
    this.streamListeners.add(listener);
    listener(new Map(this.remoteStreams));
    return () => {
      this.streamListeners.delete(listener);
    };
  }

  private updateState(patch: Partial<GroupVoiceCallState>): void {
    this.state = {
      ...this.state,
      ...patch,
    };
    for (const listener of this.stateListeners) {
      try {
        listener(this.state);
      } catch {}
    }
  }

  private notifyStreamsChanged(): void {
    const snapshot = new Map(this.remoteStreams);
    for (const listener of this.streamListeners) {
      try {
        listener(snapshot);
      } catch {}
    }
  }

  private syncParticipantsToState(): void {
    const list = Array.from(this.participantsMap.values()).sort(
      (a, b) => a.joinedAt - b.joinedAt
    );
    this.updateState({ participants: list });
  }

  /**
   * Starts or joins a live WebRTC group voice call in `conversationId`.
   */
  public async startOrJoinGroupVoiceCall(params: {
    conversationId: string;
    groupName: string;
    groupAvatar?: string;
    localProfile: UserProfile;
    members?: PublicUserProfile[];
    announceInChat?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    const {
      conversationId,
      groupName,
      groupAvatar = '',
      localProfile,
      announceInChat = true,
    } = params;

    if (!conversationId || !localProfile?.id) {
      return { success: false, error: 'Missing group conversation or user profile.' };
    }

    if (typeof window !== 'undefined') {
      try {
        unlockSound();
      } catch {}
    }

    // If already connected to this exact group call, simply keep it open
    if (
      (this.state.status === 'connected' || this.state.status === 'joining') &&
      this.state.conversationId === conversationId
    ) {
      return { success: true };
    }

    // Clean up any previous call session first
    if (this.state.status !== 'idle') {
      await this.leaveGroupVoiceCall(false);
    }

    if (
      typeof window === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function' ||
      typeof RTCPeerConnection === 'undefined'
    ) {
      return {
        success: false,
        error: 'WebRTC voice calling is not supported in this browser.',
      };
    }

    const myParticipant: GroupCallParticipant = {
      userId: localProfile.id,
      username: localProfile.username,
      displayName: localProfile.display_name || localProfile.username,
      avatarUrl:
        localProfile.avatar_url ||
        `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(
          localProfile.username || 'spark'
        )}`,
      isMuted: false,
      joinedAt: Date.now(),
      isConnectedAudio: true,
    };

    this.localParticipant = myParticipant;
    this.participantsMap.clear();
    this.participantsMap.set(myParticipant.userId, myParticipant);

    this.updateState({
      status: 'joining',
      conversationId,
      groupName: groupName || 'Group Voice Call',
      groupAvatar,
      isMuted: false,
      isSpeakerOn: true,
      connectedAt: null,
      participants: [myParticipant],
      errorMessage: null,
    });

    // 1. Request microphone stream
    let micStream: MediaStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (micErr: any) {
      const msg =
        micErr?.name === 'NotAllowedError' || micErr?.name === 'PermissionDeniedError'
          ? 'Microphone permission was denied. Please allow microphone access in browser settings to join the group call.'
          : `Could not access microphone: ${micErr?.message || 'Hardware unavailable'}`;
      this.releaseGroupResources();
      this.updateState({
        ...INITIAL_GROUP_CALL_STATE,
        status: 'ended',
        groupName,
        groupAvatar,
        errorMessage: msg,
      });
      return { success: false, error: msg };
    }

    this.localStream = micStream;

    if (!isSupabaseConfigured()) {
      this.updateState({
        status: 'connected',
        connectedAt: Date.now(),
      });
      return { success: true };
    }

    const supabase = getSupabase();
    if (!supabase) {
      this.releaseGroupResources();
      return { success: false, error: 'Supabase is not configured.' };
    }

    // 2. Subscribe to the group voice room channel (uses prefix spark_group_voice_room_ outside restrictive 1:1 policy)
    const roomTopic = `spark_group_voice_room_${conversationId}`;
    try {
      const existing = supabase
        .getChannels()
        .filter((ch) => ch.topic === `realtime:${roomTopic}` || ch.topic === roomTopic);
      for (const ch of existing) {
        try {
          await supabase.removeChannel(ch);
        } catch {}
      }
    } catch {}

    const channel = supabase.channel(roomTopic, {
      config: {
        broadcast: { self: false },
        presence: { key: myParticipant.userId },
      },
    });

    this.roomChannel = channel;

    channel
      .on('presence', { event: 'sync' }, () => {
        const presenceState = channel.presenceState();
        const activeIds = new Set<string>([myParticipant.userId]);

        Object.entries(presenceState).forEach(([peerUserId, presences]) => {
          if (!peerUserId || peerUserId === myParticipant.userId) return;
          const latest = (presences as any[])?.[0];
          if (latest && latest.userId) {
            activeIds.add(peerUserId);
            const existing = this.participantsMap.get(peerUserId);
            this.participantsMap.set(peerUserId, {
              userId: latest.userId,
              username: latest.username || existing?.username || 'member',
              displayName:
                latest.displayName ||
                latest.username ||
                existing?.displayName ||
                'Member',
              avatarUrl: latest.avatarUrl || existing?.avatarUrl || '',
              isMuted: Boolean(latest.isMuted),
              joinedAt: Number(latest.joinedAt) || existing?.joinedAt || Date.now(),
              isConnectedAudio: existing?.isConnectedAudio ?? false,
            });

            // Deterministic tie-breaker: if we don't have a peer connection yet and our userId < peerUserId, initiate offer
            if (
              !this.peerConnections.has(peerUserId) &&
              myParticipant.userId.localeCompare(peerUserId) < 0
            ) {
              this.initiateOfferToPeer(peerUserId).catch(() => {});
            }
          }
        });

        // Remove participants who left presence
        for (const existingId of Array.from(this.participantsMap.keys())) {
          if (existingId !== myParticipant.userId && !activeIds.has(existingId)) {
            this.removePeerConnection(existingId);
            this.participantsMap.delete(existingId);
          }
        }

        this.syncParticipantsToState();
      })
      .on('broadcast', { event: 'group_voice_signal' }, ({ payload }) => {
        if (!payload) return;
        this.handleGroupSignal(payload as GroupSignalPayload).catch((err) =>
          console.warn('[GroupVoiceCall] Signal error:', err)
        );
      })
      .subscribe(async (status: string) => {
        if (status === 'SUBSCRIBED') {
          try {
            await channel.track(myParticipant);
          } catch {}

          await this.sendGroupSignal({
            type: 'group-peer-join',
            conversationId,
            senderId: myParticipant.userId,
            participant: myParticipant,
            timestamp: Date.now(),
          });

          try {
            playCallConnectedTone();
          } catch {}

          const wasFirstInRoom = this.participantsMap.size <= 1;
          this.updateState({
            status: 'connected',
            connectedAt: Date.now(),
            errorMessage: null,
          });

          // Dispatch Web Push + in-chat call event if announcing the group call start
          if (announceInChat && wasFirstInRoom) {
            this.dispatchGroupCallNotification(
              conversationId,
              groupName,
              myParticipant
            ).catch(() => {});
          }
        }
      });

    return { success: true };
  }

  private async dispatchGroupCallNotification(
    conversationId: string,
    groupName: string,
    caller: GroupCallParticipant
  ): Promise<void> {
    const supabase = getSupabase();
    if (!supabase) return;

    const callContent = `📞 ${caller.displayName} started a group voice call — Tap "Join Call" to hop in!`;
    const nowIso = new Date().toISOString();

    try {
      // 1. Insert group call message into public.messages so all members see it and pg_net triggers Web Push
      await supabase.from('messages').insert({
        conversation_id: conversationId,
        sender_id: caller.userId,
        content: callContent,
        coins_earned: 0,
      });

      await supabase
        .from('conversations')
        .update({ updated_at: nowIso })
        .eq('id', conversationId);
    } catch {}

    try {
      // 2. Also invoke Edge Function directly with isCallInvite: true for immediate call-grade push alert
      await supabase.functions.invoke('send-push-notification', {
        body: {
          type: 'INSERT',
          table: 'messages',
          schema: 'public',
          isCallInvite: true,
          isGroup: true,
          title: `📞 Group Call in ${groupName}`,
          record: {
            id: `group_call_${Date.now()}`,
            conversation_id: conversationId,
            sender_id: caller.userId,
            content: callContent,
            created_at: nowIso,
          },
        },
      });
    } catch {}
  }

  private async sendGroupSignal(payload: GroupSignalPayload): Promise<void> {
    if (!this.roomChannel) return;
    try {
      await this.roomChannel.send({
        type: 'broadcast',
        event: 'group_voice_signal',
        payload,
      });
    } catch {}
  }

  private async handleGroupSignal(msg: GroupSignalPayload): Promise<void> {
    const myUser = this.localParticipant;
    if (!myUser || !this.state.conversationId) return;
    if (msg.conversationId !== this.state.conversationId) return;
    if (msg.senderId === myUser.userId) return;
    if (msg.targetUserId && msg.targetUserId !== myUser.userId) return;

    switch (msg.type) {
      case 'group-room-query': {
        await this.sendGroupSignal({
          type: 'group-room-announce',
          conversationId: this.state.conversationId,
          senderId: myUser.userId,
          participant: {
            ...myUser,
            isMuted: this.state.isMuted,
          },
          timestamp: Date.now(),
        });
        break;
      }

      case 'group-peer-join': {
        if (msg.participant) {
          this.participantsMap.set(msg.senderId, {
            ...msg.participant,
            isConnectedAudio: false,
          });
          this.syncParticipantsToState();
        }
        // Existing room member immediately sends a WebRTC offer to the newcomer
        await this.initiateOfferToPeer(msg.senderId);
        break;
      }

      case 'group-peer-leave': {
        this.removePeerConnection(msg.senderId);
        this.participantsMap.delete(msg.senderId);
        this.syncParticipantsToState();
        break;
      }

      case 'group-peer-mute': {
        const existing = this.participantsMap.get(msg.senderId);
        if (existing) {
          this.participantsMap.set(msg.senderId, {
            ...existing,
            isMuted: Boolean(msg.isMuted),
          });
          this.syncParticipantsToState();
        }
        break;
      }

      case 'group-webrtc-offer': {
        if (!msg.sdp) return;
        if (msg.participant && !this.participantsMap.has(msg.senderId)) {
          this.participantsMap.set(msg.senderId, msg.participant);
          this.syncParticipantsToState();
        }
        const pc = this.getOrCreatePeerConnection(msg.senderId);
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          await this.flushPendingIceForPeer(msg.senderId, pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await this.sendGroupSignal({
            type: 'group-webrtc-answer',
            conversationId: this.state.conversationId,
            senderId: myUser.userId,
            targetUserId: msg.senderId,
            participant: {
              ...myUser,
              isMuted: this.state.isMuted,
            },
            sdp: pc.localDescription || answer,
            timestamp: Date.now(),
          });
        } catch (err) {
          console.warn('[GroupVoiceCall] Error handling group offer:', err);
        }
        break;
      }

      case 'group-webrtc-answer': {
        if (!msg.sdp) return;
        if (msg.participant && !this.participantsMap.has(msg.senderId)) {
          this.participantsMap.set(msg.senderId, msg.participant);
          this.syncParticipantsToState();
        }
        const pc = this.peerConnections.get(msg.senderId);
        if (!pc) return;
        try {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            await this.flushPendingIceForPeer(msg.senderId, pc);
          }
        } catch (err) {
          console.warn('[GroupVoiceCall] Error setting group answer:', err);
        }
        break;
      }

      case 'group-webrtc-ice': {
        if (!msg.candidate) return;
        const pc = this.peerConnections.get(msg.senderId);
        if (pc && pc.remoteDescription) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch {}
        } else {
          const queue = this.pendingIceByPeer.get(msg.senderId) || [];
          queue.push(msg.candidate);
          this.pendingIceByPeer.set(msg.senderId, queue);
        }
        break;
      }
    }
  }

  private getOrCreatePeerConnection(peerUserId: string): RTCPeerConnection {
    const existing = this.peerConnections.get(peerUserId);
    if (existing) {
      try {
        existing.close();
      } catch {}
    }

    const pc = new RTCPeerConnection({
      iceServers: FREE_STUN_ICE_SERVERS,
      iceCandidatePoolSize: 4,
    });

    this.peerConnections.set(peerUserId, pc);

    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        track.enabled = !this.state.isMuted;
        pc.addTrack(track, this.localStream);
      }
    }

    pc.ontrack = (event: RTCTrackEvent) => {
      const stream =
        event.streams && event.streams[0]
          ? event.streams[0]
          : new MediaStream([event.track]);
      this.remoteStreams.set(peerUserId, stream);
      this.notifyStreamsChanged();

      const p = this.participantsMap.get(peerUserId);
      if (p) {
        this.participantsMap.set(peerUserId, { ...p, isConnectedAudio: true });
        this.syncParticipantsToState();
      }
    };

    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate && this.localParticipant && this.state.conversationId) {
        this.sendGroupSignal({
          type: 'group-webrtc-ice',
          conversationId: this.state.conversationId,
          senderId: this.localParticipant.userId,
          targetUserId: peerUserId,
          candidate: event.candidate.toJSON(),
          timestamp: Date.now(),
        }).catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        const p = this.participantsMap.get(peerUserId);
        if (p) {
          this.participantsMap.set(peerUserId, { ...p, isConnectedAudio: true });
          this.syncParticipantsToState();
        }
      }
    };

    return pc;
  }

  private async initiateOfferToPeer(peerUserId: string): Promise<void> {
    if (!this.localParticipant || !this.state.conversationId) return;
    const pc = this.getOrCreatePeerConnection(peerUserId);
    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);
      await this.sendGroupSignal({
        type: 'group-webrtc-offer',
        conversationId: this.state.conversationId,
        senderId: this.localParticipant.userId,
        targetUserId: peerUserId,
        participant: {
          ...this.localParticipant,
          isMuted: this.state.isMuted,
        },
        sdp: pc.localDescription || offer,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn('[GroupVoiceCall] Offer creation error:', err);
    }
  }

  private async flushPendingIceForPeer(
    peerUserId: string,
    pc: RTCPeerConnection
  ): Promise<void> {
    const queue = this.pendingIceByPeer.get(peerUserId) || [];
    this.pendingIceByPeer.delete(peerUserId);
    for (const cand of queue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch {}
    }
  }

  private removePeerConnection(peerUserId: string): void {
    const pc = this.peerConnections.get(peerUserId);
    if (pc) {
      try {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.close();
      } catch {}
      this.peerConnections.delete(peerUserId);
    }
    this.pendingIceByPeer.delete(peerUserId);
    if (this.remoteStreams.has(peerUserId)) {
      const stream = this.remoteStreams.get(peerUserId);
      if (stream) {
        for (const t of stream.getTracks()) {
          try {
            t.stop();
          } catch {}
        }
      }
      this.remoteStreams.delete(peerUserId);
      this.notifyStreamsChanged();
    }
  }

  public async toggleMute(): Promise<boolean> {
    const nextMuted = !this.state.isMuted;
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        track.enabled = !nextMuted;
      }
    }
    if (this.localParticipant) {
      this.localParticipant = {
        ...this.localParticipant,
        isMuted: nextMuted,
      };
      this.participantsMap.set(this.localParticipant.userId, this.localParticipant);
      this.syncParticipantsToState();

      if (this.roomChannel) {
        try {
          await this.roomChannel.track(this.localParticipant);
        } catch {}
      }
      if (this.state.conversationId) {
        await this.sendGroupSignal({
          type: 'group-peer-mute',
          conversationId: this.state.conversationId,
          senderId: this.localParticipant.userId,
          isMuted: nextMuted,
          timestamp: Date.now(),
        });
      }
    }
    this.updateState({ isMuted: nextMuted });
    return nextMuted;
  }

  public toggleSpeaker(): boolean {
    const nextSpeaker = !this.state.isSpeakerOn;
    this.updateState({ isSpeakerOn: nextSpeaker });
    return nextSpeaker;
  }

  public async leaveGroupVoiceCall(playTone = true): Promise<void> {
    if (playTone && typeof window !== 'undefined') {
      try {
        playCallEndedTone();
      } catch {}
    }

    if (this.localParticipant && this.state.conversationId && this.roomChannel) {
      await this.sendGroupSignal({
        type: 'group-peer-leave',
        conversationId: this.state.conversationId,
        senderId: this.localParticipant.userId,
        timestamp: Date.now(),
      });
      try {
        await this.roomChannel.untrack();
      } catch {}
    }

    this.releaseGroupResources();
    this.updateState({ ...INITIAL_GROUP_CALL_STATE });
  }

  public dismissEndedScreen(): void {
    this.releaseGroupResources();
    this.updateState({ ...INITIAL_GROUP_CALL_STATE });
  }

  private releaseGroupResources(): void {
    for (const peerId of Array.from(this.peerConnections.keys())) {
      this.removePeerConnection(peerId);
    }
    this.peerConnections.clear();
    this.pendingIceByPeer.clear();
    this.remoteStreams.clear();
    this.notifyStreamsChanged();

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        try {
          track.stop();
        } catch {}
      }
      this.localStream = null;
    }

    this.localParticipant = null;
    this.participantsMap.clear();

    if (this.roomChannel) {
      const ch = this.roomChannel;
      this.roomChannel = null;
      setTimeout(() => {
        try {
          ch.unsubscribe();
          getSupabase()?.removeChannel(ch);
        } catch {}
      }, 200);
    }
  }
}

export const groupVoiceCallManager = new GroupVoiceCallManager();
