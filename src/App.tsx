/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import confetti from 'canvas-confetti';
import { FluidBackground } from './components/FluidBackground';
import { TopNav } from './components/TopNav';
import { HomeHub } from './components/HomeHub';
import { ChatView } from './components/ChatView';
import { AuthScreen, AuthView } from './components/AuthScreen';
import { SupabaseGuideModal } from './components/SupabaseGuideModal';
import { LoginModal } from './components/LoginModal';
import { AddFriendModal } from './components/AddFriendModal';
import { ShopModal } from './components/ShopModal';
import { LeaderboardModal } from './components/LeaderboardModal';
import { StoryViewerModal } from './components/StoryViewerModal';
import { CreateStoryModal } from './components/CreateStoryModal';
import { CreateGroupModal } from './components/CreateGroupModal';
import {
  UserProfile,
  DailyQuest,
  UserStory,
  RealConversation,
  PublicUserProfile,
  LeaderboardEntry,
} from './types';
import {
  getLocalProfile,
  saveLocalProfile,
  getLocalQuests,
  saveLocalQuests,
  getLocalStories,
  saveLocalStories,
  getWeeklyLeaderboard,
  clearUserSessionData,
  DEFAULT_STARTER_PROFILE,
  getActiveLocalSession,
  getPersistentSignedInProfile,
  findLocalAccountById,
  findLocalAccountByEmail,
} from './lib/storage';
import { getSupabase, isSupabaseConfigured } from './lib/supabase';
import {
  fetchUserRealConversations,
  getOrCreateRealConversation,
  syncProfileToSupabaseDirectory,
  syncDailyQuestsToSupabase,
  syncStoryToSupabase,
  deleteRealGroupConversation,
  deleteRealConversation,
  fetchActiveStoriesFromSupabase,
  fetchTodayQuestsFromSupabase,
  fetchRealLeaderboardFromSupabase,
} from './lib/chatService';
import {
  getOrCreateDeviceIdentityKeyPair,
  syncPublicKeyToSupabase,
  purgeCryptoSessionMemory,
} from './lib/cryptoService';
import { DataPrecisionModal } from './components/DataPrecisionModal';

