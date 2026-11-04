import { getSupabase, isSupabaseConfigured } from './supabase';

/**
 * Default VAPID Public Key for Spark Web Push Notifications (P-256 uncompressed base64url).
 * NOTE: Only the PUBLIC key is placed in client code. The matching VAPID PRIVATE key
 * is strictly stored in Supabase Edge Function secrets (VAPID_PRIVATE_KEY) and NEVER in frontend code.
 */
export const DEFAULT_VAPID_PUBLIC_KEY =
  (import.meta as any).env?.VITE_VAPID_PUBLIC_KEY || '';

const PUSH_PREFS_STORAGE_PREFIX = 'spark_push_prefs_v1_';
const CUSTOM_VAPID_PUB_KEY_STORAGE = 'spark_custom_vapid_public_key';

export interface NotificationPreferences {
  user_id: string;
  push_enabled: boolean;
  dm_enabled: boolean;
  group_enabled: boolean;
  muted_conversations: string[];
  updated_at: string;
}

export interface PushSubscriptionRecord {
  id?: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string;
  created_at?: string;
  updated_at?: string;
}

export function getActiveVapidPublicKey(): string {
  try {
    const custom = localStorage.getItem(CUSTOM_VAPID_PUB_KEY_STORAGE);
    if (custom && custom.trim().length > 40) {
      return custom.trim();
    }
  } catch {}
  return DEFAULT_VAPID_PUBLIC_KEY;
}

export function setCustomVapidPublicKey(pubKey: string): void {
  try {
    if (!pubKey.trim()) {
      localStorage.removeItem(CUSTOM_VAPID_PUB_KEY_STORAGE);
    } else {
      localStorage.setItem(CUSTOM_VAPID_PUB_KEY_STORAGE, pubKey.trim());
    }
  } catch {}
}

/**
 * Converts a URL-safe base64 VAPID public key into a Uint8Array for PushManager.subscribe().
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window
    .btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generates a fresh P-256 VAPID keypair 100% locally inside the user's browser using Web Crypto API.
 * Neither key is ever sent to chat logs or committed to GitHub.
 */
export async function generateLocalVapidKeyPairInBrowser(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const keyPair = await window.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const rawPublic = await window.crypto.subtle.exportKey('raw', keyPair.publicKey);
  const jwkPrivate = await window.crypto.subtle.exportKey('jwk', keyPair.privateKey);

  const publicKey = uint8ArrayToBase64Url(new Uint8Array(rawPublic));
  const privateKey = jwkPrivate.d || '';

  if (!publicKey || !privateKey) {
    throw new Error('Browser Web Crypto failed to export P-256 VAPID keys.');
  }

  return { publicKey, privateKey };
}

/**
 * Checks if Web Push notifications and Service Workers are supported by the current browser.
 */
export function isWebPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Returns the current browser notification permission state ('granted', 'denied', 'default', or 'unsupported').
 */
export function getBrowserNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!isWebPushSupported()) return 'unsupported';
  return Notification.permission;
}

/**
 * Resolves the Service Worker script URL so it works both at "/" in development
 * and under "/spark/" on GitHub Pages without creating conflicting registrations.
 */
export function resolveServiceWorkerUrl(): { swUrl: string; scope: string } {
  const baseUrl = (import.meta as any).env?.BASE_URL || './';
  if (typeof window === 'undefined') {
    return { swUrl: '/sw.js', scope: '/' };
  }
  const pathname = window.location.pathname;
  // Detect GitHub Pages "/spark/" deployment path
  if (pathname.startsWith('/spark/') || pathname === '/spark') {
    return { swUrl: '/spark/sw.js', scope: '/spark/' };
  }
  if (baseUrl && baseUrl !== './' && baseUrl !== '/') {
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    return { swUrl: `${normalizedBase}sw.js`, scope: normalizedBase };
  }
  return { swUrl: './sw.js', scope: './' };
}

/**
 * Registers or retrieves the existing Spark Service Worker without requesting permission automatically.
 */
export async function registerSparkServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isWebPushSupported()) return null;

  try {
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing) {
      return existing;
    }
    const { swUrl, scope } = resolveServiceWorkerUrl();
    const registration = await navigator.serviceWorker.register(swUrl, { scope });
    await navigator.serviceWorker.ready;
    return registration;
  } catch (err) {
    console.warn('Service worker registration notice:', err);
    return null;
  }
}

