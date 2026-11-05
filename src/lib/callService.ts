import { RealtimeChannel } from '@supabase/supabase-js';
import {
  PublicUserProfile,
  VoiceCallSignalMessage,
  VoiceCallState,
} from '../types';
import { getSupabase, isSupabaseConfigured } from './supabase';
import { ensureSupabaseAuthSession, getOrCreateRealConversation } from './chatService';
import {
  getOrCreateDeviceIdentityKeyPair,
  fetchRecipientPublicKey,
  deriveConversationKey,
  encryptE2EEMessage,
  decryptE2EEMessage,
} from './cryptoService';
import {
  playIncomingRingTone,
  playOutgoingRingbackTone,
  playCallConnectedTone,
  playCallEndedTone,
  unlockSound,
} from './sounds';

/**
 * Phase 1: Free public STUN servers only (no TURN server or paid services).
 */
export const FREE_STUN_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

const INITIAL_CALL_STATE: VoiceCallState = {
  status: 'idle',
  callId: null,
  conversationId: null,
  isCaller: false,
  peerUser: null,
  isMuted: false,
  isSpeakerOn: false,
  isPeerMuted: false,
  isPeerRinging: false,
  connectedAt: null,
  statusDetail: null,
  errorMessage: null,
  isPrivateChannel: false,
};

type CallStateListener = (state: VoiceCallState) => void;
type RemoteStreamListener = (stream: MediaStream | null) => void;

class OneToOneVoiceCallManager {
  private state: VoiceCallState = { ...INITIAL_CALL_STATE };
  private stateListeners = new Set<CallStateListener>();
  private remoteStreamListeners = new Set<RemoteStreamListener>();

  private verifiedUserId: string | null = null;
  private inboxChannel: RealtimeChannel | null = null;
  private callRoomChannel: RealtimeChannel | null = null;

  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private sharedCryptoKey: CryptoKey | null = null;

  private ringInterval: ReturnType<typeof setInterval> | null = null;
  private inviteResendInterval: ReturnType<typeof setInterval> | null = null;
  private unansweredTimeout: ReturnType<typeof setTimeout> | null = null;
  private iceConnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private disconnectedRecoveryTimeout: ReturnType<typeof setTimeout> | null = null;
  private isHandlingOffer = false;

  constructor() {
    if (typeof window !== 'undefined') {
      const cleanupOnUnload = () => {
        if (this.state.status !== 'idle' && this.state.status !== 'ended') {
          this.endVoiceCall('Call ended because participant left the page.');
        }
      };
      window.addEventListener('beforeunload', cleanupOnUnload);
      window.addEventListener('pagehide', cleanupOnUnload);
    }
  }

  public getState(): VoiceCallState {
    return this.state;
  }

  public getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  public subscribeState(listener: CallStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  public subscribeRemoteStream(listener: RemoteStreamListener): () => void {
    this.remoteStreamListeners.add(listener);
    listener(this.remoteStream);
    return () => {
      this.remoteStreamListeners.delete(listener);
    };
  }

  private updateState(patch: Partial<VoiceCallState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateListeners) {
      try {
        listener(this.state);
      } catch (e) {
        console.warn('[VoiceCall] State listener error:', e);
      }
    }
  }

  private updateRemoteStream(stream: MediaStream | null) {
    this.remoteStream = stream;
    for (const listener of this.remoteStreamListeners) {
      try {
        listener(stream);
      } catch (e) {
        console.warn('[VoiceCall] Stream listener error:', e);
      }
    }
  }

  /**
   * Authenticates the Supabase Realtime client with the current server-verified JWT access token
   * and returns the verified authenticated user ID.
   */
  private async getVerifiedSessionUser(): Promise<{
    userId: string;
    accessToken: string | null;
  } | null> {
    if (!isSupabaseConfigured()) return null;
    const supabase = getSupabase();
    if (!supabase) return null;

    try {
      await ensureSupabaseAuthSession();
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData?.session;

      if (session?.access_token) {
        try {
          await supabase.realtime.setAuth(session.access_token);
        } catch {}
      }

      if (session?.user?.id) {
        return {
          userId: session.user.id,
          accessToken: session.access_token || null,
        };
      }

      const { data: userData } = await supabase.auth.getUser();
      if (userData?.user?.id) {
        return {
          userId: userData.user.id,
          accessToken: session?.access_token || null,
        };
      }
    } catch (e) {
      console.warn('[VoiceCall] Auth verification notice:', e);
    }

    return this.verifiedUserId
      ? { userId: this.verifiedUserId, accessToken: null }
      : null;
  }

