import { getSupabase, isSupabaseConfigured } from './supabase';
import { PublicUserProfile } from '../types';

export interface TodoTaskItem {
  id: string;
  text: string;
  completed: boolean;
  completed_at?: string;
}

export interface MemberDailyTodoList {
  id: string;
  conversation_id: string;
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  date_key: string; // YYYY-MM-DD
  tasks: TodoTaskItem[];
  status: 'in_progress' | 'submitted' | 'auto_submitted';
  submitted_at?: string;
  updated_at: string;
}

const GROUP_TODO_STORAGE_PREFIX = 'spark_group_todos_v1_';

export function getTodayDateKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getTimeUntilDeadline(): {
  hours: number;
  minutes: number;
  seconds: number;
  label: string;
  isCheckInWindow: boolean;
} {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);

  const diffMs = Math.max(0, midnight.getTime() - now.getTime());
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

  // Prompt user to check & submit when approaching deadline (last 2 hours before midnight, or around 12pm/12am check-in)
  const isCheckInWindow = hours < 2 || now.getHours() === 12 || now.getHours() === 23;

  return {
    hours,
    minutes,
    seconds,
    label: `${hours}h ${minutes}m`,
    isCheckInWindow,
  };
}

function getStorageKey(conversationId: string, dateKey: string): string {
  return `${GROUP_TODO_STORAGE_PREFIX}${conversationId}_${dateKey}`;
}

export const DUMMY_TODO_TASK_TEXTS = new Set([
  'Morning 5km run & hydration',
  'Finish UI sprint review deck',
  'Push API integration PR',
  'Read 20 pages before bed',
  'Finalize brand illustrations',
  'Client feedback call at 2 PM',
  'Organize design system tokens',
  'Fix database migration script',
  'Gym session (Upper body)',
  'Review group pull requests',
  'Complete priority work tasks',
  '30 mins workout / walk',
]);

const DUMMY_TODO_TASK_TEXTS_LOWER = new Set(
  Array.from(DUMMY_TODO_TASK_TEXTS).map((t) => t.toLowerCase())
);

export function isDummyTodoList(list: MemberDailyTodoList): boolean {
  if (!list || !list.user_id) return true;
  const uid = list.user_id.toLowerCase();
  if (
    uid.startsWith('test_user_') ||
    uid.startsWith('testuser_') ||
    uid === 'test_user_arjun' ||
    uid === 'test_user_neha' ||
    uid === 'test_user_rohan'
  ) {
    return true;
  }
  // If list has no tasks, it's not a valid to-do list
  if (!list.tasks || list.tasks.length === 0) {
    return true;
  }
  // Any list where all tasks are trial/sample tasks (e.g. seeded trial tasks)
  const isAllTrialTasks = list.tasks.every(
    (t) => !t.text || DUMMY_TODO_TASK_TEXTS_LOWER.has(t.text.trim().toLowerCase())
  );
  if (isAllTrialTasks) {
    return true;
  }
  // Also check if tasks have trial generator IDs and trial task text
  const hasTrialTaskIds = list.tasks.some(
    (t) =>
      t.id.startsWith(`task_${list.user_id}_`) &&
      DUMMY_TODO_TASK_TEXTS_LOWER.has((t.text || '').trim().toLowerCase())
  );
  if (hasTrialTaskIds) {
    return true;
  }
  return false;
}

/**
 * Scans localStorage and purges any trial/sample to-do lists that were saved previously.
 */
function purgeStoredTrialTodos(): void {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (
        storageKey &&
        storageKey.startsWith(GROUP_TODO_STORAGE_PREFIX) &&
        !storageKey.includes('draft_')
      ) {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              const cleaned = parsed.filter((l) => !isDummyTodoList(l));
              if (cleaned.length !== parsed.length) {
                localStorage.setItem(storageKey, JSON.stringify(cleaned));
              }
            }
          } catch {}
        }
      }
    }
  } catch {}
}

/**
 * Loads all members' daily to-do lists for a group conversation on a given date.
 * Preserves all real user-created tasks and history, returning an empty list if no user has shared one yet.
 */
