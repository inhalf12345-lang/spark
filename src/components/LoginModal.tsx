import React, { useState } from 'react';
import {
  X,
  Check,
  RefreshCw,
  User,
  Mail,
  LogOut,
  ShieldCheck,
  Lock,
  Globe,
  Loader2,
  Sparkles,
  Copy,
  ExternalLink,
  AlertCircle,
  Share2,
  Link as LinkIcon,
} from 'lucide-react';
import { UserProfile } from '../types';
import { syncProfileToSupabaseDirectory } from '../lib/chatService';
import {
  isSupabaseConfigured,
  getSavedCredentials,
  getOneClickShareableUrl,
} from '../lib/supabase';
import { SUPABASE_MIGRATION_SQL } from '../lib/supabaseSql';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: UserProfile;
  onSaveProfile: (updated: UserProfile) => void;
  onSignOut?: () => void;
  onOpenSupabaseGuide?: () => void;
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
  onOpenSupabaseGuide,
}) => {
  const [displayName, setDisplayName] = useState(profile.display_name || profile.username);
  const [bio, setBio] = useState(profile.bio || '');
  const [selectedAvatarSeed, setSelectedAvatarSeed] = useState(profile.avatar_url);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncErrorCode, setSyncErrorCode] = useState<string | null>(null);
  const [copiedSql, setCopiedSql] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

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

  const handleCopyMigrationSql = () => {
    navigator.clipboard.writeText(SUPABASE_MIGRATION_SQL);
    setCopiedSql(true);
    setTimeout(() => setCopiedSql(false), 3000);
  };

  const getSupabaseSqlEditorUrl = (): string => {
    const { url } = getSavedCredentials();
    if (!url) return 'https://supabase.com/dashboard';
    try {
      const host = new URL(url).hostname;
      const ref = host.split('.')[0];
      if (ref && ref !== 'localhost') {
        return `https://supabase.com/dashboard/project/${ref}/sql/new`;
      }
    } catch {}
    return 'https://supabase.com/dashboard';
  };

  const handleShareConnectionLink = () => {
    const link = getOneClickShareableUrl();
    if (!link) {
      if (onOpenSupabaseGuide) onOpenSupabaseGuide();
      return;
    }
    navigator.clipboard.writeText(link);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 3000);
  };

  const handleManualSync = async () => {
    if (!isSupabaseConfigured()) {
      setSyncStatus('error');
      setSyncMsg('Supabase is not configured yet on this device. Opening setup...');
      setSyncErrorCode('NOT_CONFIGURED');
      if (onOpenSupabaseGuide) onOpenSupabaseGuide();
      return;
    }
    setSyncStatus('syncing');
    setSyncMsg('Syncing profile to Supabase database...');
    setSyncErrorCode(null);

    try {
      const cleanDisplayName = displayName.trim() || profile.username;
      const updated: UserProfile = {
        ...profile,
        display_name: cleanDisplayName,
        bio: bio.trim(),
        avatar_url: selectedAvatarSeed,
      };
      const result = await syncProfileToSupabaseDirectory(updated);
      if (result.success) {
        setSyncStatus('success');
        setSyncMsg(`✓ Saved! @${profile.username} is now live in Supabase.`);
        setSyncErrorCode(null);
      } else {
        setSyncStatus('error');
        setSyncErrorCode(result.code || 'UNKNOWN');
        if (result.code === '42501') {
          setSyncMsg(
            'Supabase RLS Blocked (42501): Row Level Security denied the insert. Run the Safe Migration SQL script below in your Supabase SQL Editor.'
          );
        } else if (result.code === '23503') {
          setSyncMsg(
            'Foreign Key Blocked (23503): Table requires auth.users link. Run the Safe Migration SQL script to drop profiles_id_fkey.'
          );
        } else if (result.code === '42P01') {
          setSyncMsg(
            'Table Missing (42P01): "profiles" table does not exist in your Supabase project. Run the SQL setup script to create it.'
          );
        } else {
          setSyncMsg(
            `Supabase error: ${result.error || 'Write failed'}${
              result.code ? ` (Code: ${result.code})` : ''
            }`
          );
        }
      }
    } catch (e: any) {
      setSyncStatus('error');
      setSyncMsg(e?.message || 'Failed to sync to Supabase.');
      setSyncErrorCode('EXCEPTION');
    }
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

          {/* Supabase Global Directory Sync Status */}
          <div className={`p-3.5 rounded-2xl border flex flex-col gap-2.5 transition-all ${
            isSupabaseConfigured()
              ? 'bg-slate-50 border-slate-200/80'
              : 'bg-amber-50/70 border-amber-200'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
                <Globe className={`w-3.5 h-3.5 ${isSupabaseConfigured() ? 'text-[#ff3b69]' : 'text-amber-600'}`} />
                <span>Supabase Cloud Directory</span>
              </div>
              {isSupabaseConfigured() ? (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 flex items-center gap-1">
                  <Check className="w-2.5 h-2.5" />
                  <span>Connected</span>
                </span>
              ) : (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 flex items-center gap-1">
                  <AlertCircle className="w-2.5 h-2.5" />
                  <span>Offline / Local Only</span>
                </span>
              )}
            </div>

            {isSupabaseConfigured() ? (
              <>
                <p className="text-[11px] text-slate-600 leading-relaxed">
                  Your device is connected to Supabase. Tap <strong>Sync to Supabase</strong> to make sure <strong className="text-slate-800 font-mono">@{profile.username}</strong> is up to date in the directory.
                </p>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleManualSync}
                    disabled={syncStatus === 'syncing'}
                    className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-[#ff3b69] to-[#fb7185] hover:opacity-95 text-white font-bold text-xs flex items-center gap-1.5 shadow-xs disabled:opacity-60 transition-all active:scale-95"
                  >
                    {syncStatus === 'syncing' ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Syncing to Supabase...</span>
                      </>
                    ) : (
                      <>
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Sync to Supabase</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={handleShareConnectionLink}
                    className="px-3 py-1.5 rounded-xl bg-white border border-slate-200 text-slate-700 hover:bg-slate-100 font-bold text-xs flex items-center gap-1.5 shadow-xs transition-all active:scale-95"
                    title="Copy 1-Click invite link to connect another phone automatically"
                  >
                    {copiedLink ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                        <span className="text-emerald-700 font-bold">1-Click Link Copied!</span>
                      </>
                    ) : (
                      <>
                        <Share2 className="w-3.5 h-3.5 text-[#ff3b69]" />
                        <span>Share 1-Click Link</span>
                      </>
                    )}
                  </button>
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <p className="text-[11px] text-amber-900 leading-relaxed">
                  <strong>Notice:</strong> This phone is running in <strong>Local Offline Mode</strong>. The account <strong className="font-mono text-amber-950">@{profile.username}</strong> ({profile.email}) is saved only in this browser and <strong>not in Supabase</strong>. Connect Supabase below to sync this account and find friends.
                </p>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {onOpenSupabaseGuide && (
                    <button
                      type="button"
                      onClick={onOpenSupabaseGuide}
                      className="px-3 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-xs transition-all active:scale-95"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Connect Supabase on this Phone</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {syncMsg && (
              <div
                className={`text-[11px] p-2.5 rounded-xl font-medium transition-all space-y-2 ${
                  syncStatus === 'success'
                    ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                    : syncStatus === 'error'
                    ? 'bg-rose-50 text-rose-800 border border-rose-200'
                    : 'bg-blue-50 text-blue-800 border border-blue-200'
                }`}
              >
                <div className="flex items-start gap-1.5 leading-snug">
                  {syncStatus === 'error' && (
                    <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />
                  )}
                  {syncStatus === 'success' && (
                    <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                  )}
                  <span>{syncMsg}</span>
                </div>

                {syncStatus === 'error' && syncErrorCode !== 'NOT_CONFIGURED' && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-rose-200/60">
                    <button
                      type="button"
                      onClick={handleCopyMigrationSql}
                      className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold text-[10px] flex items-center gap-1 transition-all active:scale-95 shadow-xs"
                    >
                      {copiedSql ? (
                        <>
                          <Check className="w-3 h-3" />
                          <span>Copied SQL to Clipboard!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>Copy Safe Migration SQL</span>
                        </>
                      )}
                    </button>

                    <a
                      href={getSupabaseSqlEditorUrl()}
                      target="_blank"
                      rel="noreferrer"
                      className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold text-[10px] flex items-center gap-1 transition-all active:scale-95 shadow-xs"
                    >
                      <ExternalLink className="w-3 h-3 text-rose-400" />
                      <span>Open SQL Editor (Supabase) ↗</span>
                    </a>

                    {onOpenSupabaseGuide && (
                      <button
                        type="button"
                        onClick={onOpenSupabaseGuide}
                        className="px-2.5 py-1 rounded-lg bg-white border border-rose-300 text-rose-700 hover:bg-rose-50 font-bold text-[10px] flex items-center gap-1 transition-all active:scale-95"
                      >
                        <ExternalLink className="w-3 h-3" />
                        <span>View Guide</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
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