  /**
   * Server-side conversation membership and identity verification.
   * Never trusts senderId, conversationId, or user profile metadata supplied only by the client.
   * Queries Supabase `conversations`, `conversation_members`, and `profiles` under RLS.
   */
  private async verifyServerSideOneToOneAuthorization(
    conversationId: string,
    peerUserId: string
  ): Promise<{
    authorized: boolean;
    verifiedLocalUserId?: string;
    verifiedPeerProfile?: PublicUserProfile;
    reason?: string;
  }> {
    if (!conversationId || !peerUserId) {
      return { authorized: false, reason: 'Missing conversation or peer identifier.' };
    }

    const supabase = getSupabase();
    if (!supabase) {
      return { authorized: false, reason: 'Supabase is not configured.' };
    }

    const verifiedSession = await this.getVerifiedSessionUser();
    const localUserId = verifiedSession?.userId || this.verifiedUserId;
    if (!localUserId) {
      return {
        authorized: false,
        reason: 'You must be signed in with a verified session to place or receive calls.',
      };
    }

    if (localUserId === peerUserId) {
      return { authorized: false, reason: 'Cannot start a voice call with yourself.' };
    }

    try {
      // 1. Verify the conversation record on the server (must exist and NOT be a group in Phase 1)
      const { data: convRow, error: convErr } = await supabase
        .from('conversations')
        .select('id, is_group, deleted_at')
        .eq('id', conversationId)
        .maybeSingle();

      if (convErr) {
        return {
          authorized: false,
          reason: 'Unable to verify conversation authorization with Supabase.',
        };
      }

      if (convRow?.is_group) {
        return {
          authorized: false,
          reason: 'Phase 1 supports one-to-one voice calls only. Group calling is disabled.',
        };
      }

      if (convRow?.deleted_at) {
        return {
          authorized: false,
          reason: 'This conversation is no longer active.',
        };
      }

      // 2. Verify conversation membership in public.conversation_members on the server
      const { data: memberRows, error: memberErr } = await supabase
        .from('conversation_members')
        .select('user_id, deleted_at')
        .eq('conversation_id', conversationId);

      let bothMembersVerified = false;
      if (!memberErr && Array.isArray(memberRows) && memberRows.length > 0) {
        const activeMemberIds = new Set(
          memberRows.filter((r: any) => !r.deleted_at).map((r: any) => String(r.user_id))
        );
        if (activeMemberIds.has(localUserId) && activeMemberIds.has(peerUserId)) {
          bothMembersVerified = true;
        }
      }

      // Fallback check in public.messages if conversation_members rows were legacy
      if (!bothMembersVerified) {
        const { data: msgRows } = await supabase
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .or(
            `and(sender_id.eq.${localUserId},receiver_id.eq.${peerUserId}),and(sender_id.eq.${peerUserId},receiver_id.eq.${localUserId})`
          )
          .limit(1);

        if (Array.isArray(msgRows) && msgRows.length > 0) {
          bothMembersVerified = true;
        }
      }

      if (!bothMembersVerified) {
        return {
          authorized: false,
          reason: 'Conversation membership verification failed on the server.',
        };
      }

      // 3. Fetch peer profile directly from public.profiles on the server (never trust client-sent names/avatars)
      const { data: peerProfileRow, error: profErr } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, streak_days')
        .eq('id', peerUserId)
        .maybeSingle();

      if (profErr || !peerProfileRow || !peerProfileRow.username) {
        return {
          authorized: false,
          reason: 'Could not verify caller identity in Supabase profiles.',
        };
      }

      const verifiedPeerProfile: PublicUserProfile = {
        id: peerProfileRow.id,
        username: peerProfileRow.username,
        display_name: peerProfileRow.display_name || peerProfileRow.username,
        avatar_url:
          peerProfileRow.avatar_url ||
          `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(
            peerProfileRow.username
          )}`,
        streak_days: Number(peerProfileRow.streak_days) || 1,
      };

      // 4. Derive optional ECDH shared key from public.user_crypto_keys (RLS: auth.uid() = user_id)
      try {
        const [{ privateKey }, peerPublicKey] = await Promise.all([
          getOrCreateDeviceIdentityKeyPair(localUserId),
          fetchRecipientPublicKey(peerUserId),
        ]);
        if (privateKey && peerPublicKey) {
          this.sharedCryptoKey = await deriveConversationKey(
            privateKey,
            peerPublicKey,
            conversationId
          );
        }
      } catch {
        this.sharedCryptoKey = null;
      }

      return {
        authorized: true,
        verifiedLocalUserId: localUserId,
        verifiedPeerProfile,
      };
    } catch (err: any) {
      return {
        authorized: false,
        reason: err?.message || 'Server authorization check failed.',
      };
    }
  }

  /**
   * Generates an authenticated AES-256-GCM cryptographic proof binding the signal header
   * using the ECDH conversation key (if both peers have published public keys in user_crypto_keys).
   */
  private async attachCryptoProof(
    signal: Omit<VoiceCallSignalMessage, 'cryptoProof'>
  ): Promise<VoiceCallSignalMessage> {
    if (!this.sharedCryptoKey) {
      return signal;
    }
    try {
      const canonical = JSON.stringify({
        callId: signal.callId,
        conversationId: signal.conversationId,
        senderId: signal.senderId,
        targetUserId: signal.targetUserId,
        type: signal.type,
      });
      const encrypted = await encryptE2EEMessage(canonical, this.sharedCryptoKey);
      return {
        ...signal,
        cryptoProof: {
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
        },
      };
    } catch {
      return signal;
    }
  }

