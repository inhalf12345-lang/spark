import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronLeft,
  Phone,
  Video,
  Send,
  Paperclip,
  Flame,
  Droplets,
  Smile,
  AlertCircle,
  Loader2,
  Lock,
  ShieldCheck,
  Users,
  Image as ImageIcon,
  Camera,
  X,
  Maximize2,
  Download,
  Trash2,
  Info,
  Check,
  ShieldAlert,
  Bell,
  BellOff,
  Search,
  UserPlus,
  MoreHorizontal,
} from 'lucide-react';
import { ChatMessage, UserProfile, PublicUserProfile } from '../types';
import {
  evaluateMessageReward,
  appendCachedMessage,
  saveCachedMessages,
  getCachedMessages,
  getLocalStoredConversations,
} from '../lib/storage';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';
import {
  fetchRealMessages,
  sendRealMessageToSupabase,
  uploadGroupChatImage,
  resolveGroupMediaUrl,
  deleteRealGroupConversation,
  deleteRealConversation,
} from '../lib/chatService';
import {
  formatTimestampPrecision,
  getPrecisionSettings,
  DataPrecisionSettings,
} from '../lib/precisionService';
import {
  getExistingDeviceIdentityKeyPair,
  getOrCreateDeviceIdentityKeyPair,
  fetchRecipientPublicKey,
  deriveConversationKey,
  decryptE2EEMessage,
} from '../lib/cryptoService';
import { GroupPhotoButtonAndModal } from './GroupPhotoModal';
import {
  GroupTodoSection,
  GroupTodoDashboardCard,
  openGroupTodoBoardModal,
} from './GroupTodoBoard';
import { playSendSound, playReceiveSound } from '../lib/sounds';
import { isConversationMuted, toggleConversationMute } from '../lib/pushService';
import { voiceCallManager } from '../lib/callService';
import { groupVoiceCallManager } from '../lib/groupCallService';

interface ChatTargetUser {
  id: string;
  username: string;
  display_name?: string;
  avatar_url: string;
  streak_days?: number;
  is_online?: boolean;
  conversation_id?: string;
  is_group?: boolean;
  member_count?: number;
  members?: PublicUserProfile[];
  created_by?: string;
}

interface ChatViewProps {
  friend: ChatTargetUser;
  profile: UserProfile;
  conversationId?: string;
  onBack: () => void;
  onUpdateCoins: (earned: number) => void;
  originCoords?: { x: number; y: number } | null;
  onGroupDeleted?: (conversationId: string) => void;
  onDeleteChat?: (conversationId: string) => void;
}

