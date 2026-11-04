import React, { useState, useEffect } from 'react';
import {
  X,
  Bell,
  BellOff,
  CheckCircle2,
  AlertTriangle,
  Smartphone,
  ShieldCheck,
  VolumeX,
  Volume2,
  Send,
  Download,
  Loader2,
  Info,
  KeyRound,
  Copy,
  Check,
  RefreshCw,
} from 'lucide-react';
import { RealConversation, UserProfile } from '../types';
import {
  isWebPushSupported,
  getBrowserNotificationPermission,
  getCurrentDevicePushSubscription,
  subscribeUserToWebPush,
  unsubscribeUserFromWebPush,
  fetchNotificationPreferences,
  saveNotificationPreferences,
  fetchUserPushSubscriptions,
  toggleConversationMute,
  triggerLocalServiceWorkerTestNotification,
  getActiveVapidPublicKey,
  setCustomVapidPublicKey,
  generateLocalVapidKeyPairInBrowser,
  NotificationPreferences,
  PushSubscriptionRecord,
} from '../lib/pushService';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface NotificationSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: UserProfile;
  conversations: RealConversation[];
}

export const NotificationSettingsModal: React.FC<NotificationSettingsModalProps> = ({
  isOpen,
  onClose,
  profile,
  conversations,
}) => {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    getBrowserNotificationPermission()
  );
  const [hasDeviceSub, setHasDeviceSub] = useState(false);
  const [deviceSubscriptions, setDeviceSubscriptions] = useState<PushSubscriptionRecord[]>([]);
  const [prefs, setPrefs] = useState<NotificationPreferences>({
    user_id: profile.id,
    push_enabled: true,
    dm_enabled: true,
    group_enabled: true,
    muted_conversations: [],
    updated_at: new Date().toISOString(),
  });
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [showVapidGenerator, setShowVapidGenerator] = useState(false);
  const [generatedKeys, setGeneratedKeys] = useState<{
    publicKey: string;
    privateKey: string;
  } | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleGenerateFreshVapidKeys = async () => {
    try {
      const pair = await generateLocalVapidKeyPairInBrowser();
      setGeneratedKeys(pair);
      setCustomVapidPublicKey(pair.publicKey);
      setStatusMessage({
        type: 'success',
        text: 'Generated a fresh VAPID keypair locally in your browser (never sent to chat or GitHub). Copy the secrets to Supabase below.',
      });
    } catch (err: any) {
      setStatusMessage({
        type: 'error',
        text: err?.message || 'Failed to generate VAPID keys in browser.',
      });
    }
  };

  const handleCopyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(label);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {}
  };

  const refreshState = async () => {
    const currentPerm = getBrowserNotificationPermission();
    setPermission(currentPerm);

    const activeSub = await getCurrentDevicePushSubscription();
    setHasDeviceSub(Boolean(activeSub));

    if (profile.id) {
      const loadedPrefs = await fetchNotificationPreferences(profile.id);
      setPrefs(loadedPrefs);

      const allSubs = await fetchUserPushSubscriptions(profile.id);
      setDeviceSubscriptions(allSubs);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setStatusMessage(null);
      refreshState();
    }
  }, [isOpen, profile.id]);

  if (!isOpen) return null;

  const isPushActiveOnThisDevice =
    permission === 'granted' && hasDeviceSub && prefs.push_enabled;

  const handleEnableNotifications = async () => {
    setIsLoading(true);
    setStatusMessage(null);
    try {
      const result = await subscribeUserToWebPush(profile.id);
      await refreshState();
      if (result.success) {
        setStatusMessage({
          type: 'success',
          text: 'Background Web Push notifications enabled on this device!',
        });
      } else {
        setStatusMessage({
          type: 'error',
          text: result.error || 'Could not enable notifications.',
        });
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleDisableNotifications = async () => {
    setIsLoading(true);
    setStatusMessage(null);
    try {
      await unsubscribeUserFromWebPush(profile.id);
      await refreshState();
      setStatusMessage({
        type: 'info',
        text: 'Notifications disabled for this device.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleTogglePreference = async (key: 'dm_enabled' | 'group_enabled') => {
    const nextVal = !prefs[key];
    const updated = await saveNotificationPreferences(profile.id, {
      [key]: nextVal,
    });
    setPrefs(updated);
  };

  const handleUnmuteConversation = async (convId: string) => {
    await toggleConversationMute(profile.id, convId);
    const updated = await fetchNotificationPreferences(profile.id);
    setPrefs(updated);
  };

  const handleSendTestPush = async () => {
    const firstConv = conversations[0];
    const ok = await triggerLocalServiceWorkerTestNotification(
      firstConv?.id,
      Boolean(firstConv?.is_group),
      firstConv
        ? firstConv.is_group
          ? firstConv.name || 'Group Chat'
          : firstConv.other_user.display_name || firstConv.other_user.username
        : 'Rohan'
    );
    if (ok) {
      setStatusMessage({
        type: 'success',
        text: 'Test notification sent via Service Worker! Tap it to test navigation.',
      });
    } else {
      setStatusMessage({
        type: 'error',
        text: 'Please enable notifications first before testing.',
      });
    }
  };

  const mutedConversationObjects = conversations.filter((c) =>
    prefs.muted_conversations.includes(c.id)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-[32px] bg-white border border-slate-100 shadow-2xl flex flex-col overflow-hidden text-slate-800 max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-rose-50 flex items-center justify-center text-[#ff3b69]">
              <Bell className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-display font-bold text-base text-slate-900 tracking-tight">
                Notification Settings
              </h2>
              <p className="text-[11px] text-slate-500">
                Background Web Push & conversation alerts
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 sm:p-5 space-y-4 overflow-y-auto">
          {/* 1. Browser Permission & Device Subscription Status Card */}
          <div
            className={`p-4 rounded-2xl border space-y-3 ${
              isPushActiveOnThisDevice
                ? 'bg-emerald-50/60 border-emerald-200'
                : permission === 'denied'
                ? 'bg-amber-50/70 border-amber-200'
                : 'bg-slate-50 border-slate-200/80'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                  {isPushActiveOnThisDevice ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span>Background Push Active</span>
                    </>
                  ) : permission === 'denied' ? (
                    <>
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                      <span>Browser Permission Blocked</span>
                    </>
                  ) : (
                    <>
                      <BellOff className="w-4 h-4 text-slate-500 shrink-0" />
                      <span>Notifications Not Enabled</span>
                    </>
                  )}
                </div>

                <p className="text-[11px] text-slate-600 leading-relaxed">
                  {isPushActiveOnThisDevice
                    ? 'You will receive WhatsApp-style notifications on this device even when switching to YouTube or other apps.'
                    : permission === 'denied'
                    ? 'Notifications are blocked in your browser settings for this site.'
                    : !isWebPushSupported()
                    ? 'This browser does not support Web Push. On Android, open Spark in Chrome.'
                    : 'Enable Web Push to receive instant alerts when new messages arrive in the background.'}
                </p>
              </div>

              <span className="text-[11px] font-mono text-slate-500 shrink-0">
                {permission === 'granted'
                  ? 'Granted'
                  : permission === 'denied'
                  ? 'Blocked'
                  : permission === 'default'
                  ? 'Prompt'
                  : 'Unsupported'}
              </span>
            </div>

            {/* Instructions when permission is blocked */}
            {permission === 'denied' && (
              <div className="p-3 rounded-xl bg-white/90 border border-amber-200/80 text-[11px] text-slate-700 space-y-1">
                <p className="font-bold text-amber-900">How to unblock in Chrome (Android / Desktop):</p>
                <ol className="list-decimal list-inside space-y-0.5 text-slate-600">
                  <li>Tap the tune / lock icon on the left side of the address bar.</li>
                  <li>Tap <strong>Permissions</strong> → <strong>Notifications</strong>.</li>
                  <li>Select <strong>Allow</strong>, then tap <strong>Enable Notifications</strong> below.</li>
                </ol>
              </div>
            )}

            {/* Primary Enable / Disable Action Buttons */}
            <div className="flex items-center gap-2 pt-1">
              {!isPushActiveOnThisDevice ? (
                <button
                  type="button"
                  onClick={handleEnableNotifications}
                  disabled={isLoading || !isWebPushSupported()}
                  className="flex-1 min-h-[44px] py-2.5 px-4 rounded-full bg-gradient-to-r from-[#ff3b69] to-[#fb7185] text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm hover:opacity-95 active:scale-98 disabled:opacity-50 transition-all cursor-pointer"
                >
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Bell className="w-4 h-4" />
                  )}
                  <span>Enable Notifications</span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleSendTestPush}
                    className="flex-1 min-h-[44px] py-2 px-3.5 rounded-full bg-white hover:bg-slate-50 border border-slate-200 text-slate-800 font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5 text-[#ff3b69]" />
                    <span>Send Test Alert</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDisableNotifications}
                    disabled={isLoading}
                    className="min-h-[44px] py-2 px-4 rounded-full bg-rose-50 hover:bg-rose-100 border border-rose-200 text-[#ff3b69] font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                  >
                    <BellOff className="w-3.5 h-3.5" />
                    <span>Disable</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Feedback Banner */}
          {statusMessage && (
            <div
              className={`p-3 rounded-2xl text-xs font-medium flex items-center gap-2 border ${
                statusMessage.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : statusMessage.type === 'error'
                  ? 'bg-rose-50 border-rose-200 text-rose-700'
                  : 'bg-slate-50 border-slate-200 text-slate-700'
              }`}
            >
              <Info className="w-4 h-4 shrink-0" />
              <span>{statusMessage.text}</span>
            </div>
          )}

          {/* 2. Notification Preferences (1-to-1 & Group Toggles) */}
          <div className="space-y-2">
            <h3 className="text-xs font-bold text-slate-900 px-1">
              Alert Preferences
            </h3>

            <div className="rounded-2xl border border-slate-200/80 divide-y divide-slate-100 overflow-hidden bg-white">
              {/* Direct 1-to-1 Messages Toggle */}
              <div className="p-3.5 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-slate-900">
                    One-to-One Messages
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Example: &ldquo;Spark — Rohan: You received a new message.&rdquo;
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleTogglePreference('dm_enabled')}
                  className={`min-w-[52px] h-7 rounded-full p-1 transition-colors flex items-center cursor-pointer ${
                    prefs.dm_enabled ? 'bg-[#ff3b69] justify-end' : 'bg-slate-200 justify-start'
                  }`}
                  aria-label="Toggle one-to-one message notifications"
                >
                  <span className="w-5 h-5 rounded-full bg-white shadow-xs block" />
                </button>
              </div>

              {/* Group Chat Messages Toggle */}
              <div className="p-3.5 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-slate-900">
                    Group Conversations
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Example: &ldquo;Spark — JEE Aspirants: New message in your group.&rdquo;
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleTogglePreference('group_enabled')}
                  className={`min-w-[52px] h-7 rounded-full p-1 transition-colors flex items-center cursor-pointer ${
                    prefs.group_enabled ? 'bg-[#ff3b69] justify-end' : 'bg-slate-200 justify-start'
                  }`}
                  aria-label="Toggle group message notifications"
                >
                  <span className="w-5 h-5 rounded-full bg-white shadow-xs block" />
                </button>
              </div>
            </div>
          </div>

          {/* 3. Muted Conversations List */}
          <div className="space-y-2">
            <div className="flex items-center justify-between px-1 text-xs">
              <span className="font-bold text-slate-900">Muted Conversations</span>
              <span className="text-slate-400 font-mono tabular-nums">
                {mutedConversationObjects.length} muted
              </span>
            </div>

            {mutedConversationObjects.length === 0 ? (
              <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-100 text-[11px] text-slate-500 flex items-center gap-2">
                <Volume2 className="w-4 h-4 text-slate-400 shrink-0" />
                <span>
                  No conversations are muted. You can mute individual chats using the bell icon inside any conversation header.
                </span>
              </div>
            ) : (
              <div className="rounded-2xl border border-slate-200/80 divide-y divide-slate-100 overflow-hidden bg-white">
                {mutedConversationObjects.map((conv) => {
                  const title = conv.is_group
                    ? conv.name || 'Group Chat'
                    : conv.other_user.display_name || conv.other_user.username;
                  return (
                    <div
                      key={conv.id}
                      className="p-3 flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <VolumeX className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <span className="font-semibold text-slate-800 truncate">
                          {title}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleUnmuteConversation(conv.id)}
                        className="px-3 py-1.5 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-[11px] transition-colors shrink-0 cursor-pointer"
                      >
                        Unmute
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 4. Multi-Device Subscriptions & E2EE Privacy Guarantee */}
          <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200/70 space-y-2 text-[11px] text-slate-600">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-800 flex items-center gap-1.5">
                <Smartphone className="w-3.5 h-3.5 text-[#ff3b69]" />
                <span>Active Devices on Your Account</span>
              </span>
              <span className="font-mono font-bold text-slate-900 tabular-nums">
                {Math.max(deviceSubscriptions.length, isPushActiveOnThisDevice ? 1 : 0)} registered
              </span>
            </div>
            <p className="leading-relaxed text-slate-500">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 inline mr-1 -mt-0.5" />
              <strong>End-to-End Encryption Privacy:</strong> Private message contents are never exposed in push notifications.
            </p>
          </div>

          {/* 5. Optional PWA Home Screen Installation */}
          {!isInstalled && (isInstallable || isIOS) && (
            <div className="p-3.5 rounded-2xl bg-rose-50/60 border border-rose-100 flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <p className="text-xs font-bold text-slate-900">
                  Install Spark App (Optional)
                </p>
                <p className="text-[11px] text-slate-600">
                  Add Spark to your home screen for faster access and reliable background push delivery.
                </p>
              </div>
              {isInstallable ? (
                <button
                  type="button"
                  onClick={install}
                  className="px-3.5 py-2 rounded-full bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Install</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowIOSGuide((v) => !v)}
                  className="px-3.5 py-2 rounded-full bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shrink-0 transition-colors cursor-pointer"
                >
                  iOS Guide
                </button>
              )}
            </div>
          )}

          {showIOSGuide && (
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-[11px] text-slate-600">
              In Safari on iPhone/iPad: Tap the <strong>Share</strong> icon in the toolbar, then tap <strong>Add to Home Screen</strong>.
            </div>
          )}

          {/* 6. Local Browser VAPID Keypair Generator (Zero Chat / Zero GitHub Exposure) */}
          <div className="pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setShowVapidGenerator((prev) => !prev)}
              className="w-full flex items-center justify-between text-[11px] font-semibold text-slate-500 hover:text-slate-800 py-1.5 transition-colors cursor-pointer"
            >
              <span className="flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-[#ff3b69]" />
                <span>Rotate / Generate Unexposed VAPID Keypair Locally</span>
              </span>
              <span>{showVapidGenerator ? 'Hide' : 'Open'}</span>
            </button>

            {showVapidGenerator && (
              <div className="mt-2 p-3.5 rounded-2xl bg-slate-50 border border-slate-200/80 space-y-3 text-[11px]">
                <p className="text-slate-600 leading-relaxed">
                  Generate a brand-new P-256 VAPID keypair <strong>100% locally in your browser</strong> using Web Crypto. Because it runs only on your screen, the private key is never seen in AI chat logs or GitHub.
                </p>
                <button
                  type="button"
                  onClick={handleGenerateFreshVapidKeys}
                  className="w-full py-2 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Generate New Keypair on This Device</span>
                </button>

                {generatedKeys && (
                  <div className="space-y-2.5 pt-1">
                    <div className="p-2.5 rounded-xl bg-white border border-slate-200 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-800">
                          1. VAPID_PUBLIC_KEY ( &amp; VITE_VAPID_PUBLIC_KEY )
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCopyText(generatedKeys.publicKey, 'pub')}
                          className="text-[#ff3b69] font-bold flex items-center gap-1 cursor-pointer"
                        >
                          {copiedField === 'pub' ? (
                            <>
                              <Check className="w-3 h-3" />
                              <span>Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      </div>
                      <p className="font-mono text-[10px] text-slate-600 break-all select-all">
                        {generatedKeys.publicKey}
                      </p>
                    </div>

                    <div className="p-2.5 rounded-xl bg-amber-50/70 border border-amber-200 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-amber-900">
                          2. VAPID_PRIVATE_KEY (Supabase Edge Function Secret ONLY)
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCopyText(generatedKeys.privateKey, 'priv')}
                          className="text-amber-900 font-bold flex items-center gap-1 cursor-pointer"
                        >
                          {copiedField === 'priv' ? (
                            <>
                              <Check className="w-3 h-3" />
                              <span>Copied Secret</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              <span>Copy Secret</span>
                            </>
                          )}
                        </button>
                      </div>
                      <p className="text-[10px] text-amber-800">
                        Paste into <strong>Supabase Dashboard → Edge Functions → Secrets</strong> as <code className="font-mono">VAPID_PRIVATE_KEY</code>. Never commit to GitHub.
                      </p>
                    </div>
                  </div>
                )}

                <div className="text-[10px] text-slate-400 font-mono break-all">
                  Active Public Key: {getActiveVapidPublicKey().slice(0, 22)}...
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