export function getGroupDailyTodos(
  conversationId: string,
  _members?: PublicUserProfile[],
  dateKey: string = getTodayDateKey()
): MemberDailyTodoList[] {
  purgeStoredTrialTodos();

  const safeConvId = conversationId || 'default_group';
  const key = getStorageKey(safeConvId, dateKey);
  const latestKey = `${GROUP_TODO_STORAGE_PREFIX}${safeConvId}_latest`;
  try {
    const raw = localStorage.getItem(key) || localStorage.getItem(latestKey);
    if (raw) {
      const parsed: MemberDailyTodoList[] = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Filter out dummy/sample entries only, preserving real user tasks
        const realLists = parsed.filter((list) => !isDummyTodoList(list));
        if (realLists.length !== parsed.length) {
          saveGroupDailyTodos(safeConvId, realLists, dateKey);
        }
        return realLists;
      }
    }
  } catch {}

  return [];
}

export function saveGroupDailyTodos(
  conversationId: string,
  lists: MemberDailyTodoList[],
  dateKey: string = getTodayDateKey()
): void {
  const safeConvId = conversationId || 'default_group';
  const key = getStorageKey(safeConvId, dateKey);
  const latestKey = `${GROUP_TODO_STORAGE_PREFIX}${safeConvId}_latest`;
  try {
    const serialized = JSON.stringify(lists);
    localStorage.setItem(key, serialized);
    localStorage.setItem(latestKey, serialized);
  } catch (e) {
    console.warn('Failed to save group daily todos:', e);
  }
}