/**
 * Returns the active PushSubscription on the current browser/device, if one exists.
 */
export async function getCurrentDevicePushSubscription(): Promise<PushSubscription | null> {
  if (!isWebPushSupported()) return null;
  try {
    const registration = await registerSparkServiceWorker();
    if (!registration || !registration.pushManager) return null;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Extracts endpoint, p256dh, and auth keys from a browser PushSubscription object.
 */
function serializePushSubscription(
  sub: PushSubscription,
  userId: string
): PushSubscriptionRecord | null {
  const json = sub.toJSON();
  const endpoint = json.endpoint || sub.endpoint;
  const p256dh = json.keys?.p256dh || '';
  const auth = json.keys?.auth || '';
  if (!endpoint || !p256dh || !auth) return null;

  return {
    user_id: userId,
    endpoint,
    p256dh,
    auth,
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 250) : 'web',
    updated_at: new Date().toISOString(),
  };
}

/**
 * Explicit user-initiated action:
 * 1. Requests browser Notification permission (ONLY when user clicks "Enable Notifications").
 * 2. Subscribes the Service Worker's PushManager using the VAPID public key.
 * 3. Saves/upserts the subscription in Supabase `push_subscriptions` for the authenticated user.
 */
export async function subscribeUserToWebPush(userId: string): Promise<{
  success: boolean;
  permission: NotificationPermission | 'unsupported';
  subscription?: PushSubscriptionRecord;
  error?: string;
}> {
  if (!isWebPushSupported()) {
    return {
      success: false,
      permission: 'unsupported',
      error: 'Web Push is not supported in this browser. On Android, please open Spark in Google Chrome.',
    };
  }

  if (!userId) {
    return {
      success: false,
      permission: Notification.permission,
      error: 'Please sign in first to enable notifications.',
    };
  }

  try {
    // 1. Request browser notification permission explicitly on user gesture
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return {
        success: false,
        permission,
        error:
          permission === 'denied'
            ? 'Notification permission is blocked by your browser. Tap the lock/tune icon in your Chrome address bar → Permissions → Notifications → Allow.'
            : 'Notification permission was dismissed.',
      };
    }

    // 2. Ensure Service Worker is active
    const registration = await registerSparkServiceWorker();
    if (!registration) {
      return {
        success: false,
        permission,
        error: 'Could not register the Spark Service Worker. Check that you are on HTTPS or localhost.',
      };
    }

    // 3. Check for existing subscription; if it was created with an older/invalidated VAPID key, unsubscribe and rotate it
    let pushSub = await registration.pushManager.getSubscription();
    let vapidKey = getActiveVapidPublicKey();

    // Try fetching the canonical VAPID_PUBLIC_KEY from the Supabase Edge Function so all devices stay in sync
    try {
      const supabaseUrl = (import.meta as any).env?.VITE_SUPABASE_URL || 'https://zyyaeuiprnrezuuqdmyt.supabase.co';
      const resp = await fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
        method: 'GET',
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.publicKey && typeof data.publicKey === 'string' && data.publicKey.trim().length > 40) {
          vapidKey = data.publicKey.trim();
          setCustomVapidPublicKey(vapidKey);
        }
      }
    } catch {}

    if (!vapidKey || vapidKey.length < 40) {
      const generated = await generateLocalVapidKeyPairInBrowser();
      setCustomVapidPublicKey(generated.publicKey);
      vapidKey = generated.publicKey;
    }
    const applicationServerKey = urlBase64ToUint8Array(vapidKey);

    if (pushSub && pushSub.options?.applicationServerKey) {
      const existingKeyBytes = new Uint8Array(pushSub.options.applicationServerKey);
      const isSameKey =
        existingKeyBytes.length === applicationServerKey.length &&
        existingKeyBytes.every((b, idx) => b === applicationServerKey[idx]);
      if (!isSameKey) {
        try {
          await pushSub.unsubscribe();
        } catch {}
        pushSub = null;
      }
    }

    if (!pushSub) {
      pushSub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey as BufferSource,
      });
    }

    const record = serializePushSubscription(pushSub, userId);
    if (!record) {
      return {
        success: false,
        permission,
        error: 'Browser returned an incomplete push subscription.',
      };
    }

    // 4. Sync subscription to Supabase `push_subscriptions` table (supports multiple devices per user)
    await syncSubscriptionToSupabase(record);

    // 5. Mark push_enabled = true in preferences
    const prefs = getLocalNotificationPreferences(userId);
    await saveNotificationPreferences(userId, { ...prefs, push_enabled: true });

    window.dispatchEvent(new CustomEvent('spark_push_status_changed'));

    return {
      success: true,
      permission: 'granted',
      subscription: record,
    };
  } catch (err: any) {
    console.warn('Web Push subscription error:', err);
    return {
      success: false,
      permission: Notification.permission,
      error: err?.message || 'Failed to subscribe to Web Push notifications.',
    };
  }
}

