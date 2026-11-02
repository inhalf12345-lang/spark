import React, { useState, useEffect } from 'react';
import {
  X,
  SlidersHorizontal,
  Clock,
  HardDrive,
  Check,
  RefreshCw,
  Trash2,
  Sparkles,
  Info,
  ShieldCheck,
  Coins,
  Flame,
} from 'lucide-react';
import {
  DataPrecisionSettings,
  NumericPrecision,
  TimestampPrecision,
  RoundingStrategy,
  getPrecisionSettings,
  savePrecisionSettings,
  formatNumericPrecision,
  formatTimestampPrecision,
  formatStorageBytes,
  getStorageUsageMetrics,
  normalizeProfileDataPrecision,
  purgeMessageCache,
} from '../lib/precisionService';
import { UserProfile } from '../types';

interface DataPrecisionModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: UserProfile;
  onProfileUpdated?: (updated: UserProfile) => void;
}

export const DataPrecisionModal: React.FC<DataPrecisionModalProps> = ({
  isOpen,
  onClose,
  profile,
  onProfileUpdated,
}) => {
  const [settings, setSettings] = useState<DataPrecisionSettings>(getPrecisionSettings());
  const [metrics, setMetrics] = useState(getStorageUsageMetrics());
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [nowTimestamp, setNowTimestamp] = useState(Date.now());

  useEffect(() => {
    if (isOpen) {
      setSettings(getPrecisionSettings());
      setMetrics(getStorageUsageMetrics());
      setStatusMessage(null);
    }
  }, [isOpen]);

  // Keep live timestamp ticking for preview
  useEffect(() => {
    if (!isOpen) return;
    const interval = setInterval(() => setNowTimestamp(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleUpdateNumeric = (num: NumericPrecision) => {
    const updated = { ...settings, numericPrecision: num };
    setSettings(updated);
    savePrecisionSettings(updated);
    setStatusMessage(`Numeric precision updated to ${num.replace('_', ' ')}.`);
  };

  const handleUpdateRounding = (rounding: RoundingStrategy) => {
    const updated = { ...settings, roundingMode: rounding };
    setSettings(updated);
    savePrecisionSettings(updated);
    setStatusMessage(`Rounding mode set to ${rounding.replace('_', ' ')}.`);
  };

  const handleUpdateTimestamp = (ts: TimestampPrecision) => {
    const updated = { ...settings, timestampPrecision: ts };
    setSettings(updated);
    savePrecisionSettings(updated);
    setStatusMessage(`Timestamp display updated.`);
  };

  const handleNormalizeData = () => {
    const { normalized, fixedDelta } = normalizeProfileDataPrecision(profile, settings);
    if (onProfileUpdated) {
      onProfileUpdated(normalized);
    }
    setMetrics(getStorageUsageMetrics());
    setStatusMessage(
      fixedDelta > 0
        ? `Recalculated data! Adjusted ${fixedDelta.toFixed(4)} delta float artifacts.`
        : 'Data precision is strictly aligned with your rules.'
    );
  };

  const handlePurgeCache = () => {
    const { freedBytes, deletedKeysCount } = purgeMessageCache();
    setMetrics(getStorageUsageMetrics());
    setStatusMessage(`Purged ${deletedKeysCount} cache files, freeing ${formatStorageBytes(freedBytes)}.`);
  };

  const sampleCoinValue = 1245.8754;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div
        className="relative w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-100 overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-rose-50 flex items-center justify-center text-[#ff3b69]">
              <SlidersHorizontal className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-display font-bold text-base text-slate-900">Data Precision Settings</h2>
              <div className="flex items-center gap-2 text-[11px] text-slate-500">
                <span>Numeric Formatting</span>
                <span aria-hidden="true">·</span>
                <span>Timestamps</span>
                <span aria-hidden="true">·</span>
                <span>Cache Storage</span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {statusMessage && (
            <div className="p-3 rounded-2xl bg-emerald-50 text-emerald-800 text-xs font-semibold flex items-center gap-2 border border-emerald-100 animate-in fade-in">
              <Check className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{statusMessage}</span>
            </div>
          )}

          {/* Section 1: Numeric Precision */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <Coins className="w-3.5 h-3.5 text-amber-500" />
                <span>Coin & Score Numeric Precision</span>
              </label>
              <span className="text-[11px] font-mono text-slate-400">
                {settings.numericPrecision}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              {[
                { id: 'integer', label: 'Integer', desc: '1,246', sub: '0 decimals' },
                { id: 'two_decimals', label: 'Financial', desc: '1,245.88', sub: '2 decimals' },
                { id: 'four_decimals', label: 'Micro-Spark', desc: '1,245.8754', sub: '4 decimals' },
                { id: 'compact', label: 'Compact', desc: '1.25k', sub: 'Metric' },
              ].map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleUpdateNumeric(item.id as NumericPrecision)}
                  className={`p-3 rounded-2xl border text-left transition-all ${
                    settings.numericPrecision === item.id
                      ? 'border-[#ff3b69] bg-rose-50/50 shadow-xs'
                      : 'border-slate-200/80 bg-slate-50 hover:bg-white'
                  }`}
                >
                  <div className="font-semibold text-xs text-slate-900">{item.label}</div>
                  <div className="font-mono text-xs text-[#ff3b69] font-bold my-0.5">{item.desc}</div>
                  <div className="text-[10px] text-slate-400">{item.sub}</div>
                </button>
              ))}
            </div>

            {/* Rounding Mode */}
            <div className="flex items-center justify-between text-xs p-3 rounded-2xl bg-slate-50 border border-slate-100">
              <span className="text-slate-600 font-medium">Rounding Strategy:</span>
              <div className="flex items-center gap-1">
                {(['half_up', 'floor', 'ceil'] as RoundingStrategy[]).map((r) => (
                  <button
                    key={r}
                    onClick={() => handleUpdateRounding(r)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all ${
                      settings.roundingMode === r
                        ? 'bg-white text-slate-900 shadow-xs border border-slate-200'
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    {r === 'half_up' ? 'Half-Up' : r === 'floor' ? 'Truncate' : 'Ceil'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Section 2: Timestamp Precision */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-blue-500" />
                <span>Message & Activity Timestamp Fidelity</span>
              </label>
            </div>

            <div className="space-y-2">
              {[
                {
                  id: 'relative',
                  label: 'Relative Timeline',
                  sample: formatTimestampPrecision(nowTimestamp - 120000, { timestampPrecision: 'relative' }),
                  detail: 'Casual view (e.g. "Just now", "2m", "Yesterday")',
                },
                {
                  id: 'seconds',
                  label: 'Exact Time (Seconds)',
                  sample: formatTimestampPrecision(nowTimestamp, { timestampPrecision: 'seconds' }),
                  detail: 'Messaging fidelity with hour, minute, second (HH:mm:ss)',
                },
                {
                  id: 'iso_precise',
                  label: 'High Precision ISO (Milliseconds)',
                  sample: formatTimestampPrecision(nowTimestamp, { timestampPrecision: 'iso_precise' }),
                  detail: 'Full timestamp resolution with millisecond accuracy (.SSS)',
                },
              ].map((ts) => (
                <div
                  key={ts.id}
                  onClick={() => handleUpdateTimestamp(ts.id as TimestampPrecision)}
                  className={`p-3 rounded-2xl border flex items-center justify-between gap-3 cursor-pointer transition-all ${
                    settings.timestampPrecision === ts.id
                      ? 'border-[#ff3b69] bg-rose-50/40'
                      : 'border-slate-200/80 bg-slate-50/60 hover:bg-white'
                  }`}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-xs text-slate-900">{ts.label}</span>
                      {settings.timestampPrecision === ts.id && (
                        <span className="w-2 h-2 rounded-full bg-[#ff3b69]" />
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{ts.detail}</div>
                  </div>
                  <div className="font-mono text-xs font-bold text-slate-700 bg-white px-2.5 py-1 rounded-lg border border-slate-200 shrink-0">
                    {ts.sample}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Section 3: E2EE & Data Protection Precision */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                <span>E2EE & Privacy Protection Controls</span>
              </label>
              <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                AES-256-GCM
              </span>
            </div>

            <div className="space-y-2">
              <button
                type="button"
                onClick={() => {
                  const next = !settings.e2eeStrictProtection;
                  const updated = { ...settings, e2eeStrictProtection: next };
                  setSettings(updated);
                  savePrecisionSettings(updated);
                  setStatusMessage(
                    next
                      ? 'Strict E2EE message verification enabled.'
                      : 'Standard E2EE compatibility mode active.'
                  );
                }}
                className="w-full p-3 rounded-2xl border border-slate-200/80 bg-slate-50/70 hover:bg-white flex items-center justify-between gap-3 text-left transition-all"
              >
                <div>
                  <div className="text-xs font-semibold text-slate-900">
                    Strict E2EE Ciphertext Verification
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    Enforces ECDH P-256 + AES-256-GCM authenticated encryption on 1-on-1 messages
                  </div>
                </div>
                <div
                  className={`w-10 h-5.5 rounded-full p-0.5 transition-colors shrink-0 ${
                    settings.e2eeStrictProtection ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                >
                  <div
                    className={`w-4.5 h-4.5 rounded-full bg-white shadow-xs transition-transform ${
                      settings.e2eeStrictProtection ? 'translate-x-4.5' : 'translate-x-0'
                    }`}
                  />
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  const next = !settings.stripAttachmentMetadata;
                  const updated = { ...settings, stripAttachmentMetadata: next };
                  setSettings(updated);
                  savePrecisionSettings(updated);
                  setStatusMessage(
                    next
                      ? 'Media & attachment metadata scrubbing enabled.'
                      : 'Media metadata scrubbing disabled.'
                  );
                }}
                className="w-full p-3 rounded-2xl border border-slate-200/80 bg-slate-50/70 hover:bg-white flex items-center justify-between gap-3 text-left transition-all"
              >
                <div>
                  <div className="text-xs font-semibold text-slate-900">
                    Scrub Media & Timestamp Metadata
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    Strips device EXIF & high-entropy path identifiers when uploading chat photos
                  </div>
                </div>
                <div
                  className={`w-10 h-5.5 rounded-full p-0.5 transition-colors shrink-0 ${
                    settings.stripAttachmentMetadata ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                >
                  <div
                    className={`w-4.5 h-4.5 rounded-full bg-white shadow-xs transition-transform ${
                      settings.stripAttachmentMetadata ? 'translate-x-4.5' : 'translate-x-0'
                    }`}
                  />
                </div>
              </button>
            </div>
          </div>

          {/* Section 4: Live Preview & Storage Telemetry */}
          <div className="p-4 rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 text-white shadow-sm space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-300 font-medium flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span>Live Formatted Preview</span>
              </span>
              <span className="text-[10px] text-slate-400 font-mono">Realtime preview</span>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="p-2.5 rounded-xl bg-white/10 border border-white/10">
                <div className="text-[10px] text-slate-300">Your Coin Balance</div>
                <div className="font-mono font-black text-sm text-amber-300 mt-0.5">
                  {formatNumericPrecision(profile.coins, settings)} 🪙
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-white/10 border border-white/10">
                <div className="text-[10px] text-slate-300">Timestamp Sample</div>
                <div className="font-mono text-xs text-slate-200 mt-0.5 truncate">
                  {formatTimestampPrecision(nowTimestamp, settings)}
                </div>
              </div>
            </div>
          </div>

          {/* Section 5: Storage Breakdown & Optimization */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <HardDrive className="w-3.5 h-3.5 text-purple-500" />
                <span>Storage & Memory Usage</span>
              </label>
              <span className="text-xs font-mono font-bold text-slate-700">
                {formatStorageBytes(metrics.totalBytes)}
              </span>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-100 space-y-2.5 text-xs">
              <div className="flex items-center justify-between text-slate-600">
                <span>Cached Messages:</span>
                <span className="font-mono font-bold text-slate-900">{metrics.messageCount}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>Cached Conversations:</span>
                <span className="font-mono font-bold text-slate-900">{metrics.conversationsCount}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>Local Accounts Stored:</span>
                <span className="font-mono font-bold text-slate-900">{metrics.accountsCount}</span>
              </div>

              <div className="pt-2 border-t border-slate-200 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleNormalizeData}
                  className="px-3 py-1.5 rounded-xl bg-white border border-slate-200 text-slate-700 hover:text-slate-900 font-semibold text-[11px] flex items-center gap-1.5 shadow-2xs hover:bg-slate-50 active:scale-95 transition-all"
                >
                  <RefreshCw className="w-3 h-3 text-[#ff3b69]" />
                  <span>Recalculate & Normalize Data</span>
                </button>
                <button
                  type="button"
                  onClick={handlePurgeCache}
                  className="px-3 py-1.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 hover:bg-rose-100 font-semibold text-[11px] flex items-center gap-1.5 shadow-2xs active:scale-95 transition-all"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>Purge Stale Message Cache</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
          <span className="text-[11px] text-slate-500">
            Changes apply across all chats, cards, and reward boards immediately.
          </span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
