import React, { useState, useEffect } from 'react';
import {
  X,
  Check,
  RefreshCw,
  User,
  Mail,
  LogOut,
  ShieldCheck,
  SlidersHorizontal,
  Lock,
  Bell,
  BellOff,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { UserProfile } from '../types';
import { syncProfileToSupabaseDirectory } from '../lib/chatService';
import {
  isWebPushSupported,
  getBrowserNotificationPermission,
  getCurrentDevicePushSubscription,
  isDevicePushExplicitlyDisabled,
  subscribeUserToWebPush,
  unsubscribeUserFromWebPush,
} from '../lib/pushService';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: UserProfile;
  onSaveProfile: (updated: UserProfile) => void;
  onSignOut?: () => void;
  onOpenSupabaseGuide?: () => void;
  onOpenDataPrecision?: () => void;
  onOpenNotifications?: () => void;
}

const PRESET_AVATARS = [
  { name: 'Yatish S', seed: 'Yatish' },
  { name: 'Raj V.', seed: 'Raj' },
  { name: 'Sheela', seed: 'Sheela' },
  { name: 'Kavita', seed: 'Kavita' },
  { name: 'Chad', seed: 'Chad' },
  { name: 'Nadya', seed: 'Nadya' },
];

export const LoginModal: React.FC<LoginModalProps> = ({
  isOpen,
  onClose,
  profile,
  onSaveProfile,
  onSignOut,
  onOpenDataPrecision,
  onOpenNotifications,
}) => {
  const [displayName, setDisplayName] = useState(profile.display_name || profile.username);
  const [bio, setBio] = useState(profile.bio || '');
  const [selectedAvatarSeed, setSelectedAvatarSeed] = useState(profile.avatar_url);
  const [pushPerm, setPushPerm] = useState<NotificationPermission | 'unsupported'>(() =>
    getBrowserNotificationPermission()
  );
  const [isDevicePushOn, setIsDevicePushOn] = useState(false);
  const [isTogglingPush, setIsTogglingPush] = useState(false);
  const [pushNotice, setPushNotice] = useState<string | null>(null);

  const syncDevicePushState = async () => {
    const perm = getBrowserNotificationPermission();
    setPushPerm(perm);
    const sub = await getCurrentDevicePushSubscription();
    const disabled = isDevicePushExplicitlyDisabled(profile.id);
    setIsDevicePushOn(perm === 'granted' && Boolean(sub) && !disabled);
  };

  useEffect(() => {
    if (isOpen) {
      setDisplayName(profile.display_name || profile.username || '');
      setBio(profile.bio || '');
      setSelectedAvatarSeed(profile.avatar_url);
      setPushNotice(null);
      syncDevicePushState();
    }
  }, [isOpen, profile.id, profile.display_name, profile.username, profile.bio, profile.avatar_url]);

  const handleToggleDevicePush = async () => {
    if (isTogglingPush) return;
    setIsTogglingPush(true);
    setPushNotice(null);
    try {
      if (isDevicePushOn) {
        await unsubscribeUserFromWebPush(profile.id);
        await syncDevicePushState();
        setPushNotice('Notifications turned OFF on this device.');
      } else {
        const res = await subscribeUserToWebPush(profile.id);
        await syncDevicePushState();
        if (res.success) {
          setPushNotice('Notifications turned ON for this device.');
        } else {
          setPushNotice(res.error || 'Could not enable notifications.');
        }
      }
    } finally {
      setIsTogglingPush(false);
    }
  };

  if (!isOpen) return null;

  const handleSelectPreset = (seed: string) => {
    const url = `https://api.dicebear.com/7.x/bottts/svg?seed=${seed}&backgroundColor=f1f5f9`;
    setSelectedAvatarSeed(url);
  };

  const handleRandomizeAvatar = () => {
    const randomSeed = 'spark_' + Math.random().toString(36).substring(2, 8);
    const url = `https://api.dicebear.com/7.x/bottts/svg?seed=${randomSeed}&backgroundColor=f1f5f9`;
    setSelectedAvatarSeed(url);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();

    const cleanDisplayName = displayName.trim() || profile.username;
    const updated: UserProfile = {
      ...profile,
      display_name: cleanDisplayName,
      bio: bio.trim(),
      avatar_url: selectedAvatarSeed,
    };

    onSaveProfile(updated);
    // Also trigger background sync
    syncProfileToSupabaseDirectory(updated).catch(() => {});
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
      <div className="w-full max-w-sm rounded-[32px] bg-white border border-slate-100 shadow-2xl flex flex-col overflow-hidden text-slate-800">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-rose-50 flex items-center justify-center text-[#ff3b69]">
              <User className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-display font-bold text-base text-slate-900 tracking-tight">
                Profile & Account
              </h2>
              <p className="text-[11px] text-slate-500">Manage identity & session</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-4 space-y-3.5 max-h-[75vh] overflow-y-auto">
          {/* Email badge (Read only) */}
          {profile.email && (
            <div className="p-2.5 rounded-2xl bg-slate-50 border border-slate-100 flex items-center gap-2 text-xs text-slate-600">
              <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="truncate font-mono">{profile.email}</span>
            </div>
          )}

          {/* E2EE Status */}
          <div className="p-2.5 rounded-2xl bg-emerald-50/70 border border-emerald-100 flex items-center justify-between text-xs text-emerald-800">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              <span className="font-semibold text-[11px]">E2EE Device Keys</span>
            </div>
            <span className="text-[10px] font-mono text-emerald-700 bg-emerald-100/60 px-2 py-0.5 rounded-full font-medium">
              ECDH-P256 / AES-GCM
            </span>
          </div>

          {/* Background Push Notifications (Simple ON/OFF Toggle + Settings Link) */}
          <div className="p-3 rounded-2xl bg-rose-50/50 border border-rose-200/80 space-y-2 text-xs text-slate-800">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {isDevicePushOn ? (
                  <Bell className="w-4 h-4 text-[#ff3b69] shrink-0" />
                ) : (
                  <BellOff className="w-4 h-4 text-slate-400 shrink-0" />
                )}
                <div>
                  <p className="font-bold text-[11px] text-slate-900">
                    Push Notifications (This Device)
                  </p>
                  <p className="text-[10px] text-slate-500">
                    {isDevicePushOn
                      ? 'ON · Receiving background alerts'
                      : pushPerm === 'denied'
                      ? 'OFF · Blocked in Chrome settings'
                      : 'OFF · Paused on this device'}
                  </p>
                </div>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={isDevicePushOn}
                disabled={isTogglingPush || !isWebPushSupported()}
                onClick={handleToggleDevicePush}
                className={`relative w-12 h-6 rounded-full transition-colors shrink-0 cursor-pointer disabled:opacity-50 ${
                  isDevicePushOn ? 'bg-[#ff3b69]' : 'bg-slate-300'
                }`}
                title={isDevicePushOn ? 'Turn OFF notifications on this device' : 'Turn ON notifications on this device'}
              >
                {isTogglingPush ? (
                  <Loader2 className="w-3.5 h-3.5 text-white animate-spin mx-auto" />
                ) : (
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-xs transition-transform ${
                      isDevicePushOn ? 'translate-x-6' : 'translate-x-0'
                    }`}
                  />
                )}
              </button>
            </div>

            {pushPerm === 'denied' && (
              <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-[10px] text-amber-900 space-y-0.5">
                <p className="font-bold flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
                  <span>How to enable in Chrome settings:</span>
                </p>
                <p className="text-amber-800 leading-relaxed">
                  Tap the lock/tune icon in your Chrome address bar → <strong>Permissions</strong> → <strong>Notifications</strong> → select <strong>Allow</strong>, then switch ON above.
                </p>
              </div>
            )}

            {pushNotice && (
              <p className="text-[10px] font-medium text-slate-600">{pushNotice}</p>
            )}

            {onOpenNotifications && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenNotifications();
                }}
                className="w-full pt-1.5 border-t border-rose-200/60 flex items-center justify-between text-[10px] font-semibold text-[#ff3b69] hover:underline cursor-pointer"
              >
                <span>Muted chats, group alerts &amp; test alert</span>
                <span>Open →</span>
              </button>
            )}
          </div>

          {/* Manage Data Precision */}
          {onOpenDataPrecision && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenDataPrecision();
              }}
              className="w-full p-2.5 rounded-2xl bg-slate-50 hover:bg-slate-100/90 border border-slate-200/80 flex items-center justify-between text-xs text-slate-800 transition-colors"
            >
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-3.5 h-3.5 text-[#ff3b69] shrink-0" />
                <span className="font-semibold text-[11px]">Manage Data Precision</span>
              </div>
              <span className="text-[10px] text-slate-500 font-medium">
                Decimals · Timestamps · Cache →
              </span>
            </button>
          )}

          {/* Avatar Preview & Randomizer */}
          <div className="flex flex-col items-center gap-2">
            <div className="relative">
              <div className="w-16 h-16 rounded-full p-[2px] bg-gradient-to-tr from-[#ff3b69] to-[#38bdf8] shadow-sm">
                <img
                  src={selectedAvatarSeed}
                  alt="Avatar Preview"
                  className="w-full h-full rounded-full object-cover bg-white"
                />
              </div>

              <button
                type="button"
                onClick={handleRandomizeAvatar}
                className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-[#ff3b69] text-white flex items-center justify-center shadow-sm hover:opacity-90 transition-opacity"
                title="Randomize avatar"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>

            <span className="text-[10px] text-slate-400">Choose a preset avatar</span>

            {/* Presets Grid */}
            <div className="grid grid-cols-3 gap-2 w-full pt-1">
              {PRESET_AVATARS.map((preset) => (
                <button
                  key={preset.seed}
                  type="button"
                  onClick={() => handleSelectPreset(preset.seed)}
                  className={`p-1.5 rounded-xl border flex flex-col items-center gap-1 transition-all ${
                    selectedAvatarSeed.includes(preset.seed)
                      ? 'border-[#ff3b69] bg-rose-50/50'
                      : 'border-slate-100 bg-slate-50 hover:bg-slate-100'
                  }`}
                >
                  <img
                    src={`https://api.dicebear.com/7.x/bottts/svg?seed=${preset.seed}&backgroundColor=f1f5f9`}
                    alt={preset.name}
                    className="w-7 h-7 rounded-full bg-white"
                  />
                  <span className="text-[9px] font-medium text-slate-600 truncate max-w-full">
                    {preset.name}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Display Name Field */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Maya Sun"
              maxLength={30}
              className="w-full py-2 px-3.5 rounded-full text-xs bg-slate-50 border border-slate-200 text-slate-800 placeholder-slate-400 focus:outline-none focus:border-[#ff3b69] focus:bg-white transition-all shadow-inner"
            />
          </div>

          {/* Immutable Username Display */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-semibold text-slate-600">
                Unique Username
              </label>
              <span className="text-[10px] text-slate-400 flex items-center gap-1">
                <Lock className="w-3 h-3 text-slate-400" />
                <span>Immutable</span>
              </span>
            </div>
            <div className="flex items-center gap-2 py-2 px-3.5 rounded-full text-xs bg-slate-100/80 border border-slate-200/80 text-slate-700 font-mono">
              <span className="text-[#ff3b69] font-bold">@</span>
              <span className="flex-1 font-semibold">{profile.username}</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-200/80 text-slate-600 font-sans">
                Permanent
              </span>
            </div>
            <p className="text-[10px] text-slate-400 mt-1 pl-2">
              Usernames cannot be changed once chosen to protect your identity across Spark.
            </p>
          </div>

          {/* Bio Field */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-semibold text-slate-600">
                Bio
              </label>
              <span className="text-[10px] text-slate-400">{bio.length}/100</span>
            </div>
            <textarea
              rows={2}
              maxLength={100}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Tell others what you're up to, or your interests..."
              className="w-full py-2 px-3.5 rounded-2xl text-xs bg-slate-50 border border-slate-200 text-slate-800 placeholder-slate-400 focus:outline-none focus:border-[#ff3b69] focus:bg-white transition-all shadow-inner resize-none"
            />
          </div>



          <button
            type="submit"
            className="w-full py-2.5 rounded-full bg-gradient-to-r from-[#ff3b69] to-[#fb7185] text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-md shadow-pink-500/20 hover:opacity-95 active:scale-95 transition-all"
          >
            <Check className="w-4 h-4" />
            <span>Save Profile</span>
          </button>

          {/* Sign Out Option */}
          {onSignOut && (
            <div className="pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onSignOut();
                }}
                className="w-full py-2.5 rounded-full border border-rose-200 bg-rose-50 hover:bg-rose-100 text-[#ff3b69] font-bold text-xs flex items-center justify-center gap-1.5 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign Out of Spark</span>
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
};