/**
 * Silently refreshes/syncs the current device's subscription to Supabase if the user has ALREADY granted permission
 * and enabled notifications (never triggers a permission prompt).
 */
export async function syncExistingPushSubscriptionIfGranted(userId: string): Promise<void> {
  if (!userId || !isWebPushSupported()) return;
  if (Notification.permission !== 'granted') return;

  const prefs = getLocalNotificationPreferences(userId);
  if (!prefs.push_enabled) return;

  try {
    const sub = await getCurrentDevicePushSubscription();
    if (sub) {
      const record = serializePushSubscription(sub, userId);
      if (record) {
        await syncSubscriptionToSupabase(record);
      }
    }
  } catch {}
}

/**
 * Unsubscribes the current browser/device from Web Push and removes its endpoint from Supabase.
 */
export async function unsubscribeUserFromWebPush(userId: string): Promise<boolean> {
  try {
    const sub = await getCurrentDevicePushSubscription();
    const endpoint = sub?.endpoint;

    if (sub) {
      try {
        await sub.unsubscribe();
      } catch {}
    }

    if (endpoint && isSupabaseConfigured()) {
      const supabase = getSupabase();
      if (supabase) {
        await supabase
          .from('push_subscriptions')
          .delete()
          .eq('user_id', userId)
          .eq('endpoint', endpoint);
      }
    }

    const prefs = getLocalNotificationPreferences(userId);
    await saveNotificationPreferences(userId, { ...prefs, push_enabled: false });

    window.dispatchEvent(new CustomEvent('spark_push_status_changed'));
    return true;
  } catch (err) {
    console.warn('Error unsubscribing from Web Push:', err);
    return false;
  }
}

/**
 * Upserts a device push subscription into Supabase `push_subscriptions`.
 */
async function syncSubscriptionToSupabase(record: PushSubscriptionRecord): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const supabase = getSupabase();
  if (!supabase) return;

  try {
    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        user_id: record.user_id,
        endpoint: record.endpoint,
        p256dh: record.p256dh,
        auth: record.auth,
        user_agent: record.user_agent,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' }
    );
    if (error) {
      console.warn('Supabase push_subscriptions upsert notice:', error.message);
    }
  } catch (e) {
    console.warn('Failed to sync push subscription to Supabase:', e);
  }
}

/**
 * Fetches all registered device subscriptions for the current user from Supabase.
 */
export async function fetchUserPushSubscriptions(
  userId: string
): Promise<PushSubscriptionRecord[]> {
  if (!userId || !isSupabaseConfigured()) return [];
  const supabase = getSupabase();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (!error && Array.isArray(data)) {
      return data as PushSubscriptionRecord[];
    }
  } catch {}
  return [];
}

/**
 * Local & Cloud Notification Preferences Management
 */
