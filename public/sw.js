/**
 * Spark Service Worker — Installable PWA App Shell, Safe Offline Fallback & Background Web Push
 * Supports both root ("/") and GitHub Pages ("/spark/") deployments.
 *
 * Security & Privacy Guarantees:
 * - Caches ONLY safe static application shell assets (HTML shell, CSS/JS bundles, icons, manifest).
 * - NEVER caches private messages, authentication tokens, user profiles, or API responses.
 * - Offline fallback is static and contains zero personal or sensitive information.
 */

const SHELL_CACHE_NAME = 'spark-app-shell-v4';

const SAFE_APP_SHELL_PATHS = [
  './',
  './index.html',
  './public/manifest.json',
  './public/icon.svg',
  './public/pwa-192x192.png',
  './public/pwa-512x512.png',
  './public/pwa-maskable-512x512.png',
  './public/apple-touch-icon.png',
  './public/gh-pages-bundle/app.css',
  './public/gh-pages-bundle/app.js',
];

const SAFE_OFFLINE_FALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#ff3b69" />
  <title>Spark — Offline</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: linear-gradient(135deg, #f8fafc 0%, #fff1f2 100%);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #0f172a;
    }
    .card {
      max-width: 360px;
      width: 100%;
      background: #ffffff;
      border-radius: 28px;
      padding: 32px 24px;
      text-align: center;
      box-shadow: 0 20px 40px rgba(15, 23, 42, 0.08);
      border: 1px solid #f1f5f9;
    }
    .logo {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: linear-gradient(135deg, #ff3b69 0%, #fb7185 100%);
      color: #ffffff;
      font-size: 26px;
      font-weight: 900;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 16px;
    }
    h1 { font-size: 20px; font-weight: 800; margin-bottom: 8px; }
    p { font-size: 13px; line-height: 1.5; color: #64748b; margin-bottom: 20px; }
    button {
      width: 100%;
      padding: 12px 20px;
      border-radius: 9999px;
      border: none;
      background: linear-gradient(90deg, #ff3b69 0%, #fb7185 100%);
      color: #ffffff;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">&#9889;</div>
    <h1>You're Offline</h1>
    <p>Spark needs an internet connection to sync encrypted messages. Check your connection and try again.</p>
    <button onclick="window.location.reload()">Retry Connection</button>
  </div>
</body>
</html>`;

/**
 * Helper to resolve an asset URL relative to the Service Worker registration scope
 * so icons and deep links work at both "/" and "/spark/".
 */
function resolveScopeUrl(relativePath) {
  try {
    const scope =
      self.registration && self.registration.scope
        ? self.registration.scope
        : self.location.origin + '/';
    const cleanRel = (relativePath || '').replace(/^\/+/, '');
    return new URL(cleanRel, scope).href;
  } catch (e) {
    return relativePath || '/';
  }
}

/**
 * Strictly validates that a request is a safe, static, same-origin application shell request.
 * Never allows caching of API calls, Supabase endpoints, auth tokens, or user data.
 */
function isSafeAppShellRequest(request) {
  if (!request || request.method !== 'GET') return false;

  try {
    const url = new URL(request.url);

    // Only allow same-origin HTTP(S) requests (excludes *.supabase.co and all external APIs)
    if (url.origin !== self.location.origin) return false;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

    const lowerPathAndQuery = (url.pathname + url.search).toLowerCase();

    // Never cache any auth, API, database, realtime, storage, or token-bearing URLs
    const forbiddenPatterns = [
      '/api/',
      '/auth',
      '/rest/',
      '/realtime',
      '/storage/',
      '/functions/',
      'supabase',
      'access_token',
      'refresh_token',
      'apikey',
      'token=',
      'code=',
    ];
    for (let i = 0; i < forbiddenPatterns.length; i++) {
      if (lowerPathAndQuery.includes(forbiddenPatterns[i])) {
        return false;
      }
    }

    if (request.mode === 'navigate') return true;

    const safeExtensions = ['.html', '.css', '.js', '.json', '.png', '.svg', '.ico', '.woff2'];
    for (let i = 0; i < safeExtensions.length; i++) {
      if (url.pathname.endsWith(safeExtensions[i])) {
        return true;
      }
    }

    return false;
  } catch (e) {
    return false;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE_NAME)
      .then((cache) => {
        const urlsToCache = SAFE_APP_SHELL_PATHS.map((p) => resolveScopeUrl(p));
        return Promise.allSettled(
          urlsToCache.map((u) =>
            fetch(u, { cache: 'reload' }).then((resp) => {
              if (resp && resp.status === 200 && resp.type === 'basic') {
                return cache.put(u, resp);
              }
            })
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE_NAME)
            .map((oldKey) => caches.delete(oldKey))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!isSafeAppShellRequest(request)) {
    return;
  }

  // Navigation requests: Network-first, falling back to cached index.html or safe offline HTML
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            networkResponse.type === 'basic'
          ) {
            const clone = networkResponse.clone();
            caches.open(SHELL_CACHE_NAME).then((cache) => {
              cache.put(resolveScopeUrl('./index.html'), clone);
            });
          }
          return networkResponse;
        })
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE_NAME);
          const cachedIndex =
            (await cache.match(resolveScopeUrl('./index.html'))) ||
            (await cache.match(resolveScopeUrl('./'))) ||
            (await cache.match(request));
          if (cachedIndex) return cachedIndex;

          return new Response(SAFE_OFFLINE_FALLBACK_HTML, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        })
    );
    return;
  }

  // Static app shell assets (.js, .css, icons, manifest): Network-first with cache fallback
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          networkResponse.type === 'basic'
        ) {
          const clone = networkResponse.clone();
          caches.open(SHELL_CACHE_NAME).then((cache) => {
            cache.put(request, clone);
          });
        }
        return networkResponse;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw new Error('Offline and asset not in app shell cache');
      })
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (e) {
      try {
        payload = { body: event.data.text() };
      } catch (err) {
        payload = {};
      }
    }
  }

  const title = payload.title || 'Spark';
  const conversationId = payload.conversationId || payload.conversation_id || '';
  const isGroup = Boolean(payload.isGroup || payload.is_group);
  const body =
    payload.body ||
    (isGroup ? 'New message in your group.' : 'You received a new message.');
  const tag = payload.tag || (conversationId ? `spark-conv-${conversationId}` : 'spark-msg');
  const icon = payload.icon || resolveScopeUrl('public/pwa-192x192.png');
  const badge = payload.badge || resolveScopeUrl('public/pwa-192x192.png');
  const targetUrl = payload.url
    ? resolveScopeUrl(payload.url)
    : conversationId
    ? resolveScopeUrl(`?chat=${encodeURIComponent(conversationId)}`)
    : resolveScopeUrl('');

  const handlePushPromise = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((windowClients) => {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.focused && client.visibilityState === 'visible') {
          client.postMessage({
            type: 'SPARK_PUSH_RECEIVED_FOREGROUND',
            conversationId,
            title,
            body,
            isGroup,
          });
          if (payload.suppressIfFocused && client.url.includes(conversationId)) {
            return;
          }
        }
      }

      return self.registration.showNotification(title, {
        body,
        icon,
        badge,
        tag,
        renotify: true,
        vibrate: [180, 80, 180],
        data: {
          url: targetUrl,
          conversationId,
          isGroup,
          senderId: payload.senderId || payload.sender_id || '',
          timestamp: Date.now(),
        },
      });
    });

  event.waitUntil(handlePushPromise);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const conversationId = data.conversationId || '';
  const targetUrl =
    data.url ||
    (conversationId
      ? resolveScopeUrl(`?chat=${encodeURIComponent(conversationId)}`)
      : resolveScopeUrl(''));

  const handleClickPromise = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(async (windowClients) => {
      const scopeBase =
        self.registration && self.registration.scope
          ? self.registration.scope
          : self.location.origin;

      // 1. Prefer an existing Spark tab within our scope so we never spawn duplicate tabs unnecessarily
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.startsWith(scopeBase) && 'focus' in client) {
          try {
            await client.focus();
          } catch (e) {}
          client.postMessage({
            type: 'SPARK_OPEN_CONVERSATION',
            conversationId,
            url: targetUrl,
          });
          return client;
        }
      }

      // 2. Fallback: any open client on the same origin
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          try {
            await client.focus();
          } catch (e) {}
          client.postMessage({
            type: 'SPARK_OPEN_CONVERSATION',
            conversationId,
            url: targetUrl,
          });
          return client;
        }
      }

      // 3. If Spark is completely closed, open a new browser window/tab directly to the conversation URL
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    });

  event.waitUntil(handleClickPromise);
});
