import { UserProfile } from '../types';

export type NumericPrecision = 'integer' | 'two_decimals' | 'four_decimals' | 'compact';
export type TimestampPrecision = 'relative' | 'seconds' | 'iso_precise';
export type RoundingStrategy = 'half_up' | 'floor' | 'ceil';
export type StoragePrecisionMode = 'exact_bytes' | 'human_readable';

export interface DataPrecisionSettings {
  numericPrecision: NumericPrecision;
  timestampPrecision: TimestampPrecision;
  roundingMode: RoundingStrategy;
  storagePrecision: StoragePrecisionMode;
  cacheSyncResolution: 'realtime' | 'high_precision' | 'battery_saver';
}

const PRECISION_SETTINGS_KEY = 'spark_data_precision_settings_v1';

export const DEFAULT_PRECISION_SETTINGS: DataPrecisionSettings = {
  numericPrecision: 'integer',
  timestampPrecision: 'relative',
  roundingMode: 'half_up',
  storagePrecision: 'human_readable',
  cacheSyncResolution: 'realtime',
};

/**
 * Loads current precision settings from localStorage
 */
export function getPrecisionSettings(): DataPrecisionSettings {
  try {
    const raw = localStorage.getItem(PRECISION_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_PRECISION_SETTINGS,
        ...parsed,
      };
    }
  } catch {}
  return { ...DEFAULT_PRECISION_SETTINGS };
}

/**
 * Saves precision settings to localStorage and dispatches a change event
 */
export function savePrecisionSettings(settings: DataPrecisionSettings): void {
  try {
    localStorage.setItem(PRECISION_SETTINGS_KEY, JSON.stringify(settings));
    window.dispatchEvent(new CustomEvent('spark_precision_changed', { detail: settings }));
  } catch (e) {
    console.warn('Failed to save precision settings:', e);
  }
}

/**
 * Applies rounding strategy to a numeric value with specific decimal places
 */
export function applyPrecisionRounding(
  val: number,
  decimals: number,
  roundingMode: RoundingStrategy = 'half_up'
): number {
  if (isNaN(val) || !isFinite(val)) return 0;
  const factor = Math.pow(10, decimals);
  if (roundingMode === 'floor') {
    return Math.floor(val * factor) / factor;
  }
  if (roundingMode === 'ceil') {
    return Math.ceil(val * factor) / factor;
  }
  return Math.round(val * factor) / factor;
}

/**
 * Formats any numeric value according to configured precision
 */
