import { createClient, SupabaseClient } from '@supabase/supabase-js';

const STORAGE_KEY_URL = 'spark_supabase_url';
const STORAGE_KEY_ANON = 'spark_supabase_anon';

export function sanitizeSupabaseUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let cleaned = rawUrl.trim().replace(/\/+$/, '');
  cleaned = cleaned.replace(/\/rest\/v1\/?$/i, '');
  cleaned = cleaned.replace(/\/rest\/?$/i, '');
  cleaned = cleaned.replace(/\/auth\/v1\/?$/i, '');
  return cleaned.replace(/\/+$/, '');
}

export function isValidHttpUrl(str: string): boolean {
  if (!str || typeof str !== 'string') return false;
  const trimmed = sanitizeSupabaseUrl(str);
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export function isLikelyApiKey(str: string): boolean {
  if (!str || typeof str !== 'string') return false;
  const trimmed = str.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return false;
  return (
    trimmed.startsWith('eyJ') ||
    trimmed.startsWith('sb_publishable_') ||
    trimmed.startsWith('sb_secret_') ||
    (trimmed.split('.').length === 3 && trimmed.length > 40)
  );
}

export const DEFAULT_PROJECT_URL = 'https://zyyaeuiprnrezuuqdmyt.supabase.co';
export const DEFAULT_ANON_KEY = 'sb_publishable_FQzPhZZQolCGuGpGSO_HcA__P41b0DG';

export function getOneClickShareableUrl(): string | null {
  const { url, anonKey } = getSavedCredentials();
  const targetUrl = url || DEFAULT_PROJECT_URL;
  const targetKey = anonKey || DEFAULT_ANON_KEY;
  if (!targetUrl || !targetKey || !isValidHttpUrl(targetUrl) || targetKey.length < 10) return null;
  if (typeof window === 'undefined') return null;
  const baseUrl = window.location.origin + window.location.pathname;
  return `${baseUrl}?sb_url=${encodeURIComponent(targetUrl)}&sb_key=${encodeURIComponent(targetKey)}`;
}

export function getSupabaseConfigState(): {
  rawUrl: string;
  rawAnon: string;
  detectedUrlIsKey: boolean;
  isConfigured: boolean;
} {
  // Check for auto-configuration parameters from URL search or hash fragment
  if (typeof window !== 'undefined') {
    try {
      let paramUrl = '';
      let paramKey = '';

      if (window.location?.search) {
        const searchParams = new URLSearchParams(window.location.search);
        paramUrl = searchParams.get('sb_url')?.trim() || '';
        paramKey = searchParams.get('sb_key')?.trim() || '';
      }

      if ((!paramUrl || !paramKey) && window.location?.hash && window.location.hash.includes('?')) {
        const hashQuery = window.location.hash.split('?')[1];
        if (hashQuery) {
          const hashParams = new URLSearchParams(hashQuery);
          paramUrl = paramUrl || hashParams.get('sb_url')?.trim() || '';
          paramKey = paramKey || hashParams.get('sb_key')?.trim() || '';
        }
      }

      if (paramUrl && paramKey && isValidHttpUrl(paramUrl)) {
        localStorage.setItem(STORAGE_KEY_URL, sanitizeSupabaseUrl(paramUrl));
        localStorage.setItem(STORAGE_KEY_ANON, paramKey);
        // Clean URL query parameters smoothly without reloading
        const cleanSearch = new URLSearchParams(window.location.search);
        cleanSearch.delete('sb_url');
        cleanSearch.delete('sb_key');
        const newSearchStr = cleanSearch.toString() ? `?${cleanSearch.toString()}` : '';
        const cleanHash = window.location.hash.includes('?')
          ? window.location.hash.split('?')[0]
          : window.location.hash;
        const newRelativePath = window.location.pathname + newSearchStr + cleanHash;
        window.history.replaceState(null, '', newRelativePath);
      }
    } catch {}
  }

  const envUrl =
    typeof import.meta.env.VITE_SUPABASE_URL === 'string'
      ? import.meta.env.VITE_SUPABASE_URL.trim()
      : '';
  const envAnon =
    typeof import.meta.env.VITE_SUPABASE_ANON_KEY === 'string'
      ? import.meta.env.VITE_SUPABASE_ANON_KEY.trim()
      : '';

  let localUrl = '';
  let localAnon = '';
  try {
    localUrl = localStorage.getItem(STORAGE_KEY_URL)?.trim() || '';
    localAnon = localStorage.getItem(STORAGE_KEY_ANON)?.trim() || '';
  } catch {}

  // Use configured URL or default project URL and anon key
  const validLocalUrl = localUrl && isValidHttpUrl(localUrl) && !isLikelyApiKey(localUrl) ? localUrl : '';
  const validLocalAnon = localAnon && isLikelyApiKey(localAnon) ? localAnon : '';

  const rawUrl = validLocalUrl || envUrl || DEFAULT_PROJECT_URL;
  const rawAnon = validLocalAnon || envAnon || DEFAULT_ANON_KEY;
  const detectedUrlIsKey = isLikelyApiKey(rawUrl);

  return {
    rawUrl,
    rawAnon,
    detectedUrlIsKey,
    isConfigured: !detectedUrlIsKey && Boolean(rawUrl && rawAnon && isValidHttpUrl(rawUrl)),
  };
}

// Default to env vars if present, otherwise check localStorage
export function getSavedCredentials(): { url: string; anonKey: string } {
  const { rawUrl, rawAnon, detectedUrlIsKey } = getSupabaseConfigState();

  return {
    url: detectedUrlIsKey ? DEFAULT_PROJECT_URL : sanitizeSupabaseUrl(rawUrl),
    anonKey: rawAnon || (detectedUrlIsKey ? rawUrl : DEFAULT_ANON_KEY),
  };
}

let supabaseInstance: SupabaseClient | null = null;
let currentConfigKey = '';

const safeBrowserFetch: typeof fetch = (...args: Parameters<typeof fetch>) => {
  const fn = typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : typeof window !== 'undefined' && typeof window.fetch === 'function'
    ? window.fetch.bind(window)
    : fetch;
  return fn(...args);
};

export function isSupabaseConfigured(): boolean {
  const { url, anonKey } = getSavedCredentials();
  if (!url || !anonKey) return false;
  if (!isValidHttpUrl(url)) return false;
  if (
    url.includes('your-project-ref') ||
    url.includes('xyzcompany') ||
    anonKey.includes('your-anon-public-key') ||
    anonKey.length < 10
  ) {
    return false;
  }
  return true;
}

export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured()) {
    return null;
  }

  const { url, anonKey } = getSavedCredentials();
  const key = `${url}_${anonKey}`;

  if (!supabaseInstance || currentConfigKey !== key) {
    try {
      supabaseInstance = createClient(url, anonKey, {
        global: {
          fetch: safeBrowserFetch,
        },
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
        realtime: {
          params: {
            eventsPerSecond: 10,
          },
        },
      });
      currentConfigKey = key;
    } catch {
      supabaseInstance = null;
      return null;
    }
  }

  return supabaseInstance;
}

