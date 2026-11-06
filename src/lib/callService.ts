import { RealtimeChannel } from '@supabase/supabase-js';
import {
  PublicUserProfile,
  PublishedUserCryptoKeyBundle,
  VoiceCallSignalMessage,
  VoiceCallSignalType,
  VoiceCallState,
  VoiceCallStatus,
} from '../types';
import { getSupabase, isSupabaseConfigured } from './supabase';
import { ensureSupabaseAuthSession, getOrCreateRealConversation } from './chatService';
import {
  getOrCreateDeviceIdentityKeyPair,
  syncPublicKeyToSupabase,
  fetchAndVerifyPeerKeyBundle,
  approvePeerKeyRotation,
  deriveDirectionalCallSignalKey,
  signCallSignalCanonical,
  verifyCallSignalSignature,
  encryptE2EEMessage,
  decryptE2EEMessage,
  bufferToBase64,
} from './cryptoService';
import {
  playIncomingRingTone,
  playOutgoingRingbackTone,
  playCallConnectedTone,
  playCallEndedTone,
  stopRingTonePlayback,
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

export const SIGNAL_MAX_AGE_MS = 60_000;
const MAX_REPLAY_CACHE_SIZE = 2000;
export const CALL_CRYPTO_PROOF_VERSION = 'ecdsa_p256_hkdf_aes256gcm_v2';

export interface CallCryptoSessionBundle {
  localUserId: string;
  peerUserId: string;
  conversationId: string;
  outboundAesKey: CryptoKey;
  inboundAesKey: CryptoKey;
  localSigningPrivateKey: CryptoKey;
  peerVerifyPublicKey: CryptoKey;
  localEcdsaFingerprint: string;
  peerEcdsaFingerprint: string;
  localKeyRotationVersion: number;
  peerKeyRotationVersion: number;
}

export interface ConversationMembershipInspectionInput {
  conversation: {
    id: string;
    is_group?: boolean | null;
    deleted_at?: string | null;
  } | null;
  members: Array<{
    user_id?: string | null;
    deleted_at?: string | null;
  }> | null;
  localUserId: string;
  expectedPeerId?: string;
}

/**
 * Pure validator for 1-to-1 conversation membership.
 * Enforces:
 * 1. Conversation exists, is NOT a group (`is_group === false`), and is NOT deleted (`deleted_at == null`).
 * 2. Exactly 2 active (`deleted_at == null`) distinct members exist.
 * 3. One active member is `localUserId` and the other is `peerUserId` (`peerUserId !== localUserId`).
 * 4. If `expectedPeerId` is provided, it must match the server-derived `peerUserId`.
 */
export function validateOneToOneConversationMembership(
  input: ConversationMembershipInspectionInput
): {
  valid: boolean;
  verifiedConversationId?: string;
  verifiedPeerUserId?: string;
  reason?: string;
} {
  const { conversation, members, localUserId, expectedPeerId } = input;
  if (!localUserId || typeof localUserId !== 'string') {
    return { valid: false, reason: 'Missing authenticated local user ID.' };
  }
  if (!conversation || !conversation.id) {
    return {
      valid: false,
      reason: 'Conversation does not exist or access was denied by server RLS.',
    };
  }
  if (Boolean(conversation.is_group)) {
    return {
      valid: false,
      reason: 'Phase 1 supports one-to-one voice calls only. Group calling is disabled.',
    };
  }
  if (conversation.deleted_at) {
    return {
      valid: false,
      reason: 'This conversation has been deleted.',
    };
  }
  if (!Array.isArray(members)) {
    return {
      valid: false,
      reason: 'Failed to verify conversation membership on the server.',
    };
  }

  const activeMemberRows = members.filter(
    (m) => m && !m.deleted_at && typeof m.user_id === 'string' && m.user_id.trim().length > 0
  );
  const distinctActiveIds = Array.from(
    new Set(activeMemberRows.map((m) => String(m.user_id).trim()))
  );

  if (
    activeMemberRows.length !== 2 ||
    distinctActiveIds.length !== 2 ||
    !distinctActiveIds.includes(localUserId)
  ) {
    return {
      valid: false,
      reason:
        'Unauthorized: Conversation must have exactly two active members including the authenticated user.',
    };
  }

  const derivedPeerId = distinctActiveIds.find((id) => id !== localUserId);
  if (!derivedPeerId || derivedPeerId === localUserId) {
    return {
      valid: false,
      reason: 'Invalid 1-to-1 conversation membership on the server.',
    };
  }

  if (expectedPeerId && expectedPeerId !== derivedPeerId) {
    return {
      valid: false,
      reason: 'Peer identity mismatch against server conversation membership.',
    };
  }

  return {
    valid: true,
    verifiedConversationId: conversation.id,
    verifiedPeerUserId: derivedPeerId,
  };
}

/**
 * Generates a cryptographically unique signal identifier for replay protection.
 */
export function generateUniqueSignalId(): string {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
    return `sig_${globalThis.crypto.randomUUID()}`;
  }
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return `sig_${bufferToBase64(bytes)}`;
  }
  throw new Error('Cryptographically secure random generator is unavailable.');
}

/**
 * Deterministically serializes the entire voice call signal (including SDP, ICE candidate,
 * mute status, reason, signalId, callId, conversationId, senderId, targetUserId, type, timestamp,
 * senderEcdsaFingerprint, and keyRotationVersion) so that every field is bound to both the sender's
 * dedicated ECDSA P-256 signature and directional AES-256-GCM ciphertext.
 */
export function serializeCanonicalCallSignal(
  signal: Omit<VoiceCallSignalMessage, 'cryptoProof'>,
  senderEcdsaFingerprint: string,
  keyRotationVersion: number
): string {
  return JSON.stringify({
    v: CALL_CRYPTO_PROOF_VERSION,
    signalId: signal.signalId,
    callId: signal.callId,
    conversationId: signal.conversationId,
    senderId: signal.senderId,
    targetUserId: signal.targetUserId,
    type: signal.type,
    timestamp: signal.timestamp,
    senderEcdsaFingerprint,
    keyRotationVersion,
    sdp: signal.sdp
      ? {
          type: signal.sdp.type ?? null,
          sdp: signal.sdp.sdp ?? null,
        }
      : null,
    candidate: signal.candidate
      ? {
          candidate: signal.candidate.candidate ?? null,
          sdpMid: signal.candidate.sdpMid ?? null,
          sdpMLineIndex: signal.candidate.sdpMLineIndex ?? null,
          usernameFragment: signal.candidate.usernameFragment ?? null,
        }
      : null,
    isMuted: typeof signal.isMuted === 'boolean' ? signal.isMuted : null,
    reason: typeof signal.reason === 'string' ? signal.reason : null,
  });
}

/**
 * Creates a non-impersonable cryptographic proof for a voice call signal:
 * 1. Signs the canonical payload (covering all metadata + SDP/ICE + key fingerprint/version)
 *    with the sender's dedicated ECDSA P-256 private key (`extractable: false`).
 * 2. Encrypts the canonical payload with the directional HKDF AES-256-GCM key (`senderId -> targetUserId`).
 */