// Subcomponent to resolve and display private Supabase Storage images asynchronously
const GroupChatImage: React.FC<{
  mediaRef: string;
  alt: string;
  onClick: (url: string) => void;
}> = ({ mediaRef, alt, onClick }) => {
  const [resolvedUrl, setResolvedUrl] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setHasError(false);

    resolveGroupMediaUrl(mediaRef)
      .then((url) => {
        if (active) {
          if (url) {
            setResolvedUrl(url);
          } else {
            setHasError(true);
          }
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setHasError(true);
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [mediaRef]);

  if (isLoading) {
    return (
      <div className="w-56 h-48 rounded-2xl bg-slate-100 flex flex-col items-center justify-center text-slate-400 gap-2">
        <Loader2 className="w-5 h-5 animate-spin text-[#ff3b69]" />
        <span className="text-[10px]">Loading photo...</span>
      </div>
    );
  }

  if (hasError || !resolvedUrl) {
    return (
      <div className="w-56 h-28 rounded-2xl bg-slate-100 flex flex-col items-center justify-center text-slate-400 p-3 text-center">
        <AlertCircle className="w-4 h-4 text-slate-400 mb-1" />
        <span className="text-[10px]">Unable to load image</span>
      </div>
    );
  }

  return (
    <div
      onClick={() => onClick(resolvedUrl)}
      className="relative group/img cursor-pointer overflow-hidden rounded-2xl max-w-xs sm:max-w-sm max-h-80 shadow-xs"
    >
      <img
        src={resolvedUrl}
        alt={alt}
        className="w-full h-auto object-cover max-h-80 transition-transform duration-200 group-hover/img:scale-[1.02]"
        loading="lazy"
      />
      <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/15 transition-colors flex items-center justify-center">
        <div className="w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity backdrop-blur-xs">
          <Maximize2 className="w-4 h-4" />
        </div>
      </div>
    </div>
  );
};

const GroupDashboardMediaThumbnail: React.FC<{
  mediaRef: string;
  alt: string;
  overlayLabel?: string;
  onClick: (url: string) => void;
}> = ({ mediaRef, alt, overlayLabel, onClick }) => {
  const [resolvedUrl, setResolvedUrl] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    resolveGroupMediaUrl(mediaRef)
      .then((url) => {
        if (active) {
          setResolvedUrl(url || '');
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mediaRef]);

  if (isLoading) {
    return (
      <div className="aspect-square rounded-2xl bg-violet-50/70 border border-violet-100 flex items-center justify-center">
        <Loader2 className="w-4 h-4 animate-spin text-[#8B5CF6]" />
      </div>
    );
  }

  if (!resolvedUrl) {
    return (
      <div className="aspect-square rounded-2xl bg-slate-100 border border-slate-200/70 flex items-center justify-center text-slate-400">
        <ImageIcon className="w-4 h-4" />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onClick(resolvedUrl)}
      className="relative aspect-square rounded-2xl overflow-hidden border border-violet-100/90 shadow-2xs group/thumb cursor-pointer bg-slate-100"
    >
      <img
        src={resolvedUrl}
        alt={alt}
        className="w-full h-full object-cover transition-transform duration-200 group-hover/thumb:scale-105"
        loading="lazy"
      />
      {overlayLabel && (
        <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-[1px] flex items-center justify-center text-white font-display font-bold text-xs">
          {overlayLabel}
        </div>
      )}
    </button>
  );
};

// Helper to check if two message instances represent the same message (prevents Realtime / HTTP send race duplicates)
function isSameOrDuplicateMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a.id && b.id && a.id === b.id) return true;
  const isSameSender = a.sender_id === b.sender_id;
  const isSameContent = (a.content || '').trim() === (b.content || '').trim();
  const isSameMedia = (a.media_url || '') === (b.media_url || '');
  if (isSameSender && isSameContent && isSameMedia) {
    if (a.created_at && b.created_at) {
      const timeDiff = Math.abs(new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      if (timeDiff < 5000) return true;
    } else {
      return true;
    }
  }
  return false;
}

function mergeAndDeduplicateMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const result = [...existing];
  for (const inc of incoming) {
    const existingIndex = result.findIndex((m) => isSameOrDuplicateMessage(m, inc));
    if (existingIndex >= 0) {
      result[existingIndex] = {
        ...result[existingIndex],
        ...inc,
        content: inc.content && !inc.decryption_error ? inc.content : result[existingIndex].content,
      };
    } else {
      result.push(inc);
    }
  }
  return result.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

export const ChatView: React.FC<ChatViewProps> = ({
  friend,
  profile,
  conversationId,
  onBack,
  onUpdateCoins,
  originCoords,
  onGroupDeleted,
  onDeleteChat,
}) => {
  const activeConvId = conversationId || friend.conversation_id || friend.id || 'default_conv';

  // Initialize immediately from cached device messages so screen is never blank or stuck loading
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    return getCachedMessages(activeConvId);
  });
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(() => {
    return getCachedMessages(activeConvId).length === 0;
  });
  const [isKeyNegotiating, setIsKeyNegotiating] = useState(!friend.is_group);
  const [conversationKey, setConversationKey] = useState<CryptoKey | null>(null);
  const conversationKeyRef = useRef<CryptoKey | null>(null);

  useEffect(() => {
    conversationKeyRef.current = conversationKey;
  }, [conversationKey]);

  // Keep local messages updated if active conversation changes
  useEffect(() => {
    const cached = getCachedMessages(activeConvId);
    setMessages(cached);
    setIsLoadingMessages(cached.length === 0);
  }, [activeConvId]);

  const [isE2EEActive, setIsE2EEActive] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isExiting, setIsExiting] = useState(false);
  const [coinDroplets, setCoinDroplets] = useState<{ id: string; amount: number; x: number }[]>([]);
  const [callNotice, setCallNotice] = useState<string | null>(null);

  // Group Details & Deletion states (creator-only deletion enforcement)
  const [isGroupInfoOpen, setIsGroupInfoOpen] = useState(false);
  const [showAllGroupMedia, setShowAllGroupMedia] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeletingGroup, setIsDeletingGroup] = useState(false);
  const [deleteGroupError, setDeleteGroupError] = useState<string | null>(null);
  const [groupCreatorId, setGroupCreatorId] = useState<string | undefined>(friend.created_by);

  // Direct 1-on-1 Chat Deletion states
  const [showDeleteDirectChatConfirm, setShowDeleteDirectChatConfirm] = useState(false);
  const [isDeletingDirectChat, setIsDeletingDirectChat] = useState(false);

  // Data Precision Settings
  const [precisionSettings, setPrecisionSettings] = useState<DataPrecisionSettings>(getPrecisionSettings());

  useEffect(() => {
    const handlePrecisionChange = (e: any) => {
      if (e.detail) {
        setPrecisionSettings(e.detail);
      } else {
        setPrecisionSettings(getPrecisionSettings());
      }
    };
    window.addEventListener('spark_precision_changed', handlePrecisionChange);
    return () => window.removeEventListener('spark_precision_changed', handlePrecisionChange);
  }, []);

  // Per-conversation notification mute state
  const [isChatMuted, setIsChatMuted] = useState<boolean>(() =>
    isConversationMuted(profile.id, activeConvId)
  );
  const [groupCallState, setGroupCallState] = useState(() =>
    groupVoiceCallManager.getState()
  );
  const [activeGroupCallStartedAt, setActiveGroupCallStartedAt] = useState<number | null>(() =>
    groupVoiceCallManager.getActiveConversationCallStartedAt(activeConvId)
  );

  useEffect(() => {
    const syncBanner = () => {
      setActiveGroupCallStartedAt(
        groupVoiceCallManager.getActiveConversationCallStartedAt(activeConvId)
      );
    };
    syncBanner();
    const unsubGroup = groupVoiceCallManager.subscribeState((nextState) => {
      setGroupCallState(nextState);
      syncBanner();
    });
    window.addEventListener('spark_group_call_ended', syncBanner);
    window.addEventListener('spark_group_call_banner_updated', syncBanner);
    return () => {
      unsubGroup();
      window.removeEventListener('spark_group_call_ended', syncBanner);
      window.removeEventListener('spark_group_call_banner_updated', syncBanner);
    };
  }, [activeConvId]);

  // Automatically hide and clear the group call banner if it is older than 5 minutes
  useEffect(() => {
    if (!activeGroupCallStartedAt) return;
    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    const elapsed = Date.now() - activeGroupCallStartedAt;
    if (elapsed >= FIVE_MINUTES_MS) {
      groupVoiceCallManager.clearConversationCallState(activeConvId);
      setActiveGroupCallStartedAt(null);
      return;
    }
    const timer = setTimeout(() => {
      groupVoiceCallManager.clearConversationCallState(activeConvId);
      setActiveGroupCallStartedAt(null);
    }, FIVE_MINUTES_MS - elapsed);
    return () => clearTimeout(timer);
  }, [activeGroupCallStartedAt, activeConvId]);

  // Observe live room presence so banner shows ONLY while a group call is actually active, and clears on load if no call is active
  useEffect(() => {
    if (!friend.is_group || !isSupabaseConfigured()) {
      groupVoiceCallManager.clearConversationCallState(activeConvId);
      setActiveGroupCallStartedAt(null);
      return;
    }
    if (
      groupCallState.status !== 'idle' &&
      groupCallState.conversationId === activeConvId
    ) {
      return;
    }
    const supabase = getSupabase();
    if (!supabase) return;

    let isMounted = true;
    const roomTopic = `spark_group_voice_room_${activeConvId}`;
    const observerChannel = supabase.channel(roomTopic, {
      config: {
        broadcast: { self: false },
      },
    });

    const evaluateRoomPresence = () => {
      if (!isMounted) return;
      const presenceState = observerChannel.presenceState();
      let earliestJoinedAt: number | null = null;
      const now = Date.now();
      const FIVE_MINUTES_MS = 5 * 60 * 1000;

      Object.entries(presenceState).forEach(([peerId, presences]) => {
        if (!peerId || peerId === profile.id) return;
        const latest = (presences as any[])?.[0];
        if (latest && latest.userId) {
          const joinedAt = Number(latest.joinedAt) || now;
          if (now - joinedAt < FIVE_MINUTES_MS) {
            if (earliestJoinedAt === null || joinedAt < earliestJoinedAt) {
              earliestJoinedAt = joinedAt;
            }
          }
        }
      });

      if (earliestJoinedAt !== null) {
        groupVoiceCallManager.setConversationCallActive(activeConvId, earliestJoinedAt);
      } else {
        groupVoiceCallManager.clearConversationCallState(activeConvId);
      }
    };

    observerChannel
      .on('presence', { event: 'sync' }, evaluateRoomPresence)
      .on('broadcast', { event: 'group_voice_signal' }, ({ payload }) => {
        if (!isMounted || !payload || payload.conversationId !== activeConvId) return;
        if (
          payload.type === 'group-peer-join' ||
          payload.type === 'group-room-announce'
        ) {
          const startedAt =
            Number(payload.participant?.joinedAt) ||
            Number(payload.timestamp) ||
            Date.now();
          groupVoiceCallManager.setConversationCallActive(activeConvId, startedAt);
        } else if (payload.type === 'group-call-end') {
          groupVoiceCallManager.clearConversationCallState(activeConvId);
        } else if (payload.type === 'group-peer-leave') {
          setTimeout(evaluateRoomPresence, 200);
        }
      })
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED' && isMounted) {
          evaluateRoomPresence();
        }
      });

    return () => {
      isMounted = false;
      try {
        observerChannel.unsubscribe();
        supabase.removeChannel(observerChannel);
      } catch {}
    };
  }, [
    friend.is_group,
    activeConvId,
    profile.id,
    groupCallState.status,
    groupCallState.conversationId,
  ]);

  useEffect(() => {
    const syncMuteState = () => {
      setIsChatMuted(isConversationMuted(profile.id, activeConvId));
    };
    syncMuteState();
    window.addEventListener('spark_push_status_changed', syncMuteState);
    return () => window.removeEventListener('spark_push_status_changed', syncMuteState);
  }, [profile.id, activeConvId]);

  const handleToggleChatMute = async () => {
    const nextMuted = await toggleConversationMute(profile.id, activeConvId);
    setIsChatMuted(nextMuted);
    setCallNotice(
      nextMuted
        ? 'Notifications muted for this conversation'
        : 'Notifications enabled for this conversation'
    );
    setTimeout(() => setCallNotice(null), 2200);
  };

  useEffect(() => {
    if (friend.is_group) {
      if (friend.created_by) {
        setGroupCreatorId(friend.created_by);
      } else {
        const local = getLocalStoredConversations(profile.id);
        const match = local.find((c: any) => c.id === activeConvId);
        if (match?.created_by) {
          setGroupCreatorId(match.created_by);
        }
      }
    }
  }, [friend.is_group, friend.created_by, activeConvId, profile.id]);

  const isGroupCreator =
    Boolean(friend.is_group) &&
    Boolean(
      groupCreatorId &&
        (groupCreatorId === profile.id ||
          groupCreatorId.toLowerCase() === profile.username.toLowerCase())
    );

  // Group Image Upload states (exclusive to group chats)
  const [selectedImageFile, setSelectedImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [lightboxImageUrl, setLightboxImageUrl] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Clean up blob URL on unmount
  useEffect(() => {
    return () => {
      if (imagePreviewUrl && imagePreviewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(imagePreviewUrl);
      }
    };
  }, [imagePreviewUrl]);

  // Set origin coordinates for liquid transition
  useEffect(() => {
    if (containerRef.current) {
      const x = originCoords?.x ? `${originCoords.x}px` : '50%';
      const y = originCoords?.y ? `${originCoords.y}px` : '50%';
      containerRef.current.style.setProperty('--origin-x', x);
      containerRef.current.style.setProperty('--origin-y', y);
    }
  }, [originCoords]);

  // Step 1: Establish E2EE ECDH Shared Key (for 1-on-1 chats) & Fetch Messages
  useEffect(() => {
    let isSubscribed = true;
    let channel: any = null;
    const supabase = isSupabaseConfigured() ? getSupabase() : null;

    const initChat = async () => {
      let derivedKey: CryptoKey | null = conversationKeyRef.current;

      // 1-on-1 Chat: negotiate pairwise ECDH AES-256-GCM key
      if (!friend.is_group) {
        setIsKeyNegotiating(true);
        try {
          const { privateKey } = await getOrCreateDeviceIdentityKeyPair(profile.id);
          const recipientPubKey = await fetchRecipientPublicKey(friend.id);

          if (recipientPubKey) {
            derivedKey = await deriveConversationKey(privateKey, recipientPubKey, activeConvId);
            conversationKeyRef.current = derivedKey;
            if (isSubscribed) {
              setConversationKey(derivedKey);
              setIsE2EEActive(true);
            }
          } else {
            console.info('Recipient has not published public key yet; message fallback active');
            if (isSubscribed) {
              setIsE2EEActive(false);
            }
          }
        } catch (cryptoErr) {
          console.warn('E2EE key derivation note:', cryptoErr);
          if (isSubscribed) {
            setIsE2EEActive(false);
          }
        } finally {
          if (isSubscribed) {
            setIsKeyNegotiating(false);
          }
        }
      } else {
        // Group chat uses Supabase RLS server-authoritative authenticated storage
        setIsKeyNegotiating(false);
        setIsE2EEActive(false);
      }

      // Fetch messages from Supabase
      try {
        const loadedMessages = await fetchRealMessages(
          activeConvId,
          profile.id,
          friend.is_group ? undefined : friend.id,
          derivedKey
        );
        if (isSubscribed) {
          const serverIds = new Set(loadedMessages.map((m) => m.id));
          setMessages((prev) => {
            const keptPrev = prev.filter((m) => m.id && serverIds.has(m.id));
            const reconciled = mergeAndDeduplicateMessages(keptPrev, loadedMessages).filter(
              (m) => m.id && serverIds.has(m.id)
            );
            saveCachedMessages(activeConvId, reconciled);
            return reconciled;
          });
          setIsLoadingMessages(false);
        }
      } catch (err) {
        console.warn('Error loading messages:', err);
        if (isSubscribed) {
          setIsLoadingMessages(false);
        }
      }
    };

    initChat();

    // Step 2: Setup Supabase Realtime Listener for Instant Incoming Messages
    if (supabase) {
      const channelName =
        activeConvId && !activeConvId.startsWith('conv_')
          ? `chat_${activeConvId}`
          : `chat_pair_${[profile.id, friend.id].sort().join('_')}`;

      try {
        channel = supabase
          .channel(channelName)
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'messages',
            },
            async (payload) => {
              const newMsg = payload.new as any;
              if (!newMsg) return;

              const isRelevant = friend.is_group
                ? newMsg.conversation_id === activeConvId
                : (newMsg.conversation_id && newMsg.conversation_id === activeConvId) ||
                  (newMsg.sender_id === friend.id && newMsg.receiver_id === profile.id) ||
                  (newMsg.sender_id === profile.id && newMsg.receiver_id === friend.id);

              if (isRelevant) {
                if (newMsg.sender_id !== profile.id) playReceiveSound();
                let displayContent = newMsg.content || '';
                let isE2EE = false;
                let decryptionError = false;

                // Decrypt incoming message if encrypted using active key ref
                const currentKey = conversationKeyRef.current;
                if (newMsg.ciphertext && newMsg.iv) {
                  if (currentKey) {
                    const decrypted = await decryptE2EEMessage(
                      newMsg.ciphertext,
                      newMsg.iv,
                      currentKey
                    );
                    if (decrypted !== null) {
                      displayContent = decrypted;
                      isE2EE = true;
                    } else {
                      displayContent = '🔒 Unable to decrypt this message';
                      decryptionError = true;
                    }
                  } else {
                    displayContent = '🔒 Unable to decrypt this message';
                    decryptionError = true;
                  }
                }

                // If sender details not included in realtime payload, resolve from friend members
                let senderName = '';
                let senderAvatar = '';
                if (friend.is_group && friend.members) {
                  const found = friend.members.find((m) => m.id === newMsg.sender_id);
                  if (found) {
                    senderName = found.display_name || found.username;
                    senderAvatar = found.avatar_url;
                  }
                }

                const processedMsg: ChatMessage = {
                  id: newMsg.id,
                  conversation_id: newMsg.conversation_id,
                  sender_id: newMsg.sender_id,
                  sender_display_name: senderName,
                  sender_avatar_url: senderAvatar,
                  receiver_id: newMsg.receiver_id,
                  content: displayContent,
                  media_url: newMsg.media_url,
                  ciphertext: newMsg.ciphertext,
                  iv: newMsg.iv,
                  encryption_version: newMsg.encryption_version,
                  is_e2ee: isE2EE,
                  decryption_error: decryptionError,
                  coins_earned: newMsg.coins_earned || 2,
                  created_at: newMsg.created_at,
                  status: 'delivered',
                };

                setMessages((prev) => {
                  const existingIndex = prev.findIndex((m) => isSameOrDuplicateMessage(m, processedMsg));
                  let next: ChatMessage[];
                  if (existingIndex >= 0) {
                    next = [...prev];
                    next[existingIndex] = {
                      ...next[existingIndex],
                      ...processedMsg,
                      content: processedMsg.content && !processedMsg.decryption_error ? processedMsg.content : next[existingIndex].content,
                      status: 'delivered',
                    };
                  } else {
                    next = [...prev, processedMsg];
                  }
                  next.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
                  saveCachedMessages(activeConvId, next);
                  return next;
                });
              }
            }
          )
          .on(
            'postgres_changes',
            {
              event: 'DELETE',
              schema: 'public',
              table: 'messages',
            },
            (payload) => {
              const deletedId = (payload.old as any)?.id;
              if (!deletedId) return;
              setMessages((prev) => {
                const next = prev.filter((m) => m.id !== deletedId);
                saveCachedMessages(activeConvId, next);
                return next;
              });
            }
          )
          .subscribe();
      } catch (err) {
        console.warn('Chat realtime channel notice:', err);
      }
    }

    return () => {
      isSubscribed = false;
      if (channel && supabase) {
        try {
          channel.unsubscribe();
          supabase.removeChannel(channel);
        } catch (e) {
          console.warn('Chat channel cleanup notice:', e);
        }
      }
    };
  }, [activeConvId, friend.id, friend.is_group, profile.id]);

  // Auto-scroll on new message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoadingMessages]);

  const handleBack = () => {
    setIsExiting(true);
    setTimeout(() => {
      onBack();
    }, 280);
  };

  const spawnCoinDroplet = (amount: number) => {
    const id = `${Date.now()}_${Math.random()}`;
    const x = Math.floor(Math.random() * 20) - 10;
    setCoinDroplets((prev) => [...prev, { id, amount, x }]);

    setTimeout(() => {
      setCoinDroplets((prev) => prev.filter((d) => d.id !== id));
    }, 1200);
  };

  const handleStartOrJoinGroupCall = async (announceInChat = true) => {
    const result = await groupVoiceCallManager.startOrJoinGroupVoiceCall({
      conversationId: activeConvId,
      groupName: friend.display_name || friend.username || 'Group Call',
      groupAvatar: friend.avatar_url,
      localProfile: profile,
      members: friend.members,
      announceInChat,
    });
    if (!result.success && result.error) {
      setCallNotice(result.error);
      setTimeout(() => setCallNotice(null), 4500);
    }
  };

  const triggerCallNotice = async (type: 'Audio Call' | 'Video Call') => {
    if (type === 'Video Call') {
      setCallNotice('Voice calling is supported for 1-to-1 and group chats. Video calling is not enabled yet.');
      setTimeout(() => setCallNotice(null), 3500);
      return;
    }

    if (friend.is_group) {
      await handleStartOrJoinGroupCall(true);
      return;
    }

    const result = await voiceCallManager.startOneToOneVoiceCall(activeConvId, friend.id);
    if (!result.success && result.error) {
      setCallNotice(result.error);
      setTimeout(() => setCallNotice(null), 4500);
    }
  };

  // Handle image file selection (group only)
  const handleImageSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setSendError('Please select a valid image file (PNG, JPG, WebP, GIF).');
      return;
    }

    // Limit to 10MB
    if (file.size > 10 * 1024 * 1024) {
      setSendError('Image size exceeds limit of 10MB.');
      return;
    }

    if (imagePreviewUrl && imagePreviewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(imagePreviewUrl);
    }

    const preview = URL.createObjectURL(file);
    setSelectedImageFile(file);
    setImagePreviewUrl(preview);
    setSendError(null);
  };

  const clearSelectedImage = () => {
    if (imagePreviewUrl && imagePreviewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(imagePreviewUrl);
    }
    setSelectedImageFile(null);
    setImagePreviewUrl(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputText.trim();
    if ((!trimmed && !selectedImageFile) || isSending) return;

    if (trimmed.length > 5000) {
      setSendError('Message exceeds maximum limit of 5000 characters.');
      return;
    }

    setSendError(null);
    setIsSending(true);

    const reward = evaluateMessageReward(trimmed || 'photo', profile.daily_coins_earned);

    try {
      let uploadedMediaPath: string | undefined = undefined;

      // Upload image to Supabase Storage if an image was selected
      if (selectedImageFile && friend.is_group) {
        setIsUploadingImage(true);
        uploadedMediaPath = await uploadGroupChatImage(activeConvId, selectedImageFile);
        setIsUploadingImage(false);
      }

      if (isSupabaseConfigured()) {
        const supabase = getSupabase();
        if (supabase) {
          const { data: sessionData } = await supabase.auth.getSession();
          const verifiedSenderId = sessionData.session?.user?.id || profile.id;

          let latestConversationKey: CryptoKey | null = null;
          if (!friend.is_group && !uploadedMediaPath) {
            try {
              const currentRecipientPubKey = await fetchRecipientPublicKey(friend.id);
              if (currentRecipientPubKey) {
                const localKeyPair =
                  (await getExistingDeviceIdentityKeyPair(verifiedSenderId)) ||
                  (await getOrCreateDeviceIdentityKeyPair(verifiedSenderId));
                latestConversationKey = await deriveConversationKey(
                  localKeyPair.privateKey,
                  currentRecipientPubKey,
                  activeConvId
                );
                conversationKeyRef.current = latestConversationKey;
                setConversationKey(latestConversationKey);
              }
            } catch {}
          }

          const savedMessage = await sendRealMessageToSupabase(
            activeConvId,
            verifiedSenderId,
            friend.is_group ? '' : friend.id,
            trimmed,
            latestConversationKey,
            uploadedMediaPath
          );
          playSendSound();

          appendCachedMessage(activeConvId, savedMessage);
          setMessages((prev) => {
            const existingIdx = prev.findIndex((m) => isSameOrDuplicateMessage(m, savedMessage));
            let next: ChatMessage[];
            if (existingIdx >= 0) {
              next = [...prev];
              next[existingIdx] = { ...next[existingIdx], ...savedMessage, status: 'delivered' };
            } else {
              next = [...prev, savedMessage];
            }
            next.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
            saveCachedMessages(activeConvId, next);
            return next;
          });
        }
      } else {
        const fallbackMsg: ChatMessage = {
          id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          conversation_id: activeConvId,
          sender_id: profile.id,
          sender_username: profile.username,
          sender_display_name: profile.display_name || profile.username,
          sender_avatar_url: profile.avatar_url,
          receiver_id: friend.is_group ? undefined : friend.id,
          content: trimmed,
          media_url: uploadedMediaPath || imagePreviewUrl || undefined,
          is_e2ee: Boolean(conversationKey),
          coins_earned: reward.coins,
          created_at: new Date().toISOString(),
          status: 'sent',
        };
        appendCachedMessage(activeConvId, fallbackMsg);
        setMessages((prev) => {
          const next = [...prev, fallbackMsg];
          saveCachedMessages(activeConvId, next);
          return next;
        });
      }

      if (reward.coins > 0) {
        spawnCoinDroplet(reward.coins);
        onUpdateCoins(reward.coins);
      }

      // Reset form & image
      setInputText('');
      clearSelectedImage();
    } catch (err: any) {
      console.error('Failed to send message:', err);
      setSendError(err?.message || 'Failed to send message. Please retry.');
    } finally {
      setIsSending(false);
      setIsUploadingImage(false);
      inputRef.current?.focus();
    }
  };

  const handleSendGroupPhoto = async (
    file: File,
    captionText: string,
    compressedDataUrl?: string
  ) => {
    if (!friend.is_group || isSending) return;
    setSendError(null);
    setIsSending(true);

    const reward = evaluateMessageReward(captionText || 'photo', profile.daily_coins_earned);

    try {
      let uploadedMediaPath = await uploadGroupChatImage(activeConvId, file);
      if (!uploadedMediaPath && compressedDataUrl) {
        uploadedMediaPath = compressedDataUrl;
      }

      if (isSupabaseConfigured()) {
        const supabase = getSupabase();
        if (supabase) {
          const { data: sessionData } = await supabase.auth.getSession();
          const verifiedSenderId = sessionData.session?.user?.id || profile.id;

          const savedMessage = await sendRealMessageToSupabase(
            activeConvId,
            verifiedSenderId,
            '',
            captionText,
            null,
            uploadedMediaPath
          );

          appendCachedMessage(activeConvId, savedMessage);
          setMessages((prev) => {
            const existingIdx = prev.findIndex((m) => isSameOrDuplicateMessage(m, savedMessage));
            let next: ChatMessage[];
            if (existingIdx >= 0) {
              next = [...prev];
              next[existingIdx] = { ...next[existingIdx], ...savedMessage, status: 'delivered' };
            } else {
              next = [...prev, savedMessage];
            }
            next.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
            saveCachedMessages(activeConvId, next);
            return next;
          });
        }
      } else {
        const fallbackMsg: ChatMessage = {
          id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          conversation_id: activeConvId,
          sender_id: profile.id,
          sender_username: profile.username,
          sender_display_name: profile.display_name || profile.username,
          sender_avatar_url: profile.avatar_url,
          content: captionText,
          media_url: uploadedMediaPath || compressedDataUrl,
          coins_earned: reward.coins,
          created_at: new Date().toISOString(),
          status: 'sent',
        };
        appendCachedMessage(activeConvId, fallbackMsg);
        setMessages((prev) => {
          const next = [...prev, fallbackMsg];
          saveCachedMessages(activeConvId, next);
          return next;
        });
      }

      if (reward.coins > 0) {
        spawnCoinDroplet(reward.coins);
        onUpdateCoins(reward.coins);
      }
    } catch (err: any) {
      setSendError(err?.message || 'Failed to send group photo.');
      throw err;
    } finally {
      setIsSending(false);
    }
  };

  const handlePostTodoSummary = async (summaryText: string) => {
    if (!friend.is_group || !summaryText.trim()) return;
    const reward = evaluateMessageReward(summaryText, profile.daily_coins_earned);
    const fallbackMsg: ChatMessage = {
      id: `msg_todo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      conversation_id: activeConvId,
      sender_id: profile.id,
      sender_username: profile.username,
      sender_display_name: profile.display_name || profile.username,
      sender_avatar_url: profile.avatar_url,
      content: summaryText,
      coins_earned: reward.coins,
      created_at: new Date().toISOString(),
      status: 'sent',
    };

    try {
      if (isSupabaseConfigured()) {
        const supabase = getSupabase();
        if (supabase) {
          const { data: sessionData } = await supabase.auth.getSession();
          const verifiedSenderId = sessionData.session?.user?.id || profile.id;
          const savedMessage = await sendRealMessageToSupabase(
            activeConvId,
            verifiedSenderId,
            '',
            summaryText,
            null,
            undefined
          );
          appendCachedMessage(activeConvId, savedMessage);
          setMessages((prev) => {
            const next = prev.some((m) => m.id === savedMessage.id)
              ? prev
              : [...prev, savedMessage];
            saveCachedMessages(activeConvId, next);
            return next;
          });
        } else {
          appendCachedMessage(activeConvId, fallbackMsg);
          setMessages((prev) => {
            const next = [...prev, fallbackMsg];
            saveCachedMessages(activeConvId, next);
            return next;
          });
        }
      } else {
        appendCachedMessage(activeConvId, fallbackMsg);
        setMessages((prev) => {
          const next = [...prev, fallbackMsg];
          saveCachedMessages(activeConvId, next);
          return next;
        });
      }

      if (reward.coins > 0) {
        spawnCoinDroplet(reward.coins);
        onUpdateCoins(reward.coins);
      }
    } catch {
      appendCachedMessage(activeConvId, fallbackMsg);
      setMessages((prev) => {
        const next = [...prev, fallbackMsg];
        saveCachedMessages(activeConvId, next);
        return next;
      });
    }
  };



  const handleDeleteGroup = async () => {
    if (!isGroupCreator) {
      setDeleteGroupError('Permission denied: Only the person who created this group can delete it.');
      return;
    }
    setIsDeletingGroup(true);
    setDeleteGroupError(null);
    try {
      await deleteRealGroupConversation(activeConvId, profile.id);
      setIsGroupInfoOpen(false);
      setShowDeleteConfirm(false);
      if (onGroupDeleted) {
        onGroupDeleted(activeConvId);
      }
      handleBack();
    } catch (err: any) {
      setDeleteGroupError(err?.message || 'Failed to delete group. Please try again.');
      setIsDeletingGroup(false);
    }
  };

  const handleDeleteDirectChat = async () => {
    setIsDeletingDirectChat(true);
    try {
      await deleteRealConversation(activeConvId, profile.id);
      setShowDeleteDirectChatConfirm(false);
      if (onDeleteChat) {
        onDeleteChat(activeConvId);
      }
      handleBack();
    } catch (err: any) {
      console.warn('Delete chat warning:', err);
      setShowDeleteDirectChatConfirm(false);
      handleBack();
    } finally {
      setIsDeletingDirectChat(false);
    }
  };

  const formatMessageTime = (isoString: string) => {
    if (!isoString) return '';
    return formatTimestampPrecision(isoString, precisionSettings);
  };

  const isCurrentGroupCallActive =
    groupCallState.status !== 'idle' && groupCallState.conversationId === activeConvId;

  const hasRecentGroupCallInvite =
    Boolean(friend.is_group) &&
    !isCurrentGroupCallActive &&
    activeGroupCallStartedAt !== null &&
    Date.now() - activeGroupCallStartedAt < 5 * 60 * 1000;

  return (
    <div
      ref={containerRef}
      className={`spark-aura-surface fixed inset-0 h-[100dvh] max-h-[100dvh] overflow-hidden z-50 flex flex-col transition-all duration-300 ${
        isExiting ? 'liquid-exit' : 'liquid-enter'
      }`}
      style={{
        background: `
          radial-gradient(circle at 15% 25%, #ede9fe 0%, #f5f3ff 42%, transparent 72%),
          radial-gradient(circle at 85% 38%, #f3e8ff 0%, #ede9fe 48%, transparent 72%),
          linear-gradient(180deg, #f8f7fc 0%, #f4f1fb 52%, #f8f7fc 100%)
        `,
      }}
    >
      {/* Spark Aura Header */}
      <header className="sticky top-0 z-20 w-full px-3 sm:px-6 py-2.5 sm:py-3 bg-white/95 backdrop-blur-md border-b border-violet-100/80 shadow-[0_4px_20px_rgba(42,30,75,0.04)] shrink-0">
        <div className="max-w-4xl lg:max-w-5xl mx-auto flex items-center justify-between gap-2">
          {/* Left: Back chevron + Avatar + User/Group info */}
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0 flex-1">
            <button
              onClick={handleBack}
              className="w-9 h-9 rounded-full flex items-center justify-center text-slate-700 hover:text-[#8B5CF6] hover:bg-violet-50 transition-colors -ml-1 active:scale-90 shrink-0"
              title="Back to Messages"
            >
              <ChevronLeft className="w-6 h-6 stroke-[2.6]" />
            </button>

            <div
              className={`flex items-center gap-2 sm:gap-2.5 min-w-0 flex-1 ${
                friend.is_group ? 'cursor-pointer hover:opacity-90' : ''
              }`}
              onClick={() => {
                if (friend.is_group) setIsGroupInfoOpen(true);
              }}
              title={friend.is_group ? 'Click for group details & settings' : undefined}
            >
              <div className="relative shrink-0">
                <div className="w-10 h-10 rounded-full p-[1.5px] bg-gradient-to-tr from-[#8B5CF6] to-[#A78BFA] shadow-xs">
                  <img
                    src={
                      friend.avatar_url ||
                      `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(
                        friend.username || 'spark'
                      )}&backgroundColor=f1f5f9`
                    }
                    alt={friend.display_name || friend.username}
                    className="w-full h-full rounded-full object-cover bg-white"
                    referrerPolicy="no-referrer"
                  />
                </div>
                {friend.is_group ? (
                  <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-[#8B5CF6] border-2 border-white flex items-center justify-center text-white">
                    <Users className="w-2.5 h-2.5" />
                  </span>
                ) : (
                  <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-white" />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <h2 className="font-display font-bold text-sm sm:text-[15px] tracking-tight text-slate-900 truncate">
                    {friend.display_name || friend.username}
                  </h2>
                  {!friend.is_group && (
                    <div className="flex items-center gap-0.5 text-[#8B5CF6] bg-violet-50 px-1.5 py-0.5 rounded-full font-bold text-[10px] shrink-0">
                      <Flame className="w-3 h-3 fill-[#8B5CF6] text-[#8B5CF6]" />
                      <span>{friend.streak_days || 1}d</span>
                    </div>
                  )}
                </div>

                {/* Status */}
                <div className="flex items-center gap-1.5 sm:gap-2 text-[10px] mt-0.5 min-w-0">
                  {friend.is_group ? (
                    <span className="text-emerald-600 font-semibold flex items-center gap-1 truncate">
                      <Users className="w-3 h-3 text-[#8B5CF6] shrink-0" />
                      <span className="truncate">
                        {friend.member_count || (friend.members?.length || 2)} members
                      </span>
                      {isGroupCreator && (
                        <span className="text-[9px] font-bold text-[#8B5CF6] bg-violet-50 border border-violet-200/60 px-1.5 py-0.2 rounded-full shrink-0">
                          Creator
                        </span>
                      )}
                    </span>
                  ) : (
                    <>
                      <span className="text-emerald-600 font-semibold shrink-0">Online</span>
                      <span className="text-slate-300 shrink-0">•</span>
                      <span className="text-slate-400 font-mono truncate">@{friend.username}</span>
                      {isKeyNegotiating ? (
                        <span className="text-amber-500 flex items-center gap-0.5 shrink-0">
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                          <span className="hidden sm:inline">Verifying keys...</span>
                        </span>
                      ) : isE2EEActive ? (
                        <span
                          className="text-emerald-600 font-semibold flex items-center gap-0.5 bg-emerald-50 px-1.5 py-0.2 rounded-full shrink-0"
                          title="Messages are end-to-end encrypted with AES-256-GCM. Supabase cannot read them."
                        >
                          <ShieldCheck className="w-3 h-3" />
                          <span className="hidden xs:inline sm:inline">Encrypted</span>
                        </span>
                      ) : (
                        <span className="text-slate-400 flex items-center gap-0.5 shrink-0">
                          <Lock className="w-2.5 h-2.5" />
                          <span className="hidden sm:inline">Direct chat</span>
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Right: Call Actions + Mute + Delete Chat / Group Info */}
          <div className="flex items-center gap-1 sm:gap-1.5 text-[#8B5CF6] shrink-0">
            <button
              type="button"
              onClick={handleToggleChatMute}
              className={`w-9 h-9 rounded-full hover:bg-violet-50 flex items-center justify-center transition-colors active:scale-90 ${
                isChatMuted ? 'text-amber-500 bg-amber-50/70' : 'text-slate-500 hover:text-[#8B5CF6]'
              }`}
              title={isChatMuted ? 'Unmute conversation notifications' : 'Mute conversation notifications'}
            >
              {isChatMuted ? <BellOff className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
            </button>
            {friend.is_group ? (
              <button
                onClick={() => setIsGroupInfoOpen(true)}
                className="w-9 h-9 rounded-full bg-violet-50/70 hover:bg-violet-100/80 flex items-center justify-center transition-colors active:scale-90 text-[#8B5CF6]"
                title="Group Info & Creator Settings"
              >
                <Info className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowDeleteDirectChatConfirm(true)}
                className="w-9 h-9 rounded-full hover:bg-rose-50 flex items-center justify-center transition-colors active:scale-90 text-slate-400 hover:text-rose-600"
                title="Delete Chat"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => triggerCallNotice('Audio Call')}
              className="w-9 h-9 rounded-full bg-violet-50/80 hover:bg-violet-100 flex items-center justify-center transition-colors active:scale-90 text-[#8B5CF6]"
              title={friend.is_group ? 'Start or Join Group Voice Call' : 'Audio Call'}
            >
              <Phone className="w-4 h-4 fill-current stroke-none" />
            </button>
            <button
              onClick={() => triggerCallNotice('Video Call')}
              className="w-9 h-9 rounded-full bg-violet-50/80 hover:bg-violet-100 flex items-center justify-center transition-colors active:scale-90 text-[#8B5CF6]"
              title="Video Call"
            >
              <Video className="w-4 h-4 fill-current stroke-none" />
            </button>
          </div>
        </div>
      </header>

      {friend.is_group && (
        <GroupTodoSection
          conversationId={activeConvId}
          groupName={friend.display_name || friend.username || 'Group Chat'}
          profile={profile}
          members={friend.members}
          onPostTodoChatSummary={handlePostTodoSummary}
        />
      )}

      {/* Live Group Voice Call Join Banner */}
      {friend.is_group && hasRecentGroupCallInvite && (
        <div className="w-full bg-gradient-to-r from-[#8B5CF6] via-[#7C3AED] to-emerald-600 text-white px-4 py-2 shadow-sm shrink-0">
          <div className="max-w-4xl lg:max-w-5xl mx-auto flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-300 animate-ping shrink-0" />
              <span className="text-xs font-bold truncate">
                Group Voice Room Open — Tap to join live audio
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => handleStartOrJoinGroupCall(false)}
                className="px-3.5 py-1 rounded-full bg-white text-[#7C3AED] hover:bg-violet-50 font-bold text-xs flex items-center gap-1.5 shadow-xs active:scale-95 transition-all shrink-0 cursor-pointer"
              >
                <Phone className="w-3.5 h-3.5 fill-current" />
                <span>Join Call</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  groupVoiceCallManager.markConversationCallEnded(activeConvId, Date.now())
                }
                className="w-6 h-6 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center transition-colors cursor-pointer"
                title="Dismiss banner"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {callNotice && (
        <div className="p-2 text-center text-xs font-semibold bg-violet-50 text-[#7C3AED] border-b border-violet-100 animate-pulse shrink-0">
          {callNotice}
        </div>
      )}

      {sendError && (
        <div className="p-2.5 text-center text-xs font-semibold bg-rose-50 text-rose-600 border-b border-rose-100 flex items-center justify-center gap-1.5 shrink-0">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{sendError}</span>
        </div>
      )}

      {/* Messages Stream */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-3.5 max-w-4xl w-full mx-auto flex flex-col">
        {isLoadingMessages && messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-16 text-slate-400 text-xs gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-[#8B5CF6]" />
            <span>Establishing secure conversation...</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-16 text-center px-4">
            <div className="w-14 h-14 rounded-full bg-violet-100/80 flex items-center justify-center text-[#8B5CF6] mb-3 shadow-inner">
              {friend.is_group ? <Users className="w-7 h-7" /> : <ShieldCheck className="w-7 h-7" />}
            </div>
            <h3 className="font-display font-bold text-base text-slate-800 mb-1">
              {friend.is_group ? friend.display_name || 'Group Chat' : 'End-to-End Encrypted'}
            </h3>
            <p className="text-xs text-slate-500 max-w-xs mb-3 leading-relaxed">
              {friend.is_group
                ? 'Welcome to the group! Send a message or share photos with everyone.'
                : `Messages are encrypted on your device and can only be read by you and @${friend.username}.`}
            </p>
            <button
              onClick={() => setInputText('Hey everyone! 👋')}
              className="px-4 py-2 rounded-full bg-violet-100/80 hover:bg-violet-200/70 text-[#7C3AED] font-bold text-xs transition-colors"
            >
              Say &quot;Hey everyone! 👋&quot;
            </button>
          </div>
        ) : (
          <>
            <div className="text-center py-1.5 flex items-center justify-center gap-1.5 text-[11px] font-medium text-slate-400">
              <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-white/80 border border-violet-100/80 shadow-2xs text-slate-500">
                <Lock className="w-3 h-3 text-[#8B5CF6]" />
                <span>
                  {friend.is_group
                    ? 'Private group with Supabase Row Level Security'
                    : 'Messages are end-to-end encrypted'}
                </span>
              </span>
            </div>

            {messages.map((msg) => {
              const isMine = msg.sender_id === profile.id;
              const senderDisplayName =
                msg.sender_display_name || msg.sender_username || (isMine ? 'You' : 'Member');
              const senderAvatar = msg.sender_avatar_url || friend.avatar_url;

              return (
                <div
                  key={msg.id}
                  className={`flex items-end gap-2 ${
                    isMine ? 'justify-end' : 'justify-start'
                  } group transition-all`}
                >
                  {!isMine && (
                    <img
                      src={
                        senderAvatar ||
                        `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(
                          senderDisplayName || 'member'
                        )}&backgroundColor=f1f5f9`
                      }
                      alt={senderDisplayName}
                      className="w-7 h-7 rounded-full object-cover bg-white mb-1 shadow-xs border border-violet-100"
                    />
                  )}

                  {/* Message Bubble (Spark Aura Soft Pastel & Lilac Pill Styling) */}
                  <div className="max-w-[82%] sm:max-w-[70%] flex flex-col items-end">
                    <div
                      className={`rounded-[22px] p-2 text-xs sm:text-sm font-medium leading-relaxed transition-transform active:scale-[0.99] ${
                        msg.decryption_error
                          ? 'bg-rose-50 text-rose-800 border border-rose-200 px-4 py-2.5 shadow-xs'
                          : isMine
                          ? 'bg-gradient-to-br from-[#8B5CF6] to-[#7C3AED] text-white rounded-br-xs shadow-[0_6px_18px_rgba(139,92,246,0.22)]'
                          : 'bg-white text-slate-800 border border-violet-100/90 rounded-bl-xs shadow-[0_4px_14px_rgba(42,30,75,0.05)]'
                      }`}
                    >
                      {/* Sender name for group messages from others */}
                      {friend.is_group && !isMine && (
                        <div className="px-2 pt-0.5 pb-1">
                          <span className="text-[11px] font-bold text-[#8B5CF6]">
                            {senderDisplayName}
                          </span>
                        </div>
                      )}

                      {/* Image Thumbnail in group */}
                      {msg.media_url && (
                        <div className="mb-1">
                          <GroupChatImage
                            mediaRef={msg.media_url}
                            alt="Group photo"
                            onClick={(url) => setLightboxImageUrl(url)}
                          />
                        </div>
                      )}

                      {/* Text content */}
                      {msg.content && (
                        <div
                          className={`break-words whitespace-pre-wrap ${
                            msg.media_url ? 'px-2 py-1' : 'px-3 py-1.5'
                          }`}
                        >
                          <p>{msg.content}</p>
                          {msg.content.includes('https://meet.google.com/') && (
                            <a
                              href={
                                msg.content.match(/https:\/\/meet\.google\.com\/[a-zA-Z0-9-]+/)?.[0] ||
                                'https://meet.google.com'
                              }
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold shadow-xs transition-all ${
                                isMine
                                  ? 'bg-white text-[#7C3AED] hover:bg-violet-50'
                                  : 'bg-emerald-600 text-white hover:bg-emerald-700'
                              }`}
                            >
                              <Video className="w-3.5 h-3.5" />
                              <span>Join Google Meet</span>
                            </a>
                          )}
                          {friend.is_group &&
                            hasRecentGroupCallInvite &&
                            /started a group voice call/i.test(msg.content) && (
                              <button
                                type="button"
                                onClick={() => handleStartOrJoinGroupCall(false)}
                                className={`mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold shadow-xs transition-all cursor-pointer ${
                                  isMine
                                    ? 'bg-white text-[#7C3AED] hover:bg-violet-50'
                                    : 'bg-emerald-600 text-white hover:bg-emerald-700'
                                }`}
                              >
                                <Phone className="w-3.5 h-3.5 fill-current" />
                                <span>Join Group Voice Call</span>
                              </button>
                            )}
                        </div>
                      )}
                    </div>

                    <div
                      className={`flex items-center gap-1 mt-0.5 px-1 text-[10px] ${
                        isMine ? 'text-slate-400 justify-end' : 'text-slate-400 justify-start'
                      }`}
                    >
                      {msg.is_e2ee && (
                        <span title="End-to-End Encrypted with AES-256-GCM">
                          <Lock className="w-2.5 h-2.5 text-emerald-500" />
                        </span>
                      )}
                      <span>{formatMessageTime(msg.created_at)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}

        <div ref={messagesEndRef} />

        {/* Floating Coin Droplets */}
        {coinDroplets.map((d) => (
          <div
            key={d.id}
            className="fixed bottom-20 left-1/2 pointer-events-none -translate-x-1/2 z-40 flex items-center gap-1 px-3 py-1 rounded-full bg-amber-400 text-slate-900 font-bold text-xs shadow-lg animate-droplet-squish"
            style={{ transform: `translate(calc(-50% + ${d.x}px), -20px)` }}
          >
            <Droplets className="w-3.5 h-3.5 text-amber-900 fill-amber-900" />
            <span>+{d.amount} Coin!</span>
          </div>
        ))}
      </div>

      {/* Image Preview Banner before sending (WhatsApp style) */}
      {imagePreviewUrl && (
        <div className="bg-violet-50/90 border-t border-violet-200/80 px-4 py-2 flex items-center justify-between gap-3 max-w-4xl mx-auto w-full backdrop-blur-md animate-fade-in">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="relative w-12 h-12 rounded-xl overflow-hidden shadow-xs border border-white shrink-0">
              <img
                src={imagePreviewUrl}
                alt="Selected preview"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold text-slate-800 truncate">Photo selected</p>
              <p className="text-[10px] text-slate-500 truncate">
                {selectedImageFile?.name} ({(Number(selectedImageFile?.size || 0) / 1024).toFixed(0)} KB)
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={clearSelectedImage}
            className="w-7 h-7 rounded-full bg-white text-slate-500 hover:text-slate-800 flex items-center justify-center shadow-xs transition-colors shrink-0"
            title="Cancel photo"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Message Composer */}
      <footer className="sticky bottom-0 w-full px-3 sm:px-6 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] bg-white/95 backdrop-blur-md border-t border-violet-100/80 shadow-[0_-4px_20px_rgba(42,30,75,0.04)] shrink-0">
        {/* Hidden file input for Group Image Sharing */}
        {friend.is_group && (
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageSelected}
            className="hidden"
          />
        )}

        <form
          onSubmit={handleSendMessage}
          className="max-w-4xl lg:max-w-5xl mx-auto flex items-center gap-2 sm:gap-2.5 relative"
        >
          {/* Group-Only WhatsApp-Style Picture Sender (Hidden in 1-to-1 chats) */}
          {friend.is_group && (
            <GroupPhotoButtonAndModal
              groupName={friend.display_name || friend.username || 'Group Chat'}
              isSending={isSending}
              onSendPhoto={handleSendGroupPhoto}
            />
          )}

          <div className="relative flex-1">
            <input
              ref={inputRef}
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={
                selectedImageFile
                  ? 'Add a caption to your photo...'
                  : friend.is_group
                  ? 'Message the group...'
                  : 'Type a message...'
              }
              className="w-full py-2.5 pl-4 pr-9 rounded-full text-xs sm:text-sm bg-[#f8f7fc] border border-violet-200/70 text-slate-800 placeholder-slate-400 focus:outline-none focus:border-[#8B5CF6] focus:bg-white transition-all shadow-inner"
            />
            <button
              type="button"
              onClick={() => setInputText((prev) => `${prev} ✨`)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-[#8B5CF6] transition-colors"
            >
              <Smile className="w-4 h-4" />
            </button>
          </div>

          <button
            type="submit"
            disabled={(!inputText.trim() && !selectedImageFile) || isSending}
            className={`w-10 h-10 rounded-full flex items-center justify-center text-white transition-all shadow-md shadow-violet-500/25 active:scale-90 shrink-0 ${
              inputText.trim() || selectedImageFile
                ? 'bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] hover:opacity-95'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed shadow-none'
            }`}
            title="Send Message"
          >
            {isSending ? (
              <Loader2 className="w-4 h-4 animate-spin text-white" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </form>
      </footer>

      {/* Lightbox Modal: Tap an image to view it larger */}
      {lightboxImageUrl && (
        <div
          className="fixed inset-0 z-60 bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-4 animate-fade-in"
          onClick={() => setLightboxImageUrl(null)}
        >
          {/* Top Bar */}
          <div className="w-full max-w-4xl flex items-center justify-between pb-3 text-white">
            <span className="text-xs font-semibold text-slate-300">Group Photo</span>
            <div className="flex items-center gap-3">
              <a
                href={lightboxImageUrl}
                target="_blank"
                rel="noreferrer"
                download="spark-image.jpg"
                onClick={(e) => e.stopPropagation()}
                className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
                title="Download / Open Full"
              >
                <Download className="w-4 h-4" />
              </a>
              <button
                onClick={() => setLightboxImageUrl(null)}
                className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
                title="Close Viewer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Centered Image */}
          <div
            className="max-w-4xl max-h-[82vh] overflow-hidden flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={lightboxImageUrl}
              alt="Fullscreen View"
              className="max-w-full max-h-[82vh] object-contain rounded-2xl shadow-2xl"
            />
          </div>
        </div>
      )}

      {/* Group Dashboard & Details Modal */}
      {friend.is_group && isGroupInfoOpen && (
        <div
          className="fixed inset-0 z-60 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in"
          onClick={() => {
            if (!isDeletingGroup) {
              setIsGroupInfoOpen(false);
              setShowDeleteConfirm(false);
              setDeleteGroupError(null);
            }
          }}
        >
          <div
            className="w-full max-w-md bg-[#f8f7fc] rounded-[32px] shadow-2xl border border-violet-100/90 overflow-hidden flex flex-col max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Dashboard Header */}
            <div className="flex items-center justify-between px-5 py-3.5 bg-white/95 border-b border-violet-100/80">
              <div className="flex items-center gap-2.5 min-w-0">
                <button
                  type="button"
                  disabled={isDeletingGroup}
                  onClick={() => {
                    setIsGroupInfoOpen(false);
                    setShowDeleteConfirm(false);
                    setDeleteGroupError(null);
                  }}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-slate-700 hover:bg-violet-50 transition-colors shrink-0 cursor-pointer"
                  title="Back to Chat"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <div className="relative shrink-0">
                  <img
                    src={
                      friend.avatar_url ||
                      `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(
                        friend.username || 'group'
                      )}&backgroundColor=f1f5f9`
                    }
                    alt={friend.display_name || friend.username}
                    className="w-10 h-10 rounded-full object-cover bg-white border border-violet-200"
                  />
                  <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-white" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-display font-bold text-sm text-slate-900 truncate">
                    {friend.display_name || friend.username}
                  </h3>
                  <p className="text-[11px] text-emerald-600 font-semibold">
                    {friend.member_count || friend.members?.length || 2} members
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={isDeletingGroup}
                onClick={() => {
                  setIsGroupInfoOpen(false);
                  setShowDeleteConfirm(false);
                  setDeleteGroupError(null);
                }}
                className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Dashboard Body */}
            <div className="p-4 sm:p-5 space-y-4 overflow-y-auto">
              {/* 1. Group Banner Card */}
              <div className="relative rounded-3xl overflow-hidden bg-gradient-to-br from-[#8B5CF6] via-[#7C3AED] to-[#4F46E5] p-5 text-white shadow-md shadow-violet-500/15">
                <div className="relative z-10 space-y-1">
                  <span className="inline-block px-2.5 py-0.5 rounded-full bg-white/20 backdrop-blur-xs text-[10px] font-bold uppercase tracking-wider">
                    Spark Group Space
                  </span>
                  <h4 className="font-display font-extrabold text-base sm:text-lg tracking-tight">
                    Together in {friend.display_name || friend.username} ✨
                  </h4>
                  <p className="text-xs text-violet-100/90">
                    Stay connected, share updates, and track daily group tasks together.
                  </p>
                </div>
              </div>

              {/* 2. Group Action Shortcuts Row */}
              <div className="grid grid-cols-4 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsGroupInfoOpen(false);
                    setTimeout(() => inputRef.current?.focus(), 100);
                  }}
                  className="py-2.5 px-2 rounded-2xl bg-white hover:bg-violet-50/70 border border-violet-100/90 shadow-2xs flex flex-col items-center justify-center gap-1 transition-all active:scale-95 cursor-pointer"
                >
                  <Search className="w-4 h-4 text-[#8B5CF6]" />
                  <span className="text-[11px] font-semibold text-slate-700">Search</span>
                </button>

                <button
                  type="button"
                  onClick={() => openGroupTodoBoardModal(activeConvId, 'my_todo')}
                  className="py-2.5 px-2 rounded-2xl bg-white hover:bg-violet-50/70 border border-violet-100/90 shadow-2xs flex flex-col items-center justify-center gap-1 transition-all active:scale-95 cursor-pointer"
                >
                  <UserPlus className="w-4 h-4 text-[#8B5CF6]" />
                  <span className="text-[11px] font-semibold text-slate-700">Add</span>
                </button>

                <button
                  type="button"
                  onClick={handleToggleChatMute}
                  className="py-2.5 px-2 rounded-2xl bg-white hover:bg-violet-50/70 border border-violet-100/90 shadow-2xs flex flex-col items-center justify-center gap-1 transition-all active:scale-95 cursor-pointer"
                >
                  {isChatMuted ? (
                    <BellOff className="w-4 h-4 text-amber-500" />
                  ) : (
                    <Bell className="w-4 h-4 text-[#8B5CF6]" />
                  )}
                  <span className="text-[11px] font-semibold text-slate-700">
                    {isChatMuted ? 'Muted' : 'Notifications'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => openGroupTodoBoardModal(activeConvId, 'group_progress')}
                  className="py-2.5 px-2 rounded-2xl bg-white hover:bg-violet-50/70 border border-violet-100/90 shadow-2xs flex flex-col items-center justify-center gap-1 transition-all active:scale-95 cursor-pointer"
                >
                  <MoreHorizontal className="w-4 h-4 text-[#8B5CF6]" />
                  <span className="text-[11px] font-semibold text-slate-700">More</span>
                </button>
              </div>

              {/* 3. Group To-Do List Section (Below Group Action Shortcuts & Above Group Media) */}
              <GroupTodoDashboardCard
                conversationId={activeConvId}
                profile={profile}
                members={friend.members}
                onOpenFullBoard={(tab = 'group_progress') => {
                  openGroupTodoBoardModal(activeConvId, tab);
                }}
              />

              {/* 4. Group Media Section */}
              {(() => {
                const mediaMessages = messages.filter((m) => Boolean(m.media_url));
                const visibleMedia = showAllGroupMedia
                  ? mediaMessages
                  : mediaMessages.slice(0, 4);
                const extraCount = Math.max(0, mediaMessages.length - 4);

                return (
                  <div className="rounded-3xl bg-white/95 border border-violet-100/90 shadow-[0_8px_26px_rgba(42,30,75,0.06)] p-4 sm:p-5 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="font-display font-bold text-sm sm:text-[15px] text-slate-900 tracking-tight">
                        Group Media
                      </h4>
                      {mediaMessages.length > 4 && (
                        <button
                          type="button"
                          onClick={() => setShowAllGroupMedia((prev) => !prev)}
                          className="text-xs font-bold text-[#8B5CF6] hover:text-violet-700 flex items-center gap-1 transition-colors cursor-pointer"
                        >
                          <span>{showAllGroupMedia ? 'Show less' : 'See all →'}</span>
                        </button>
                      )}
                    </div>

                    {mediaMessages.length === 0 ? (
                      <div className="py-5 px-3 rounded-2xl bg-[#f8f7fc] border border-dashed border-violet-200/70 text-center text-xs text-slate-400">
                        No photos shared in this group yet.
                      </div>
                    ) : (
                      <div className="grid grid-cols-4 gap-2">
                        {visibleMedia.map((m, idx) => (
                          <GroupDashboardMediaThumbnail
                            key={m.id}
                            mediaRef={m.media_url!}
                            alt={m.content || 'Group media'}
                            overlayLabel={
                              !showAllGroupMedia && idx === 3 && extraCount > 0
                                ? `+${extraCount}`
                                : undefined
                            }
                            onClick={(url) => {
                              if (!showAllGroupMedia && idx === 3 && extraCount > 0) {
                                setShowAllGroupMedia(true);
                              } else {
                                setLightboxImageUrl(url);
                              }
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* 5. Group Members Section */}
              {friend.members && friend.members.length > 0 && (
                <div className="rounded-3xl bg-white/95 border border-violet-100/90 shadow-[0_8px_26px_rgba(42,30,75,0.06)] p-4 sm:p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h5 className="font-display font-bold text-sm text-slate-900">
                      Members ({friend.member_count || friend.members.length})
                    </h5>
                  </div>
                  <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                    {friend.members.map((m) => {
                      const isOwner =
                        groupCreatorId === m.id || (isGroupCreator && m.id === profile.id);
                      return (
                        <div
                          key={m.id}
                          className="flex items-center justify-between p-2 rounded-xl bg-slate-50/80 border border-slate-100 text-xs"
                        >
                          <div className="flex items-center gap-2 truncate">
                            <img
                              src={
                                m.avatar_url ||
                                `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(
                                  m.username || 'member'
                                )}&backgroundColor=f1f5f9`
                              }
                              alt={m.username}
                              className="w-7 h-7 rounded-full object-cover bg-white shrink-0"
                            />
                            <div className="truncate">
                              <span className="font-semibold text-slate-800 truncate block">
                                {m.display_name || m.username}
                              </span>
                              <span className="text-[10px] text-slate-400 font-mono block">
                                @{m.username}
                              </span>
                            </div>
                          </div>
                          {isOwner && (
                            <span className="text-[10px] font-bold text-[#8B5CF6] bg-violet-50 px-2 py-0.5 rounded-full shrink-0">
                              Creator
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Creator Status Indicator */}
              {isGroupCreator ? (
                <div className="p-3 rounded-2xl bg-emerald-50/80 border border-emerald-200/80 text-emerald-800 text-xs flex items-center gap-2.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                  <div>
                    <span className="font-bold">Group Creator / Owner: </span>
                    <span>You created this group and have full administrator permissions.</span>
                  </div>
                </div>
              ) : (
                <div className="p-3 rounded-2xl bg-white border border-violet-100 text-slate-600 text-xs flex items-center gap-2.5">
                  <Lock className="w-4 h-4 text-slate-400 shrink-0" />
                  <div>
                    <span className="font-semibold">Role: Member · </span>
                    <span className="text-slate-500">
                      Only the person who created this group can delete it.
                    </span>
                  </div>
                </div>
              )}

              {/* Danger Zone: ONLY shown to group creator */}
              {isGroupCreator && (
                <div className="pt-1">
                  <div className="p-4 rounded-2xl bg-rose-50/70 border border-rose-200/80 space-y-3">
                    <div className="flex items-start gap-2.5">
                      <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                      <div>
                        <h5 className="text-xs font-bold text-rose-900">Delete Group</h5>
                        <p className="text-[11px] text-rose-700/90 leading-relaxed mt-0.5">
                          Permanently delete this group for all members. All message history, media, and group tasks will be removed.
                        </p>
                      </div>
                    </div>

                    {deleteGroupError && (
                      <div className="p-2 rounded-xl bg-white border border-rose-300 text-rose-600 text-xs font-semibold flex items-center gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        <span>{deleteGroupError}</span>
                      </div>
                    )}

                    {!showDeleteConfirm ? (
                      <button
                        type="button"
                        onClick={() => setShowDeleteConfirm(true)}
                        className="w-full py-2.5 px-4 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-xs transition-colors active:scale-98 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete Group (Creator Only)</span>
                      </button>
                    ) : (
                      <div className="space-y-2 p-3 rounded-xl bg-white border border-rose-200 animate-in fade-in">
                        <p className="text-xs font-bold text-slate-900 text-center">
                          Confirm deletion of &quot;{friend.display_name || friend.username}&quot;?
                        </p>
                        <p className="text-[10px] text-slate-500 text-center">
                          This action cannot be undone.
                        </p>
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            type="button"
                            disabled={isDeletingGroup}
                            onClick={() => setShowDeleteConfirm(false)}
                            className="flex-1 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={isDeletingGroup}
                            onClick={handleDeleteGroup}
                            className="flex-1 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50"
                          >
                            {isDeletingGroup ? (
                              <>
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                <span>Deleting...</span>
                              </>
                            ) : (
                              <>
                                <Trash2 className="w-3.5 h-3.5" />
                                <span>Yes, Delete</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3 bg-white border-t border-violet-100/80 flex justify-end">
              <button
                type="button"
                disabled={isDeletingGroup}
                onClick={() => {
                  setIsGroupInfoOpen(false);
                  setShowDeleteConfirm(false);
                }}
                className="px-4 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Direct Chat Deletion Confirmation Dialog */}
      {showDeleteDirectChatConfirm && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in"
          onClick={() => {
            if (!isDeletingDirectChat) setShowDeleteDirectChatConfirm(false);
          }}
        >
          <div
            className="w-full max-w-sm bg-white rounded-3xl p-6 shadow-2xl border border-slate-100 text-center space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-12 h-12 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center mx-auto">
              <Trash2 className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-display font-bold text-base text-slate-900">
                Delete Chat with @{friend.username}?
              </h3>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                This will delete this conversation and all messages from your chat list.
              </p>
            </div>
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                disabled={isDeletingDirectChat}
                onClick={() => setShowDeleteDirectChatConfirm(false)}
                className="flex-1 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDeletingDirectChat}
                onClick={handleDeleteDirectChat}
                className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50"
              >
                {isDeletingDirectChat ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Deleting...</span>
                  </>
                ) : (
                  <span>Delete Chat</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
