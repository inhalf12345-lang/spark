import { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabase, isSupabaseConfigured } from './supabase';
import { PublicUserProfile, UserProfile } from '../types';
import { FREE_STUN_ICE_SERVERS } from './callService';
import { ensureSupabaseAuthSession } from './chatService';
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
  | 'group-call-end'
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

const GROUP_CALL_BANNER_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const ACTIVE_GROUP_CALL_STORAGE_PREFIX = 'spark_active_group_call_';
const ENDED_GROUP_CALL_STORAGE_PREFIX = 'spark_group_call_ended_';

class GroupVoiceCallManager {
  private state: GroupVoiceCallState = { ...INITIAL_GROUP_CALL_STATE };
  private stateListeners = new Set<(state: GroupVoiceCallState) => void>();
  private remoteStreams = new Map<string, MediaStream>();
  private streamListeners = new Set<(streams: Map<string, MediaStream>) => void>();

  private localStream: MediaStream | null = null;
  private localParticipant: GroupCallParticipant | null = null;
  private roomChannel: RealtimeChannel | null = null;
  private peerConnections = new Map<string, RTCPeerConnection>();
  private makingOfferByPeer = new Map<string, boolean>();
  private pendingIceByPeer = new Map<string, RTCIceCandidateInit[]>();
  private participantsMap = new Map<string, GroupCallParticipant>();
  private activeSessionToken = 0;
  private hadRemoteParticipantInSession = false;
  private endedConversationAt = new Map<string, number>();
  private activeConversationCalls = new Map<string, number>();
  private activeCallNoticeMessageIds = new Map<string, string>();

  constructor() {
    this.clearAllStoredBannerStateOnLoad();
  }

  public getState(): GroupVoiceCallState {
    return this.state;
  }

  public getRemoteStreams(): Map<string, MediaStream> {
    return new Map(this.remoteStreams);
  }

  public isOwnRoomChannel(ch: RealtimeChannel | null | undefined): boolean {
    return Boolean(ch && this.roomChannel && ch === this.roomChannel);
  }

