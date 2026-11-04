/**
 * Spark Service Worker — Background Web Push & Deep-Link Notification Handler
 * Supports both root ("/") and GitHub Pages ("/spark/") deployments.
 * Never caches private messages, authentication tokens, or personal user data.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Helper to resolve an asset URL relative to the Service Worker registration scope
 * so icons and deep links work at both "/" and "/spark/".
 */
function resolveScopeUrl(relativePath) {
  try {
    const scope = self.registration && self.registration.scope ? self.registration.scope : self.location.origin + '/';
    const cleanRel = (relativePath || '').replace(/^\/+/, '');
    return new URL(cleanRel, scope).href;
  } catch (e) {
    return relativePath || '/';
  }
}

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
  const icon = payload.icon || resolveScopeUrl('public/icon.svg');
  const badge = payload.badge || resolveScopeUrl('public/icon.svg');
  const targetUrl = payload.url
    ? resolveScopeUrl(payload.url)
    : conversationId
    ? resolveScopeUrl(`?chat=${encodeURIComponent(conversationId)}`)
    : resolveScopeUrl('');

  const handlePushPromise = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((windowClients) => {
      // Check if any open Spark window is currently focused and actively viewing this exact conversation
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.focused && client.visibilityState === 'visible') {
          // Notify active client so it can optionally handle in-app state, and check if it's already in this chat
          client.postMessage({
            type: 'SPARK_PUSH_RECEIVED_FOREGROUND',
            conversationId,
            title,
            body,
            isGroup,
          });
          // If the focused tab URL has ?chat=<conversationId> or active hash, still allow OS notification
          // unless suppressWhenFocused is explicitly requested by payload
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