  /**
   * Verifies the cryptographic proof attached to an incoming signal when a shared ECDH key exists.
   */
  private async verifySignalCryptoProof(signal: VoiceCallSignalMessage): Promise<boolean> {
    if (!signal.cryptoProof || !this.sharedCryptoKey) {
      return true;
    }
    try {
      const decrypted = await decryptE2EEMessage(
        signal.cryptoProof.ciphertext,
        signal.cryptoProof.iv,
        this.sharedCryptoKey
      );
      if (!decrypted) return false;
      const parsed = JSON.parse(decrypted);
      return (
        parsed.callId === signal.callId &&
        parsed.conversationId === signal.conversationId &&
        parsed.senderId === signal.senderId &&
        parsed.targetUserId === signal.targetUserId &&
        parsed.type === signal.type
      );
    } catch {
      return false;
    }
  }

  /**
   * Helper to subscribe a Supabase Realtime channel with `private: true` first,
   * falling back cleanly if the database has not yet run the `realtime.messages` RLS policy.
   */
  private async subscribeAuthenticatedChannel(
    topic: string,
    onSignal: (msg: VoiceCallSignalMessage) => void
  ): Promise<{ channel: RealtimeChannel; isPrivate: boolean } | null> {
    const supabase = getSupabase();
    if (!supabase) return null;

    await this.getVerifiedSessionUser();

    const trySubscribe = (usePrivate: boolean): Promise<RealtimeChannel | null> => {
      return new Promise((resolve) => {
        let settled = false;
        const ch = supabase.channel(topic, {
          config: {
            private: usePrivate,
            broadcast: { self: false, ack: true },
          },
        });

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try {
              ch.unsubscribe();
              supabase.removeChannel(ch);
            } catch {}
            resolve(null);
          }
        }, 4500);

        ch.on('broadcast', { event: 'voice_call_signal' }, (payload) => {
          const msg = payload?.payload as VoiceCallSignalMessage | undefined;
          if (msg && msg.type && msg.senderId && msg.conversationId) {
            onSignal(msg);
          }
        }).subscribe((status: string) => {
          if (settled) return;
          if (status === 'SUBSCRIBED') {
            settled = true;
            clearTimeout(timer);
            resolve(ch);
          } else if (
            status === 'CHANNEL_ERROR' ||
            status === 'TIMED_OUT' ||
            status === 'CLOSED'
          ) {
            settled = true;
            clearTimeout(timer);
            try {
              ch.unsubscribe();
              supabase.removeChannel(ch);
            } catch {}
            resolve(null);
          }
        });
      });
    };

    // 1. Try authenticated private channel first (enforces realtime.messages RLS when configured)
    const privateCh = await trySubscribe(true);
    if (privateCh) {
      return { channel: privateCh, isPrivate: true };
    }

    // 2. Fallback to authenticated channel if realtime.messages RLS SQL was not yet run
    const fallbackCh = await trySubscribe(false);
    if (fallbackCh) {
      return { channel: fallbackCh, isPrivate: false };
    }

    return null;
  }

  /**
   * Initializes the signed-in user's global incoming call inbox listener (`spark_call_inbox_<userId>`).
   */
  public async initIncomingCallListener(userId: string): Promise<void> {
    if (!userId || !isSupabaseConfigured()) return;
    if (this.verifiedUserId === userId && this.inboxChannel) return;

    this.cleanupInboxChannel();
    this.verifiedUserId = userId;

    const inboxTopic = `spark_call_inbox_${userId}`;
    const result = await this.subscribeAuthenticatedChannel(inboxTopic, (msg) => {
      this.handleIncomingSignal(msg).catch((e) =>
        console.warn('[VoiceCall] Error handling inbox signal:', e)
      );
    });

    if (result) {
      this.inboxChannel = result.channel;
    }
  }

  public cleanupInboxChannel(): void {
    const supabase = getSupabase();
    if (this.inboxChannel) {
      try {
        this.inboxChannel.unsubscribe();
        supabase?.removeChannel(this.inboxChannel);
      } catch {}
      this.inboxChannel = null;
    }
  }

  private async sendSignalOnChannel(
    channel: RealtimeChannel | null,
    rawSignal: Omit<VoiceCallSignalMessage, 'cryptoProof'>
  ): Promise<void> {
    if (!channel) return;
    const signedSignal = await this.attachCryptoProof(rawSignal);
    try {
      await channel.send({
        type: 'broadcast',
        event: 'voice_call_signal',
        payload: signedSignal,
      });
    } catch (e) {
      console.warn('[VoiceCall] Signal send notice:', e);
    }
  }

  /**
   * Sends a one-shot invite packet to the target user's inbox channel (`spark_call_inbox_<targetUserId>`).
   */
  private async sendInviteToPeerInbox(
    targetUserId: string,
    rawSignal: Omit<VoiceCallSignalMessage, 'cryptoProof'>
  ): Promise<void> {
    const supabase = getSupabase();
    if (!supabase) return;

    const inboxTopic = `spark_call_inbox_${targetUserId}`;
    const sub = await this.subscribeAuthenticatedChannel(inboxTopic, () => {});
    if (!sub) return;

    try {
      await this.sendSignalOnChannel(sub.channel, rawSignal);
    } finally {
      setTimeout(() => {
        try {
          sub.channel.unsubscribe();
          supabase.removeChannel(sub.channel);
        } catch {}
      }, 400);
    }
  }

  /**
   * Starts a 1-to-1 outgoing voice call to `targetUserId` in `conversationId`.
   */
  public async startOneToOneVoiceCall(
    conversationId: string,
    targetUserId: string
  ): Promise<{ success: boolean; error?: string }> {
    unlockSound();

    if (this.state.status !== 'idle' && this.state.status !== 'ended') {
      return { success: false, error: 'You are already in an active call.' };
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

    const sessionInfo = await this.getVerifiedSessionUser();
    const callerId = sessionInfo?.userId || this.verifiedUserId;
    if (!callerId) {
      return {
        success: false,
        error: 'Authentication required. Please sign in again.',
      };
    }

    // Ensure the 1-to-1 conversation record and membership exist on the server before calling
    let resolvedConvId = conversationId;
    try {
      resolvedConvId = await getOrCreateRealConversation(callerId, targetUserId);
    } catch {}

    // 1. Server-side conversation membership & identity check
    const authCheck = await this.verifyServerSideOneToOneAuthorization(
      resolvedConvId,
      targetUserId
    );
    if (!authCheck.authorized || !authCheck.verifiedPeerProfile) {
      const errMsg = authCheck.reason || 'Call authorization failed.';
      this.updateState({
        ...INITIAL_CALL_STATE,
        status: 'ended',
        errorMessage: errMsg,
        statusDetail: 'Authorization failed',
      });
      return { success: false, error: errMsg };
    }

    // 2. Request microphone access before ringing the remote user
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
          ? 'Microphone permission was denied. Please allow microphone access in Chrome site settings to make voice calls.'
          : `Could not access microphone: ${micErr?.message || 'Hardware unavailable'}`;
      this.updateState({
        ...INITIAL_CALL_STATE,
        status: 'ended',
         peerUser: authCheck.verifiedPeerProfile,
        errorMessage: msg,
        statusDetail: 'Microphone unavailable',
      });
      return { success: false, error: msg };
    }

    this.localStream = micStream;
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    this.updateState({
      status: 'outgoing',
      callId,
      conversationId: resolvedConvId,
      isCaller: true,
      peerUser: authCheck.verifiedPeerProfile,
      isMuted: false,
      isSpeakerOn: false,
      isPeerMuted: false,
      isPeerRinging: false,
      connectedAt: null,
      statusDetail: 'Calling...',
      errorMessage: null,
      isPrivateChannel: false,
    });

    // 3. Join the per-conversation 1-to-1 call room channel
    const roomTopic = `spark_call_1on1_${resolvedConvId}`;
    const roomSub = await this.subscribeAuthenticatedChannel(roomTopic, (msg) => {
      this.handleIncomingSignal(msg).catch((e) =>
        console.warn('[VoiceCall] Room signal error:', e)
      );
    });

    if (!roomSub) {
      this.releaseMediaAndConnections();
      const errMsg = 'Could not connect to Supabase Realtime signaling channel.';
      this.updateState({
        status: 'ended',
        errorMessage: errMsg,
        statusDetail: 'Signaling failed',
      });
      return { success: false, error: errMsg };
    }

    this.callRoomChannel = roomSub.channel;
    this.updateState({ isPrivateChannel: roomSub.isPrivate });

    // 4. Start outgoing ringback tone & broadcast call-invite
    this.startRingLoop('outgoing');

    const invitePayload: Omit<VoiceCallSignalMessage, 'cryptoProof'> = {
      callId,
      conversationId: resolvedConvId,
      senderId: callerId,
      targetUserId,
      type: 'call-invite',
      timestamp: new Date().toISOString(),
    };

    await Promise.all([
      this.sendSignalOnChannel(this.callRoomChannel, invitePayload),
      this.sendInviteToPeerInbox(targetUserId, invitePayload),
    ]);

    // Repeat invite every 3.5s while ringing in case recipient just opened the app
    this.inviteResendInterval = setInterval(() => {
      if (this.state.status === 'outgoing' && this.state.callId === callId) {
        const repeatInvite: Omit<VoiceCallSignalMessage, 'cryptoProof'> = {
          ...invitePayload,
          timestamp: new Date().toISOString(),
        };
        this.sendSignalOnChannel(this.callRoomChannel, repeatInvite).catch(() => {});
        this.sendInviteToPeerInbox(targetUserId, repeatInvite).catch(() => {});
      }
    }, 3500);

    // 45-second unanswered timeout
    this.unansweredTimeout = setTimeout(() => {
      if (this.state.status === 'outgoing' && this.state.callId === callId) {
        this.endVoiceCall('No answer. The recipient may be offline or unavailable.');
      }
    }, 45000);

    return { success: true };
  }

  /**
   * Handles incoming signaling messages from either `spark_call_inbox_<userId>` or `spark_call_1on1_<conversationId>`.
   */
  private async handleIncomingSignal(msg: VoiceCallSignalMessage): Promise<void> {
    const sessionInfo = await this.getVerifiedSessionUser();
    const myUserId = sessionInfo?.userId || this.verifiedUserId;
    if (!myUserId) return;

    // Ignore signals sent by ourselves or targeted at another user
    if (msg.senderId === myUserId) return;
    if (msg.targetUserId && msg.targetUserId !== myUserId) return;

    // Case 1: New incoming call invite
    if (msg.type === 'call-invite') {
      // Ignore duplicate invite for the exact same call we're already handling
      if (
        this.state.callId === msg.callId &&
        (this.state.status === 'incoming' ||
          this.state.status === 'connecting' ||
          this.state.status === 'connected')
      ) {
        return;
      }

      // If already in another call, notify caller that we are busy
      if (this.state.status !== 'idle' && this.state.status !== 'ended') {
        const roomSub = await this.subscribeAuthenticatedChannel(
          `spark_call_1on1_${msg.conversationId}`,
          () => {}
        );
        if (roomSub) {
          await this.sendSignalOnChannel(roomSub.channel, {
            callId: msg.callId,
            conversationId: msg.conversationId,
            senderId: myUserId,
            targetUserId: msg.senderId,
            type: 'call-busy',
            timestamp: new Date().toISOString(),
          });
          setTimeout(() => {
            try {
              roomSub.channel.unsubscribe();
              getSupabase()?.removeChannel(roomSub.channel);
            } catch {}
          }, 400);
        }
        return;
      }

      // Server-side verification of conversation membership & caller profile
      const authCheck = await this.verifyServerSideOneToOneAuthorization(
        msg.conversationId,
        msg.senderId
      );
      if (!authCheck.authorized || !authCheck.verifiedPeerProfile) {
        console.warn(
          '[VoiceCall] Rejected unauthorized incoming call signal:',
          authCheck.reason
        );
        return;
      }

      // Verify cryptographic proof if present
      const proofValid = await this.verifySignalCryptoProof(msg);
      if (!proofValid) {
        console.warn('[VoiceCall] Rejected incoming call signal with invalid crypto proof.');
        return;
      }

      // Subscribe to the conversation's 1-to-1 call room channel
      const roomTopic = `spark_call_1on1_${msg.conversationId}`;
      const roomSub = await this.subscribeAuthenticatedChannel(roomTopic, (roomMsg) => {
        this.handleIncomingSignal(roomMsg).catch((e) =>
          console.warn('[VoiceCall] Room signal error:', e)
        );
      });

      if (!roomSub) return;

      this.callRoomChannel = roomSub.channel;
      this.pendingIceCandidates = [];

      this.updateState({
        status: 'incoming',
        callId: msg.callId,
        conversationId: msg.conversationId,
        isCaller: false,
        peerUser: authCheck.verifiedPeerProfile,
        isMuted: false,
        isSpeakerOn: false,
        isPeerMuted: false,
        isPeerRinging: true,
        connectedAt: null,
        statusDetail: 'Incoming Voice Call...',
        errorMessage: null,
        isPrivateChannel: roomSub.isPrivate,
      });

      this.startRingLoop('incoming');

      // Acknowledge ringing to caller
      await this.sendSignalOnChannel(this.callRoomChannel, {
        callId: msg.callId,
        conversationId: msg.conversationId,
        senderId: myUserId,
        targetUserId: msg.senderId,
        type: 'call-ringing',
        timestamp: new Date().toISOString(),
      });

      // Auto-dismiss incoming call if not answered within 45s
      this.clearTimers(['unanswered']);
      this.unansweredTimeout = setTimeout(() => {
        if (this.state.status === 'incoming' && this.state.callId === msg.callId) {
          this.endVoiceCall('Missed voice call.');
        }
      }, 45000);

      return;
    }

    // For all subsequent call signals, verify that they match the active callId, conversationId, and verified peerUser
    if (
      !this.state.callId ||
      msg.callId !== this.state.callId ||
      msg.conversationId !== this.state.conversationId ||
      !this.state.peerUser ||
      msg.senderId !== this.state.peerUser.id
    ) {
      return;
    }

    const proofOk = await this.verifySignalCryptoProof(msg);
    if (!proofOk) {
      console.warn('[VoiceCall] Dropped signal failing cryptographic proof:', msg.type);
      return;
    }

    switch (msg.type) {
      case 'call-ringing': {
        if (this.state.status === 'outgoing') {
          this.updateState({
            isPeerRinging: true,
            statusDetail: 'Ringing...',
          });
        }
        break;
      }

      case 'call-busy': {
        this.endVoiceCall(
          `${this.state.peerUser.display_name || this.state.peerUser.username} is busy in another call.`,
          false
        );
        break;
      }

      case 'call-reject': {
        this.endVoiceCall(
          `${this.state.peerUser.display_name || this.state.peerUser.username} declined the call.`,
          false
        );
        break;
      }

      case 'call-end': {
        this.endVoiceCall(msg.reason || 'Call ended.', false);
        break;
      }

      case 'peer-mute': {
        this.updateState({
          isPeerMuted: Boolean(msg.isMuted),
        });
        break;
      }

      case 'call-accept': {
        if (this.state.isCaller && this.state.status === 'outgoing') {
          this.stopRingLoop();
          this.clearTimers(['invite', 'unanswered']);
          this.updateState({
            status: 'connecting',
            statusDetail: 'Connecting P2P audio (STUN)...',
          });
          await this.createAndSendOffer(myUserId);
        }
        break;
      }

      case 'webrtc-offer': {
        if (!msg.sdp || this.isHandlingOffer) return;
        this.isHandlingOffer = true;
        try {
          if (!this.peerConnection) {
            this.createPeerConnection(myUserId);
          }
          const pc = this.peerConnection;
          if (!pc) return;

          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          await this.flushPendingIceCandidates();

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          if (this.state.callId && this.state.conversationId && this.state.peerUser) {
            await this.sendSignalOnChannel(this.callRoomChannel, {
              callId: this.state.callId,
              conversationId: this.state.conversationId,
              senderId: myUserId,
              targetUserId: this.state.peerUser.id,
              type: 'webrtc-answer',
              sdp: pc.localDescription || answer,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (err: any) {
          console.error('[VoiceCall] Error handling WebRTC offer:', err);
          this.endVoiceCall('Failed to negotiate WebRTC audio parameters.');
        } finally {
          this.isHandlingOffer = false;
        }
        break;
      }

      case 'webrtc-answer': {
        if (!msg.sdp || !this.peerConnection) return;
        try {
          if (this.peerConnection.signalingState === 'have-local-offer') {
            await this.peerConnection.setRemoteDescription(
              new RTCSessionDescription(msg.sdp)
            );
            await this.flushPendingIceCandidates();
          }
        } catch (err) {
          console.error('[VoiceCall] Error setting remote answer:', err);
        }
        break;
      }

      case 'webrtc-ice': {
        if (!msg.candidate) return;
        try {
          if (this.peerConnection && this.peerConnection.remoteDescription) {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } else {
            this.pendingIceCandidates.push(msg.candidate);
          }
        } catch (err) {
          console.warn('[VoiceCall] Non-fatal ICE candidate error:', err);
        }
        break;
      }
    }
  }

  /**
   * Accepts an incoming 1-to-1 voice call.
   */
  public async acceptIncomingCall(): Promise<{ success: boolean; error?: string }> {
    unlockSound();

    if (
      this.state.status !== 'incoming' ||
      !this.state.callId ||
      !this.state.conversationId ||
      !this.state.peerUser
    ) {
      return { success: false, error: 'No active incoming call to accept.' };
    }

    this.stopRingLoop();
    this.clearTimers(['unanswered']);

    const sessionInfo = await this.getVerifiedSessionUser();
    const myUserId = sessionInfo?.userId || this.verifiedUserId;
    if (!myUserId) {
      this.endVoiceCall('Session expired. Please sign in again.');
      return { success: false, error: 'Session expired.' };
    }

    // Request microphone access
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      this.localStream = micStream;
    } catch (micErr: any) {
      const errMsg =
        micErr?.name === 'NotAllowedError' || micErr?.name === 'PermissionDeniedError'
          ? 'Microphone permission denied. Please enable microphone access in Chrome settings.'
          : `Could not access microphone: ${micErr?.message || 'Hardware error'}`;
      await this.rejectIncomingCall(errMsg);
      return { success: false, error: errMsg };
    }

    this.updateState({
      status: 'connecting',
      statusDetail: 'Connecting P2P audio (STUN)...',
      errorMessage: null,
    });

    this.createPeerConnection(myUserId);
    this.startIceWatchdog();

    await this.sendSignalOnChannel(this.callRoomChannel, {
      callId: this.state.callId,
      conversationId: this.state.conversationId,
      senderId: myUserId,
      targetUserId: this.state.peerUser.id,
      type: 'call-accept',
      timestamp: new Date().toISOString(),
    });

    return { success: true };
  }

  /**
   * Rejects an incoming 1-to-1 voice call.
   */
  public async rejectIncomingCall(customError?: string): Promise<void> {
    this.stopRingLoop();
    const sessionInfo = await this.getVerifiedSessionUser();
    const myUserId = sessionInfo?.userId || this.verifiedUserId;

    if (
      myUserId &&
      this.callRoomChannel &&
      this.state.callId &&
      this.state.conversationId &&
      this.state.peerUser
    ) {
      await this.sendSignalOnChannel(this.callRoomChannel, {
        callId: this.state.callId,
        conversationId: this.state.conversationId,
        senderId: myUserId,
        targetUserId: this.state.peerUser.id,
        type: 'call-reject',
        timestamp: new Date().toISOString(),
      });
    }

    this.releaseMediaAndConnections();
    if (customError) {
      this.updateState({
        status: 'ended',
        errorMessage: customError,
        statusDetail: 'Call failed',
      });
    } else {
      this.updateState({ ...INITIAL_CALL_STATE });
    }
  }

  /**
   * Creates the native RTCPeerConnection configured with free Google STUN servers,
   * attaches local microphone audio tracks, and wires ICE & connection state handlers.
   */
  private createPeerConnection(myUserId: string): RTCPeerConnection {
    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch {}
    }

    const pc = new RTCPeerConnection({
      iceServers: FREE_STUN_ICE_SERVERS,
      iceCandidatePoolSize: 4,
    });

    this.peerConnection = pc;

    // Attach local microphone tracks
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        track.enabled = !this.state.isMuted;
        pc.addTrack(track, this.localStream);
      }
    }

    // Handle remote audio tracks
    pc.ontrack = (event: RTCTrackEvent) => {
      if (event.streams && event.streams[0]) {
        this.updateRemoteStream(event.streams[0]);
      } else if (event.track) {
        const inboundStream = new MediaStream([event.track]);
        this.updateRemoteStream(inboundStream);
      }
    };

    // Trickle ICE candidates over authenticated Supabase Realtime channel
    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (
        event.candidate &&
        this.callRoomChannel &&
        this.state.callId &&
        this.state.conversationId &&
        this.state.peerUser
      ) {
        this.sendSignalOnChannel(this.callRoomChannel, {
          callId: this.state.callId,
          conversationId: this.state.conversationId,
          senderId: myUserId,
          targetUserId: this.state.peerUser.id,
          type: 'webrtc-ice',
          candidate: event.candidate.toJSON(),
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }
    };

    const handleConnectionStateEvaluation = () => {
      if (!this.peerConnection) return;
      const iceState = this.peerConnection.iceConnectionState;
      const connState = this.peerConnection.connectionState;

      if (
        iceState === 'connected' ||
        iceState === 'completed' ||
        connState === 'connected'
      ) {
        this.clearTimers(['iceWatchdog', 'disconnectedRecovery']);
        if (this.state.status !== 'connected') {
          playCallConnectedTone();
          this.updateState({
            status: 'connected',
            connectedAt: this.state.connectedAt || Date.now(),
            statusDetail: 'Voice Connected (P2P STUN)',
            errorMessage: null,
          });
        } else {
          this.updateState({
            statusDetail: 'Voice Connected (P2P STUN)',
          });
        }
      } else if (iceState === 'disconnected') {
        this.updateState({
          statusDetail: 'Network unstable — reconnecting audio...',
        });
        if (!this.disconnectedRecoveryTimeout) {
          this.disconnectedRecoveryTimeout = setTimeout(() => {
            if (
              this.peerConnection &&
              this.peerConnection.iceConnectionState === 'disconnected'
            ) {
              if (this.state.isCaller) {
                this.createAndSendOffer(myUserId, true).catch(() => {});
              }
            }
          }, 3500);
        }
      } else if (iceState === 'failed' || connState === 'failed') {
        this.endVoiceCall(
          'Direct P2P audio connection failed. One or both mobile networks appear to use strict Symmetric NAT / Carrier Firewall, which blocks STUN-only direct connections without a TURN relay server.'
        );
      }
    };

    pc.oniceconnectionstatechange = handleConnectionStateEvaluation;
    pc.onconnectionstatechange = handleConnectionStateEvaluation;

    return pc;
  }

  private async createAndSendOffer(
    myUserId: string,
    iceRestart = false
  ): Promise<void> {
    const pc = this.peerConnection || this.createPeerConnection(myUserId);
    this.startIceWatchdog();

    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
        iceRestart,
      });
      await pc.setLocalDescription(offer);

      if (this.state.callId && this.state.conversationId && this.state.peerUser) {
        await this.sendSignalOnChannel(this.callRoomChannel, {
          callId: this.state.callId,
          conversationId: this.state.conversationId,
          senderId: myUserId,
          targetUserId: this.state.peerUser.id,
          type: 'webrtc-offer',
          sdp: pc.localDescription || offer,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      console.error('[VoiceCall] Offer creation failed:', err);
      this.endVoiceCall('Failed to start WebRTC audio negotiation.');
    }
  }

  private async flushPendingIceCandidates(): Promise<void> {
    if (!this.peerConnection || !this.peerConnection.remoteDescription) return;
    const queued = [...this.pendingIceCandidates];
    this.pendingIceCandidates = [];
    for (const candidate of queued) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('[VoiceCall] Queued ICE candidate notice:', e);
      }
    }
  }

  private startIceWatchdog(): void {
    this.clearTimers(['iceWatchdog']);
    this.iceConnectTimeout = setTimeout(() => {
      if (this.state.status === 'connecting') {
        this.endVoiceCall(
          'Timed out establishing direct P2P audio (STUN). Different mobile networks behind Symmetric NAT / CGNAT require a TURN relay server when direct UDP hole-punching is blocked.'
        );
      }
    }, 20000);
  }

  /**
   * Toggles microphone mute state and notifies the remote peer.
   */
  public async toggleMute(): Promise<boolean> {
    const nextMuted = !this.state.isMuted;
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        track.enabled = !nextMuted;
      }
    }
    this.updateState({ isMuted: nextMuted });

    const sessionInfo = await this.getVerifiedSessionUser();
    const myUserId = sessionInfo?.userId || this.verifiedUserId;
    if (
      myUserId &&
      this.callRoomChannel &&
      this.state.callId &&
      this.state.conversationId &&
      this.state.peerUser
    ) {
      await this.sendSignalOnChannel(this.callRoomChannel, {
        callId: this.state.callId,
        conversationId: this.state.conversationId,
        senderId: myUserId,
        targetUserId: this.state.peerUser.id,
        type: 'peer-mute',
        isMuted: nextMuted,
        timestamp: new Date().toISOString(),
      });
    }

    return nextMuted;
  }

  /**
   * Toggles speaker / boosted audio output mode.
   */
  public toggleSpeaker(): boolean {
    const nextSpeaker = !this.state.isSpeakerOn;
    this.updateState({ isSpeakerOn: nextSpeaker });
    return nextSpeaker;
  }

  /**
   * Ends the current call, sends `call-end` if requested, stops all microphone tracks,
   * closes the RTCPeerConnection, and cleans up the Realtime room channel.
   */
  public async endVoiceCall(reason = 'Call ended.', notifyPeer = true): Promise<void> {
    this.stopRingLoop();
    playCallEndedTone();

    const activeCallId = this.state.callId;
    const activeConvId = this.state.conversationId;
    const activePeer = this.state.peerUser;
    const roomCh = this.callRoomChannel;

    if (notifyPeer && roomCh && activeCallId && activeConvId && activePeer) {
      const sessionInfo = await this.getVerifiedSessionUser();
      const myUserId = sessionInfo?.userId || this.verifiedUserId;
      if (myUserId) {
        await this.sendSignalOnChannel(roomCh, {
          callId: activeCallId,
          conversationId: activeConvId,
          senderId: myUserId,
          targetUserId: activePeer.id,
          type: 'call-end',
          reason: 'Call ended.',
          timestamp: new Date().toISOString(),
        });
      }
    }

    this.releaseMediaAndConnections();

    const isErrorReason =
      reason.toLowerCase().includes('failed') ||
      reason.toLowerCase().includes('timed out') ||
      reason.toLowerCase().includes('symmetric nat') ||
      reason.toLowerCase().includes('denied') ||
      reason.toLowerCase().includes('busy') ||
      reason.toLowerCase().includes('declined') ||
      reason.toLowerCase().includes('no answer') ||
      reason.toLowerCase().includes('missed');

    if (isErrorReason && activePeer) {
      this.updateState({
        status: 'ended',
        statusDetail: reason,
        errorMessage: reason,
      });
    } else {
      this.updateState({ ...INITIAL_CALL_STATE });
    }
  }

  /**
   * Dismisses the 'ended' summary screen and resets call state to 'idle'.
   */
  public dismissEndedCallScreen(): void {
    this.releaseMediaAndConnections();
    this.updateState({ ...INITIAL_CALL_STATE });
  }

  /**
   * Stops all local & remote media tracks, closes RTCPeerConnection, and removes the call room channel.
   */
  public releaseMediaAndConnections(): void {
    this.stopRingLoop();
    this.clearTimers(['invite', 'unanswered', 'iceWatchdog', 'disconnectedRecovery']);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        try {
          track.stop();
        } catch {}
      }
      this.localStream = null;
    }

    if (this.remoteStream) {
      for (const track of this.remoteStream.getTracks()) {
        try {
          track.stop();
        } catch {}
      }
      this.updateRemoteStream(null);
    }

    if (this.peerConnection) {
      try {
        this.peerConnection.ontrack = null;
        this.peerConnection.onicecandidate = null;
        this.peerConnection.oniceconnectionstatechange = null;
        this.peerConnection.onconnectionstatechange = null;
        this.peerConnection.close();
      } catch {}
      this.peerConnection = null;
    }

    this.pendingIceCandidates = [];
    this.sharedCryptoKey = null;
    this.isHandlingOffer = false;

    if (this.callRoomChannel) {
      const ch = this.callRoomChannel;
      this.callRoomChannel = null;
      setTimeout(() => {
        try {
          ch.unsubscribe();
          getSupabase()?.removeChannel(ch);
        } catch {}
      }, 250);
    }
  }

  private startRingLoop(mode: 'incoming' | 'outgoing'): void {
    this.stopRingLoop();
    const playFn = mode === 'incoming' ? playIncomingRingTone : playOutgoingRingbackTone;
    playFn();
    this.ringInterval = setInterval(playFn, 2400);
  }

  private stopRingLoop(): void {
    if (this.ringInterval) {
      clearInterval(this.ringInterval);
      this.ringInterval = null;
    }
  }

  private clearTimers(
    which: Array<'invite' | 'unanswered' | 'iceWatchdog' | 'disconnectedRecovery'>
  ): void {
    if (which.includes('invite') && this.inviteResendInterval) {
      clearInterval(this.inviteResendInterval);
      this.inviteResendInterval = null;
    }
    if (which.includes('unanswered') && this.unansweredTimeout) {
      clearTimeout(this.unansweredTimeout);
      this.unansweredTimeout = null;
    }
    if (which.includes('iceWatchdog') && this.iceConnectTimeout) {
      clearTimeout(this.iceConnectTimeout);
      this.iceConnectTimeout = null;
    }
    if (which.includes('disconnectedRecovery') && this.disconnectedRecoveryTimeout) {
      clearTimeout(this.disconnectedRecoveryTimeout);
      this.disconnectedRecoveryTimeout = null;
    }
  }
}

export const voiceCallManager = new OneToOneVoiceCallManager();
