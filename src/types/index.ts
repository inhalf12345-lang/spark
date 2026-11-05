export interface UserProfile {
  id: string;
  email?: string;
  username: string;
  display_name?: string;
  avatar_url: string;
  avatar_style?: string;
  bio?: string;
  coins: number;
  streak_days: number;
  last_spark_at?: string;
  daily_coins_earned: number;
  daily_coins_date: string;
  weekly_coins: number;
  equipped_frame: string;
  equipped_theme: string;
  equipped_outfit: string;
  unlocked_items: string[];
  created_at: string;
}

export interface PublicUserProfile {
  id: string;
  username: string;
  display_name?: string;
  avatar_url: string;
  bio?: string;
  streak_days?: number;
}

export interface RealConversation {
  id: string;
  created_at: string;
  updated_at: string;
  is_group?: boolean;
  name?: string;
  avatar_url?: string;
  member_count?: number;
  members?: PublicUserProfile[];
  created_by?: string;
  other_user: {
    id: string;
    username: string;
    display_name?: string;
    avatar_url: string;
    is_online?: boolean;
    streak_days?: number;
    equipped_frame?: string;
  };
  last_message?: {
    id: string;
    content: string;
    sender_id: string;
    created_at: string;
    media_url?: string;
  };
  has_unread?: boolean;
}

export interface ChatMessage {
  id: string;
  conversation_id?: string;
  sender_id: string;
  sender_username?: string;
  sender_display_name?: string;
  sender_avatar_url?: string;
  receiver_id?: string;
  content: string;
  media_url?: string;
  ciphertext?: string;
  iv?: string;
  encryption_version?: string;
  is_e2ee?: boolean;
  decryption_error?: boolean;
  coins_earned?: number;
  created_at: string;
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
}

export interface FriendOrb {
  id: string; // friend's user id
  username: string;
  display_name?: string;
  avatar_url: string;
  streak_days: number;
  is_online: boolean;
  orbit_angle: number;
  distance: number;
  last_message?: string;
  last_message_time?: string;
  has_unread?: boolean;
  story_active?: boolean;
  equipped_frame?: string;
  conversation_id?: string;
  is_group?: boolean;
  members?: PublicUserProfile[];
  member_count?: number;
  created_by?: string;
}

export interface FriendRequest {
  id: string;
  sender_id: string;
  sender_username: string;
  sender_avatar: string;
  sender_streak: number;
  receiver_id: string;
  status: 'pending' | 'accepted' | 'declined';
  created_at: string;
}

export interface DailyQuest {
  id: string;
  title: string;
  description: string;
  reward_coins: number;
  progress: number;
  goal: number;
  completed: boolean;
  icon_type: 'flame' | 'message' | 'streak' | 'star';
}

export type ShopCategory = 'frame' | 'theme' | 'outfit';

export interface ShopItem {
  id: string;
  category: ShopCategory;
  name: string;
  description: string;
  price: number;
  color_glow: string;
  gradient_css: string;
  badge?: string;
  icon_name: string;
}

export interface LeaderboardEntry {
  rank: number;
  user_id: string;
  username: string;
  avatar_url: string;
  weekly_coins: number;
  streak_days: number;
  is_current_user: boolean;
  equipped_frame: string;
}

export interface UserStory {
  id: string;
  user_id: string;
  username: string;
  avatar_url: string;
  media_url: string;
  media_type: 'image' | 'video';
  caption?: string;
  created_at: string;
  expires_at: string;
  spark_reactions: number;
}

export type VoiceCallStatus =
  | 'idle'
  | 'outgoing'
  | 'incoming'
  | 'connecting'
  | 'connected'
  | 'ended';

export type VoiceCallSignalType =
  | 'call-invite'
  | 'call-ringing'
  | 'call-accept'
  | 'call-reject'
  | 'call-busy'
  | 'call-end'
  | 'peer-mute'
  | 'webrtc-offer'
  | 'webrtc-answer'
  | 'webrtc-ice';

export interface PublishedPublicKeyDescriptor {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  alg: 'ECDH-ES+HKDF-256' | 'ES256';
  keyUsage: 'keyAgreement' | 'digitalSignature';
  fingerprint: string;
}

export interface PublishedIdentityBinding {
  version: 'spark_id_bind_v2';
  userId: string;
  keyRotationVersion: number;
  ecdhFingerprint: string;
  ecdsaFingerprint: string;
  issuedAt: string;
  signature: string;
}

export interface PublishedUserCryptoKeyBundle {
  // Top-level ECDH P-256 public JWK coordinates retained for backward-compatible chat E2EE
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  ext: true;
  // Explicit v2 separated key metadata
  bundleVersion: 'spark_key_bundle_v2';
  algorithm: 'ECDH-P256+ECDSA-P256-v2';
  userId: string;
  keyRotationVersion: number;
  ecdhPublicKey: PublishedPublicKeyDescriptor;
  ecdsaSigningPublicKey: PublishedPublicKeyDescriptor;
  identityBinding: PublishedIdentityBinding;
}

export interface PeerPinnedKeyRecord {
  localUserId: string;
  peerUserId: string;
  keyRotationVersion: number;
  ecdhFingerprint: string;
  ecdsaFingerprint: string;
  ecdhPublicJwk: JsonWebKey;
  ecdsaPublicJwk: JsonWebKey;
  pinnedAt: string;
  updatedAt: string;
}

export interface VoiceCallSignalMessage {
  signalId: string;
  callId: string;
  conversationId: string;
  senderId: string;
  targetUserId: string;
  type: VoiceCallSignalType;
  timestamp: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  isMuted?: boolean;
  reason?: string;
  cryptoProof?: {
    ciphertext: string;
    iv: string;
    signature: string;
    version: string;
    senderEcdsaFingerprint: string;
    keyRotationVersion: number;
  };
}

export interface VoiceCallState {
  status: VoiceCallStatus;
  callId: string | null;
  conversationId: string | null;
  isCaller: boolean;
  peerUser: PublicUserProfile | null;
  isMuted: boolean;
  isSpeakerOn: boolean;
  isPeerMuted: boolean;
  isPeerRinging: boolean;
  connectedAt: number | null;
  statusDetail: string | null;
  errorMessage: string | null;
  isPrivateChannel: boolean;
}


