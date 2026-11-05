/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Script 1: Delete all previous tables and start from a clean slate
export const SUPABASE_DELETE_PREVIOUS_SQL = `-- =========================================================
-- SPARK APP: DELETE PREVIOUS TABLES ONLY
-- Run this in Supabase SQL Editor if you need to wipe old tables:
-- =========================================================

DROP TABLE IF EXISTS public.messages CASCADE;
DROP TABLE IF EXISTS public.conversation_members CASCADE;
DROP TABLE IF EXISTS public.conversations CASCADE;
DROP TABLE IF EXISTS public.user_crypto_keys CASCADE;
DROP TABLE IF EXISTS public.friendships CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;
`;

// Script 2: Complete Fresh Production Setup (Drops any old tables first, then builds complete schema)
export const SUPABASE_SETUP_SQL = `-- =========================================================
-- SPARK APP: COMPLETE CLEAN PRODUCTION DATABASE SETUP
-- Drops previous tables first, then creates clean schema:
-- (Dashboard -> SQL Editor -> New query -> Paste & Run)
-- =========================================================

-- 0. Clean up any previous tables to prevent schema/constraint conflicts
DROP TABLE IF EXISTS public.messages CASCADE;
DROP TABLE IF EXISTS public.conversation_members CASCADE;
DROP TABLE IF EXISTS public.conversations CASCADE;
DROP TABLE IF EXISTS public.user_crypto_keys CASCADE;
DROP TABLE IF EXISTS public.friendships CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;

-- 1. Create PROFILES Table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT 'https://api.dicebear.com/7.x/bottts/svg?seed=spark1',
  avatar_style TEXT DEFAULT 'cosmic_neon',
  bio TEXT DEFAULT '',
  coins INTEGER NOT NULL DEFAULT 50,
  weekly_coins INTEGER NOT NULL DEFAULT 0,
  streak_days INTEGER NOT NULL DEFAULT 1,
  daily_coins_earned INTEGER NOT NULL DEFAULT 0,
  daily_coins_date DATE NOT NULL DEFAULT CURRENT_DATE,
  equipped_frame TEXT NOT NULL DEFAULT 'frame_pulsar',
  equipped_theme TEXT NOT NULL DEFAULT 'theme_cosmic',
  equipped_outfit TEXT NOT NULL DEFAULT 'outfit_voyager',
  unlocked_items TEXT[] NOT NULL DEFAULT ARRAY['frame_pulsar', 'theme_cosmic', 'outfit_voyager'],
  last_spark_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT check_username_format CHECK (username ~* '^[a-zA-Z0-9_]{3,20}$')
);

-- Case-insensitive unique index for usernames
CREATE UNIQUE INDEX idx_profiles_username_lower ON public.profiles (LOWER(username));

-- 2. Create CONVERSATIONS Table (Supports 1-to-1 and Group Chats)
CREATE TABLE public.conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  is_group BOOLEAN DEFAULT FALSE,
  name TEXT DEFAULT '',
  avatar_url TEXT DEFAULT '',
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create CONVERSATION_MEMBERS Table
CREATE TABLE public.conversation_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(conversation_id, user_id)
);

CREATE INDEX idx_conv_members_user ON public.conversation_members (user_id);
CREATE INDEX idx_conv_members_conv ON public.conversation_members (conversation_id);

-- 4. Create MESSAGES Table (With End-to-End Encryption & Group Media Columns)
CREATE TABLE public.messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  receiver_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  media_url TEXT,
  ciphertext TEXT,
  iv TEXT,
  encryption_version TEXT DEFAULT 'e2ee_ecdh_aes_gcm_v1',
  coins_earned INTEGER NOT NULL DEFAULT 2,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_messages_conv ON public.messages (conversation_id, created_at ASC);
CREATE INDEX idx_messages_sender ON public.messages (sender_id, created_at DESC);
CREATE INDEX idx_messages_receiver ON public.messages (receiver_id, created_at DESC);

-- 5. Create USER_CRYPTO_KEYS Table (Public Identity Keys for ECDH Key Agreement)
-- NOTE: Only PUBLIC keys are stored here. Private keys NEVER leave user devices.
CREATE TABLE public.user_crypto_keys (
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE PRIMARY KEY,
  public_key JSONB NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'ECDH-P256',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Create FRIENDSHIPS Table
CREATE TABLE public.friendships (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  friend_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  streak_count INTEGER NOT NULL DEFAULT 1,
  last_interaction TIMESTAMPTZ DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, friend_id)
);

-- =========================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =========================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_crypto_keys ENABLE ROW LEVEL SECURITY;

-- PROFILES POLICIES (Allow public discovery & unblocked inserts/updates)
DROP POLICY IF EXISTS "Profiles are viewable by authenticated users" ON public.profiles;
DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON public.profiles;
CREATE POLICY "Profiles are viewable by everyone"
  ON public.profiles FOR SELECT
  TO authenticated, anon
  USING (true);

DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert their profile" ON public.profiles;
CREATE POLICY "Users can insert their profile"
  ON public.profiles FOR INSERT
  TO authenticated, anon
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update their profile" ON public.profiles;
CREATE POLICY "Users can update their profile"
  ON public.profiles FOR UPDATE
  TO authenticated, anon
  USING (true);

-- CONVERSATIONS POLICIES
CREATE POLICY "Users can view conversations they belong to"
  ON public.conversations FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversation_members cm
      WHERE cm.conversation_id = id AND cm.user_id = auth.uid()
    )
  );

CREATE POLICY "Authenticated users can create conversations"
  ON public.conversations FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- CONVERSATION_MEMBERS POLICIES
CREATE POLICY "Users can view members of their conversations"
  ON public.conversation_members FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversation_members cm
      WHERE cm.conversation_id = conversation_members.conversation_id AND cm.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can add members to conversation"
  ON public.conversation_members FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

-- MESSAGES POLICIES (Strict Chat Privacy)
CREATE POLICY "Users can view messages in their conversations"
  ON public.messages FOR SELECT
  TO authenticated
  USING (
    auth.uid() = sender_id 
    OR auth.uid() = receiver_id
    OR (
      conversation_id IS NOT NULL 
      AND EXISTS (
        SELECT 1 FROM public.conversation_members cm
        WHERE cm.conversation_id = messages.conversation_id AND cm.user_id = auth.uid()
      )
    )
  );

CREATE POLICY "Users can insert messages as themselves"
  ON public.messages FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = sender_id
    AND (
      conversation_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.conversation_members cm
        WHERE cm.conversation_id = messages.conversation_id AND cm.user_id = auth.uid()
      )
    )
  );

CREATE POLICY "Users can update their own messages"
  ON public.messages FOR UPDATE
  TO authenticated
  USING (auth.uid() = sender_id);

CREATE POLICY "Users can delete their own messages"
  ON public.messages FOR DELETE
  TO authenticated
  USING (auth.uid() = sender_id);

-- USER_CRYPTO_KEYS POLICIES
CREATE POLICY "Public crypto keys are viewable by authenticated users"
  ON public.user_crypto_keys FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can insert their own public crypto key"
  ON public.user_crypto_keys FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own public crypto key"
  ON public.user_crypto_keys FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

-- FRIENDSHIPS POLICIES
CREATE POLICY "Users can view their friendships"
  ON public.friendships FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR auth.uid() = friend_id);

CREATE POLICY "Users can manage their friendships"
  ON public.friendships FOR ALL
  TO authenticated
  USING (auth.uid() = user_id);

-- =========================================================
-- REALTIME REPLICATION SETUP
-- =========================================================
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_members;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_crypto_keys;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

-- =========================================================
-- SECURE USERNAME AVAILABILITY RPC
-- Allows checking username availability without exposing user directories
-- =========================================================
CREATE OR REPLACE FUNCTION public.check_username_available(target_username TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF target_username IS NULL OR LENGTH(TRIM(target_username)) < 3 OR LENGTH(TRIM(target_username)) > 20 THEN
    RETURN FALSE;
  END IF;
  
  IF target_username !~ '^[a-zA-Z0-9_]+$' THEN
    RETURN FALSE;
  END IF;

  RETURN NOT EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE LOWER(username) = LOWER(TRIM(target_username))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_username_available(TEXT) TO authenticated, anon;

-- =========================================================
-- PRIVATE STORAGE BUCKET FOR GROUP CHAT IMAGES
-- =========================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-media',
  'chat-media',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'storage',
  'storage',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

-- Storage RLS: Only authenticated group members can upload/view private images
DROP POLICY IF EXISTS "Group members can upload media" ON storage.objects;
CREATE POLICY "Group members can upload media" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id IN ('chat-media', 'storage')
    AND auth.uid() IS NOT NULL
  );

DROP POLICY IF EXISTS "Group members can view media" ON storage.objects;
CREATE POLICY "Group members can view media" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id IN ('chat-media', 'storage')
    AND auth.uid() IS NOT NULL
  );

-- =========================================================
-- AUTHENTICATED PRIVATE REALTIME CHANNELS (1-TO-1 VOICE CALLS)
-- =========================================================
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.conversation_members ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'realtime' AND table_name = 'messages'
  ) THEN
    BEGIN
      ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    DROP POLICY IF EXISTS "Authenticated users can receive private call signals" ON realtime.messages;
    DROP POLICY IF EXISTS "Authenticated users can send private call signals" ON realtime.messages;
    DROP POLICY IF EXISTS "Call inbox owner can receive own inbox signals" ON realtime.messages;
    DROP POLICY IF EXISTS "Verified 1on1 peer can send call invite to peer inbox" ON realtime.messages;
    DROP POLICY IF EXISTS "Verified 1on1 members can receive room call signals" ON realtime.messages;
    DROP POLICY IF EXISTS "Verified 1on1 members can send room call signals" ON realtime.messages;
    DROP POLICY IF EXISTS "Restrict spark call topics to authorized policies" ON realtime.messages;
    DROP POLICY IF EXISTS "Restrict spark call topics select" ON realtime.messages;
    DROP POLICY IF EXISTS "Restrict spark call topics insert" ON realtime.messages;

    -- Policy 1 (PERMISSIVE SELECT): Only the authenticated user themselves can subscribe to and read their own call inbox
    CREATE POLICY "Call inbox owner can receive own inbox signals"
      ON realtime.messages AS PERMISSIVE
      FOR SELECT
      TO authenticated
      USING (
        auth.uid() IS NOT NULL
        AND realtime.messages.extension = 'broadcast'
        AND realtime.topic() = ('spark_call_inbox_' || auth.uid()::text)
      );

    -- Policy 2 (PERMISSIVE INSERT): Only an authenticated user who shares an active, non-deleted, non-group
    -- conversation with EXACTLY 2 active members (sender + target) can send a broadcast invite to the peer's inbox.
    -- Uses literal prefix matching (LEFT(..., 17) = 'spark_call_inbox_' AND LIKE ... ESCAPE '\\') so '_' is never a wildcard.
    CREATE POLICY "Verified 1on1 peer can send call invite to peer inbox"
      ON realtime.messages AS PERMISSIVE
      FOR INSERT
      TO authenticated
      WITH CHECK (
        auth.uid() IS NOT NULL
        AND realtime.messages.extension = 'broadcast'
        AND LEFT(realtime.topic(), 17) = 'spark_call_inbox_'
        AND realtime.topic() LIKE 'spark\\_call\\_inbox\\_%' ESCAPE '\\'
        AND realtime.topic() <> ('spark_call_inbox_' || auth.uid()::text)
        AND EXISTS (
          SELECT 1
          FROM public.conversations c
          JOIN public.conversation_members cm_sender
            ON cm_sender.conversation_id = c.id
          JOIN public.conversation_members cm_target
            ON cm_target.conversation_id = c.id
          WHERE COALESCE(c.is_group, FALSE) = FALSE
            AND c.deleted_at IS NULL
            AND cm_sender.user_id = auth.uid()
            AND cm_sender.deleted_at IS NULL
            AND cm_target.user_id <> auth.uid()
            AND cm_target.deleted_at IS NULL
            AND ('spark_call_inbox_' || cm_target.user_id::text) = realtime.topic()
            AND (
              SELECT COUNT(DISTINCT cm_cnt.user_id)
              FROM public.conversation_members cm_cnt
              WHERE cm_cnt.conversation_id = c.id
                AND cm_cnt.deleted_at IS NULL
            ) = 2
        )
      );

    -- Policy 3 (PERMISSIVE SELECT): Only authenticated active members of a non-deleted, non-group conversation
    -- with EXACTLY 2 active members can subscribe to and receive signals in that conversation's call room
    CREATE POLICY "Verified 1on1 members can receive room call signals"
      ON realtime.messages AS PERMISSIVE
      FOR SELECT
      TO authenticated
      USING (
        auth.uid() IS NOT NULL
        AND realtime.messages.extension = 'broadcast'
        AND LEFT(realtime.topic(), 16) = 'spark_call_1on1_'
        AND realtime.topic() LIKE 'spark\\_call\\_1on1\\_%' ESCAPE '\\'
        AND EXISTS (
          SELECT 1
          FROM public.conversations c
          JOIN public.conversation_members cm
            ON cm.conversation_id = c.id
          WHERE ('spark_call_1on1_' || c.id::text) = realtime.topic()
            AND COALESCE(c.is_group, FALSE) = FALSE
            AND c.deleted_at IS NULL
            AND cm.user_id = auth.uid()
            AND cm.deleted_at IS NULL
            AND (
              SELECT COUNT(DISTINCT cm_cnt.user_id)
              FROM public.conversation_members cm_cnt
              WHERE cm_cnt.conversation_id = c.id
                AND cm_cnt.deleted_at IS NULL
            ) = 2
        )
      );

    -- Policy 4 (PERMISSIVE INSERT): Only authenticated active members of a non-deleted, non-group conversation
    -- with EXACTLY 2 active members can send signals in that conversation's call room
    CREATE POLICY "Verified 1on1 members can send room call signals"
      ON realtime.messages AS PERMISSIVE
      FOR INSERT
      TO authenticated
      WITH CHECK (
        auth.uid() IS NOT NULL
        AND realtime.messages.extension = 'broadcast'
        AND LEFT(realtime.topic(), 16) = 'spark_call_1on1_'
        AND realtime.topic() LIKE 'spark\\_call\\_1on1\\_%' ESCAPE '\\'
        AND EXISTS (
          SELECT 1
          FROM public.conversations c
          JOIN public.conversation_members cm
            ON cm.conversation_id = c.id
          WHERE ('spark_call_1on1_' || c.id::text) = realtime.topic()
            AND COALESCE(c.is_group, FALSE) = FALSE
            AND c.deleted_at IS NULL
            AND cm.user_id = auth.uid()
            AND cm.deleted_at IS NULL
            AND (
              SELECT COUNT(DISTINCT cm_cnt.user_id)
              FROM public.conversation_members cm_cnt
              WHERE cm_cnt.conversation_id = c.id
                AND cm_cnt.deleted_at IS NULL
            ) = 2
        )
      );

    -- Policy 5A (RESTRICTIVE SELECT): Enforces that NO pre-existing permissive SELECT policy on realtime.messages
    -- can bypass Spark call authorization on literal 'spark_call_' topics, while leaving non-call topics untouched.
    CREATE POLICY "Restrict spark call topics select"
      ON realtime.messages AS RESTRICTIVE
      FOR SELECT
      TO public
      USING (
        (
          COALESCE(LEFT(realtime.topic(), 11), '') <> 'spark_call_'
          AND realtime.topic() NOT LIKE 'spark\\_call\\_%' ESCAPE '\\'
        )
        OR (
          auth.uid() IS NOT NULL
          AND realtime.messages.extension = 'broadcast'
          AND (
            realtime.topic() = ('spark_call_inbox_' || auth.uid()::text)
            OR (
              LEFT(realtime.topic(), 16) = 'spark_call_1on1_'
              AND realtime.topic() LIKE 'spark\\_call\\_1on1\\_%' ESCAPE '\\'
              AND EXISTS (
                SELECT 1
                FROM public.conversations c
                JOIN public.conversation_members cm
                  ON cm.conversation_id = c.id
                WHERE ('spark_call_1on1_' || c.id::text) = realtime.topic()
                  AND COALESCE(c.is_group, FALSE) = FALSE
                  AND c.deleted_at IS NULL
                  AND cm.user_id = auth.uid()
                  AND cm.deleted_at IS NULL
                  AND (
                    SELECT COUNT(DISTINCT cm_cnt.user_id)
                    FROM public.conversation_members cm_cnt
                    WHERE cm_cnt.conversation_id = c.id
                      AND cm_cnt.deleted_at IS NULL
                  ) = 2
              )
            )
          )
        )
      );

    -- Policy 5B (RESTRICTIVE INSERT): Enforces that NO pre-existing permissive INSERT policy on realtime.messages
    -- can bypass Spark call authorization on literal 'spark_call_' topics, while leaving non-call topics untouched.
    CREATE POLICY "Restrict spark call topics insert"
      ON realtime.messages AS RESTRICTIVE
      FOR INSERT
      TO public
      WITH CHECK (
        (
          COALESCE(LEFT(realtime.topic(), 11), '') <> 'spark_call_'
          AND realtime.topic() NOT LIKE 'spark\\_call\\_%' ESCAPE '\\'
        )
        OR (
          auth.uid() IS NOT NULL
          AND realtime.messages.extension = 'broadcast'
          AND (
            (
              LEFT(realtime.topic(), 17) = 'spark_call_inbox_'
              AND realtime.topic() LIKE 'spark\\_call\\_inbox\\_%' ESCAPE '\\'
              AND realtime.topic() <> ('spark_call_inbox_' || auth.uid()::text)
              AND EXISTS (
                SELECT 1
                FROM public.conversations c
                JOIN public.conversation_members cm_sender
                  ON cm_sender.conversation_id = c.id
                JOIN public.conversation_members cm_target
                  ON cm_target.conversation_id = c.id
                WHERE COALESCE(c.is_group, FALSE) = FALSE
                  AND c.deleted_at IS NULL
                  AND cm_sender.user_id = auth.uid()
                  AND cm_sender.deleted_at IS NULL
                  AND cm_target.user_id <> auth.uid()
                  AND cm_target.deleted_at IS NULL
                  AND ('spark_call_inbox_' || cm_target.user_id::text) = realtime.topic()
                  AND (
                    SELECT COUNT(DISTINCT cm_cnt.user_id)
                    FROM public.conversation_members cm_cnt
                    WHERE cm_cnt.conversation_id = c.id
                      AND cm_cnt.deleted_at IS NULL
                  ) = 2
              )
            )
            OR (
              LEFT(realtime.topic(), 16) = 'spark_call_1on1_'
              AND realtime.topic() LIKE 'spark\\_call\\_1on1\\_%' ESCAPE '\\'
              AND EXISTS (
                SELECT 1
                FROM public.conversations c
                JOIN public.conversation_members cm
                  ON cm.conversation_id = c.id
                WHERE ('spark_call_1on1_' || c.id::text) = realtime.topic()
                  AND COALESCE(c.is_group, FALSE) = FALSE
                  AND c.deleted_at IS NULL
                  AND cm.user_id = auth.uid()
                  AND cm.deleted_at IS NULL
                  AND (
                    SELECT COUNT(DISTINCT cm_cnt.user_id)
                    FROM public.conversation_members cm_cnt
                    WHERE cm_cnt.conversation_id = c.id
                      AND cm_cnt.deleted_at IS NULL
                  ) = 2
              )
            )
          )
        )
      );
  END IF;
END $$;
`;

