/**
 * Supabase Edge Function: send-push-notification
 * Triggered automatically via Supabase Database Webhook (AFTER INSERT on public.messages).
 *
 * Security & Privacy Guarantees:
 * - Never exposes plaintext content of E2EE messages in Web Push payloads.
 * - Never sends a push notification to the message sender (`sender_id`).
 * - Respects user notification preferences (`push_enabled`, `dm_enabled`, `group_enabled`, `muted_conversations`)
 *   and per-chat `conversation_members.is_muted` / `deleted_at`.
 * - Supports multiple active device subscriptions per user.
 * - Automatically deletes expired or unsubscribed endpoints (HTTP 404 / 410).
 *
 * Required Edge Function Secrets (configure via `supabase secrets set` or Dashboard -> Edge Functions -> Secrets):
 * - VAPID_PUBLIC_KEY
 * - VAPID_PRIVATE_KEY
 * - VAPID_SUBJECT (optional, defaults to "mailto:notifications@spark-app.local")
 * - SUPABASE_URL (automatically injected by Supabase runtime)
 * - SUPABASE_SERVICE_ROLE_KEY (automatically injected by Supabase runtime)
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface WebhookInsertPayload {
  type?: 'INSERT' | 'UPDATE' | 'DELETE';
  table?: string;
  schema?: string;
  record?: {
    id: string;
    conversation_id?: string | null;
    sender_id: string;
    receiver_id?: string | null;
    content?: string | null;
    ciphertext?: string | null;
    iv?: string | null;
    media_url?: string | null;
    deleted_at?: string | null;
    created_at?: string;
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const vapidPublicKey =
      Deno.env.get('VAPID_PUBLIC_KEY') ??
      'BJgUZPhdUoOEDDMaETACOGKwyAk8kQNvvuZrQkB8EiV7McXinQxaPnnHh2Vax0xqY2TSkx1WX1I8dW9K5l3sXYk';
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
    const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:notifications@spark-app.local';

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return new Response(
        JSON.stringify({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!vapidPrivateKey) {
      return new Response(
        JSON.stringify({ error: 'Missing VAPID_PRIVATE_KEY in Edge Function secrets' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    const body: WebhookInsertPayload = await req.json();
    const record = body.record || (body as any);

    if (!record || !record.id || !record.sender_id) {
      return new Response(
        JSON.stringify({ skipped: true, reason: 'Invalid message payload' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Never send notifications for soft-deleted messages
    if (record.deleted_at) {
      return new Response(
        JSON.stringify({ skipped: true, reason: 'Message is deleted' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const senderId = record.sender_id;
    const conversationId = record.conversation_id || '';

    // 1. Fetch sender profile display name
    const { data: senderProfile } = await supabase
      .from('profiles')
      .select('username, display_name')
      .eq('id', senderId)
      .maybeSingle();

    const senderName =
      senderProfile?.display_name?.trim() ||
      senderProfile?.username?.trim() ||
      'Someone';

    // 2. Determine conversation metadata and eligible recipient user IDs
    let isGroup = false;
    let groupName = 'Group Chat';
    const recipientUserIds = new Set<string>();

    if (conversationId) {
      const { data: convData } = await supabase
        .from('conversations')
        .select('id, is_group, name, deleted_at')
        .eq('id', conversationId)
        .maybeSingle();

      if (convData?.deleted_at) {
        return new Response(
          JSON.stringify({ skipped: true, reason: 'Conversation is deleted' }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (convData) {
        isGroup = Boolean(convData.is_group);
        if (convData.name && convData.name.trim()) {
          groupName = convData.name.trim();
        }
      }

      const { data: members } = await supabase
        .from('conversation_members')
        .select('user_id, deleted_at, is_muted')
        .eq('conversation_id', conversationId);

      if (Array.isArray(members)) {
        for (const m of members) {
          if (
            m.user_id &&
            m.user_id !== senderId &&
            !m.deleted_at &&
            !m.is_muted
          ) {
            recipientUserIds.add(m.user_id);
          }
        }
      }
    }

    // Also include direct receiver_id for 1-to-1 messages if not already in set
    if (!isGroup && record.receiver_id && record.receiver_id !== senderId) {
      recipientUserIds.add(record.receiver_id);
    }

    const targetIds = Array.from(recipientUserIds);
    if (targetIds.length === 0) {
      return new Response(
        JSON.stringify({ skipped: true, reason: 'No eligible recipients' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 3. Check user-level notification preferences (respect global disable, DM/group toggles, and muted_conversations)
    const { data: prefsRows } = await supabase
      .from('notification_preferences')
      .select('user_id, push_enabled, dm_enabled, group_enabled, muted_conversations')
      .in('user_id', targetIds);

    const prefsMap = new Map<string, any>();
    if (Array.isArray(prefsRows)) {
      for (const p of prefsRows) {
        prefsMap.set(p.user_id, p);
      }
    }

    const allowedRecipientIds = targetIds.filter((uid) => {
      const pref = prefsMap.get(uid);
      if (!pref) return true; // Default enabled if no custom preference row
      if (pref.push_enabled === false) return false;
      if (isGroup && pref.group_enabled === false) return false;
      if (!isGroup && pref.dm_enabled === false) return false;
      if (
        conversationId &&
        Array.isArray(pref.muted_conversations) &&
        pref.muted_conversations.includes(conversationId)
      ) {
        return false;
      }
      return true;
    });

    if (allowedRecipientIds.length === 0) {
      return new Response(
        JSON.stringify({ skipped: true, reason: 'All recipients have muted notifications' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 4. Load all active push subscriptions for allowed recipients (supports multiple devices per user)
    const { data: subscriptions, error: subErr } = await supabase
      .from('push_subscriptions')
      .select('id, user_id, endpoint, p256dh, auth')
      .in('user_id', allowedRecipientIds);

    if (subErr || !subscriptions || subscriptions.length === 0) {
      return new Response(
        JSON.stringify({ skipped: true, reason: 'No active push subscriptions found for recipients' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 5. Construct E2EE-safe notification payload
    // CRITICAL: Never expose plaintext or ciphertext message content in Web Push notifications.
    const notificationTitle = isGroup
      ? `Spark — ${groupName}`
      : `Spark — ${senderName}`;
    const notificationBody = isGroup
      ? 'New message in your group.'
      : 'You received a new message.';

    const pushPayload = JSON.stringify({
      title: notificationTitle,
      body: notificationBody,
      conversationId: conversationId || senderId,
      isGroup,
      senderId,
      messageId: record.id,
      tag: conversationId ? `spark-conv-${conversationId}` : `spark-dm-${senderId}`,
      url: `?chat=${encodeURIComponent(conversationId || senderId)}`,
    });

    let sentCount = 0;
    const expiredSubscriptionIds: string[] = [];

    await Promise.all(
      subscriptions.map(async (sub: any) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.p256dh,
                auth: sub.auth,
              },
            },
            pushPayload,
            {
              TTL: 86400, // 24 hours TTL for offline mobile devices
              urgency: 'high',
            }
          );
          sentCount++;
        } catch (pushErr: any) {
          const statusCode = pushErr?.statusCode || pushErr?.status;
          // Safely remove expired or revoked subscriptions (HTTP 404 Not Found or 410 Gone)
          if (statusCode === 404 || statusCode === 410) {
            expiredSubscriptionIds.push(sub.id);
          } else {
            console.warn(`Web Push error for subscription ${sub.id}:`, statusCode, pushErr?.message);
          }
        }
      })
    );

    if (expiredSubscriptionIds.length > 0) {
      await supabase
        .from('push_subscriptions')
        .delete()
        .in('id', expiredSubscriptionIds);
    }

    return new Response(
      JSON.stringify({
        success: true,
        sent: sentCount,
        expiredRemoved: expiredSubscriptionIds.length,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('Edge Function send-push-notification error:', err);
    return new Response(
      JSON.stringify({ error: err?.message || 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