export default function App() {
  // Session & Authentication state (synchronously restored so user stays signed in until explicit Sign Out)
  const [isSessionInitializing, setIsSessionInitializing] = useState<boolean>(false);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(
    () => Boolean(getPersistentSignedInProfile())
  );
  const [authView, setAuthView] = useState<AuthView>('login');
  const [sessionUser, setSessionUser] = useState<any>(null);

  // Application data state
  const [profile, setProfile] = useState<UserProfile>(
    () => getPersistentSignedInProfile() || getLocalProfile()
  );
  const [conversations, setConversations] = useState<RealConversation[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [quests, setQuests] = useState<DailyQuest[]>(getLocalQuests);
  const [stories, setStories] = useState<UserStory[]>(getLocalStories);
  const [cloudLeaderboard, setCloudLeaderboard] = useState<LeaderboardEntry[]>([]);

  // Active chat state
  const [selectedFriend, setSelectedFriend] = useState<any | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [chatOriginCoords, setChatOriginCoords] = useState<{ x: number; y: number } | null>(null);

  // Modals
  const [isSupabaseModalOpen, setIsSupabaseModalOpen] = useState(false);
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [isAddFriendModalOpen, setIsAddFriendModalOpen] = useState(false);
  const [isShopModalOpen, setIsShopModalOpen] = useState(false);
  const [isLeaderboardModalOpen, setIsLeaderboardModalOpen] = useState(false);
  const [isCreateStoryModalOpen, setIsCreateStoryModalOpen] = useState(false);
  const [isCreateGroupModalOpen, setIsCreateGroupModalOpen] = useState(false);
  const [isDataPrecisionModalOpen, setIsDataPrecisionModalOpen] = useState(false);
  const [viewingStory, setViewingStory] = useState<UserStory | null>(null);

  // Status & FX
  const [isSupabaseConnected, setIsSupabaseConnected] = useState<boolean>(isSupabaseConfigured());
  const [animatingCoins, setAnimatingCoins] = useState(false);

  const loadCloudDataForUser = useCallback(async (userProf: UserProfile) => {
    if (!userProf.id || !isSupabaseConfigured()) return;
    try {
      const [cloudStories, cloudQuests, lb] = await Promise.all([
        fetchActiveStoriesFromSupabase(),
        fetchTodayQuestsFromSupabase(userProf.id, getLocalQuests()),
        fetchRealLeaderboardFromSupabase(userProf),
      ]);

      if (cloudStories.length > 0) {
        setStories((prev) => {
          const map = new Map<string, UserStory>();
          for (const s of [...cloudStories, ...prev]) {
            if (new Date(s.expires_at).getTime() > Date.now()) {
              map.set(s.id, s);
            }
          }
          const merged = Array.from(map.values()).sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          );
          saveLocalStories(merged);
          return merged;
        });
      }

      if (cloudQuests.length > 0) {
        setQuests(cloudQuests);
        saveLocalQuests(cloudQuests);
      }

      if (lb.length > 0) {
        setCloudLeaderboard(lb);
      }
    } catch (e) {
      console.warn('Cloud data sync notice:', e);
    }
  }, []);

  // Helper to compare conversations list and prevent redundant re-renders
  const areConversationsEqual = (a: RealConversation[], b: RealConversation[]): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const itemA = a[i];
      const itemB = b[i];
      if (!itemA || !itemB) return false;
      if (
        itemA.id !== itemB.id ||
        itemA.name !== itemB.name ||
        itemA.updated_at !== itemB.updated_at ||
        itemA.has_unread !== itemB.has_unread ||
        itemA.member_count !== itemB.member_count ||
        itemA.last_message?.id !== itemB.last_message?.id ||
        itemA.last_message?.content !== itemB.last_message?.content ||
        itemA.last_message?.created_at !== itemB.last_message?.created_at ||
        itemA.other_user?.id !== itemB.other_user?.id
      ) {
        return false;
      }
    }
    return true;
  };

  // Fetch real conversations for current authenticated user
  const loadConversations = useCallback(async (userId: string, isInitial = false) => {
    if (!userId) return;
    if (isInitial) {
      setIsLoadingConversations(true);
    }
    try {
      const realConvs = await fetchUserRealConversations(userId);
      setConversations((prev) => {
        if (areConversationsEqual(prev, realConvs)) {
          return prev;
        }
        return realConvs;
      });
    } catch (e) {
      console.warn('Error loading conversations:', e);
      if (isInitial) {
        setConversations([]);
      }
    } finally {
      if (isInitial) {
        setIsLoadingConversations(false);
      }
    }
  }, []);

  // 1. Initial Session Restoration & Recovery Hash Listener
  useEffect(() => {
    // Safety timeout: never leave user trapped on restoring splash for longer than 2.5 seconds
    const safetyTimer = setTimeout(() => {
      setIsSessionInitializing(false);
    }, 2500);

    const hash = window.location.hash;
    if (hash && hash.includes('type=recovery')) {
      setAuthView('reset_password');
    }

    const restoreSavedLocalSession = (): boolean => {
      const persisted = getPersistentSignedInProfile();
      if (persisted && persisted.id && persisted.username) {
        setProfile(persisted);
        saveLocalProfile(persisted);
        setIsAuthenticated(true);
        loadConversations(persisted.id, true);
        loadCloudDataForUser(persisted);
        syncProfileToSupabaseDirectory(persisted).catch(() => {});
        syncDailyQuestsToSupabase(persisted.id, getLocalQuests()).catch(() => {});
        return true;
      }
      return false;
    };

    // Always restore saved local session immediately so user stays signed in across reloads
    const hadLocalSession = restoreSavedLocalSession();

    if (!isSupabaseConfigured()) {
      setIsSupabaseConnected(false);
      if (!hadLocalSession) {
        setIsAuthenticated(false);
      }
      setIsSessionInitializing(false);
      clearTimeout(safetyTimer);
      return;
    }

    const supabase = getSupabase();
    if (!supabase) {
      if (!hadLocalSession) {
        setIsAuthenticated(false);
      }
      setIsSessionInitializing(false);
      return;
    }

    setIsSupabaseConnected(true);

    // Restore persistent Supabase session (never overrides an active local session with a sign-out)
    supabase.auth.getSession().then(async ({ data: { session }, error }) => {
      if (error || !session?.user) {
        if (!restoreSavedLocalSession()) {
          setIsAuthenticated(false);
        }
        setIsSessionInitializing(false);
        return;
      }

      setSessionUser(session.user);

      try {
        const { data: profileData } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', session.user.id)
          .maybeSingle();

        if (profileData && profileData.username) {
          syncProfileFromDatabase(session.user, profileData);
          setIsAuthenticated(true);
          loadConversations(session.user.id, true);
          syncDailyQuestsToSupabase(session.user.id, getLocalQuests()).catch(() => {});

          // Initialize local device ECDH identity key and sync public key to Supabase
          getOrCreateDeviceIdentityKeyPair(session.user.id)
            .then(({ publicJwk }) => syncPublicKeyToSupabase(session.user.id, publicJwk))
            .catch((e) => console.warn('E2EE keypair init notice:', e));
        } else if (!restoreSavedLocalSession()) {
          setAuthView('profile_setup');
          setIsAuthenticated(false);
        }
      } catch (err) {
        console.warn('Initial session check note:', err);
        if (!restoreSavedLocalSession()) {
          setIsAuthenticated(false);
        }
      } finally {
        setIsSessionInitializing(false);
      }
    });

    // 2. Realtime Auth State Change Listener
    let subscription: { unsubscribe: () => void } | null = null;
    try {
      const authListener = supabase.auth.onAuthStateChange(async (event, session) => {
        if (event === 'PASSWORD_RECOVERY') {
          setAuthView('reset_password');
          setIsAuthenticated(false);
          setIsSessionInitializing(false);
        } else if (event === 'SIGNED_IN' && session?.user) {
          setSessionUser(session.user);
          const { data: profileData } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', session.user.id)
            .maybeSingle();

          if (profileData && profileData.username) {
            syncProfileFromDatabase(session.user, profileData);
            setIsAuthenticated(true);
            loadConversations(session.user.id, true);
            syncDailyQuestsToSupabase(session.user.id, getLocalQuests()).catch(() => {});

            getOrCreateDeviceIdentityKeyPair(session.user.id)
              .then(({ publicJwk }) => syncPublicKeyToSupabase(session.user.id, publicJwk))
              .catch((e) => console.warn('E2EE keypair init notice:', e));
          } else if (!restoreSavedLocalSession()) {
            setAuthView('profile_setup');
            setIsAuthenticated(false);
          }
          setIsSessionInitializing(false);
        } else if (event === 'SIGNED_OUT') {
          // Only sign out if the user explicitly signed out (no active persistent local session)
          if (!getPersistentSignedInProfile()) {
            purgeCryptoSessionMemory();
            setSessionUser(null);
            setIsAuthenticated(false);
            setConversations([]);
            setAuthView('login');
            setIsSessionInitializing(false);
          }
        }
      });
      subscription = authListener?.data?.subscription || null;
    } catch (err) {
      console.warn('Auth state listener notice:', err);
    }

    return () => {
      clearTimeout(safetyTimer);
      try {
        subscription?.unsubscribe();
      } catch {}
    };
  }, [loadConversations]);

  // Hidden developer shortcut to toggle Supabase Guide modal if ever needed (Ctrl+Shift+S or Cmd+Shift+S)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        setIsSupabaseModalOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Realtime conversation updates: whenever a new message, group, or conversation arrives, refresh conversations list
  useEffect(() => {
    if (!isAuthenticated || !profile.id || !isSupabaseConfigured()) return;

    const supabase = getSupabase();
    if (!supabase) return;

    let channel: any = null;
    let broadcastChannel: any = null;
    let fallbackPollTimer: any = null;

    const startFallbackPolling = () => {
      if (!fallbackPollTimer) {
        fallbackPollTimer = setInterval(() => {
          loadConversations(profile.id);
        }, 20000); // Lightweight 20s fallback activated only when Realtime is disconnected
      }
    };

    const stopFallbackPolling = () => {
      if (fallbackPollTimer) {
        clearInterval(fallbackPollTimer);
        fallbackPollTimer = null;
      }
    };

    try {
      // 1. Realtime postgres changes channel
      channel = supabase
        .channel(`user_conv_refresh_${profile.id}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'messages',
          },
          (payload) => {
            const newMsg = payload.new as any;
            if (
              !newMsg ||
              newMsg.receiver_id === profile.id ||
              newMsg.sender_id === profile.id ||
              !newMsg.receiver_id // Group messages have no receiver_id
            ) {
              loadConversations(profile.id);
            }
          }
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'conversation_members',
          },
          () => {
            loadConversations(profile.id);
          }
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'conversations',
          },
          () => {
            loadConversations(profile.id);
          }
        )
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            stopFallbackPolling();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            startFallbackPolling();
          }
        });

      // 2. Broadcast channel for instantaneous cross-device group creation notifications
      broadcastChannel = supabase
        .channel('spark_global_broadcast')
        .on('broadcast', { event: 'conversation_created' }, () => {
          loadConversations(profile.id);
        })
        .subscribe();
    } catch (err) {
      console.warn('Realtime channel subscription notice:', err);
      startFallbackPolling();
    }

    // 3. Focus & visibility listener: reload when user switches back to this browser tab or phone wakes up (throttled)
    let lastFocusRefresh = 0;
    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        const now = Date.now();
        if (now - lastFocusRefresh > 4000) {
          lastFocusRefresh = now;
          loadConversations(profile.id);
        }
      }
    };
    window.addEventListener('focus', handleVisibilityOrFocus);
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);

    // 4. Custom in-app event listeners
    const handleCustomRefresh = () => {
      loadConversations(profile.id);
    };
    window.addEventListener('spark_conversation_created', handleCustomRefresh);
    window.addEventListener('spark_conversation_deleted', handleCustomRefresh);
    window.addEventListener('spark_refresh_conversations', handleCustomRefresh);

    return () => {
      stopFallbackPolling();
      window.removeEventListener('focus', handleVisibilityOrFocus);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      window.removeEventListener('spark_conversation_created', handleCustomRefresh);
      window.removeEventListener('spark_conversation_deleted', handleCustomRefresh);
      window.removeEventListener('spark_refresh_conversations', handleCustomRefresh);

      if (channel) {
        try {
          channel.unsubscribe();
          supabase.removeChannel(channel);
        } catch {}
      }
      if (broadcastChannel) {
        try {
          broadcastChannel.unsubscribe();
          supabase.removeChannel(broadcastChannel);
        } catch {}
      }
    };
  }, [isAuthenticated, profile.id, loadConversations]);

  const syncProfileFromDatabase = (authUser: any, data: any) => {
    setProfile((prev) => {
      const merged: UserProfile = {
        ...prev,
        id: data.id,
        email: authUser.email || prev.email,
        username: data.username || prev.username,
        display_name: data.display_name || prev.display_name || data.username,
        avatar_url: data.avatar_url || prev.avatar_url,
        bio: data.bio ?? prev.bio ?? '',
        coins: data.coins ?? prev.coins,
        streak_days: data.streak_days ?? prev.streak_days,
        weekly_coins: data.weekly_coins ?? prev.weekly_coins,
        equipped_frame: data.equipped_frame || prev.equipped_frame,
        equipped_theme: data.equipped_theme || prev.equipped_theme,
        equipped_outfit: data.equipped_outfit || prev.equipped_outfit,
        unlocked_items: data.unlocked_items || prev.unlocked_items,
      };
      saveLocalProfile(merged);
      return merged;
    });
  };

  const handleAuthSuccess = (newProfile: UserProfile) => {
    setProfile(newProfile);
    saveLocalProfile(newProfile);
    setIsAuthenticated(true);
    loadConversations(newProfile.id, true);
    loadCloudDataForUser(newProfile);
    syncProfileToSupabaseDirectory(newProfile).catch(() => {});
    syncDailyQuestsToSupabase(newProfile.id, quests).catch(() => {});

    getOrCreateDeviceIdentityKeyPair(newProfile.id)
      .then(({ publicJwk }) => syncPublicKeyToSupabase(newProfile.id, publicJwk))
      .catch((e) => console.warn('E2EE key init notice:', e));
  };

  const handleSignOut = async () => {
    purgeCryptoSessionMemory();
    clearUserSessionData();

    if (isSupabaseConfigured()) {
      const supabase = getSupabase();
      if (supabase) {
        try {
          await supabase.auth.signOut();
        } catch (e) {
          console.warn('Sign out error:', e);
        }
      }
    }

    setSessionUser(null);
    setIsAuthenticated(false);
    setConversations([]);
    setSelectedFriend(null);
    setActiveConversationId(null);
    setAuthView('login');
    setProfile(DEFAULT_STARTER_PROFILE);
  };

  // Start a real conversation with another user from Search
  const handleStartChatWithUser = async (targetUser: PublicUserProfile) => {
    if (!profile.id || profile.id === targetUser.id) {
      console.warn('Cannot start conversation with yourself');
      return;
    }

    try {
      const convId = await getOrCreateRealConversation(profile.id, targetUser.id, targetUser);
      await loadConversations(profile.id);
      setActiveConversationId(convId);
      setSelectedFriend({
        id: targetUser.id,
        username: targetUser.username,
        display_name: targetUser.display_name,
        avatar_url: targetUser.avatar_url,
        streak_days: targetUser.streak_days || 1,
        is_online: true,
        conversation_id: convId,
      });
    } catch (e) {
      console.error('Failed to open chat:', e);
    }
  };

  // Select an existing conversation from Chat List
  const handleSelectConversation = (
    conv: RealConversation,
    coords?: { x: number; y: number }
  ) => {
    setChatOriginCoords(coords || null);
    setActiveConversationId(conv.id);
    setSelectedFriend({
      ...conv.other_user,
      is_group: conv.is_group,
      display_name: conv.is_group ? conv.name : (conv.other_user.display_name || conv.other_user.username),
      avatar_url: conv.is_group && conv.avatar_url ? conv.avatar_url : conv.other_user.avatar_url,
      member_count: conv.member_count,
      members: conv.members,
      created_by: conv.created_by,
      conversation_id: conv.id,
    });
  };

  const handleDeleteConversation = async (conversationId: string) => {
    try {
      const targetConv = conversations.find((c) => c.id === conversationId);
      if (targetConv?.is_group && targetConv.created_by === profile.id) {
        await deleteRealGroupConversation(conversationId, profile.id);
      } else {
        await deleteRealConversation(conversationId, profile.id);
      }
      await loadConversations(profile.id);
      if (activeConversationId === conversationId) {
        setSelectedFriend(null);
        setActiveConversationId(null);
      }
    } catch (err: any) {
      console.error('Failed to delete conversation:', err);
    }
  };

  const handleDeleteGroup = handleDeleteConversation;

  const handleGroupCreated = async (newConvId: string) => {
    const refreshed = await fetchUserRealConversations(profile.id);
    setConversations(refreshed);
    const newGroup = refreshed.find((c) => c.id === newConvId);
    if (newGroup) {
      handleSelectConversation(newGroup);
    }
  };

  const handleCloseChat = () => {
    setSelectedFriend(null);
    setActiveConversationId(null);
    setChatOriginCoords(null);
    loadConversations(profile.id);
  };

  const handleUpdateCoins = (earned: number) => {
    setAnimatingCoins(true);
    setTimeout(() => setAnimatingCoins(false), 500);

    setProfile((prev) => {
      const updated: UserProfile = {
        ...prev,
        coins: prev.coins + earned,
        weekly_coins: (prev.weekly_coins || 0) + earned,
        daily_coins_earned: prev.daily_coins_earned + earned,
      };
      saveLocalProfile(updated);

      if (isSupabaseConfigured()) {
        const supabase = getSupabase();
        if (supabase) {
          supabase
            .from('profiles')
            .update({
              coins: updated.coins,
              weekly_coins: updated.weekly_coins,
              daily_coins_earned: updated.daily_coins_earned,
              last_spark_at: new Date().toISOString(),
            })
            .eq('id', prev.id)
            .then();
        }
        fetchRealLeaderboardFromSupabase(updated)
          .then((lb) => {
            if (lb.length > 0) setCloudLeaderboard(lb);
          })
          .catch(() => {});
      }

      return updated;
    });

    // Advance daily quests & sync to Supabase daily_quests table
    setQuests((prevQuests) => {
      const nextQuests = prevQuests.map((q) => {
        if (q.completed) return q;
        if (q.id === 'quest_1' || q.id === 'quest_2' || q.id === 'quest_3') {
          const nextProg = Math.min(q.goal, q.progress + 1);
          return {
            ...q,
            progress: nextProg,
          };
        }
        return q;
      });
      saveLocalQuests(nextQuests);
      if (profile.id) {
        syncDailyQuestsToSupabase(profile.id, nextQuests).catch(() => {});
      }
      return nextQuests;
    });
  };

  const handleDeductCoins = (amount: number) => {
    setAnimatingCoins(true);
    setTimeout(() => setAnimatingCoins(false), 500);

    if (amount > 0) {
      setProfile((prev) => {
        const updated = { ...prev, coins: Math.max(0, prev.coins - amount) };
        saveLocalProfile(updated);
        return updated;
      });
    }
  };

  const handleClaimQuest = (questId: string) => {
    const targetQuest = quests.find((q) => q.id === questId);
    if (!targetQuest || targetQuest.completed) return;

    try {
      confetti({
        particleCount: 40,
        spread: 70,
        origin: { y: 0.6, x: 0.5 },
        colors: ['#ff3b69', '#38bdf8', '#fb7185', '#ffd700'],
        disableForReducedMotion: true,
      });
    } catch {}

    setQuests((prev) => {
      const next = prev.map((q) => (q.id === questId ? { ...q, completed: true } : q));
      saveLocalQuests(next);
      if (profile.id) {
        syncDailyQuestsToSupabase(profile.id, next).catch(() => {});
      }
      return next;
    });

    handleUpdateCoins(targetQuest.reward_coins);
  };

  const handleSaveProfile = (updated: UserProfile) => {
    setProfile(updated);
    saveLocalProfile(updated);
    syncProfileToSupabaseDirectory(updated).catch((err) => {
      console.warn('Sync profile on save notice:', err);
    });
    if (isSupabaseConfigured()) {
      const supabase = getSupabase();
      if (supabase && updated.id) {
        supabase
          .from('profiles')
          .update({
            display_name: updated.display_name,
            avatar_url: updated.avatar_url,
            bio: updated.bio || '',
            coins: updated.coins,
            equipped_frame: updated.equipped_frame,
            equipped_theme: updated.equipped_theme,
            equipped_outfit: updated.equipped_outfit,
            unlocked_items: updated.unlocked_items,
            updated_at: new Date().toISOString(),
          })
          .eq('id', updated.id)
          .then();
      }
    }
  };

  const handleStoryCreated = (story: UserStory) => {
    setStories((prev) => {
      const next = [story, ...prev.filter((s) => s.id !== story.id)];
      saveLocalStories(next);
      return next;
    });
    syncStoryToSupabase(story)
      .then(() => fetchActiveStoriesFromSupabase())
      .then((cloudStories) => {
        if (cloudStories.length > 0) {
          setStories((prev) => {
            const map = new Map<string, UserStory>();
            for (const s of [...cloudStories, ...prev]) {
              if (new Date(s.expires_at).getTime() > Date.now()) {
                map.set(s.id, s);
              }
            }
            const merged = Array.from(map.values()).sort(
              (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            );
            saveLocalStories(merged);
            return merged;
          });
        }
      })
      .catch(() => {});
  };

  const handleReactSpark = (storyId: string) => {
    setStories((prev) => {
      const next = prev.map((s) => {
        if (s.id === storyId) {
          const updatedStory = { ...s, spark_reactions: (s.spark_reactions || 0) + 1 };
          syncStoryToSupabase(updatedStory).catch(() => {});
          return updatedStory;
        }
        return s;
      });
      saveLocalStories(next);
      return next;
    });
    handleUpdateCoins(1);
  };

  const handleConnectionSuccess = () => {
    setIsSupabaseConnected(isSupabaseConfigured());
    if (profile.id && profile.username) {
      loadConversations(profile.id);
      loadCloudDataForUser(profile);
      syncProfileToSupabaseDirectory(profile).catch((err) => {
        console.warn('Auto-sync profile on connect notice:', err);
      });
      syncDailyQuestsToSupabase(profile.id, quests).catch(() => {});
    }
  };

  const leaderboardEntries =
    cloudLeaderboard.length > 0
      ? cloudLeaderboard.map((entry) =>
          entry.user_id === profile.id
            ? {
                ...entry,
                username: profile.username,
                avatar_url: profile.avatar_url,
                equipped_frame: profile.equipped_frame || entry.equipped_frame,
                weekly_coins: Math.max(profile.coins || 0, profile.weekly_coins || 0, entry.weekly_coins),
              }
            : entry
        )
      : getWeeklyLeaderboard(
          profile,
          conversations
            .filter((c) => Boolean(c && c.other_user))
            .map((c) => ({
              id: c.other_user?.id || c.id,
              username: c.other_user?.username || 'Friend',
              avatar_url: c.other_user?.avatar_url || '',
              streak_days: c.other_user?.streak_days || 1,
              is_online: true,
              orbit_angle: 45,
              distance: 140,
            }))
        );

  // Splash Loading State
  if (isSessionInitializing) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center relative p-4 selection:bg-[#ff3b69] selection:text-white">
        <FluidBackground />
        <div className="relative z-20 flex flex-col items-center gap-4 text-center">
          <div className="w-14 h-14 rounded-full bg-gradient-to-tr from-[#ff3b69] to-[#fb7185] flex items-center justify-center text-white shadow-lg shadow-pink-500/25 animate-droplet-squish">
            <span className="text-2xl font-black">⚡</span>
          </div>
          <div>
            <h2 className="font-display font-black text-xl text-slate-900 tracking-tight">
              Spark
            </h2>
            <p className="text-xs text-slate-500 font-medium animate-pulse mt-1">
              Restoring session...
            </p>
          </div>
          <button
            onClick={() => setIsSessionInitializing(false)}
            className="mt-3 text-xs text-slate-500 hover:text-slate-800 underline font-medium cursor-pointer transition-colors"
          >
            Taking a while? Click here to sign in
          </button>
        </div>
      </div>
    );
  }

  // Unauthenticated State: Show Authentication Screen
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center relative selection:bg-[#ff3b69] selection:text-white">
        <FluidBackground />
        <AuthScreen
          initialView={authView}
          initialUserId={sessionUser?.id || null}
          recoveryUserEmail={sessionUser?.email || null}
          onAuthSuccess={handleAuthSuccess}
        />
        <SupabaseGuideModal
          isOpen={isSupabaseModalOpen}
          onClose={() => setIsSupabaseModalOpen(false)}
          onConnectionSuccess={handleConnectionSuccess}
        />
      </div>
    );
  }

  // Authenticated State: Main Messaging Application
  return (
    <div className="min-h-screen w-full flex flex-col relative selection:bg-[#ff3b69] selection:text-white">
      {/* Full-Screen Pastel Gradient Atmosphere */}
      <FluidBackground />

      {/* Full-Screen Main Messenger Application Surface */}
      <div className="relative z-10 w-full min-h-screen flex flex-col bg-white/95 backdrop-blur-md">
        {/* Top Header */}
        <TopNav
          profile={profile}
          onOpenProfile={() => setIsLoginModalOpen(true)}
          onOpenShop={() => setIsShopModalOpen(true)}
          onOpenLeaderboard={() => setIsLeaderboardModalOpen(true)}
          onOpenDataPrecision={() => setIsDataPrecisionModalOpen(true)}
          onSignOut={handleSignOut}
          animatingCoins={animatingCoins}
        />

        {/* Home Messenger View with Real Conversations & Search */}
        <main className="flex-1 w-full flex flex-col overflow-y-auto">
          <HomeHub
            profile={profile}
            conversations={conversations}
            isLoadingConversations={isLoadingConversations}
            quests={quests}
            stories={stories}
            onSelectConversation={handleSelectConversation}
            onStartChatWithUser={handleStartChatWithUser}
            onOpenAddFriend={() => setIsAddFriendModalOpen(true)}
            onOpenProfile={() => setIsLoginModalOpen(true)}
            onOpenShop={() => setIsShopModalOpen(true)}
            onOpenLeaderboard={() => setIsLeaderboardModalOpen(true)}
            onOpenCreateStory={() => setIsCreateStoryModalOpen(true)}
            onViewStory={(story) => setViewingStory(story)}
            onClaimQuest={handleClaimQuest}
            onOpenCreateGroup={() => setIsCreateGroupModalOpen(true)}
            onDeleteGroup={handleDeleteGroup}
            onDeleteConversation={handleDeleteConversation}
            onRefreshConversations={() => loadConversations(profile.id)}
            onOpenDataPrecision={() => setIsDataPrecisionModalOpen(true)}
          />
        </main>

        {/* Screen Flow into Real ChatView */}
        {selectedFriend && (
          <ChatView
            friend={selectedFriend}
            profile={profile}
            conversationId={activeConversationId || undefined}
            onBack={handleCloseChat}
            onUpdateCoins={handleUpdateCoins}
            originCoords={chatOriginCoords}
            onGroupDeleted={handleDeleteGroup}
            onDeleteChat={handleDeleteConversation}
          />
        )}
      </div>

      {/* Real User Search & Connect Modal */}
      <AddFriendModal
        isOpen={isAddFriendModalOpen}
        onClose={() => setIsAddFriendModalOpen(false)}
        currentUserId={profile.id}
        onStartChat={handleStartChatWithUser}
        onInviteBonus={() => handleUpdateCoins(50)}
      />

      {/* Create Group Modal */}
      <CreateGroupModal
        isOpen={isCreateGroupModalOpen}
        onClose={() => setIsCreateGroupModalOpen(false)}
        currentUserId={profile.id}
        existingConversations={conversations}
        onGroupCreated={handleGroupCreated}
      />

      {/* Light Modals with Clean Surfaces */}
      <SupabaseGuideModal
        isOpen={isSupabaseModalOpen}
        onClose={() => setIsSupabaseModalOpen(false)}
        onConnectionSuccess={handleConnectionSuccess}
      />

      <LoginModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        profile={profile}
        onSaveProfile={handleSaveProfile}
        onSignOut={handleSignOut}
        onOpenDataPrecision={() => setIsDataPrecisionModalOpen(true)}
      />

      <DataPrecisionModal
        isOpen={isDataPrecisionModalOpen}
        onClose={() => setIsDataPrecisionModalOpen(false)}
        profile={profile}
        onProfileUpdated={(updated) => {
          setProfile(updated);
          saveLocalProfile(updated);
        }}
      />

      <ShopModal
        isOpen={isShopModalOpen}
        onClose={() => setIsShopModalOpen(false)}
        profile={profile}
        onUpdateProfile={handleSaveProfile}
        onDeductCoins={handleDeductCoins}
      />

      <LeaderboardModal
        isOpen={isLeaderboardModalOpen}
        onClose={() => setIsLeaderboardModalOpen(false)}
        entries={leaderboardEntries}
      />

      <StoryViewerModal
        isOpen={Boolean(viewingStory)}
        onClose={() => setViewingStory(null)}
        story={viewingStory}
        onReactSpark={handleReactSpark}
      />

      <CreateStoryModal
        isOpen={isCreateStoryModalOpen}
        onClose={() => setIsCreateStoryModalOpen(false)}
        profile={profile}
        onStoryCreated={handleStoryCreated}
      />
    </div>
  );
}