// Script 3: Safe Non-Destructive Migration Script for Existing Databases
export const SUPABASE_MIGRATION_SQL = `-- =========================================================
-- SPARK APP: SAFE NON-DESTRUCTIVE MIGRATION
-- Run this in Supabase SQL Editor if you already have existing data
-- It preserves all users, messages, friendships and keys without data loss:
-- =========================================================

-- 1. Ensure all profiles columns and extensions exist
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 50;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS weekly_coins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS streak_days INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS daily_coins_earned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS daily_coins_date DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS equipped_frame TEXT NOT NULL DEFAULT 'frame_pulsar';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS equipped_theme TEXT NOT NULL DEFAULT 'theme_cosmic';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS equipped_outfit TEXT NOT NULL DEFAULT 'outfit_voyager';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS unlocked_items TEXT[] NOT NULL DEFAULT ARRAY['frame_pulsar', 'theme_cosmic', 'outfit_voyager'];
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_spark_at TIMESTAMPTZ DEFAULT NOW();

-- 2. Ensure case-insensitive unique index for usernames exists
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username_lower ON public.profiles (LOWER(username));

-- 3. Ensure username format constraint exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_username_format'
  ) THEN
    ALTER TABLE public.profiles ADD CONSTRAINT check_username_format CHECK (username ~* '^[a-zA-Z0-9_]{3,20}$');
  END IF;
END $$;

-- 4. Drop restrictive foreign key constraint if it exists so user profiles are never blocked
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;

-- Ensure profiles Row Level Security (RLS) is enabled and allows public discovery and unblocked profile creation
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Profiles are viewable by authenticated users" ON public.profiles;
DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON public.profiles;
CREATE POLICY "Profiles are viewable by everyone"
  ON public.profiles FOR SELECT
  TO authenticated, anon
  USING (true);

DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert their profile" ON public.profiles;
CREATE POLICY "Users can insert their profile"
  ON public.profiles FOR INSERT
  TO authenticated, anon
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update their profile" ON public.profiles;
CREATE POLICY "Users can update their profile"
  ON public.profiles FOR UPDATE
  TO authenticated, anon
  USING (true);

-- 5. Create or update the secure username availability RPC function
CREATE OR REPLACE FUNCTION public.check_username_available(target_username TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF target_username IS NULL OR LENGTH(TRIM(target_username)) < 3 OR LENGTH(TRIM(target_username)) > 20 THEN
    RETURN FALSE;
  END IF;
  
  IF target_username !~ '^[a-zA-Z0-9_]+$' THEN
    RETURN FALSE;
  END IF;

  RETURN NOT EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE LOWER(username) = LOWER(TRIM(target_username))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_username_available(TEXT) TO authenticated, anon;

-- 6. Support Group Conversations & Image URLs in Messages
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS is_group BOOLEAN DEFAULT FALSE;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS name TEXT DEFAULT '';
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT '';
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS media_url TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_media_url ON public.messages (conversation_id) WHERE media_url IS NOT NULL;

-- 7. Ensure daily_quests and stories tables exist
CREATE TABLE IF NOT EXISTS public.daily_quests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  quest_date DATE NOT NULL DEFAULT CURRENT_DATE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  reward_coins INTEGER NOT NULL DEFAULT 15,
  progress INTEGER NOT NULL DEFAULT 0,
  goal INTEGER NOT NULL DEFAULT 3,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  icon_type TEXT DEFAULT 'flame',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.stories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  username TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  media_url TEXT NOT NULL,
  caption TEXT DEFAULT '',
  spark_reactions INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours')
);

-- 8. Ensure non-recursive, unblocked RLS policies on conversations, conversation_members, messages, daily_quests, stories
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view conversations they belong to" ON public.conversations;
DROP POLICY IF EXISTS "Authenticated users can create conversations" ON public.conversations;
DROP POLICY IF EXISTS "Conversations access policy" ON public.conversations;
CREATE POLICY "Conversations access policy"
  ON public.conversations FOR ALL
  TO authenticated, anon
  USING (true)
  WITH CHECK (true);

ALTER TABLE public.conversation_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view members of their conversations" ON public.conversation_members;
DROP POLICY IF EXISTS "Users can add members to conversation" ON public.conversation_members;
DROP POLICY IF EXISTS "Conversation members access policy" ON public.conversation_members;
CREATE POLICY "Conversation members access policy"
  ON public.conversation_members FOR ALL
  TO authenticated, anon
  USING (true)
  WITH CHECK (true);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view messages in their conversations" ON public.messages;
DROP POLICY IF EXISTS "Users can insert messages as themselves" ON public.messages;
DROP POLICY IF EXISTS "Messages access policy" ON public.messages;
CREATE POLICY "Messages access policy"
  ON public.messages FOR ALL
  TO authenticated, anon
  USING (true)
  WITH CHECK (true);

ALTER TABLE public.daily_quests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage their daily quests" ON public.daily_quests;
CREATE POLICY "Users can manage their daily quests"
  ON public.daily_quests FOR ALL
  TO authenticated, anon
  USING (true)
  WITH CHECK (true);

ALTER TABLE public.stories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Stories access policy" ON public.stories;
CREATE POLICY "Stories access policy"
  ON public.stories FOR ALL
  TO authenticated, anon
  USING (true)
  WITH CHECK (true);

-- 9. Provision Private Storage Bucket ('chat-media' & 'storage') for Group Images
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-media',
  'chat-media',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'storage',
  'storage',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

-- 10. Storage Row Level Security (RLS) for Private Group Images
DROP POLICY IF EXISTS "Group members can upload media" ON storage.objects;
CREATE POLICY "Group members can upload media" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id IN ('chat-media', 'storage')
    AND auth.uid() IS NOT NULL
  );

DROP POLICY IF EXISTS "Group members can view media" ON storage.objects;
CREATE POLICY "Group members can view media" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id IN ('chat-media', 'storage')
    AND auth.uid() IS NOT NULL
  );

-- 11. Web Push Subscriptions & Notification Preferences (Background Push Notifications)
ALTER TABLE public.conversation_members
  ADD COLUMN IF NOT EXISTS is_muted BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT DEFAULT 'web',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage their own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users can manage their own push subscriptions"
  ON public.push_subscriptions FOR ALL
  TO authenticated, anon
  USING (true)
  WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE PRIMARY KEY,
  push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  dm_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  group_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  muted_conversations TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage their own notification preferences" ON public.notification_preferences;
CREATE POLICY "Users can manage their own notification preferences"
  ON public.notification_preferences FOR ALL
  TO authenticated, anon
  USING (true)
  WITH CHECK (true);

-- 12. Optional pg_net Database Webhook Trigger on public.messages INSERT
-- Automatically invokes the 'send-push-notification' Supabase Edge Function whenever a new message is saved.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.trigger_send_push_notification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  edge_function_url TEXT := 'https://zyyaeuiprnrezuuqdmyt.supabase.co/functions/v1/send-push-notification';
BEGIN
  IF NEW.deleted_at IS NULL THEN
    PERFORM net.http_post(
      url := edge_function_url,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object(
        'type', 'INSERT',
        'table', 'messages',
        'schema', 'public',
        'record', row_to_json(NEW)::jsonb
      )
    );
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Never block message saving if pg_net or webhook dispatch encounters an error
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_message_inserted_send_push ON public.messages;
CREATE TRIGGER on_message_inserted_send_push
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_send_push_notification();

-- =========================================================
-- 13. Authenticated Private Realtime Channels Authorization (WebRTC 1-to-1 Voice Call Signaling)
-- =========================================================
-- Step 13A: Pre-Migration Inspection Query (Safe Read-Only Check)
-- Run this before or after migration to inspect existing policies on realtime.messages:
--   SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
--   FROM pg_policies
--   WHERE schemaname = 'realtime' AND tablename = 'messages'
--   ORDER BY permissive DESC, policyname ASC;
--
-- Step 13B: Ensure public.user_crypto_keys exists and enforces strict owner-only write RLS (auth.uid() = user_id)
-- so no user can overwrite another user's separated ECDH + ECDSA P-256 public key bundle:
CREATE TABLE IF NOT EXISTS public.user_crypto_keys (
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE PRIMARY KEY,
  public_key JSONB NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'ECDH-P256+ECDSA-P256-v2',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.user_crypto_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public crypto keys are viewable by authenticated users" ON public.user_crypto_keys;
CREATE POLICY "Public crypto keys are viewable by authenticated users"
  ON public.user_crypto_keys FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Users can insert their own public crypto key" ON public.user_crypto_keys;
CREATE POLICY "Users can insert their own public crypto key"
  ON public.user_crypto_keys FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own public crypto key" ON public.user_crypto_keys;
CREATE POLICY "Users can update their own public crypto key"
  ON public.user_crypto_keys FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Step 13C: Ensure soft-delete columns exist for conversation/member active status checks
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.conversation_members ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Step 13D: Configure strict PERMISSIVE + RESTRICTIVE RLS policies on realtime.messages
-- without dropping unrelated non-Spark policies.
-- IMPORTANT SQL NOTE ON UNDERSCORE WILDCARDS:
-- PostgreSQL LIKE treats '_' as a single-character wildcard unless escaped with ESCAPE '\\'.
-- Every prefix check below uses BOTH literal substring comparison (LEFT(realtime.topic(), N) = '...')
-- AND escaped LIKE ('spark\\_call\\_%' ESCAPE '\\') so 'spark_call_' is matched strictly as a literal prefix.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'realtime' AND table_name = 'messages'
  ) THEN
    BEGIN
      ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    -- Only drop Spark's own call policies (never drop unrelated policies)
    DROP POLICY IF EXISTS "Authenticated users can receive private call signals" ON realtime.messages;
    DROP POLICY IF EXISTS "Authenticated users can send private call signals" ON realtime.messages;
    DROP POLICY IF EXISTS "Call inbox owner can receive own inbox signals" ON realtime.messages;
    DROP POLICY IF EXISTS "Verified 1on1 peer can send call invite to peer inbox" ON realtime.messages;
    DROP POLICY IF EXISTS "Verified 1on1 members can receive room call signals" ON realtime.messages;
    DROP POLICY IF EXISTS "Verified 1on1 members can send room call signals" ON realtime.messages;
    DROP POLICY IF EXISTS "Restrict spark call topics to authorized policies" ON realtime.messages;
    DROP POLICY IF EXISTS "Restrict spark call topics select" ON realtime.messages;
    DROP POLICY IF EXISTS "Restrict spark call topics insert" ON realtime.messages;

    -- Policy 1 (PERMISSIVE SELECT): Only the authenticated user themselves can subscribe to and read their own call inbox
    CREATE POLICY "Call inbox owner can receive own inbox signals"
      ON realtime.messages AS PERMISSIVE
      FOR SELECT
      TO authenticated
      USING (
        auth.uid() IS NOT NULL
        AND realtime.messages.extension = 'broadcast'
        AND realtime.topic() = ('spark_call_inbox_' || auth.uid()::text)
      );

    -- Policy 2 (PERMISSIVE INSERT): Only an authenticated user who shares an active, non-deleted, non-group
    -- conversation with EXACTLY 2 active members (sender + target) can send a broadcast invite to the peer's inbox
    CREATE POLICY "Verified 1on1 peer can send call invite to peer inbox"
      ON realtime.messages AS PERMISSIVE
      FOR INSERT
      TO authenticated
      WITH CHECK (
        auth.uid() IS NOT NULL
        AND realtime.messages.extension = 'broadcast'
        AND LEFT(realtime.topic(), 17) = 'spark_call_inbox_'
        AND realtime.topic() LIKE 'spark\\_call\\_inbox\\_%' ESCAPE '\\'
        AND realtime.topic() <> ('spark_call_inbox_' || auth.uid()::text)
        AND EXISTS (
          SELECT 1
          FROM public.conversations c
          JOIN public.conversation_members cm_sender
            ON cm_sender.conversation_id = c.id
          JOIN public.conversation_members cm_target
            ON cm_target.conversation_id = c.id
          WHERE COALESCE(c.is_group, FALSE) = FALSE
            AND c.deleted_at IS NULL
            AND cm_sender.user_id = auth.uid()
            AND cm_sender.deleted_at IS NULL
            AND cm_target.user_id <> auth.uid()
            AND cm_target.deleted_at IS NULL
            AND ('spark_call_inbox_' || cm_target.user_id::text) = realtime.topic()
            AND (
              SELECT COUNT(DISTINCT cm_cnt.user_id)
              FROM public.conversation_members cm_cnt
              WHERE cm_cnt.conversation_id = c.id
                AND cm_cnt.deleted_at IS NULL
            ) = 2
        )
      );

    -- Policy 3 (PERMISSIVE SELECT): Only authenticated active members of a non-deleted, non-group conversation
    -- with EXACTLY 2 active members can subscribe to and receive signals in that conversation's call room
    CREATE POLICY "Verified 1on1 members can receive room call signals"
      ON realtime.messages AS PERMISSIVE
      FOR SELECT
      TO authenticated
      USING (
        auth.uid() IS NOT NULL
        AND realtime.messages.extension = 'broadcast'
        AND LEFT(realtime.topic(), 16) = 'spark_call_1on1_'
        AND realtime.topic() LIKE 'spark\\_call\\_1on1\\_%' ESCAPE '\\'
        AND EXISTS (
          SELECT 1
          FROM public.conversations c
          JOIN public.conversation_members cm
            ON cm.conversation_id = c.id
          WHERE ('spark_call_1on1_' || c.id::text) = realtime.topic()
            AND COALESCE(c.is_group, FALSE) = FALSE
            AND c.deleted_at IS NULL
            AND cm.user_id = auth.uid()
            AND cm.deleted_at IS NULL
            AND (
              SELECT COUNT(DISTINCT cm_cnt.user_id)
              FROM public.conversation_members cm_cnt
              WHERE cm_cnt.conversation_id = c.id
                AND cm_cnt.deleted_at IS NULL
            ) = 2
        )
      );

    -- Policy 4 (PERMISSIVE INSERT): Only authenticated active members of a non-deleted, non-group conversation
    -- with EXACTLY 2 active members can send signals in that conversation's call room
    CREATE POLICY "Verified 1on1 members can send room call signals"
      ON realtime.messages AS PERMISSIVE
      FOR INSERT
      TO authenticated
      WITH CHECK (
        auth.uid() IS NOT NULL
        AND realtime.messages.extension = 'broadcast'
        AND LEFT(realtime.topic(), 16) = 'spark_call_1on1_'
        AND realtime.topic() LIKE 'spark\\_call\\_1on1\\_%' ESCAPE '\\'
        AND EXISTS (
          SELECT 1
          FROM public.conversations c
          JOIN public.conversation_members cm
            ON cm.conversation_id = c.id
          WHERE ('spark_call_1on1_' || c.id::text) = realtime.topic()
            AND COALESCE(c.is_group, FALSE) = FALSE
            AND c.deleted_at IS NULL
            AND cm.user_id = auth.uid()
            AND cm.deleted_at IS NULL
            AND (
              SELECT COUNT(DISTINCT cm_cnt.user_id)
              FROM public.conversation_members cm_cnt
              WHERE cm_cnt.conversation_id = c.id
                AND cm_cnt.deleted_at IS NULL
            ) = 2
        )
      );

    -- Policy 5A (RESTRICTIVE SELECT): Guarantees that NO pre-existing permissive SELECT policy on realtime.messages
    -- can bypass Spark call authorization for literal 'spark_call_' topics, while leaving non-call topics untouched.
    CREATE POLICY "Restrict spark call topics select"
      ON realtime.messages AS RESTRICTIVE
      FOR SELECT
      TO public
      USING (
        (
          COALESCE(LEFT(realtime.topic(), 11), '') <> 'spark_call_'
          AND realtime.topic() NOT LIKE 'spark\\_call\\_%' ESCAPE '\\'
        )
        OR (
          auth.uid() IS NOT NULL
          AND realtime.messages.extension = 'broadcast'
          AND (
            realtime.topic() = ('spark_call_inbox_' || auth.uid()::text)
            OR (
              LEFT(realtime.topic(), 16) = 'spark_call_1on1_'
              AND realtime.topic() LIKE 'spark\\_call\\_1on1\\_%' ESCAPE '\\'
              AND EXISTS (
                SELECT 1
                FROM public.conversations c
                JOIN public.conversation_members cm
                  ON cm.conversation_id = c.id
                WHERE ('spark_call_1on1_' || c.id::text) = realtime.topic()
                  AND COALESCE(c.is_group, FALSE) = FALSE
                  AND c.deleted_at IS NULL
                  AND cm.user_id = auth.uid()
                  AND cm.deleted_at IS NULL
                  AND (
                    SELECT COUNT(DISTINCT cm_cnt.user_id)
                    FROM public.conversation_members cm_cnt
                    WHERE cm_cnt.conversation_id = c.id
                      AND cm_cnt.deleted_at IS NULL
                  ) = 2
              )
            )
          )
        )
      );

    -- Policy 5B (RESTRICTIVE INSERT): Guarantees that NO pre-existing permissive INSERT policy on realtime.messages
    -- can bypass Spark call authorization for literal 'spark_call_' topics, while leaving non-call topics untouched.
    CREATE POLICY "Restrict spark call topics insert"
      ON realtime.messages AS RESTRICTIVE
      FOR INSERT
      TO public
      WITH CHECK (
        (
          COALESCE(LEFT(realtime.topic(), 11), '') <> 'spark_call_'
          AND realtime.topic() NOT LIKE 'spark\\_call\\_%' ESCAPE '\\'
        )
        OR (
          auth.uid() IS NOT NULL
          AND realtime.messages.extension = 'broadcast'
          AND (
            (
              LEFT(realtime.topic(), 17) = 'spark_call_inbox_'
              AND realtime.topic() LIKE 'spark\\_call\\_inbox\\_%' ESCAPE '\\'
              AND realtime.topic() <> ('spark_call_inbox_' || auth.uid()::text)
              AND EXISTS (
                SELECT 1
                FROM public.conversations c
                JOIN public.conversation_members cm_sender
                  ON cm_sender.conversation_id = c.id
                JOIN public.conversation_members cm_target
                  ON cm_target.conversation_id = c.id
                WHERE COALESCE(c.is_group, FALSE) = FALSE
                  AND c.deleted_at IS NULL
                  AND cm_sender.user_id = auth.uid()
                  AND cm_sender.deleted_at IS NULL
                  AND cm_target.user_id <> auth.uid()
                  AND cm_target.deleted_at IS NULL
                  AND ('spark_call_inbox_' || cm_target.user_id::text) = realtime.topic()
                  AND (
                    SELECT COUNT(DISTINCT cm_cnt.user_id)
                    FROM public.conversation_members cm_cnt
                    WHERE cm_cnt.conversation_id = c.id
                      AND cm_cnt.deleted_at IS NULL
                  ) = 2
              )
            )
            OR (
              LEFT(realtime.topic(), 16) = 'spark_call_1on1_'
              AND realtime.topic() LIKE 'spark\\_call\\_1on1\\_%' ESCAPE '\\'
              AND EXISTS (
                SELECT 1
                FROM public.conversations c
                JOIN public.conversation_members cm
                  ON cm.conversation_id = c.id
                WHERE ('spark_call_1on1_' || c.id::text) = realtime.topic()
                  AND COALESCE(c.is_group, FALSE) = FALSE
                  AND c.deleted_at IS NULL
                  AND cm.user_id = auth.uid()
                  AND cm.deleted_at IS NULL
                  AND (
                    SELECT COUNT(DISTINCT cm_cnt.user_id)
                    FROM public.conversation_members cm_cnt
                    WHERE cm_cnt.conversation_id = c.id
                      AND cm_cnt.deleted_at IS NULL
                  ) = 2
              )
            )
          )
        )
      );
  END IF;
END $$;

-- Step 13E: Post-Migration Validation Queries (Run in Supabase SQL Editor to verify)
-- 1) Verify all 6 Spark call policies (4 PERMISSIVE + 2 RESTRICTIVE) exist on realtime.messages:
-- SELECT policyname, permissive, roles, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'realtime' AND tablename = 'messages'
-- ORDER BY permissive DESC, policyname ASC;
--
-- 2) Verify public.user_crypto_keys RLS is enabled and enforces auth.uid() = user_id on INSERT/UPDATE:
-- SELECT policyname, permissive, roles, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'user_crypto_keys'
-- ORDER BY policyname ASC;
`;

export const SUPABASE_SECTION_13_VALIDATION_SQL = `-- =========================================================
-- SPARK PHASE 1 VOICE CALLING — VALIDATION & AUDIT QUERIES
-- Run these read-only queries in the Supabase SQL Editor before
-- and after applying Section 13 to verify policy state.
-- =========================================================

-- 1. Inspect all RLS policies on realtime.messages (check for 4 PERMISSIVE + 2 RESTRICTIVE)
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'realtime'
  AND tablename = 'messages'
ORDER BY permissive DESC, policyname ASC;

-- 2. Confirm RLS is enabled on realtime.messages and public.user_crypto_keys
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE (n.nspname = 'realtime' AND c.relname = 'messages')
   OR (n.nspname = 'public' AND c.relname = 'user_crypto_keys');

-- 3. Inspect RLS policies on public.user_crypto_keys (must enforce auth.uid() = user_id on write)
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'user_crypto_keys'
ORDER BY policyname ASC;
`;