export function getDraftTodoTasks(conversationId: string, userId: string): TodoTaskItem[] | null {
  const safeConvId = conversationId || 'default_group';
  try {
    const raw = localStorage.getItem(`${GROUP_TODO_STORAGE_PREFIX}draft_${safeConvId}_${userId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return null;
}

export function saveDraftTodoTasks(
  conversationId: string,
  userId: string,
  tasks: TodoTaskItem[]
): void {
  const safeConvId = conversationId || 'default_group';
  try {
    localStorage.setItem(
      `${GROUP_TODO_STORAGE_PREFIX}draft_${safeConvId}_${userId}`,
      JSON.stringify(tasks)
    );
  } catch {}
}

function notifyLocalGroupTodoListeners(
  conversationId: string,
  lists: MemberDailyTodoList[]
): void {
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(
        new CustomEvent('spark_group_todos_updated', {
          detail: { conversationId, lists },
        })
      );
    } catch {}
  }
}

function broadcastGroupTodoEntry(
  conversationId: string,
  entry: MemberDailyTodoList
): void {
  if (!isSupabaseConfigured()) return;
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const channel = supabase.channel(`group_todos_${conversationId}`);
    const state = (channel as any).state;
    if (state === 'joined') {
      void channel.send({
        type: 'broadcast',
        event: 'todo_updated',
        payload: entry,
      });
    } else {
      channel.subscribe((subStatus) => {
        if (subStatus === 'SUBSCRIBED') {
          void channel.send({
            type: 'broadcast',
            event: 'todo_updated',
            payload: entry,
          });
        }
      });
    }
  } catch {}
}

/**
 * Creates or updates a user's daily to-do list for a group and broadcasts to Supabase.
 */
export async function upsertMemberDailyTodoList(
  conversationId: string,
  user: { id: string; username: string; display_name?: string; avatar_url: string },
  tasks: TodoTaskItem[],
  status: 'in_progress' | 'submitted' | 'auto_submitted' = 'in_progress',
  members?: PublicUserProfile[]
): Promise<MemberDailyTodoList[]> {
  const dateKey = getTodayDateKey();
  const existingLists = getGroupDailyTodos(conversationId, members, dateKey);
  const nowIso = new Date().toISOString();

  const updatedEntry: MemberDailyTodoList = {
    id: `todo_${conversationId}_${user.id}_${dateKey}`,
    conversation_id: conversationId,
    user_id: user.id,
    username: user.username,
    display_name: user.display_name || user.username,
    avatar_url: user.avatar_url,
    date_key: dateKey,
    tasks,
    status,
    submitted_at:
      status === 'submitted' || status === 'auto_submitted' ? nowIso : undefined,
    updated_at: nowIso,
  };

  const idx = existingLists.findIndex((item) => item.user_id === user.id);
  let nextLists: MemberDailyTodoList[];
  if (idx >= 0) {
    nextLists = [...existingLists];
    nextLists[idx] = updatedEntry;
  } else {
    nextLists = [updatedEntry, ...existingLists];
  }

  saveGroupDailyTodos(conversationId, nextLists, dateKey);
  notifyLocalGroupTodoListeners(conversationId, nextLists);
  broadcastGroupTodoEntry(conversationId, updatedEntry);

  return nextLists;
}

/**
 * Toggles a specific task's completion state within a group's daily to-do lists
 * for authorized group members and synchronizes across local and Supabase Realtime channels.
 */
export async function toggleGroupTodoTask(
  conversationId: string,
  targetUserId: string,
  taskId: string,
  members?: PublicUserProfile[]
): Promise<MemberDailyTodoList[]> {
  const dateKey = getTodayDateKey();
  const existingLists = getGroupDailyTodos(conversationId, members, dateKey);
  const idx = existingLists.findIndex((item) => item.user_id === targetUserId);
  if (idx < 0) return existingLists;

  const targetList = existingLists[idx];
  const nowIso = new Date().toISOString();
  const updatedTasks = targetList.tasks.map((t) =>
    t.id === taskId
      ? {
          ...t,
          completed: !t.completed,
          completed_at: !t.completed ? nowIso : undefined,
        }
      : t
  );

  const updatedEntry: MemberDailyTodoList = {
    ...targetList,
    tasks: updatedTasks,
    updated_at: nowIso,
  };

  const nextLists = [...existingLists];
  nextLists[idx] = updatedEntry;

  saveGroupDailyTodos(conversationId, nextLists, dateKey);
  notifyLocalGroupTodoListeners(conversationId, nextLists);
  broadcastGroupTodoEntry(conversationId, updatedEntry);

  return nextLists;
}

/**
 * Automatically submits any 'in_progress' to-do lists in the group when the deadline is reached.
 */
export function autoSubmitPendingGroupTodos(
  conversationId: string,
  members?: PublicUserProfile[]
): { lists: MemberDailyTodoList[]; autoSubmittedUsers: MemberDailyTodoList[] } {
  const dateKey = getTodayDateKey();
  const existing = getGroupDailyTodos(conversationId, members, dateKey);
  const nowIso = new Date().toISOString();
  const autoSubmittedUsers: MemberDailyTodoList[] = [];

  const updated = existing.map((entry) => {
    if (entry.status === 'in_progress') {
      const nextEntry: MemberDailyTodoList = {
        ...entry,
        status: 'auto_submitted',
        submitted_at: nowIso,
        updated_at: nowIso,
      };
      autoSubmittedUsers.push(nextEntry);
      return nextEntry;
    }
    return entry;
  });

  if (autoSubmittedUsers.length > 0) {
    saveGroupDailyTodos(conversationId, updated, dateKey);
  }

  return { lists: updated, autoSubmittedUsers };
}

/**
 * Formats a clean chat message summary for when a user shares or submits their To-Do list in the group.
 */
export function formatTodoSummaryMessage(
  entry: MemberDailyTodoList,
  action: 'created' | 'updated' | 'submitted' | 'auto_submitted'
): string {
  const completedCount = entry.tasks.filter((t) => t.completed).length;
  const totalCount = entry.tasks.length;
  const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const header =
    action === 'created'
      ? `📋 Today's To-Do List (${completedCount}/${totalCount} · ${percent}%)`
      : action === 'submitted'
      ? `✅ Final To-Do Check-In Submitted (${completedCount}/${totalCount} · ${percent}%)`
      : action === 'auto_submitted'
      ? `🕛 12:00 Auto-Submitted To-Do Report (${completedCount}/${totalCount} · ${percent}%)`
      : `⚡ To-Do Progress Updated (${completedCount}/${totalCount} · ${percent}%)`;

  const lines = entry.tasks.map((t) => `${t.completed ? '☑️' : '⬜'} ${t.text}`);
  return `${header}\n${lines.join('\n')}`;
}