  /**
   * Clears any leftover group call banner state from localStorage and sessionStorage on app load
   * when no call is active.
   */
  public clearAllStoredBannerStateOnLoad(): void {
    if (this.state.status !== 'idle') return;
    this.activeConversationCalls.clear();
    if (typeof window === 'undefined') return;
    try {
      const localKeys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (
          k &&
          (k.startsWith(ACTIVE_GROUP_CALL_STORAGE_PREFIX) ||
            k.startsWith(ENDED_GROUP_CALL_STORAGE_PREFIX))
        ) {
          localKeys.push(k);
        }
      }
      localKeys.forEach((k) => localStorage.removeItem(k));
    } catch {}
    try {
      const sessionKeys: string[] = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (
          k &&
          (k.startsWith(ACTIVE_GROUP_CALL_STORAGE_PREFIX) ||
            k.startsWith(ENDED_GROUP_CALL_STORAGE_PREFIX))
        ) {
          sessionKeys.push(k);
        }
      }
      sessionKeys.forEach((k) => sessionStorage.removeItem(k));
    } catch {}
  }

  public setConversationCallActive(conversationId: string, startedAt = Date.now()): void {
    if (!conversationId) return;
    if (Date.now() - startedAt >= GROUP_CALL_BANNER_MAX_AGE_MS) {
      this.clearConversationCallState(conversationId);
      return;
    }
    this.activeConversationCalls.set(conversationId, startedAt);
    this.endedConversationAt.delete(conversationId);
    if (typeof window !== 'undefined') {
      const payload = JSON.stringify({ conversationId, startedAt, active: true });
      try {
        sessionStorage.setItem(`${ACTIVE_GROUP_CALL_STORAGE_PREFIX}${conversationId}`, payload);
      } catch {}
      try {
        localStorage.removeItem(`${ENDED_GROUP_CALL_STORAGE_PREFIX}${conversationId}`);
      } catch {}
      try {
        window.dispatchEvent(
          new CustomEvent('spark_group_call_banner_updated', {
            detail: { conversationId, startedAt, active: true },
          })
        );
      } catch {}
    }
  }

  public clearConversationCallState(conversationId: string, endedAt = Date.now()): void {
    if (!conversationId) return;
    this.activeConversationCalls.delete(conversationId);
    this.endedConversationAt.set(conversationId, endedAt);

    const noticeMsgId = this.activeCallNoticeMessageIds.get(conversationId);
    if (noticeMsgId) {
      this.activeCallNoticeMessageIds.delete(conversationId);
      const supabase = isSupabaseConfigured() ? getSupabase() : null;
      if (supabase) {
        void supabase.from('messages').delete().eq('id', noticeMsgId);
      }
    }

    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem(`${ACTIVE_GROUP_CALL_STORAGE_PREFIX}${conversationId}`);
        localStorage.removeItem(`${ENDED_GROUP_CALL_STORAGE_PREFIX}${conversationId}`);
      } catch {}
      try {
        sessionStorage.removeItem(`${ACTIVE_GROUP_CALL_STORAGE_PREFIX}${conversationId}`);
        sessionStorage.removeItem(`${ENDED_GROUP_CALL_STORAGE_PREFIX}${conversationId}`);
      } catch {}
      try {
        window.dispatchEvent(
          new CustomEvent('spark_group_call_ended', {
            detail: { conversationId, endedAt },
          })
        );
        window.dispatchEvent(
          new CustomEvent('spark_group_call_banner_updated', {
            detail: { conversationId, startedAt: null, active: false },
          })
        );
      } catch {}
    }
  }

  public getActiveConversationCallStartedAt(conversationId: string): number | null {
    if (!conversationId) return null;
    let startedAt = this.activeConversationCalls.get(conversationId) || null;
    if (!startedAt && typeof window !== 'undefined') {
      try {
        const raw =
          sessionStorage.getItem(`${ACTIVE_GROUP_CALL_STORAGE_PREFIX}${conversationId}`) ||
          localStorage.getItem(`${ACTIVE_GROUP_CALL_STORAGE_PREFIX}${conversationId}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.active && typeof parsed.startedAt === 'number') {
            startedAt = parsed.startedAt;
          }
        }
      } catch {}
    }
    if (!startedAt) return null;
    if (Date.now() - startedAt >= GROUP_CALL_BANNER_MAX_AGE_MS) {
      this.clearConversationCallState(conversationId);
      return null;
    }
    return startedAt;
  }

  public markConversationCallEnded(conversationId: string, endedAt = Date.now()): void {
    this.clearConversationCallState(conversationId, endedAt);
  }

  public getConversationCallEndedAt(conversationId: string): number {
    if (!conversationId) return 0;
    return this.endedConversationAt.get(conversationId) || 0;
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
    if (this.state.status === 'idle') return;
    const list = Array.from(this.participantsMap.values()).sort(
      (a, b) => a.joinedAt - b.joinedAt
    );
    this.updateState({ participants: list });
  }

  private isSessionActive(token: number): boolean {
    return token === this.activeSessionToken && this.state.status !== 'idle';
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

    const sessionToken = ++this.activeSessionToken;
    this.hadRemoteParticipantInSession = false;

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
      if (!this.isSessionActive(sessionToken)) {
        return { success: false };
      }
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

    // If the user cut/left the call while getUserMedia was pending, stop tracks immediately and do not reopen UI
    if (!this.isSessionActive(sessionToken)) {
      for (const track of micStream.getTracks()) {
        try {
          track.stop();
        } catch {}
      }
      return { success: false };
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
      this.updateState({ ...INITIAL_GROUP_CALL_STATE });
      return { success: false, error: 'Supabase is not configured.' };
    }

    try {
      await ensureSupabaseAuthSession(localProfile);
    } catch {}

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

    if (!this.isSessionActive(sessionToken)) {
      this.releaseGroupResources();
      return { success: false };
    }

    const channel = supabase.channel(roomTopic, {
      config: {
        broadcast: { self: false },
        presence: { key: myParticipant.userId },
      },
    });

    this.roomChannel = channel;

    channel
      .on('presence', { event: 'sync' }, () => {
        if (!this.isSessionActive(sessionToken)) {
          return;
        }
        const presenceState = channel.presenceState();
        const activeIds = new Set<string>([myParticipant.userId]);

        Object.entries(presenceState).forEach(([peerUserId, presences]) => {
          if (!peerUserId || peerUserId === myParticipant.userId) return;
          const latest = (presences as any[])?.[0];
          if (latest && latest.userId) {
            activeIds.add(peerUserId);
            this.hadRemoteParticipantInSession = true;
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

            // Deferred fallback tie-breaker so presence sync does not collide with immediate group-peer-join offer
            if (
              !this.peerConnections.has(peerUserId) &&
              myParticipant.userId.localeCompare(peerUserId) < 0
            ) {
              setTimeout(() => {
                if (
                  this.isSessionActive(sessionToken) &&
                  this.participantsMap.has(peerUserId) &&
                  !this.peerConnections.has(peerUserId)
                ) {
                  this.initiateOfferToPeer(peerUserId).catch(() => {});
                }
              }, 450);
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

        // If remote participants were in this call and all of them have now left, end the call automatically
        if (this.hadRemoteParticipantInSession && this.participantsMap.size <= 1) {
          void this.leaveGroupVoiceCall(true);
          return;
        }

        this.syncParticipantsToState();
      })
      .on('broadcast', { event: 'group_voice_signal' }, ({ payload }) => {
        if (!this.isSessionActive(sessionToken) || !payload) {
          return;
        }
        this.handleGroupSignal(payload as GroupSignalPayload).catch((err) =>
          console.warn('[GroupVoiceCall] Signal error:', err)
        );
      })
      .subscribe(async (status: string) => {
        if (!this.isSessionActive(sessionToken)) {
          return;
        }
        if (status === 'SUBSCRIBED') {
          try {
            await channel.track(myParticipant);
          } catch {}

          if (!this.isSessionActive(sessionToken)) {
            return;
          }

          await this.sendGroupSignal({
            type: 'group-peer-join',
            conversationId,
            senderId: myParticipant.userId,
            participant: myParticipant,
            timestamp: Date.now(),
          });

          if (!this.isSessionActive(sessionToken)) {
            return;
          }

          try {
            playCallConnectedTone();
          } catch {}

          const wasFirstInRoom = this.participantsMap.size <= 1;
          const nowConnected = Date.now();
          this.setConversationCallActive(conversationId, nowConnected);
          this.updateState({
            status: 'connected',
            connectedAt: nowConnected,
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
      const { data: insertedMsg } = await supabase
        .from('messages')
        .insert({
          conversation_id: conversationId,
          sender_id: caller.userId,
          content: callContent,
          coins_earned: 0,
        })
        .select('id')
        .maybeSingle();

      if (insertedMsg?.id) {
        this.activeCallNoticeMessageIds.set(conversationId, insertedMsg.id);
      }

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
    if (this.state.status === 'idle') return;
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

      case 'group-room-announce': {
        this.hadRemoteParticipantInSession = true;
        if (msg.participant) {
          const existing = this.participantsMap.get(msg.senderId);
          this.participantsMap.set(msg.senderId, {
            ...msg.participant,
            isConnectedAudio: existing?.isConnectedAudio ?? false,
          });
          this.syncParticipantsToState();
        }
        break;
      }

      case 'group-peer-join': {
        this.hadRemoteParticipantInSession = true;
        if (msg.participant) {
          const existing = this.participantsMap.get(msg.senderId);
          this.participantsMap.set(msg.senderId, {
            ...msg.participant,
            isConnectedAudio: existing?.isConnectedAudio ?? false,
          });
          this.syncParticipantsToState();
        }
        // Announce our presence to the newcomer so their participant list updates immediately
        await this.sendGroupSignal({
          type: 'group-room-announce',
          conversationId: this.state.conversationId,
          senderId: myUser.userId,
          targetUserId: msg.senderId,
          participant: {
            ...myUser,
            isMuted: this.state.isMuted,
          },
          timestamp: Date.now(),
        });
        // Existing room member initiates the WebRTC offer to the newcomer
        await this.initiateOfferToPeer(msg.senderId);
        break;
      }

      case 'group-peer-leave': {
        this.removePeerConnection(msg.senderId);
        this.participantsMap.delete(msg.senderId);
        if (this.hadRemoteParticipantInSession && this.participantsMap.size <= 1) {
          await this.leaveGroupVoiceCall(true);
          return;
        }
        this.syncParticipantsToState();
        break;
      }

      case 'group-call-end': {
        this.markConversationCallEnded(msg.conversationId, msg.timestamp || Date.now());
        if (this.participantsMap.size <= 2) {
          await this.leaveGroupVoiceCall(true);
          return;
        }
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
        this.hadRemoteParticipantInSession = true;
        if (msg.participant && !this.participantsMap.has(msg.senderId)) {
          this.participantsMap.set(msg.senderId, msg.participant);
          this.syncParticipantsToState();
        }

        const existingPc = this.peerConnections.get(msg.senderId);
        const isMakingOffer = Boolean(this.makingOfferByPeer.get(msg.senderId));
        const offerCollision = Boolean(
          existingPc && (isMakingOffer || existingPc.signalingState !== 'stable')
        );
        const isPolite = myUser.userId.localeCompare(msg.senderId) < 0;

        // WebRTC Perfect Negotiation: impolite peer ignores colliding offer so its own offer completes
        if (offerCollision && !isPolite) {
          return;
        }

        const pc = this.getOrCreatePeerConnection(msg.senderId, offerCollision && isPolite);
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
        this.hadRemoteParticipantInSession = true;
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

  private getOrCreatePeerConnection(
    peerUserId: string,
    forceRecreate = false
  ): RTCPeerConnection {
    const existing = this.peerConnections.get(peerUserId);
    if (existing) {
      if (
        !forceRecreate &&
        existing.connectionState !== 'closed' &&
        existing.connectionState !== 'failed' &&
        existing.signalingState !== 'closed'
      ) {
        return existing;
      }
      try {
        existing.ontrack = null;
        existing.onicecandidate = null;
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
      if (this.state.status === 'idle') return;
      event.track.enabled = true;
      let stream =
        event.streams && event.streams[0] ? event.streams[0] : null;
      if (!stream) {
        const existingStream = this.remoteStreams.get(peerUserId);
        if (existingStream) {
          if (!existingStream.getTracks().some((t) => t.id === event.track.id)) {
            existingStream.addTrack(event.track);
          }
          stream = existingStream;
        } else {
          stream = new MediaStream([event.track]);
        }
      }
      this.remoteStreams.set(peerUserId, stream);
      this.notifyStreamsChanged();

      event.track.onunmute = () => {
        if (this.state.status === 'idle') return;
        event.track.enabled = true;
        this.notifyStreamsChanged();
      };

      const p = this.participantsMap.get(peerUserId);
      if (p) {
        this.participantsMap.set(peerUserId, { ...p, isConnectedAudio: true });
        this.syncParticipantsToState();
      }
    };

    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (
        this.state.status !== 'idle' &&
        event.candidate &&
        this.localParticipant &&
        this.state.conversationId
      ) {
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

    pc.oniceconnectionstatechange = () => {
      if (this.state.status === 'idle') return;
      if (
        pc.iceConnectionState === 'connected' ||
        pc.iceConnectionState === 'completed'
      ) {
        const p = this.participantsMap.get(peerUserId);
        if (p) {
          this.participantsMap.set(peerUserId, { ...p, isConnectedAudio: true });
          this.syncParticipantsToState();
        }
        this.notifyStreamsChanged();
      } else if (
        pc.iceConnectionState === 'failed' &&
        this.localParticipant &&
        this.localParticipant.userId.localeCompare(peerUserId) < 0
      ) {
        this.initiateOfferToPeer(peerUserId, true).catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.state.status === 'idle') return;
      if (pc.connectionState === 'connected') {
        const p = this.participantsMap.get(peerUserId);
        if (p) {
          this.participantsMap.set(peerUserId, { ...p, isConnectedAudio: true });
          this.syncParticipantsToState();
        }
        this.notifyStreamsChanged();
      }
    };

    return pc;
  }

  private async initiateOfferToPeer(
    peerUserId: string,
    forceRecreate = false
  ): Promise<void> {
    if (!this.localParticipant || !this.state.conversationId || this.state.status === 'idle') {
      return;
    }
    if (this.makingOfferByPeer.get(peerUserId)) {
      return;
    }
    const pc = this.getOrCreatePeerConnection(peerUserId, forceRecreate);
    if (!forceRecreate && pc.signalingState !== 'stable') {
      return;
    }
    this.makingOfferByPeer.set(peerUserId, true);
    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      if (pc.signalingState !== 'stable') {
        return;
      }
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
    } finally {
      this.makingOfferByPeer.set(peerUserId, false);
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
    this.makingOfferByPeer.delete(peerUserId);
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
    // 1. Immediately invalidate all in-flight async steps and channel callbacks
    this.activeSessionToken++;
    this.hadRemoteParticipantInSession = false;

    const prevConversationId = this.state.conversationId;
    const prevParticipant = this.localParticipant;
    const prevChannel = this.roomChannel;
    const wasAloneOrEnding = this.participantsMap.size <= 2;

    if (prevConversationId) {
      this.markConversationCallEnded(prevConversationId, Date.now());
    }

    // 2. Detach channel reference so releaseGroupResources doesn't double-close before our broadcast
    this.roomChannel = null;

    // 3. Synchronously stop all audio tracks and peer connections
    this.releaseGroupResources();

    // 4. Synchronously reset state to 'idle' so the Group Call popup disappears in 0ms
    this.updateState({ ...INITIAL_GROUP_CALL_STATE });

    if (playTone && typeof window !== 'undefined') {
      try {
        playCallEndedTone();
      } catch {}
    }

    // 5. Non-blocking background broadcast and channel cleanup
    if (prevChannel) {
      void (async () => {
        try {
          if (prevParticipant && prevConversationId) {
            await prevChannel.send({
              type: 'broadcast',
              event: 'group_voice_signal',
              payload: {
                type: 'group-peer-leave',
                conversationId: prevConversationId,
                senderId: prevParticipant.userId,
                timestamp: Date.now(),
              } as GroupSignalPayload,
            });
            if (wasAloneOrEnding) {
              await prevChannel.send({
                type: 'broadcast',
                event: 'group_voice_signal',
                payload: {
                  type: 'group-call-end',
                  conversationId: prevConversationId,
                  senderId: prevParticipant.userId,
                  timestamp: Date.now(),
                } as GroupSignalPayload,
              });
            }
          }
        } catch {}
        try {
          await prevChannel.untrack();
        } catch {}
        try {
          await prevChannel.unsubscribe();
        } catch {}
        try {
          getSupabase()?.removeChannel(prevChannel);
        } catch {}
      })();
    }
  }

  public dismissEndedScreen(): void {
    this.activeSessionToken++;
    this.hadRemoteParticipantInSession = false;
    if (this.state.conversationId) {
      this.markConversationCallEnded(this.state.conversationId, Date.now());
    }
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
      }, 150);
    }
  }
}

export const groupVoiceCallManager = new GroupVoiceCallManager();