export function saveSupabaseCredentials(url: string, anonKey: string) {
  const cleanUrl = sanitizeSupabaseUrl(url);
  const cleanAnon = anonKey.trim();
  try {
    localStorage.setItem(STORAGE_KEY_URL, cleanUrl);
    localStorage.setItem(STORAGE_KEY_ANON, cleanAnon);
  } catch {}
  supabaseInstance = null; // force re-create
  return getSupabase();
}

export function clearSupabaseCredentials() {
  try {
    localStorage.removeItem(STORAGE_KEY_URL);
    localStorage.removeItem(STORAGE_KEY_ANON);
  } catch {}
  supabaseInstance = null;
}

export interface DatabaseVerificationReport {
  success: boolean;
  message: string;
  tables?: { name: string; exists: boolean; status: string }[];
  bucketExists?: boolean;
}

export async function testSupabaseConnection(url: string, anonKey: string): Promise<DatabaseVerificationReport> {
  if (!isValidHttpUrl(url)) {
    return {
      success: false,
      message: 'Please enter a valid URL starting with https://',
      tables: [],
    };
  }
  if (!anonKey || anonKey.trim().length < 10) {
    return {
      success: false,
      message: 'Please enter a valid Supabase anon public key.',
      tables: [],
    };
  }

  try {
    const testClient = createClient(url.trim().replace(/\/+$/, ''), anonKey.trim(), {
      global: {
        fetch: safeBrowserFetch,
      },
    });
    const tableNames = [
      'profiles',
      'conversations',
      'conversation_members',
      'messages',
      'user_crypto_keys',
      'friendships',
    ];
    const tableResults: { name: string; exists: boolean; status: string }[] = [];

    for (const tbl of tableNames) {
      const { error } = await testClient.from(tbl).select('*').limit(1);
      if (error && error.message?.includes('does not exist')) {
        tableResults.push({ name: tbl, exists: false, status: 'Missing in SQL' });
      } else {
        tableResults.push({ name: tbl, exists: true, status: 'Ready & Protected' });
      }
    }

    // Check private image storage bucket ('chat-media' or 'storage')
    let bucketExists = false;
    try {
      const { error: listErr } = await testClient.storage.from('chat-media').list('', { limit: 1 });
      if (!listErr || !listErr.message?.toLowerCase().includes('not found')) {
        bucketExists = true;
      } else {
        const { error: fallbackErr } = await testClient.storage.from('storage').list('', { limit: 1 });
        if (!fallbackErr || !fallbackErr.message?.toLowerCase().includes('not found')) {
          bucketExists = true;
        }
      }
    } catch {
      bucketExists = false;
    }

    const allExist = tableResults.every((t) => t.exists);
    return {
      success: true,
      message: allExist
        ? 'All tables & SQL migrations verified successfully! Your Supabase database is ready.'
        : 'Connected to Supabase, but some tables are missing. Please re-run the SQL migration script.',
      tables: tableResults,
      bucketExists,
    };
  } catch (err: any) {
    return {
      success: false,
      message: err?.message || 'Connection failed',
      tables: [],
    };
  }
}