export function getLocalNotificationPreferences(userId: string): NotificationPreferences {
  const defaultPrefs: NotificationPreferences = {
    user_id: userId,
    push_enabled: true,
    dm_enabled: true,
    group_enabled: true,
    muted_conversations: [],
    updated_at: new Date().toISOString(),
  };

  if (!userId) return defaultPrefs;

  try {
    const raw = localStorage.getItem(`${PUSH_PREFS_STORAGE_PREFIX}${userId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...defaultPrefs,
        ...parsed,
        user_id: userId,
        muted_conversations: Array.isArray(parsed.muted_conversations)
          ? parsed.muted_conversations
          : [],
      };
    }
  } catch {}
  return defaultPrefs;
}

export async function fetchNotificationPreferences(
  userId: string
): Promise<NotificationPreferences> {
  const local = getLocalNotificationPreferences(userId);
  if (!userId || !isSupabaseConfigured()) return local;

  const supabase = getSupabase();
  if (!supabase) return local;

  try {
    const { data, error } = await supabase
      .from('notification_preferences')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (!error && data) {
      const merged: NotificationPreferences = {
        user_id: userId,
        push_enabled: data.push_enabled ?? local.push_enabled,
        dm_enabled: data.dm_enabled ?? local.dm_enabled,
        group_enabled: data.group_enabled ?? local.group_enabled,
        muted_conversations: Array.isArray(data.muted_conversations)
          ? data.muted_conversations
          : local.muted_conversations,
        updated_at: data.updated_at || new Date().toISOString(),
      };
      localStorage.setItem(`${PUSH_PREFS_STORAGE_PREFIX}${userId}`, JSON.stringify(merged));
      return merged;
    }
  } catch {}
  return local;
}

export async function saveNotificationPreferences(
  userId: string,
  prefs: Partial<NotificationPreferences>
): Promise<NotificationPreferences> {
  const current = getLocalNotificationPreferences(userId);
  const updated: NotificationPreferences = {
    ...current,
    ...prefs,
    user_id: userId,
    updated_at: new Date().toISOString(),
  };

  try {
    localStorage.setItem(`${PUSH_PREFS_STORAGE_PREFIX}${userId}`, JSON.stringify(updated));
  } catch {}

  if (userId && isSupabaseConfigured()) {
    const supabase = getSupabase();
    if (supabase) {
      try {
        await supabase.from('notification_preferences').upsert(
          {
            user_id: userId,
            push_enabled: updated.push_enabled,
            dm_enabled: updated.dm_enabled,
            group_enabled: updated.group_enabled,
            muted_conversations: updated.muted_conversations,
            updated_at: updated.updated_at,
          },
          { onConflict: 'user_id' }
        );
      } catch {}
    }
  }

  window.dispatchEvent(new CustomEvent('spark_push_status_changed'));
  return updated;
}

/**
 * Checks whether a specific conversation is muted by the user.
 */
export function isConversationMuted(userId: string, conversationId: string): boolean {
  if (!userId || !conversationId) return false;
  const prefs = getLocalNotificationPreferences(userId);
  return prefs.muted_conversations.includes(conversationId);
}

/**
 * Toggles mute state for a specific conversation both in `notification_preferences`
 * and on `conversation_members.is_muted` in Supabase.
 */
export async function toggleConversationMute(
  userId: string,
  conversationId: string
): Promise<boolean> {
  const prefs = getLocalNotificationPreferences(userId);
  const currentlyMuted = prefs.muted_conversations.includes(conversationId);
  const nextMutedState = !currentlyMuted;

  const nextMutedList = nextMutedState
    ? Array.from(new Set([...prefs.muted_conversations, conversationId]))
    : prefs.muted_conversations.filter((id) => id !== conversationId);

  await saveNotificationPreferences(userId, {
    muted_conversations: nextMutedList,
  });

  if (isSupabaseConfigured()) {
    const supabase = getSupabase();
    if (supabase) {
      try {
        await supabase
          .from('conversation_members')
          .update({ is_muted: nextMutedState })
          .eq('conversation_id', conversationId)
          .eq('user_id', userId);
      } catch {}
    }
  }

  return nextMutedState;
}

/**
 * Sends a local Service Worker test notification so the user can verify OS banner rendering
 * and notification click routing immediately on their device.
 */
export async function triggerLocalServiceWorkerTestNotification(
  conversationId?: string,
  isGroup = false,
  titleName = 'Rohan'
): Promise<boolean> {
  if (!isWebPushSupported() || Notification.permission !== 'granted') return false;

  try {
    const registration = await registerSparkServiceWorker();
    if (!registration) return false;

    const title = `Spark — ${titleName}`;
    const body = isGroup ? 'New message in your group.' : 'You received a new message.';
    const targetConv = conversationId || '';

    await registration.showNotification(title, {
      body,
      icon: './pwa-192x192.png',
      badge: './pwa-192x192.png',
      tag: targetConv ? `spark-conv-${targetConv}` : 'spark-test-notification',
      data: {
        conversationId: targetConv,
        isGroup,
        url: targetConv ? `?chat=${encodeURIComponent(targetConv)}` : './',
      },
    });
    return true;
  } catch (err) {
    console.warn('Test notification error:', err);
    return false;
  }
}