export async function createSignedEncryptedSignal(
  rawSignal: Omit<VoiceCallSignalMessage, 'cryptoProof'>,
  cryptoBundle: CallCryptoSessionBundle | null
): Promise<VoiceCallSignalMessage | null> {
  if (!cryptoBundle) {
    return null;
  }
  if (
    !rawSignal.signalId ||
    !rawSignal.callId ||
    !rawSignal.conversationId ||
    !rawSignal.senderId ||
    !rawSignal.targetUserId ||
    rawSignal.senderId === rawSignal.targetUserId ||
    rawSignal.senderId !== cryptoBundle.localUserId ||
    rawSignal.targetUserId !== cryptoBundle.peerUserId ||
    rawSignal.conversationId !== cryptoBundle.conversationId ||
    !cryptoBundle.localEcdsaFingerprint ||
    cryptoBundle.localKeyRotationVersion < 1
  ) {
    return null;
  }

  try {
    const canonical = serializeCanonicalCallSignal(
      rawSignal,
      cryptoBundle.localEcdsaFingerprint,
      cryptoBundle.localKeyRotationVersion
    );
    const [signature, encrypted] = await Promise.all([
      signCallSignalCanonical(canonical, cryptoBundle.localSigningPrivateKey),
      encryptE2EEMessage(canonical, cryptoBundle.outboundAesKey),
    ]);

    if (!signature || !encrypted?.ciphertext || !encrypted?.iv) {
      return null;
    }

    return {
      ...rawSignal,
      cryptoProof: {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        signature,
        version: CALL_CRYPTO_PROOF_VERSION,
        senderEcdsaFingerprint: cryptoBundle.localEcdsaFingerprint,
        keyRotationVersion: cryptoBundle.localKeyRotationVersion,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Verifies an incoming voice call signal's pinned key fingerprint/version, timestamp freshness,
 * directional AES-256-GCM encryption, canonical payload integrity, and dedicated ECDSA P-256 signature.
 */
export async function verifySignedEncryptedSignal(
  signal: VoiceCallSignalMessage,
  expectedConversationId: string,
  expectedSenderId: string,
  expectedTargetUserId: string,
  cryptoBundle: CallCryptoSessionBundle | null,
  nowMs: number = Date.now()
): Promise<{ valid: boolean; reason?: string }> {
  if (!signal || !signal.cryptoProof || !cryptoBundle) {
    return { valid: false, reason: 'Missing signal cryptographic proof or key bundle.' };
  }

  const {
    ciphertext,
    iv,
    signature,
    version,
    senderEcdsaFingerprint,
    keyRotationVersion,
  } = signal.cryptoProof;

  if (
    typeof ciphertext !== 'string' ||
    !ciphertext ||
    typeof iv !== 'string' ||
    !iv ||
    typeof signature !== 'string' ||
    !signature ||
    version !== CALL_CRYPTO_PROOF_VERSION ||
    typeof senderEcdsaFingerprint !== 'string' ||
    !senderEcdsaFingerprint ||
    typeof keyRotationVersion !== 'number'
  ) {
    return { valid: false, reason: 'Incomplete or unsupported cryptographic proof fields.' };
  }

  if (
    !signal.signalId ||
    !signal.callId ||
    signal.conversationId !== expectedConversationId ||
    signal.senderId !== expectedSenderId ||
    signal.targetUserId !== expectedTargetUserId ||
    expectedSenderId === expectedTargetUserId ||
    cryptoBundle.conversationId !== expectedConversationId ||
    cryptoBundle.peerUserId !== expectedSenderId ||
    cryptoBundle.localUserId !== expectedTargetUserId
  ) {
    return {
      valid: false,
      reason: 'Signal identity headers do not match server-verified participant bindings.',
    };
  }

  // 1. Verify pinned sender ECDSA key fingerprint and rotation version (never trust mismatched keys)
  if (
    senderEcdsaFingerprint !== cryptoBundle.peerEcdsaFingerprint ||
    keyRotationVersion !== cryptoBundle.peerKeyRotationVersion
  ) {
    return {
      valid: false,
      reason:
        'Signal signing key fingerprint or rotation version does not match the pinned peer key.',
    };
  }

  // 2. Validate timestamp freshness (±60 seconds)
  const signalTime = new Date(signal.timestamp).getTime();
  if (!Number.isFinite(signalTime)) {
    return { valid: false, reason: 'Invalid signal timestamp format.' };
  }
  if (Math.abs(nowMs - signalTime) > SIGNAL_MAX_AGE_MS) {
    return {
      valid: false,
      reason: 'Signal timestamp is outside the 60-second anti-replay window.',
    };
  }

  // 3. Decrypt directional AES-256-GCM ciphertext (bound to expectedSenderId -> expectedTargetUserId)
  const decryptedCanonical = await decryptE2EEMessage(
    ciphertext,
    iv,
    cryptoBundle.inboundAesKey
  );
  if (!decryptedCanonical) {
    return {
      valid: false,
      reason: 'Directional AES-256-GCM authentication tag verification failed.',
    };
  }

  // 4. Recompute canonical representation of all outer signal fields (including SDP/ICE) and require exact match
  const expectedCanonical = serializeCanonicalCallSignal(
    signal,
    cryptoBundle.peerEcdsaFingerprint,
    cryptoBundle.peerKeyRotationVersion
  );
  if (decryptedCanonical !== expectedCanonical) {
    return {
      valid: false,
      reason: 'Outer signal payload does not match authenticated encrypted canonical payload.',
    };
  }

  // 5. Verify asymmetric ECDSA P-256 signature using the sender's pinned ECDSA verification public key
  const signatureOk = await verifyCallSignalSignature(
    expectedCanonical,
    signature,
    cryptoBundle.peerVerifyPublicKey
  );
  if (!signatureOk) {
    return {
      valid: false,
      reason: 'ECDSA P-256 signature verification failed (sender impersonation or key mismatch).',
    };
  }

  return { valid: true };
}

/**
 * Validates whether a signal type is permitted on a given channel ('inbox' vs 'room')
 * and in the current call state machine.
 */
export function isSignalAllowedInCallState(params: {
  channelKind: 'inbox' | 'room';
  signal: VoiceCallSignalMessage;
  currentStatus: VoiceCallStatus;
  currentCallId: string | null;
  isCaller: boolean;
  rtcSignalingState?: RTCSignalingState | null;
}): { allowed: boolean; reason?: string } {
  const {
    channelKind,
    signal,
    currentStatus,
    currentCallId,
    isCaller,
    rtcSignalingState,
  } = params;

  if (channelKind === 'inbox') {
    if (signal.type !== 'call-invite') {
      return {
        allowed: false,
        reason: `Signal type '${signal.type}' is not allowed on the inbox channel.`,
      };
    }
    return { allowed: true };
  }

  // Room channel never accepts call-invite
  if (signal.type === 'call-invite') {
    return {
      allowed: false,
      reason: 'call-invite is prohibited on the conversation room channel.',
    };
  }

  if (currentStatus === 'idle' || currentStatus === 'ended' || !currentCallId) {
    return {
      allowed: false,
      reason: 'Room signal rejected because there is no active call.',
    };
  }

  if (signal.callId !== currentCallId) {
    return {
      allowed: false,
      reason: 'Room signal callId does not match the active callId.',
    };
  }

  switch (signal.type) {
    case 'call-ringing':
    case 'call-accept':
    case 'call-reject':
    case 'call-busy': {
      if (!isCaller || currentStatus !== 'outgoing') {
        return {
          allowed: false,
          reason: `Signal '${signal.type}' is only valid for the caller while in 'outgoing' state.`,
        };
      }
      return { allowed: true };
    }

    case 'webrtc-offer': {
      if (currentStatus !== 'connecting' && currentStatus !== 'connected') {
        return {
          allowed: false,
          reason: `webrtc-offer is not allowed in call status '${currentStatus}'.`,
        };
      }
      if (!signal.sdp || signal.sdp.type !== 'offer' || !signal.sdp.sdp) {
        return {
          allowed: false,
          reason: 'Malformed SDP in webrtc-offer.',
        };
      }
      return { allowed: true };
    }

    case 'webrtc-answer': {
      if (currentStatus !== 'connecting' && currentStatus !== 'connected') {
        return {
          allowed: false,
          reason: `webrtc-answer is not allowed in call status '${currentStatus}'.`,
        };
      }
      if (!signal.sdp || signal.sdp.type !== 'answer' || !signal.sdp.sdp) {
        return {
          allowed: false,
          reason: 'Malformed SDP in webrtc-answer.',
        };
      }
      if (rtcSignalingState && rtcSignalingState !== 'have-local-offer') {
        return {
          allowed: false,
          reason: `webrtc-answer rejected because RTCPeerConnection is in state '${rtcSignalingState}' instead of 'have-local-offer'.`,
        };
      }
      return { allowed: true };
    }

    case 'webrtc-ice': {
      if (currentStatus !== 'connecting' && currentStatus !== 'connected') {
        return {
          allowed: false,
          reason: `webrtc-ice is not allowed in call status '${currentStatus}'.`,
        };
      }
      if (!signal.candidate || typeof signal.candidate.candidate !== 'string') {
        return {
          allowed: false,
          reason: 'Malformed ICE candidate payload.',
        };
      }
      return { allowed: true };
    }

    case 'peer-mute': {
      if (currentStatus !== 'connecting' && currentStatus !== 'connected') {
        return {
          allowed: false,
          reason: `peer-mute is not allowed in call status '${currentStatus}'.`,
        };
      }
      if (typeof signal.isMuted !== 'boolean') {
        return {
          allowed: false,
          reason: 'Missing boolean isMuted field in peer-mute signal.',
        };
      }
      return { allowed: true };
    }

    case 'call-end': {
      return { allowed: true };
    }

    default:
      return { allowed: false, reason: 'Unknown voice call signal type.' };
  }
}

/**
 * Stateful anti-replay tracker for signal IDs and AES-GCM IV nonces.
 * Supports `checkOnly()` (pre-verification check so unauthenticated packets cannot pollute cache)
 * and `checkAndRecord()` (atomic commit once cryptographic signature is verified).
 */
export class SignalReplayDetector {
  private seenSignalIds = new Set<string>();
  private seenIvs = new Set<string>();

  public checkOnly(
    signal: VoiceCallSignalMessage,
    nowMs: number = Date.now()
  ): { fresh: boolean; reason?: string } {
    if (!signal || typeof signal.signalId !== 'string' || signal.signalId.trim().length < 8) {
      return { fresh: false, reason: 'Missing or invalid signalId.' };
    }
    const iv = signal.cryptoProof?.iv;
    if (!iv || typeof iv !== 'string' || iv.trim().length < 8) {
      return { fresh: false, reason: 'Missing or invalid cryptographic IV.' };
    }

    const ts = new Date(signal.timestamp).getTime();
    if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > SIGNAL_MAX_AGE_MS) {
      return {
        fresh: false,
        reason: 'Signal timestamp is expired or too far in the future.',
      };
    }

    if (this.seenSignalIds.has(signal.signalId)) {
      return {
        fresh: false,
        reason: `Duplicate signalId detected (${signal.signalId}).`,
      };
    }

    if (this.seenIvs.has(iv)) {
      return {
        fresh: false,
        reason: 'Duplicate AES-GCM IV nonce detected.',
      };
    }

    return { fresh: true };
  }

  public checkAndRecord(
    signal: VoiceCallSignalMessage,
    nowMs: number = Date.now()
  ): { fresh: boolean; reason?: string } {
    const preCheck = this.checkOnly(signal, nowMs);
    if (!preCheck.fresh) {
      return preCheck;
    }

    const iv = signal.cryptoProof!.iv;

    if (this.seenSignalIds.size >= MAX_REPLAY_CACHE_SIZE) {
      const oldestId = this.seenSignalIds.values().next().value;
      if (oldestId) this.seenSignalIds.delete(oldestId);
    }
    if (this.seenIvs.size >= MAX_REPLAY_CACHE_SIZE) {
      const oldestIv = this.seenIvs.values().next().value;
      if (oldestIv) this.seenIvs.delete(oldestIv);
    }

    this.seenSignalIds.add(signal.signalId);
    this.seenIvs.add(iv);
    return { fresh: true };
  }

  public clear(): void {
    this.seenSignalIds.clear();
    this.seenIvs.clear();
  }
}

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
  isPrivateChannel: true,
};

type CallStateListener = (state: VoiceCallState) => void;
type RemoteStreamListener = (stream: MediaStream | null) => void;

export const CALL_INBOX_TOPIC_PREFIX = 'spark_call_inbox_';
export const CALL_ROOM_TOPIC_PREFIX = 'spark_call_1on1_';

/**
 * Generates the canonical private inbox Realtime topic for the authenticated user.
 */
export function buildOwnCallInboxTopic(authenticatedUserId: string): string {
  const normalized = typeof authenticatedUserId === 'string' ? authenticatedUserId.trim() : '';
  if (!normalized) {
    throw new Error('Authenticated user ID is required to construct a private call inbox topic.');
  }
  return `${CALL_INBOX_TOPIC_PREFIX}${normalized}`;
}

/**
 * Verifies whether `authenticatedUserId` is permitted to subscribe to (read from) `requestedTopic`.
 * Enforces strict private inbox isolation: a user may ONLY subscribe to `spark_call_inbox_<their_auth_uid>`.
 */
export function canSubscribeToCallInboxTopic(
  authenticatedUserId: string | null | undefined,
  requestedTopic: string
): boolean {
  if (!authenticatedUserId || typeof authenticatedUserId !== 'string') {
    return false;
  }
  const normalizedUid = authenticatedUserId.trim();
  if (!normalizedUid) {
    return false;
  }
  if (typeof requestedTopic !== 'string' || !requestedTopic.startsWith(CALL_INBOX_TOPIC_PREFIX)) {
    return false;
  }
  return requestedTopic === `${CALL_INBOX_TOPIC_PREFIX}${normalizedUid}`;
}

export interface CallRealtimeTransportOverride {
  getVerifiedSessionUser: () => Promise<{ userId: string; accessToken: string } | null>;
  authorizeOneToOneConversation?: (
    conversationId: string,
    localUserId: string,
    expectedPeerId?: string
  ) => Promise<{
    authorized: boolean;
    verifiedConversationId?: string;
    verifiedLocalUserId?: string;
    verifiedPeerProfile?: PublicUserProfile;
    cryptoBundle?: CallCryptoSessionBundle;
    reason?: string;
  }>;
  subscribeChannel?: (params: {
    topic: string;
    userId: string;
    accessToken: string;
    isPrivate: boolean;
    onSignal: (msg: VoiceCallSignalMessage) => void;
  }) => Promise<RealtimeChannel | null>;
  publishBroadcastWithoutSubscribe?: (params: {
    topic: string;
    userId: string;
    accessToken: string;
    isPrivate: boolean;
    event: string;
    payload: VoiceCallSignalMessage;
  }) => Promise<boolean>;
}

export interface PendingPeerKeyApproval {
  localUserId: string;
  peerUserId: string;
  conversationId: string;
  peerProfile: PublicUserProfile;
  candidateBundle: PublishedUserCryptoKeyBundle;
  candidateEcdsaFingerprint: string;
  pendingIncomingInvite?: VoiceCallSignalMessage;
}

export class OneToOneVoiceCallManager {
  private state: VoiceCallState = { ...INITIAL_CALL_STATE };
  private stateListeners = new Set<CallStateListener>();
  private remoteStreamListeners = new Set<RemoteStreamListener>();

  private verifiedUserId: string | null = null;
  private inboxChannel: RealtimeChannel | null = null;
  private inboxInitPromise: Promise<void> | null = null;
  private callRoomChannel: RealtimeChannel | null = null;
  private testTransportOverride: CallRealtimeTransportOverride | null = null;
  private pendingKeyRotationApproval: PendingPeerKeyApproval | null = null;

  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private activeCryptoBundle: CallCryptoSessionBundle | null = null;
  private replayDetector = new SignalReplayDetector();

  private ringInterval: ReturnType<typeof setInterval> | null = null;
  private inviteResendInterval: ReturnType<typeof setInterval> | null = null;
  private unansweredTimeout: ReturnType<typeof setTimeout> | null = null;
  private iceConnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private disconnectedRecoveryTimeout: ReturnType<typeof setTimeout> | null = null;
  private isHandlingOffer = false;
  private activeIncomingNotification: Notification | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      const cleanupOnUnload = () => {
        if (this.state.status !== 'idle' && this.state.status !== 'ended') {
          this.endVoiceCall('Call ended because participant left the page.');
        }
      };
      window.addEventListener('beforeunload', cleanupOnUnload);
      window.addEventListener('pagehide', cleanupOnUnload);

      const ensureInboxAliveOnWake = () => {
        if (
          typeof document !== 'undefined' &&
          document.visibilityState === 'hidden'
        ) {
          return;
        }
        if (this.verifiedUserId && !this.testTransportOverride) {
          void this.initIncomingCallListener(this.verifiedUserId);
        }
      };
      window.addEventListener('focus', ensureInboxAliveOnWake);
      window.addEventListener('online', ensureInboxAliveOnWake);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', ensureInboxAliveOnWake);
      }
    }
  }

  public setTestRealtimeTransportOverride(override: CallRealtimeTransportOverride | null): void {
    this.testTransportOverride = override;
  }

  public getPendingKeyRotationApproval(): PendingPeerKeyApproval | null {
    return this.pendingKeyRotationApproval;
  }

  public async approvePendingPeerKeyAndContinue(): Promise<{
    success: boolean;
    error?: string;
  }> {
    const pending = this.pendingKeyRotationApproval;
    if (!pending) {
      return { success: false, error: 'No pending peer key change to approve.' };
    }

    const approval = await approvePeerKeyRotation(
      pending.localUserId,
      pending.peerUserId,
      pending.candidateBundle,
      pending.candidateEcdsaFingerprint,
      true
    );

    if (!approval.trusted) {
      const errMsg = approval.reason || 'Failed to approve peer device key.';
      this.updateState({
        ...this.state,
        status: 'ended',
        errorMessage: errMsg,
        statusDetail: 'Key approval failed',
      });
      return { success: false, error: errMsg };
    }

    this.pendingKeyRotationApproval = null;

    if (pending.pendingIncomingInvite) {
      this.updateState({ ...INITIAL_CALL_STATE });
      await this.handleIncomingInboxSignal(pending.pendingIncomingInvite);
      return { success: true };
    }

    this.updateState({ ...INITIAL_CALL_STATE });
    return this.startOneToOneVoiceCall(pending.conversationId, pending.peerUserId);
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
   * Authenticates the Supabase Realtime client strictly using the server-verified JWT session.
   * Fails closed (returns null) if there is no valid access_token or server-verified user ID.
   */
  private async getVerifiedSessionUser(): Promise<{
    userId: string;
    accessToken: string;
  } | null> {
    if (this.testTransportOverride) {
      const session = await this.testTransportOverride.getVerifiedSessionUser();
      if (!session || !session.userId?.trim() || !session.accessToken?.trim()) {
        return null;
      }
      return {
        userId: session.userId.trim(),
        accessToken: session.accessToken.trim(),
      };
    }

    if (!isSupabaseConfigured()) return null;
    const supabase = getSupabase();
    if (!supabase) return null;

    try {
      await ensureSupabaseAuthSession();
      const [{ data: sessionData, error: sessionErr }, { data: userData, error: userErr }] =
        await Promise.all([supabase.auth.getSession(), supabase.auth.getUser()]);

      const session = sessionData?.session;
      const verifiedUser = userData?.user;

      if (
        sessionErr ||
        userErr ||
        !session?.access_token ||
        !verifiedUser?.id ||
        session.user?.id !== verifiedUser.id
      ) {
        return null;
      }

      await supabase.realtime.setAuth(session.access_token);

      return {
        userId: verifiedUser.id,
        accessToken: session.access_token,
      };
    } catch (e) {
      console.warn('[VoiceCall] Server session verification failed:', e);
      return null;
    }
  }

  /**
   * Evicts a specific channel instance (or any stale channel matching `topic`) from the
   * Supabase Realtime client so `supabase.channel(topic)` never returns an errored/closed singleton.
   */
  private async evictChannelInstance(channel: RealtimeChannel | null): Promise<void> {
    if (!channel) return;
    const supabase = getSupabase();
    try {
      await supabase?.removeChannel(channel);
    } catch {}
    try {
      (channel as any).teardown?.();
    } catch {}
    try {
      (supabase?.realtime as any)?._remove?.(channel);
    } catch {}
  }

  private async evictStaleChannelsByTopic(
    topic: string,
    preserveChannel?: RealtimeChannel | null
  ): Promise<void> {
    const supabase = getSupabase();
    if (!supabase) return;
    try {
      const realtimeTopic = `realtime:${topic}`;
      const existing = supabase
        .getChannels()
        .filter(
          (ch) =>
            (ch.topic === realtimeTopic || ch.topic === topic) &&
            (!preserveChannel || ch !== preserveChannel)
        );
      for (const ch of existing) {
        await this.evictChannelInstance(ch);
      }
    } catch {}
  }

  /**
   * Server-side conversation membership, identity, and pinned dual-key cryptographic verification.
   * Never trusts senderId, targetUserId, or conversation membership supplied by the client,
   * and NEVER silently trusts a changed peer signing key.
   */
  private async verifyServerSideOneToOneAuthorization(
    conversationId: string,
    expectedPeerId?: string
  ): Promise<{
    authorized: boolean;
    verifiedConversationId?: string;
    verifiedLocalUserId?: string;
    verifiedPeerProfile?: PublicUserProfile;
    cryptoBundle?: CallCryptoSessionBundle;
    reason?: string;
  }> {
    if (!conversationId) {
      return { authorized: false, reason: 'Missing conversation identifier.' };
    }

    const verifiedSession = await this.getVerifiedSessionUser();
    if (!verifiedSession) {
      return {
        authorized: false,
        reason: 'Authenticated Supabase session required for private call authorization.',
      };
    }

    const localUserId = verifiedSession.userId;

    if (this.testTransportOverride?.authorizeOneToOneConversation) {
      return this.testTransportOverride.authorizeOneToOneConversation(
        conversationId,
        localUserId,
        expectedPeerId
      );
    }

    const supabase = getSupabase();
    if (!supabase) {
      return { authorized: false, reason: 'Supabase is not configured.' };
    }

    try {
      // 1. Verify conversation row on the server (must exist, be 1-to-1, and not be deleted)
      const { data: convRow, error: convErr } = await supabase
        .from('conversations')
        .select('id, is_group, deleted_at')
        .eq('id', conversationId)
        .maybeSingle();

      if (convErr || !convRow) {
        return {
          authorized: false,
          reason: 'Conversation does not exist or access was denied by server RLS.',
        };
      }

      // 2. Verify conversation membership in public.conversation_members on the server
      const { data: memberRows, error: memberErr } = await supabase
        .from('conversation_members')
        .select('user_id, deleted_at')
        .eq('conversation_id', convRow.id);

      if (memberErr || !Array.isArray(memberRows)) {
        return {
          authorized: false,
          reason: 'Failed to verify conversation membership on the server.',
        };
      }

      const membershipCheck = validateOneToOneConversationMembership({
        conversation: convRow,
        members: memberRows,
        localUserId,
        expectedPeerId,
      });

      if (
        !membershipCheck.valid ||
        !membershipCheck.verifiedConversationId ||
        !membershipCheck.verifiedPeerUserId
      ) {
        return {
          authorized: false,
          reason: membershipCheck.reason || 'Unauthorized conversation membership.',
        };
      }

      const verifiedConvId = membershipCheck.verifiedConversationId;
      const serverDerivedPeerId = membershipCheck.verifiedPeerUserId;

      // 3. Fetch peer profile directly from public.profiles on the server
      const { data: peerProfileRow, error: profErr } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, streak_days')
        .eq('id', serverDerivedPeerId)
        .maybeSingle();

      if (profErr || !peerProfileRow || !peerProfileRow.username) {
        return {
          authorized: false,
          reason: 'Could not verify peer profile in Supabase.',
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

      // 4. Verify & pin separated ECDH + ECDSA keys (rejects unapproved key changes or downgrades)
      let cryptoBundle: CallCryptoSessionBundle;
      try {
        const localKeys = await getOrCreateDeviceIdentityKeyPair(localUserId);
        await syncPublicKeyToSupabase(localUserId, localKeys.publishedBundle);

        const peerKeyVerification = await fetchAndVerifyPeerKeyBundle(
          localUserId,
          serverDerivedPeerId
        );
        if (
          !peerKeyVerification.trusted ||
          !peerKeyVerification.ecdhPublicKey ||
          !peerKeyVerification.ecdsaVerifyPublicKey ||
          !peerKeyVerification.ecdsaFingerprint ||
          typeof peerKeyVerification.keyRotationVersion !== 'number'
        ) {
          if (
            peerKeyVerification.keyMismatchDetected &&
            peerKeyVerification.bundle &&
            peerKeyVerification.ecdsaFingerprint
          ) {
            this.pendingKeyRotationApproval = {
              localUserId,
              peerUserId: serverDerivedPeerId,
              conversationId: verifiedConvId,
              peerProfile: verifiedPeerProfile,
              candidateBundle: peerKeyVerification.bundle,
              candidateEcdsaFingerprint: peerKeyVerification.ecdsaFingerprint,
            };
          } else {
            this.pendingKeyRotationApproval = null;
          }
          return {
            authorized: false,
            verifiedConversationId: verifiedConvId,
            verifiedLocalUserId: localUserId,
            verifiedPeerProfile,
            reason:
              peerKeyVerification.reason ||
              'Peer cryptographic key bundle failed verification or pinning check.',
          };
        }

        this.pendingKeyRotationApproval = null;

        const [outboundAesKey, inboundAesKey] = await Promise.all([
          deriveDirectionalCallSignalKey(
            localKeys.privateKey,
            peerKeyVerification.ecdhPublicKey,
            verifiedConvId,
            localUserId,
            serverDerivedPeerId
          ),
          deriveDirectionalCallSignalKey(
            localKeys.privateKey,
            peerKeyVerification.ecdhPublicKey,
            verifiedConvId,
            serverDerivedPeerId,
            localUserId
          ),
        ]);

        cryptoBundle = {
          localUserId,
          peerUserId: serverDerivedPeerId,
          conversationId: verifiedConvId,
          outboundAesKey,
          inboundAesKey,
          localSigningPrivateKey: localKeys.signingPrivateKey,
          peerVerifyPublicKey: peerKeyVerification.ecdsaVerifyPublicKey,
          localEcdsaFingerprint: localKeys.ecdsaFingerprint,
          peerEcdsaFingerprint: peerKeyVerification.ecdsaFingerprint,
          localKeyRotationVersion: localKeys.keyRotationVersion,
          peerKeyRotationVersion: peerKeyVerification.keyRotationVersion,
        };
      } catch (cryptoErr: any) {
        return {
          authorized: false,
          reason:
            cryptoErr?.message ||
            'Failed to verify cryptographic identity & signing keys for call signaling.',
        };
      }

      return {
        authorized: true,
        verifiedConversationId: verifiedConvId,
        verifiedLocalUserId: localUserId,
        verifiedPeerProfile,
        cryptoBundle,
      };
    } catch (err: any) {
      return {
        authorized: false,
        reason: err?.message || 'Server authorization check failed.',
      };
    }
  }

  /**
   * Subscribes to a strictly private Supabase Realtime channel (`private: true` ONLY).
   * Enforces that a user can NEVER subscribe to another user's private inbox (`spark_call_inbox_<other>`),
   * evicts any stale channel instance before joining, and fails closed on authorization failure.
   */
  public async subscribePrivateChannel(
    topic: string,
    onSignal: (msg: VoiceCallSignalMessage) => void
  ): Promise<RealtimeChannel | null> {
    if (!topic || typeof topic !== 'string') return null;

    const verifiedSession = await this.getVerifiedSessionUser();
    if (!verifiedSession || !verifiedSession.userId || !verifiedSession.accessToken) {
      return null;
    }

    // Hard client-side guard: NEVER allow subscribing to another user's private call inbox
    if (topic.startsWith(CALL_INBOX_TOPIC_PREFIX)) {
      if (!canSubscribeToCallInboxTopic(verifiedSession.userId, topic)) {
        console.warn(
          `[VoiceCall] Blocked cross-user inbox subscription attempt by ${verifiedSession.userId} for topic ${topic}.`
        );
        return null;
      }
    } else if (topic.startsWith(CALL_ROOM_TOPIC_PREFIX)) {
      const roomConvId = topic.slice(CALL_ROOM_TOPIC_PREFIX.length).trim();
      if (!roomConvId) {
        return null;
      }
    } else {
      return null;
    }

    if (this.testTransportOverride?.subscribeChannel) {
      return this.testTransportOverride.subscribeChannel({
        topic,
        userId: verifiedSession.userId,
        accessToken: verifiedSession.accessToken,
        isPrivate: true,
        onSignal,
      });
    }

    const supabase = getSupabase();
    if (!supabase) return null;

    // Evict any stale/errored channel with the same topic so supabase.channel() creates a clean instance
    await this.evictStaleChannelsByTopic(topic);
    await supabase.realtime.setAuth(verifiedSession.accessToken);

    return new Promise((resolve) => {
      let settled = false;
      const ch = supabase.channel(topic, {
        config: {
          private: true,
          broadcast: { self: false, ack: true },
        },
      });

      try {
        ch.updateJoinPayload({ access_token: verifiedSession.accessToken });
      } catch {}

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          void this.evictChannelInstance(ch);
          resolve(null);
        }
      }, 5000);

      ch.on('broadcast', { event: 'voice_call_signal' }, (payload) => {
        const msg = (
          payload?.payload &&
          typeof payload.payload === 'object' &&
          'signalId' in payload.payload
            ? payload.payload
            : payload
        ) as VoiceCallSignalMessage | undefined;
        if (
          msg &&
          typeof msg.signalId === 'string' &&
          typeof msg.type === 'string' &&
          typeof msg.callId === 'string' &&
          typeof msg.conversationId === 'string' &&
          typeof msg.senderId === 'string' &&
          typeof msg.targetUserId === 'string' &&
          msg.cryptoProof &&
          typeof msg.cryptoProof.ciphertext === 'string' &&
          typeof msg.cryptoProof.iv === 'string' &&
          typeof msg.cryptoProof.signature === 'string' &&
          typeof msg.cryptoProof.senderEcdsaFingerprint === 'string' &&
          typeof msg.cryptoProof.keyRotationVersion === 'number'
        ) {
          onSignal(msg);
        }
      }).subscribe((status: string, err?: Error) => {
        if (settled) {
          if (
            this.inboxChannel === ch &&
            (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')
          ) {
            this.inboxChannel = null;
            void this.evictChannelInstance(ch);
            if (this.verifiedUserId && !this.testTransportOverride) {
              setTimeout(() => {
                if (this.verifiedUserId && !this.inboxChannel) {
                  void this.initIncomingCallListener(this.verifiedUserId);
                }
              }, 1500);
            }
          }
          return;
        }
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
          if (err) {
            console.warn(
              `[VoiceCall] Private channel (${topic}) authorization denied:`,
              err.message
            );
          }
          void this.evictChannelInstance(ch);
          resolve(null);
        }
      });
    });
  }

  /**
   * Initializes the signed-in user's private incoming call inbox listener (`spark_call_inbox_<auth.uid()>`).
   * Serializes concurrent calls, only subscribes to the server-authenticated user's own inbox, and fails closed if authorization fails.
   */
  public async initIncomingCallListener(expectedUserId?: string): Promise<void> {
    if (this.inboxInitPromise) {
      await this.inboxInitPromise;
    }

    const runInit = async (): Promise<void> => {
      if (!this.testTransportOverride && !isSupabaseConfigured()) return;

      const verifiedSession = await this.getVerifiedSessionUser();
      if (!verifiedSession) {
        this.cleanupInboxChannel();
        return;
      }

      if (expectedUserId && expectedUserId !== verifiedSession.userId) {
        console.warn('[VoiceCall] Blocked inbox subscription for mismatched user ID.');
        this.cleanupInboxChannel();
        return;
      }

      if (this.verifiedUserId === verifiedSession.userId && this.inboxChannel) {
        const currentChannelState = (this.inboxChannel as any).state;
        if (
          !currentChannelState ||
          currentChannelState === 'joined' ||
          currentChannelState === 'joining'
        ) {
          return;
        }
      }

      this.cleanupInboxChannel();
      this.verifiedUserId = verifiedSession.userId;

      // Ensure local user's separated ECDH + ECDSA public key bundle is synced to user_crypto_keys
      try {
        const localKeys = await getOrCreateDeviceIdentityKeyPair(verifiedSession.userId);
        await syncPublicKeyToSupabase(verifiedSession.userId, localKeys.publishedBundle);
      } catch {}

      const inboxTopic = buildOwnCallInboxTopic(verifiedSession.userId);
      const privateInboxChannel = await this.subscribePrivateChannel(inboxTopic, (msg) => {
        this.handleIncomingInboxSignal(msg).catch((e) =>
          console.warn('[VoiceCall] Error handling inbox signal:', e)
        );
      });

      if (!privateInboxChannel) {
        this.inboxChannel = null;
        console.warn(
          '[VoiceCall] Private call inbox subscription failed closed. Ensure Section 13 SQL (realtime.messages RLS) is applied in Supabase.'
        );
        return;
      }

      this.inboxChannel = privateInboxChannel;
    };

    const p = runInit();
    this.inboxInitPromise = p;
    try {
      await p;
    } finally {
      if (this.inboxInitPromise === p) {
        this.inboxInitPromise = null;
      }
    }
  }

  public cleanupInboxChannel(): void {
    const ch = this.inboxChannel;
    this.inboxChannel = null;
    if (ch) {
      void this.evictChannelInstance(ch);
    }
  }

  private async sendSignalOnChannel(
    channel: RealtimeChannel | null,
    rawSignal: Omit<VoiceCallSignalMessage, 'signalId' | 'cryptoProof'> & {
      signalId?: string;
    },
    cryptoBundle: CallCryptoSessionBundle | null = this.activeCryptoBundle
  ): Promise<boolean> {
    if (!channel || !cryptoBundle) return false;

    const signalWithId: Omit<VoiceCallSignalMessage, 'cryptoProof'> = {
      ...rawSignal,
      signalId: rawSignal.signalId || generateUniqueSignalId(),
    };

    const signedSignal = await createSignedEncryptedSignal(signalWithId, cryptoBundle);
    if (!signedSignal) {
      console.warn('[VoiceCall] Refusing to send signal without cryptographic proof.');
      return false;
    }
    try {
      const resp = await channel.send({
        type: 'broadcast',
        event: 'voice_call_signal',
        payload: signedSignal,
      });
      return resp === 'ok';
    } catch (e) {
      console.warn('[VoiceCall] Private signal send failed:', e);
      return false;
    }
  }

  /**
   * Publishes a private call invitation to the verified peer's inbox (`spark_call_inbox_<serverVerifiedPeerId>`)
   * WITHOUT subscribing (`phx_join` / `SELECT`) to the peer's inbox!
   *
   * Why this is critical:
   * - In Supabase Realtime, calling `channel.subscribe()` sends `phx_join`, which requires `SELECT` (read)
   *   permission on `realtime.messages`. A caller NEVER has `SELECT` permission on another user's inbox.
   * - Calling `channel.send({ type: 'broadcast', ... })` on an unsubscribed private channel sends an
   *   authenticated HTTP POST to `/realtime/v1/api/broadcast` (`private: true`), which checks ONLY `INSERT`
   *   (write) permission on `realtime.messages` ("Verified 1on1 peer can send call invite to peer inbox").
   *
   * IMPORTANT: A `true` return value ONLY confirms that the Supabase Realtime broker authorized and accepted
   * the broadcast. It is NOT proof that the recipient device is online or received the invitation.
   */
  public async publishInviteToPeerInboxChannel(
    serverVerifiedPeerId: string,
    rawSignal: Omit<VoiceCallSignalMessage, 'signalId' | 'cryptoProof'> & {
      signalId?: string;
    },
    cryptoBundle: CallCryptoSessionBundle
  ): Promise<boolean> {
    const normalizedPeerId =
      typeof serverVerifiedPeerId === 'string' ? serverVerifiedPeerId.trim() : '';
    if (!normalizedPeerId) return false;

    const verifiedSession = await this.getVerifiedSessionUser();
    if (!verifiedSession || verifiedSession.userId === normalizedPeerId) {
      return false;
    }

    const signalWithId: Omit<VoiceCallSignalMessage, 'cryptoProof'> = {
      ...rawSignal,
      signalId: rawSignal.signalId || generateUniqueSignalId(),
    };

    const signedSignal = await createSignedEncryptedSignal(signalWithId, cryptoBundle);
    if (!signedSignal) return false;

    const inboxTopic = buildOwnCallInboxTopic(normalizedPeerId);

    if (this.testTransportOverride?.publishBroadcastWithoutSubscribe) {
      return this.testTransportOverride.publishBroadcastWithoutSubscribe({
        topic: inboxTopic,
        userId: verifiedSession.userId,
        accessToken: verifiedSession.accessToken,
        isPrivate: true,
        event: 'voice_call_signal',
        payload: signedSignal,
      });
    }

    const supabase = getSupabase();
    if (!supabase) return false;

    await this.evictStaleChannelsByTopic(inboxTopic);
    await supabase.realtime.setAuth(verifiedSession.accessToken);

    const writeOnlyChannel = supabase.channel(inboxTopic, {
      config: {
        private: true,
        broadcast: { self: false, ack: true },
      },
    });

    try {
      // Do NOT call writeOnlyChannel.subscribe(): send() on an unsubscribed channel uses the
      // authenticated Realtime REST broadcast endpoint, checking INSERT RLS without SELECT RLS.
      const resp = await writeOnlyChannel.send({
        type: 'broadcast',
        event: 'voice_call_signal',
        payload: signedSignal,
      });
      return resp === 'ok';
    } catch (err) {
      console.warn('[VoiceCall] Private peer inbox broadcast rejected or failed:', err);
      return false;
    } finally {
      await this.evictChannelInstance(writeOnlyChannel);
    }
  }

  /**
   * Starts a 1-to-1 outgoing voice call in `conversationId`.
   * Authorizes conversation membership on the server and fails closed if private Realtime channel authorization fails.
   */
  public async startOneToOneVoiceCall(
    conversationId: string,
    expectedTargetUserId?: string
  ): Promise<{ success: boolean; error?: string }> {
    if (typeof window !== 'undefined') {
      try {
        unlockSound();
      } catch {}
    }

    if (this.state.status !== 'idle' && this.state.status !== 'ended') {
      return { success: false, error: 'You are already in an active call.' };
    }

    const sessionInfo = await this.getVerifiedSessionUser();
    if (!sessionInfo) {
      return {
        success: false,
        error: 'Authenticated Supabase session required. Please sign in again.',
      };
    }

    let candidateConvId = conversationId;
    if (
      !this.testTransportOverride &&
      expectedTargetUserId &&
      expectedTargetUserId !== sessionInfo.userId
    ) {
      try {
        candidateConvId = await getOrCreateRealConversation(
          sessionInfo.userId,
          expectedTargetUserId
        );
      } catch {}
    }

    // 1. Strict server-side conversation membership, peer derivation, and pinned key bundle verification
    const authCheck = await this.verifyServerSideOneToOneAuthorization(
      candidateConvId,
      expectedTargetUserId
    );
    if (
      !authCheck.authorized ||
      !authCheck.verifiedConversationId ||
      !authCheck.verifiedLocalUserId ||
      !authCheck.verifiedPeerProfile ||
      !authCheck.cryptoBundle
    ) {
      const errMsg = authCheck.reason || 'Server call authorization failed.';
      this.updateState({
        ...INITIAL_CALL_STATE,
        status: 'ended',
        peerUser: authCheck.verifiedPeerProfile || null,
        errorMessage: errMsg,
        statusDetail: this.pendingKeyRotationApproval
          ? 'Peer device key verification required'
          : 'Authorization failed',
      });
      return { success: false, error: errMsg };
    }

    const verifiedConvId = authCheck.verifiedConversationId;
    const verifiedCallerId = authCheck.verifiedLocalUserId;
    const verifiedPeer = authCheck.verifiedPeerProfile;
    this.activeCryptoBundle = authCheck.cryptoBundle;

    // 2. Subscribe to the private 1-to-1 conversation call room FIRST (fail closed before opening microphone if unauthorized)
    const roomTopic = `spark_call_1on1_${verifiedConvId}`;
    const privateRoomChannel = await this.subscribePrivateChannel(roomTopic, (msg) => {
      this.handleIncomingRoomSignal(
        msg,
        verifiedConvId,
        verifiedPeer.id,
        verifiedCallerId
      ).catch((e) => console.warn('[VoiceCall] Room signal error:', e));
    });

    if (!privateRoomChannel) {
      this.releaseMediaAndConnections();
      const errMsg =
        'Private Realtime channel authorization failed (fail-closed). Ensure Section 13 SQL policies on realtime.messages are applied in Supabase.';
      this.updateState({
        ...INITIAL_CALL_STATE,
        status: 'ended',
        peerUser: verifiedPeer,
        errorMessage: errMsg,
        statusDetail: 'Private channel denied',
      });
      return { success: false, error: errMsg };
    }

    this.callRoomChannel = privateRoomChannel;

    // 3. Request microphone access
    if (
      typeof window === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function' ||
      typeof RTCPeerConnection === 'undefined'
    ) {
      this.releaseMediaAndConnections();
      return {
        success: false,
        error: 'WebRTC voice calling is not supported in this browser.',
      };
    }

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
      this.releaseMediaAndConnections();
      const msg =
        micErr?.name === 'NotAllowedError' || micErr?.name === 'PermissionDeniedError'
          ? 'Microphone permission was denied. Please allow microphone access in Chrome site settings to make voice calls.'
          : `Could not access microphone: ${micErr?.message || 'Hardware unavailable'}`;
      this.updateState({
        ...INITIAL_CALL_STATE,
        status: 'ended',
        peerUser: verifiedPeer,
        errorMessage: msg,
        statusDetail: 'Microphone unavailable',
      });
      return { success: false, error: msg };
    }

    this.localStream = micStream;
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    // Note: isPeerRinging is false until the recipient's device sends a verified 'call-ringing' signal.
    this.updateState({
      status: 'outgoing',
      callId,
      conversationId: verifiedConvId,
      isCaller: true,
      peerUser: verifiedPeer,
      isMuted: false,
      isSpeakerOn: false,
      isPeerMuted: false,
      isPeerRinging: false,
      connectedAt: null,
      statusDetail: 'Calling (waiting for recipient device)...',
      errorMessage: null,
      isPrivateChannel: true,
    });

    // 4. Publish cryptographically signed invite to the peer's private inbox (fail closed if Realtime broker rejects publish)
    const inviteBase = {
      callId,
      conversationId: verifiedConvId,
      senderId: verifiedCallerId,
      targetUserId: verifiedPeer.id,
      type: 'call-invite' as VoiceCallSignalType,
      timestamp: new Date().toISOString(),
    };

    const brokerPublishAccepted = await this.publishInviteToPeerInboxChannel(
      verifiedPeer.id,
      inviteBase,
      this.activeCryptoBundle
    );

    if (!brokerPublishAccepted) {
      this.releaseMediaAndConnections();
      const errMsg =
        'Private inbox call invitation was rejected by Realtime authorization (fail-closed).';
      this.updateState({
        ...INITIAL_CALL_STATE,
        status: 'ended',
        peerUser: verifiedPeer,
        errorMessage: errMsg,
        statusDetail: 'Signaling denied',
      });
      return { success: false, error: errMsg };
    }

    this.startRingLoop('outgoing');

    // Periodically re-publish invite with a fresh unique signalId + timestamp + signature while outgoing
    // in case the recipient comes online while the call is still ringing.
    this.inviteResendInterval = setInterval(() => {
      if (
        this.state.status === 'outgoing' &&
        this.state.callId === callId &&
        this.activeCryptoBundle
      ) {
        const repeatInvite = {
          ...inviteBase,
          signalId: generateUniqueSignalId(),
          timestamp: new Date().toISOString(),
        };
        this.publishInviteToPeerInboxChannel(
          verifiedPeer.id,
          repeatInvite,
          this.activeCryptoBundle
        ).catch(() => {});
      }
    }, 3500);

    // 45-second unanswered / offline recipient timeout
    // Distinguishes between an offline recipient (never sent 'call-ringing') and a ringing unanswered recipient.
    this.unansweredTimeout = setTimeout(() => {
      if (this.state.status === 'outgoing' && this.state.callId === callId) {
        if (!this.state.isPeerRinging) {
          this.endVoiceCall(
            'Recipient is offline or unreachable (no device acknowledged the call invitation).'
          );
        } else {
          this.endVoiceCall('No answer. The recipient did not pick up.');
        }
      }
    }, 45000);

    return { success: true };
  }

  /**
   * Handles incoming `call-invite` signals arriving on the authenticated user's private inbox channel.
   * Order of checks:
   * 1. Channel & state validation (`isSignalAllowedInCallState`).
   * 2. Replay pre-check (`replayDetector.checkOnly`).
   * 3. Server-side conversation membership & pinned peer key verification.
   * 4. Cryptographic ECDSA P-256 signature & directional AES-256-GCM verification (`verifySignedEncryptedSignal`).
   * 5. Atomic replay commit (`replayDetector.checkAndRecord`).
   * 6. Call state transition.
   */
  public async handleIncomingInboxSignal(msg: VoiceCallSignalMessage): Promise<void> {
    // 1. Channel & call-state check
    const stateCheck = isSignalAllowedInCallState({
      channelKind: 'inbox',
      signal: msg,
      currentStatus: this.state.status,
      currentCallId: this.state.callId,
      isCaller: this.state.isCaller,
    });
    if (!stateCheck.allowed) {
      return;
    }

    // 2. Pre-verification replay check (rejects duplicates/expired without polluting seen set with unverified packets)
    const replayPreCheck = this.replayDetector.checkOnly(msg);
    if (!replayPreCheck.fresh) {
      console.warn('[VoiceCall] Dropped replayed/expired inbox signal:', replayPreCheck.reason);
      return;
    }

    const sessionInfo = await this.getVerifiedSessionUser();
    if (!sessionInfo) return;
    const verifiedLocalUserId = sessionInfo.userId;

    // 3. Server-side verification of conversation membership & pinned peer identity keys
    const authCheck = await this.verifyServerSideOneToOneAuthorization(msg.conversationId);
    if (
      !authCheck.authorized ||
      !authCheck.verifiedConversationId ||
      !authCheck.verifiedLocalUserId ||
      !authCheck.verifiedPeerProfile ||
      !authCheck.cryptoBundle
    ) {
      if (
        this.pendingKeyRotationApproval &&
        this.pendingKeyRotationApproval.conversationId === msg.conversationId &&
        this.state.status === 'idle'
      ) {
        this.pendingKeyRotationApproval.pendingIncomingInvite = msg;
        if (typeof window !== 'undefined') {
          try {
            playIncomingRingTone();
          } catch {}
        }
        this.updateState({
          ...INITIAL_CALL_STATE,
          status: 'ended',
          peerUser: authCheck.verifiedPeerProfile || null,
          errorMessage:
            authCheck.reason ||
            'Peer signing/identity key changed from the pinned fingerprint. Explicit key rotation approval is required.',
          statusDetail: 'Incoming call blocked: new peer device key',
        });
      }
      console.warn(
        '[VoiceCall] Dropped unauthorized incoming call invite:',
        authCheck.reason
      );
      return;
    }

    const serverVerifiedConvId = authCheck.verifiedConversationId;
    const serverVerifiedPeer = authCheck.verifiedPeerProfile;
    const convCryptoBundle = authCheck.cryptoBundle;

    if (
      msg.senderId !== serverVerifiedPeer.id ||
      msg.targetUserId !== verifiedLocalUserId ||
      msg.conversationId !== serverVerifiedConvId
    ) {
      console.warn('[VoiceCall] Dropped call invite with mismatched identity fields.');
      return;
    }

    // 4. Mandatory directional AES-256-GCM + dedicated ECDSA P-256 signature verification BEFORE any state change
    const proofVerification = await verifySignedEncryptedSignal(
      msg,
      serverVerifiedConvId,
      serverVerifiedPeer.id,
      verifiedLocalUserId,
      convCryptoBundle
    );
    if (!proofVerification.valid) {
      console.warn(
        '[VoiceCall] Dropped call invite failing cryptographic verification:',
        proofVerification.reason
      );
      return;
    }

    // 5. Commit authentic signalId & IV to the replay detector
    const replayCommit = this.replayDetector.checkAndRecord(msg);
    if (!replayCommit.fresh) {
      return;
    }

    // Ignore subsequent periodic resend invites for the exact same call we are already handling
    if (
      this.state.callId === msg.callId &&
      (this.state.status === 'incoming' ||
        this.state.status === 'connecting' ||
        this.state.status === 'connected')
    ) {
      return;
    }

    // 6. If already in another active call, notify the verified caller via the private room channel
    if (this.state.status !== 'idle' && this.state.status !== 'ended') {
      const busyRoomCh = await this.subscribePrivateChannel(
        `spark_call_1on1_${serverVerifiedConvId}`,
        () => {}
      );
      if (busyRoomCh) {
        await this.sendSignalOnChannel(
          busyRoomCh,
          {
            callId: msg.callId,
            conversationId: serverVerifiedConvId,
            senderId: verifiedLocalUserId,
            targetUserId: serverVerifiedPeer.id,
            type: 'call-busy',
            timestamp: new Date().toISOString(),
          },
          convCryptoBundle
        );
        setTimeout(() => {
          try {
            busyRoomCh.unsubscribe();
            getSupabase()?.removeChannel(busyRoomCh);
          } catch {}
        }, 300);
      }
      return;
    }

    // 7. Subscribe to the private 1-to-1 conversation room channel (fail closed if authorization fails)
    const roomTopic = `spark_call_1on1_${serverVerifiedConvId}`;
    const privateRoomChannel = await this.subscribePrivateChannel(roomTopic, (roomMsg) => {
      this.handleIncomingRoomSignal(
        roomMsg,
        serverVerifiedConvId,
        serverVerifiedPeer.id,
        verifiedLocalUserId
      ).catch((e) => console.warn('[VoiceCall] Room signal error:', e));
    });

    if (!privateRoomChannel) {
      console.warn('[VoiceCall] Failed closed: could not subscribe to private room channel.');
      return;
    }

    this.callRoomChannel = privateRoomChannel;
    this.activeCryptoBundle = convCryptoBundle;
    this.pendingIceCandidates = [];

    this.updateState({
      status: 'incoming',
      callId: msg.callId,
      conversationId: serverVerifiedConvId,
      isCaller: false,
      peerUser: serverVerifiedPeer,
      isMuted: false,
      isSpeakerOn: false,
      isPeerMuted: false,
      isPeerRinging: true,
      connectedAt: null,
      statusDetail: 'Incoming Voice Call...',
      errorMessage: null,
      isPrivateChannel: true,
    });

    this.startRingLoop('incoming');

    // Send signed 'call-ringing' acknowledgement over the private room channel to prove device delivery
    await this.sendSignalOnChannel(
      this.callRoomChannel,
      {
        callId: msg.callId,
        conversationId: serverVerifiedConvId,
        senderId: verifiedLocalUserId,
        targetUserId: serverVerifiedPeer.id,
        type: 'call-ringing',
        timestamp: new Date().toISOString(),
      },
      this.activeCryptoBundle
    );

    // Auto-dismiss incoming call if not answered within 45s
    this.clearTimers(['unanswered']);
    this.unansweredTimeout = setTimeout(() => {
      if (this.state.status === 'incoming' && this.state.callId === msg.callId) {
        this.endVoiceCall('Missed voice call.');
      }
    }, 45000);
  }

  /**
   * Handles signals arriving on the private conversation call room channel (`spark_call_1on1_<boundConvId>`).
   * Strictly enforces:
   * 1. Identity & active call binding check.
   * 2. Call-state machine transition validation (`isSignalAllowedInCallState`).
   * 3. Replay pre-check (`replayDetector.checkOnly`).
   * 4. Cryptographic ECDSA P-256 signature & directional AES-256-GCM verification (`verifySignedEncryptedSignal`).
   * 5. Atomic replay commit (`replayDetector.checkAndRecord`).
   * 6. WebRTC SDP / ICE / call-state processing (ONLY executed after steps 1–5 succeed).
   */
  public async handleIncomingRoomSignal(
    msg: VoiceCallSignalMessage,
    boundConversationId: string,
    boundPeerUserId: string,
    boundLocalUserId: string
  ): Promise<boolean> {
    if (
      !this.state.callId ||
      msg.callId !== this.state.callId ||
      msg.conversationId !== boundConversationId ||
      msg.senderId !== boundPeerUserId ||
      msg.targetUserId !== boundLocalUserId ||
      !this.state.peerUser ||
      this.state.peerUser.id !== boundPeerUserId
    ) {
      return false;
    }

    // 1. Validate call-state machine transition BEFORE any processing
    const stateValidation = isSignalAllowedInCallState({
      channelKind: 'room',
      signal: msg,
      currentStatus: this.state.status,
      currentCallId: this.state.callId,
      isCaller: this.state.isCaller,
      rtcSignalingState: this.peerConnection?.signalingState ?? null,
    });
    if (!stateValidation.allowed) {
      console.warn(
        `[VoiceCall] Dropped out-of-state room signal (${msg.type}):`,
        stateValidation.reason
      );
      return false;
    }

    // 2. Pre-verification replay check (rejects already-seen signalId/IV or expired timestamp)
    const replayPreCheck = this.replayDetector.checkOnly(msg);
    if (!replayPreCheck.fresh) {
      console.warn(
        `[VoiceCall] Dropped replayed room signal (${msg.type}):`,
        replayPreCheck.reason
      );
      return false;
    }

    // 3. Verify directional AES-256-GCM encryption + peer ECDSA P-256 signature BEFORE SDP/ICE processing
    const proofVerification = await verifySignedEncryptedSignal(
      msg,
      boundConversationId,
      boundPeerUserId,
      boundLocalUserId,
      this.activeCryptoBundle
    );
    if (!proofVerification.valid) {
      console.warn(
        `[VoiceCall] Dropped room signal (${msg.type}) failing cryptographic proof:`,
        proofVerification.reason
      );
      return false;
    }

    // 4. Atomically record signalId and IV in the replay detector once signature is verified
    const replayCommit = this.replayDetector.checkAndRecord(msg);
    if (!replayCommit.fresh) {
      return false;
    }

    // 5. Execute verified signal action (SDP/ICE/state update)
    switch (msg.type) {
      case 'call-ringing': {
        this.updateState({
          isPeerRinging: true,
          statusDetail: 'Ringing on recipient device...',
        });
        return true;
      }

      case 'call-busy': {
        await this.endVoiceCall(
          `${this.state.peerUser.display_name || this.state.peerUser.username} is busy in another call.`,
          false
        );
        return true;
      }

      case 'call-reject': {
        await this.endVoiceCall(
          `${this.state.peerUser.display_name || this.state.peerUser.username} declined the call.`,
          false
        );
        return true;
      }

      case 'call-end': {
        await this.endVoiceCall(msg.reason || 'Call ended.', false);
        return true;
      }

      case 'peer-mute': {
        this.updateState({
          isPeerMuted: Boolean(msg.isMuted),
        });
        return true;
      }

      case 'call-accept': {
        this.stopRingLoop();
        this.clearTimers(['invite', 'unanswered']);
        this.updateState({
          status: 'connecting',
          statusDetail: 'Connecting P2P audio (STUN)...',
        });
        await this.createAndSendOffer(boundLocalUserId);
        return true;
      }

      case 'webrtc-offer': {
        if (!msg.sdp || this.isHandlingOffer) return false;
        this.isHandlingOffer = true;
        try {
          if (!this.peerConnection) {
            this.createPeerConnection(boundLocalUserId);
          }
          const pc = this.peerConnection;
          if (!pc) return false;

          await pc.setRemoteDescription(
            typeof RTCSessionDescription !== 'undefined'
              ? new RTCSessionDescription(msg.sdp)
              : msg.sdp
          );
          await this.flushPendingIceCandidates();

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          if (this.state.callId && this.state.conversationId && this.state.peerUser) {
            await this.sendSignalOnChannel(this.callRoomChannel, {
              callId: this.state.callId,
              conversationId: boundConversationId,
              senderId: boundLocalUserId,
              targetUserId: boundPeerUserId,
              type: 'webrtc-answer',
              sdp: pc.localDescription || answer,
              timestamp: new Date().toISOString(),
            });
          }
          return true;
        } catch (err: any) {
          console.error('[VoiceCall] Error handling WebRTC offer:', err);
          await this.endVoiceCall('Failed to negotiate WebRTC audio parameters.');
          return false;
        } finally {
          this.isHandlingOffer = false;
        }
      }

      case 'webrtc-answer': {
        if (!msg.sdp || !this.peerConnection) return false;
        try {
          if (this.peerConnection.signalingState === 'have-local-offer') {
            await this.peerConnection.setRemoteDescription(
              typeof RTCSessionDescription !== 'undefined'
                ? new RTCSessionDescription(msg.sdp)
                : msg.sdp
            );
            await this.flushPendingIceCandidates();
            return true;
          }
          return false;
        } catch (err) {
          console.error('[VoiceCall] Error setting remote answer:', err);
          return false;
        }
      }

      case 'webrtc-ice': {
        if (!msg.candidate) return false;
        try {
          if (this.peerConnection && this.peerConnection.remoteDescription) {
            await this.peerConnection.addIceCandidate(
              typeof RTCIceCandidate !== 'undefined'
                ? new RTCIceCandidate(msg.candidate)
                : msg.candidate
            );
          } else {
            this.pendingIceCandidates.push(msg.candidate);
          }
          return true;
        } catch (err) {
          console.warn('[VoiceCall] Non-fatal ICE candidate error:', err);
          return false;
        }
      }

      default:
        return false;
    }
  }

  /**
   * Test-only helper allowing the automated security test suite to bind a verified session state
   * and inspect `handleIncomingRoomSignal` execution order against a mock/spy RTCPeerConnection.
   */
  public configureTestSessionForAudit(params: {
    state: Partial<VoiceCallState>;
    cryptoBundle: CallCryptoSessionBundle;
    mockPeerConnection?: RTCPeerConnection | null;
  }): void {
    this.replayDetector.clear();
    this.activeCryptoBundle = params.cryptoBundle;
    this.peerConnection = params.mockPeerConnection ?? null;
    this.updateState({
      ...INITIAL_CALL_STATE,
      ...params.state,
    });
  }

  /**
   * Accepts an incoming 1-to-1 voice call after re-verifying the authenticated session.
   */
  public async acceptIncomingCall(): Promise<{ success: boolean; error?: string }> {
    unlockSound();

    if (
      this.state.status !== 'incoming' ||
      !this.state.callId ||
      !this.state.conversationId ||
      !this.state.peerUser ||
      !this.callRoomChannel ||
      !this.activeCryptoBundle
    ) {
      return { success: false, error: 'No active authorized incoming call to accept.' };
    }

    this.stopRingLoop();
    this.clearTimers(['unanswered']);

    const sessionInfo = await this.getVerifiedSessionUser();
    if (!sessionInfo) {
      this.endVoiceCall('Session expired. Please sign in again.');
      return { success: false, error: 'Session expired.' };
    }
    const myUserId = sessionInfo.userId;

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

    const sent = await this.sendSignalOnChannel(this.callRoomChannel, {
      callId: this.state.callId,
      conversationId: this.state.conversationId,
      senderId: myUserId,
      targetUserId: this.state.peerUser.id,
      type: 'call-accept',
      timestamp: new Date().toISOString(),
    });

    if (!sent) {
      this.endVoiceCall(
        'Failed closed: could not send call acceptance on private channel.',
        false
      );
      return { success: false, error: 'Private signaling channel failed.' };
    }

    return { success: true };
  }

  /**
   * Rejects an incoming 1-to-1 voice call.
   */
  public async rejectIncomingCall(customError?: string): Promise<void> {
    this.stopRingLoop();
    const sessionInfo = await this.getVerifiedSessionUser();
    const myUserId = sessionInfo?.userId;

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

    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        track.enabled = !this.state.isMuted;
        pc.addTrack(track, this.localStream);
      }
    }

    pc.ontrack = (event: RTCTrackEvent) => {
      if (event.streams && event.streams[0]) {
        this.updateRemoteStream(event.streams[0]);
      } else if (event.track) {
        const inboundStream = new MediaStream([event.track]);
        this.updateRemoteStream(inboundStream);
      }
    };

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
        const sent = await this.sendSignalOnChannel(this.callRoomChannel, {
          callId: this.state.callId,
          conversationId: this.state.conversationId,
          senderId: myUserId,
          targetUserId: this.state.peerUser.id,
          type: 'webrtc-offer',
          sdp: pc.localDescription || offer,
          timestamp: new Date().toISOString(),
        });
        if (!sent) {
          this.endVoiceCall(
            'Failed closed: private channel rejected WebRTC offer.',
            false
          );
        }
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
        await this.peerConnection.addIceCandidate(
          typeof RTCIceCandidate !== 'undefined' ? new RTCIceCandidate(candidate) : candidate
        );
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
   * Toggles microphone mute state and notifies the remote peer over the private call room.
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
    const myUserId = sessionInfo?.userId;
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
   * closes the RTCPeerConnection, and cleans up the private Realtime room channel.
   */
  public async endVoiceCall(reason = 'Call ended.', notifyPeer = true): Promise<void> {
    this.stopRingLoop();
    if (typeof window !== 'undefined') {
      try {
        playCallEndedTone();
      } catch {}
    }

    const activeCallId = this.state.callId;
    const activeConvId = this.state.conversationId;
    const activePeer = this.state.peerUser;
    const roomCh = this.callRoomChannel;
    const activeBundle = this.activeCryptoBundle;

    if (notifyPeer && roomCh && activeCallId && activeConvId && activePeer && activeBundle) {
      const sessionInfo = await this.getVerifiedSessionUser();
      const myUserId = sessionInfo?.userId;
      if (myUserId) {
        await this.sendSignalOnChannel(
          roomCh,
          {
            callId: activeCallId,
            conversationId: activeConvId,
            senderId: myUserId,
            targetUserId: activePeer.id,
            type: 'call-end',
            reason: 'Call ended.',
            timestamp: new Date().toISOString(),
          },
          activeBundle
        );
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
      reason.toLowerCase().includes('offline') ||
      reason.toLowerCase().includes('unreachable') ||
      reason.toLowerCase().includes('missed') ||
      reason.toLowerCase().includes('unauthorized');

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
    this.pendingKeyRotationApproval = null;
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
    this.activeCryptoBundle = null;
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
    if (typeof window === 'undefined') return;
    const playFn = mode === 'incoming' ? playIncomingRingTone : playOutgoingRingbackTone;
    try {
      playFn();
    } catch {}
    if (mode === 'incoming') {
      this.showIncomingCallNotification();
    }
    const intervalMs = mode === 'incoming' ? 1800 : 2400;
    this.ringInterval = setInterval(() => {
      try {
        playFn();
      } catch {}
    }, intervalMs);
  }

  private stopRingLoop(): void {
    if (this.ringInterval) {
      clearInterval(this.ringInterval);
      this.ringInterval = null;
    }
    if (typeof window !== 'undefined') {
      try {
        stopRingTonePlayback();
      } catch {}
    }
    if (this.activeIncomingNotification) {
      try {
        this.activeIncomingNotification.close();
      } catch {}
      this.activeIncomingNotification = null;
    }
  }

  private showIncomingCallNotification(): void {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    const peerName =
      this.state.peerUser?.display_name || this.state.peerUser?.username || 'Spark Contact';
    const peerAvatar = this.state.peerUser?.avatar_url;
    try {
      const notif = new Notification(`Incoming Voice Call — ${peerName}`, {
        body: 'Tap to return to Spark and answer the voice call.',
        icon: peerAvatar,
        tag: 'spark-incoming-voice-call',
      });
      notif.onclick = () => {
        try {
          window.focus();
          notif.close();
        } catch {}
      };
      this.activeIncomingNotification = notif;
    } catch {}
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