export function formatNumericPrecision(
  val: number,
  settingsInput?: Partial<DataPrecisionSettings>
): string {
  if (val === undefined || val === null || isNaN(val)) return '0';
  const settings = { ...getPrecisionSettings(), ...settingsInput };

  const mode = settings.numericPrecision;
  const rounding = settings.roundingMode;

  if (mode === 'compact') {
    const absVal = Math.abs(val);
    if (absVal >= 1_000_000) {
      const rounded = applyPrecisionRounding(val / 1_000_000, 2, rounding);
      return `${rounded.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}M`;
    }
    if (absVal >= 1_000) {
      const rounded = applyPrecisionRounding(val / 1_000, 2, rounding);
      return `${rounded.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}k`;
    }
    const rounded = applyPrecisionRounding(val, 0, rounding);
    return rounded.toLocaleString();
  }

  if (mode === 'four_decimals') {
    const rounded = applyPrecisionRounding(val, 4, rounding);
    return rounded.toLocaleString(undefined, {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    });
  }

  if (mode === 'two_decimals') {
    const rounded = applyPrecisionRounding(val, 2, rounding);
    return rounded.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  // default: integer
  const rounded = applyPrecisionRounding(val, 0, rounding);
  return rounded.toLocaleString();
}

/**
 * Formats a timestamp according to selected timestamp precision
 */
export function formatTimestampPrecision(
  dateInput?: string | Date | number,
  settingsInput?: Partial<DataPrecisionSettings>
): string {
  if (!dateInput) return '';
  const settings = { ...getPrecisionSettings(), ...settingsInput };

  try {
    const dateObj = typeof dateInput === 'string' || typeof dateInput === 'number'
      ? new Date(dateInput)
      : dateInput;

    if (isNaN(dateObj.getTime())) return '';

    if (settings.timestampPrecision === 'iso_precise') {
      // YYYY-MM-DD HH:mm:ss.SSS (High Precision)
      const year = dateObj.getFullYear();
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const day = String(dateObj.getDate()).padStart(2, '0');
      const hours = String(dateObj.getHours()).padStart(2, '0');
      const mins = String(dateObj.getMinutes()).padStart(2, '0');
      const secs = String(dateObj.getSeconds()).padStart(2, '0');
      const ms = String(dateObj.getMilliseconds()).padStart(3, '0');
      return `${year}-${month}-${day} ${hours}:${mins}:${secs}.${ms}`;
    }

    if (settings.timestampPrecision === 'seconds') {
      // Exact time with seconds: HH:mm:ss
      const hours = String(dateObj.getHours()).padStart(2, '0');
      const mins = String(dateObj.getMinutes()).padStart(2, '0');
      const secs = String(dateObj.getSeconds()).padStart(2, '0');
      return `${hours}:${mins}:${secs}`;
    }

    // Relative mode
    const diffMs = Date.now() - dateObj.getTime();
    if (diffMs < 0) return 'Just now';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days}d`;
    return dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

/**
 * Formats byte values for storage inspection
 */
export function formatStorageBytes(bytes: number, exactBytesMode: boolean = false): string {
  if (exactBytesMode) {
    return `${bytes.toLocaleString()} B`;
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Calculates current localStorage utilization and item counts
 */
export function getStorageUsageMetrics() {
  let totalBytes = 0;
  let messageCount = 0;
  let conversationsCount = 0;
  let accountsCount = 0;
  const breakdown: { key: string; bytes: number; description: string }[] = [];

  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const value = localStorage.getItem(key) || '';
      const bytes = (key.length + value.length) * 2; // UTF-16 byte representation
      totalBytes += bytes;

      let description = 'General setting';
      if (key.startsWith('spark_chat_cache_')) {
        description = 'Encrypted message cache';
        try {
          const list = JSON.parse(value);
          if (Array.isArray(list)) messageCount += list.length;
        } catch {}
      } else if (key.startsWith('spark_local_conversations')) {
        description = 'Cached conversation metadata';
        try {
          const list = JSON.parse(value);
          if (Array.isArray(list)) conversationsCount += list.length;
        } catch {}
      } else if (key.includes('accounts')) {
        description = 'Local auth accounts';
        try {
          const list = JSON.parse(value);
          if (Array.isArray(list)) accountsCount += list.length;
        } catch {}
      } else if (key.includes('profile')) {
        description = 'Active profile cache';
      }

      breakdown.push({ key, bytes, description });
    }
  } catch (err) {
    console.warn('Storage metrics read note:', err);
  }

  breakdown.sort((a, b) => b.bytes - a.bytes);

  return {
    totalBytes,
    messageCount,
    conversationsCount,
    accountsCount,
    breakdown,
  };
}

/**
 * Recalculates and normalizes user profile numbers to prevent floating point inaccuracies
 */
export function normalizeProfileDataPrecision(
  profile: UserProfile,
  settings: DataPrecisionSettings
): { normalized: UserProfile; fixedDelta: number } {
  const originalCoins = profile.coins;
  const originalWeekly = profile.weekly_coins || 0;
  const originalDaily = profile.daily_coins_earned || 0;

  const decimals = settings.numericPrecision === 'four_decimals'
    ? 4
    : settings.numericPrecision === 'two_decimals'
    ? 2
    : 0;

  const cleanCoins = applyPrecisionRounding(originalCoins, decimals, settings.roundingMode);
  const cleanWeekly = applyPrecisionRounding(originalWeekly, decimals, settings.roundingMode);
  const cleanDaily = applyPrecisionRounding(originalDaily, decimals, settings.roundingMode);

  const delta = Math.abs(originalCoins - cleanCoins);

  const normalized: UserProfile = {
    ...profile,
    coins: cleanCoins,
    weekly_coins: cleanWeekly,
    daily_coins_earned: cleanDaily,
    streak_days: Math.max(0, Math.floor(profile.streak_days || 0)),
  };

  return {
    normalized,
    fixedDelta: delta,
  };
}

/**
 * Clears non-essential caches while preserving accounts and active sessions
 */
export function purgeMessageCache(): { freedBytes: number; deletedKeysCount: number } {
  let freedBytes = 0;
  let deletedKeysCount = 0;

  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('spark_chat_cache_')) {
        const value = localStorage.getItem(key) || '';
        freedBytes += (key.length + value.length) * 2;
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((k) => {
      localStorage.removeItem(k);
      deletedKeysCount++;
    });
  } catch (e) {
    console.warn('Purge cache note:', e);
  }

  return { freedBytes, deletedKeysCount };
}
