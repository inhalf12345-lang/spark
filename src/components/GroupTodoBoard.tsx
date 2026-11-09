import React, { useState, useEffect } from 'react';
import {
  CheckSquare,
  Plus,
  Trash2,
  CheckCircle2,
  Clock,
  Send,
  X,
  Sparkles,
  Users,
  Bell,
  ChevronRight,
  Check,
  AlertCircle,
} from 'lucide-react';
import { PublicUserProfile, UserProfile } from '../types';
import {
  MemberDailyTodoList,
  TodoTaskItem,
  getGroupDailyTodos,
  saveGroupDailyTodos,
  getDraftTodoTasks,
  saveDraftTodoTasks,
  upsertMemberDailyTodoList,
  toggleGroupTodoTask,
  autoSubmitPendingGroupTodos,
  formatTodoSummaryMessage,
  getTimeUntilDeadline,
  DUMMY_TODO_TASK_TEXTS,
} from '../lib/groupTodoService';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';
import { TodoBoard } from './TodoBoard';

export interface FlattenedGroupTask {
  id: string;
  text: string;
  completed: boolean;
  ownerUserId: string;
  ownerName: string;
  isLocked: boolean;
}

export function extractFlattenedGroupTasks(
  todoLists: MemberDailyTodoList[],
  currentUserId: string,
  draftTasks: TodoTaskItem[] = []
): FlattenedGroupTask[] {
  const result: FlattenedGroupTask[] = [];
  const seenIds = new Set<string>();

  for (const list of todoLists) {
    const isLocked = list.status === 'submitted' || list.status === 'auto_submitted';
    for (const task of list.tasks) {
      if (!task.text || DUMMY_TODO_TASK_TEXTS.has(task.text)) continue;
      seenIds.add(task.id);
      result.push({
        id: task.id,
        text: task.text,
        completed: Boolean(task.completed),
        ownerUserId: list.user_id,
        ownerName: list.display_name || list.username,
        isLocked,
      });
    }
  }

  const hasCurrentUserInLists = todoLists.some((l) => l.user_id === currentUserId);
  if (!hasCurrentUserInLists && draftTasks.length > 0) {
    for (const task of draftTasks) {
      if (!task.text || DUMMY_TODO_TASK_TEXTS.has(task.text) || seenIds.has(task.id)) continue;
      result.push({
        id: task.id,
        text: task.text,
        completed: Boolean(task.completed),
        ownerUserId: currentUserId,
        ownerName: 'You',
        isLocked: false,
      });
    }
  }

  return result;
}

export function openGroupTodoBoardModal(
  conversationId: string,
  tab: 'group_progress' | 'my_todo' = 'group_progress'
): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('spark_open_group_todo_board', {
        detail: { conversationId, tab },
      })
    );
  }
}

interface GroupTodoDashboardCardProps {
  conversationId: string;
  profile: UserProfile;
  members?: PublicUserProfile[];
  onOpenFullBoard?: (tab?: 'group_progress' | 'my_todo') => void;
}

/**
 * Spark Aura Group To-Do List Card (matches the red-circled section in the Group Dashboard reference):
 * - Header: "Group To-Do List" with "View all →" action
 * - Left: Circular progress ring showing completed / total tasks (e.g. 1/3)
 * - Right: Vertical list of actual group tasks with interactive green checkboxes
 */
export const GroupTodoDashboardCard: React.FC<GroupTodoDashboardCardProps> = ({
  conversationId,
  profile,
  members,
  onOpenFullBoard,
}) => {
  const [todoLists, setTodoLists] = useState<MemberDailyTodoList[]>(() =>
    getGroupDailyTodos(conversationId, members)
  );
  const [draftTasks, setDraftTasks] = useState<TodoTaskItem[]>(() => {
    const saved = getDraftTodoTasks(conversationId, profile.id) || [];
    return saved.filter((t) => !DUMMY_TODO_TASK_TEXTS.has(t.text));
  });

  useEffect(() => {
    const syncFromStorage = () => {
      const latestLists = getGroupDailyTodos(conversationId, members);
      setTodoLists(latestLists);
      const myList = latestLists.find((l) => l.user_id === profile.id);
      if (myList && myList.tasks.length > 0) {
        setDraftTasks(myList.tasks);
      } else {
        const saved = getDraftTodoTasks(conversationId, profile.id) || [];
        setDraftTasks(saved.filter((t) => !DUMMY_TODO_TASK_TEXTS.has(t.text)));
      }
    };

    syncFromStorage();

    const handleLocalUpdate = (e: Event) => {
      const custom = e as CustomEvent;
      if (!custom.detail || custom.detail.conversationId === conversationId) {
        syncFromStorage();
      }
    };

    window.addEventListener('spark_group_todos_updated', handleLocalUpdate);
    return () => {
      window.removeEventListener('spark_group_todos_updated', handleLocalUpdate);
    };
  }, [conversationId, profile.id, members]);

  const allTasks = extractFlattenedGroupTasks(todoLists, profile.id, draftTasks);
  const totalCount = allTasks.length;
  const completedCount = allTasks.filter((t) => t.completed).length;

  const radius = 31;
  const circumference = 2 * Math.PI * radius;
  const progressRatio = totalCount > 0 ? completedCount / totalCount : 0;
  const strokeDashoffset = circumference * (1 - progressRatio);

  const handleTriggerOpenBoard = (tab: 'group_progress' | 'my_todo' = 'group_progress') => {
    if (onOpenFullBoard) {
      onOpenFullBoard(tab);
    } else {
      openGroupTodoBoardModal(conversationId, tab);
    }
  };

  const handleToggleTaskItem = async (task: FlattenedGroupTask) => {
    if (task.isLocked) return;

    if (task.ownerUserId === profile.id) {
      const myExisting = todoLists.find((l) => l.user_id === profile.id);
      const sourceTasks = myExisting ? myExisting.tasks : draftTasks;
      const updatedTasks = sourceTasks.map((t) =>
        t.id === task.id
          ? {
              ...t,
              completed: !t.completed,
              completed_at: !t.completed ? new Date().toISOString() : undefined,
            }
          : t
      );
      setDraftTasks(updatedTasks);
      saveDraftTodoTasks(conversationId, profile.id, updatedTasks);
      const nextLists = await upsertMemberDailyTodoList(
        conversationId,
        profile,
        updatedTasks,
        'in_progress',
        members
      );
      setTodoLists(nextLists);
    } else {
      const nextLists = await toggleGroupTodoTask(
        conversationId,
        task.ownerUserId,
        task.id,
        members
      );
      setTodoLists(nextLists);
    }
  };

  return (
    <div className="rounded-3xl bg-white/95 border border-violet-100/90 shadow-[0_8px_26px_rgba(42,30,75,0.06)] p-4 sm:p-5 transition-all">
      {/* Header: "Group To-Do List" with "View all →" action */}
      <div className="flex items-center justify-between gap-2 mb-3.5">
        <h4 className="font-display font-bold text-sm sm:text-[15px] text-slate-900 tracking-tight">
          Group To-Do List
        </h4>
        <button
          type="button"
          onClick={() => handleTriggerOpenBoard('group_progress')}
          className="text-xs font-bold text-[#8B5CF6] hover:text-violet-700 flex items-center gap-1 transition-colors cursor-pointer"
        >
          <span>View all</span>
          <span aria-hidden="true">→</span>
        </button>
      </div>

      {/* Body: Circular Progress Ring + Vertical Task Checklist */}
      <div className="flex items-center gap-4 sm:gap-5">
        {/* Circular Progress Indicator (completed / total) */}
        <div className="relative w-20 h-20 shrink-0 flex items-center justify-center">
          <svg className="w-20 h-20 -rotate-90" viewBox="0 0 76 76">
            <circle
              cx="38"
              cy="38"
              r={radius}
              fill="none"
              stroke="#EDE9FE"
              strokeWidth="7"
            />
            {totalCount > 0 && (
              <circle
                cx="38"
                cy="38"
                r={radius}
                fill="none"
                stroke={completedCount === totalCount ? '#10B981' : '#8B5CF6'}
                strokeWidth="7"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                className="transition-all duration-500 ease-out"
              />
            )}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-display font-extrabold text-base text-slate-900 font-mono-numbers leading-none">
              {completedCount}/{totalCount}
            </span>
          </div>
        </div>

        {/* Vertical List of Actual Group Tasks */}
        <div className="flex-1 min-w-0">
          {allTasks.length === 0 ? (
            <div className="py-1 space-y-2">
              <p className="text-xs text-slate-500 leading-relaxed">
                No tasks added for this group yet today.
              </p>
              <button
                type="button"
                onClick={() => handleTriggerOpenBoard('my_todo')}
                className="px-3 py-1.5 rounded-full bg-violet-50 hover:bg-violet-100 border border-violet-200/80 text-[#8B5CF6] font-bold text-xs inline-flex items-center gap-1 transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Task</span>
              </button>
            </div>
          ) : (
            <div className="space-y-2.5 max-h-36 overflow-y-auto pr-1">
              {allTasks.map((task) => (
                <div
                  key={`${task.ownerUserId}_${task.id}`}
                  onClick={() => handleToggleTaskItem(task)}
                  className={`flex items-center gap-2.5 group/task select-none ${
                    task.isLocked
                      ? 'opacity-80 cursor-default'
                      : 'cursor-pointer'
                  }`}
                  title={
                    task.isLocked
                      ? `Submitted by ${task.ownerName}`
                      : `Click to mark "${task.text}" ${task.completed ? 'incomplete' : 'complete'}`
                  }
                >
                  <button
                    type="button"
                    disabled={task.isLocked}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleTaskItem(task);
                    }}
                    className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 transition-all ${
                      task.completed
                        ? 'bg-emerald-500 border border-emerald-500 text-white shadow-2xs'
                        : 'bg-white border-[1.5px] border-violet-200 group-hover/task:border-[#8B5CF6]'
                    }`}
                    aria-label={task.completed ? 'Completed' : 'Incomplete'}
                  >
                    {task.completed && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                  </button>

                  <span
                    className={`text-xs sm:text-[13px] font-medium truncate transition-colors ${
                      task.completed
                        ? 'text-slate-700'
                        : 'text-slate-800 group-hover/task:text-slate-950'
                    }`}
                  >
                    {task.text}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface GroupTodoSectionProps {
  conversationId: string;
  groupName: string;
  profile: UserProfile;
  members?: PublicUserProfile[];
  onPostTodoChatSummary: (summaryText: string) => Promise<void>;
}

export const GroupTodoSection: React.FC<GroupTodoSectionProps> = ({
  conversationId,
  groupName,
  profile,
  members,
  onPostTodoChatSummary,
}) => {
  const [todoLists, setTodoLists] = useState<MemberDailyTodoList[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'group_progress' | 'my_todo'>('group_progress');
  const [newTaskText, setNewTaskText] = useState('');
  const [draftTasks, setDraftTasks] = useState<TodoTaskItem[]>([]);
  const [isPosting, setIsPosting] = useState(false);

  // 12:00 Check & Auto-Submit Prompt state
  const [isCheckInPromptOpen, setIsCheckInPromptOpen] = useState(false);
  const [autoSubmitCountdown, setAutoSubmitCountdown] = useState<number | null>(null);
  const [deadlineInfo, setDeadlineInfo] = useState(getTimeUntilDeadline);

  // Load initial group todos & setup realtime listener
  useEffect(() => {
    const syncLocalState = () => {
      const loaded = getGroupDailyTodos(conversationId, members);
      setTodoLists(loaded);

      const myExisting = loaded.find((l) => l.user_id === profile.id);
      const savedDraft = getDraftTodoTasks(conversationId, profile.id);
      if (myExisting && myExisting.tasks.length > 0) {
        setDraftTasks(myExisting.tasks);
        saveDraftTodoTasks(conversationId, profile.id, myExisting.tasks);
      } else if (savedDraft && savedDraft.length > 0) {
        const cleanDraft = savedDraft.filter((t) => !DUMMY_TODO_TASK_TEXTS.has(t.text));
        setDraftTasks(cleanDraft);
        saveDraftTodoTasks(conversationId, profile.id, cleanDraft);
      } else {
        setDraftTasks([]);
      }
    };

    syncLocalState();

    const handleLocalTodoSync = (e: Event) => {
      const custom = e as CustomEvent;
      if (!custom.detail || custom.detail.conversationId === conversationId) {
        syncLocalState();
      }
    };

    const handleOpenBoardEvent = (e: Event) => {
      const custom = e as CustomEvent;
      if (!custom.detail || custom.detail.conversationId === conversationId) {
        if (custom.detail?.tab) {
          setActiveTab(custom.detail.tab);
        } else {
          setActiveTab('group_progress');
        }
        setIsModalOpen(true);
      }
    };

    window.addEventListener('spark_group_todos_updated', handleLocalTodoSync);
    window.addEventListener('spark_open_group_todo_board', handleOpenBoardEvent);

    let channel: any = null;
    const supabase = isSupabaseConfigured() ? getSupabase() : null;
    if (supabase) {
      try {
        channel = supabase
          .channel(`group_todos_${conversationId}`)
          .on('broadcast', { event: 'todo_updated' }, (payload) => {
            const incoming = (payload?.payload ?? payload) as MemberDailyTodoList;
            if (incoming && incoming.user_id) {
              setTodoLists((prev) => {
                const idx = prev.findIndex((i) => i.user_id === incoming.user_id);
                let next: MemberDailyTodoList[];
                if (idx >= 0) {
                  next = [...prev];
                  next[idx] = incoming;
                } else {
                  next = [incoming, ...prev];
                }
                saveGroupDailyTodos(conversationId, next);
                window.dispatchEvent(
                  new CustomEvent('spark_group_todos_updated', {
                    detail: { conversationId, lists: next },
                  })
                );
                return next;
              });
            }
          })
          .subscribe();
      } catch (err) {
        console.warn('Group todo realtime channel notice:', err);
      }
    }

    return () => {
      window.removeEventListener('spark_group_todos_updated', handleLocalTodoSync);
      window.removeEventListener('spark_open_group_todo_board', handleOpenBoardEvent);
      if (channel && supabase) {
        try {
          supabase.removeChannel(channel);
        } catch {}
      }
    };
  }, [conversationId, profile.id, members]);

  // Periodic clock check for 12:00 check-in window & midnight auto-submit
  useEffect(() => {
    const interval = setInterval(() => {
      const info = getTimeUntilDeadline();
      setDeadlineInfo(info);

      const now = new Date();
      // If it hits 23:59 (end of day) and user hasn't submitted yet, trigger auto-submit
      if (now.getHours() === 23 && now.getMinutes() === 59 && now.getSeconds() >= 50) {
        handleRunAutoSubmit();
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [conversationId, todoLists]);

  // Countdown timer when the 12:00 Check-In Prompt is open; auto-submits when countdown hits 0
  useEffect(() => {
    if (!isCheckInPromptOpen || autoSubmitCountdown === null) return;

    if (autoSubmitCountdown <= 0) {
      handleRunAutoSubmit();
      setIsCheckInPromptOpen(false);
      setAutoSubmitCountdown(null);
      return;
    }

    const timer = setTimeout(() => {
      setAutoSubmitCountdown((prev) => (prev !== null ? prev - 1 : null));
    }, 1000);

    return () => clearTimeout(timer);
  }, [isCheckInPromptOpen, autoSubmitCountdown]);

  const myTodoList = todoLists.find((l) => l.user_id === profile.id);
  const isMyListLocked =
    myTodoList?.status === 'submitted' || myTodoList?.status === 'auto_submitted';

  const handleAddDraftTask = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newTaskText.trim();
    if (!clean) return;
    const newItem: TodoTaskItem = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      text: clean,
      completed: false,
    };
    const updatedTasks = [...draftTasks, newItem];
    setDraftTasks(updatedTasks);
    saveDraftTodoTasks(conversationId, profile.id, updatedTasks);
    setNewTaskText('');

    if (!isMyListLocked) {
      const nextLists = await upsertMemberDailyTodoList(
        conversationId,
        profile,
        updatedTasks,
        'in_progress',
        members
      );
      setTodoLists(nextLists);
    }
  };

  const handleRemoveDraftTask = async (taskId: string) => {
    const updatedTasks = draftTasks.filter((t) => t.id !== taskId);
    setDraftTasks(updatedTasks);
    saveDraftTodoTasks(conversationId, profile.id, updatedTasks);

    if (!isMyListLocked && updatedTasks.length > 0) {
      const nextLists = await upsertMemberDailyTodoList(
        conversationId,
        profile,
        updatedTasks,
        'in_progress',
        members
      );
      setTodoLists(nextLists);
    }
  };

  const handleToggleTask = async (targetUserId: string, taskId: string) => {
    if (targetUserId === profile.id) {
      if (isMyListLocked) return;

      const sourceTasks = myTodoList ? myTodoList.tasks : draftTasks;
      const updatedTasks = sourceTasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              completed: !t.completed,
              completed_at: !t.completed ? new Date().toISOString() : undefined,
            }
          : t
      );

      setDraftTasks(updatedTasks);
      saveDraftTodoTasks(conversationId, profile.id, updatedTasks);

      const nextLists = await upsertMemberDailyTodoList(
        conversationId,
        profile,
        updatedTasks,
        'in_progress',
        members
      );
      setTodoLists(nextLists);
    } else {
      const nextLists = await toggleGroupTodoTask(
        conversationId,
        targetUserId,
        taskId,
        members
      );
      setTodoLists(nextLists);
    }
  };

  const handleSendOrUpdateMyTodoList = async (
    submitStatus: 'in_progress' | 'submitted' = 'in_progress'
  ) => {
    if (draftTasks.length === 0 || isPosting) return;
    setIsPosting(true);

    try {
      const hadExisting = Boolean(myTodoList);
      const nextLists = await upsertMemberDailyTodoList(
        conversationId,
        profile,
        draftTasks,
        submitStatus,
        members
      );
      setTodoLists(nextLists);

      const savedMine = nextLists.find((l) => l.user_id === profile.id);
      if (savedMine) {
        const actionType =
          submitStatus === 'submitted'
            ? 'submitted'
            : hadExisting
            ? 'updated'
            : 'created';
        const summaryMsg = formatTodoSummaryMessage(savedMine, actionType);
        await onPostTodoChatSummary(summaryMsg);
      }

      setActiveTab('group_progress');
      setIsCheckInPromptOpen(false);
      setAutoSubmitCountdown(null);
    } finally {
      setIsPosting(false);
    }
  };

  // Runs automatic submission for any member (including current user) who hasn't submitted by 12:00 deadline
  const handleRunAutoSubmit = async () => {
    const { lists, autoSubmittedUsers } = autoSubmitPendingGroupTodos(conversationId, members);
    setTodoLists(lists);

    if (autoSubmittedUsers.length > 0) {
      const lines = autoSubmittedUsers.map((u) => {
        const done = u.tasks.filter((t) => t.completed).length;
        const total = u.tasks.length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        return `• ${u.display_name} (@${u.username}): ${done}/${total} tasks (${pct}%) [Auto-Submitted]`;
      });

      const reportText = `🕛 12:00 Daily To-Do Auto-Submit Report\nUnchecked lists were automatically submitted:\n${lines.join(
        '\n'
      )}`;
      await onPostTodoChatSummary(reportText);
    }
  };

  // Trigger the 12:00 Check & Submit prompt with a 15-second auto-submit countdown so user can test it live
  const trigger12PmCheckPrompt = () => {
    setIsModalOpen(false);
    setIsCheckInPromptOpen(true);
    setAutoSubmitCountdown(15);
  };

  return (
    <>
      {/* 1. Spark Aura Group To-Do List Card */}
      <div className="bg-[#f8f7fc]/90 border-b border-violet-100/80 px-4 sm:px-6 py-3">
        <div className="max-w-4xl mx-auto">
          <GroupTodoDashboardCard
            conversationId={conversationId}
            profile={profile}
            members={members}
            onOpenFullBoard={(tab = 'group_progress') => {
              setActiveTab(tab);
              setIsModalOpen(true);
            }}
          />
        </div>
      </div>

      {/* 2. 12:00 Check & Auto-Submit Prompt Modal */}
      {isCheckInPromptOpen && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-[32px] bg-[#f8f7fc] border border-violet-100/90 shadow-2xl overflow-hidden text-slate-800 animate-droplet-squish">
            <div className="p-4 sm:p-5 bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] text-white flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center">
                  <Bell className="w-5 h-5 animate-bounce" />
                </div>
                <div>
                  <h3 className="font-display font-bold text-base">
                    12:00 Daily To-Do Check-In
                  </h3>
                  <p className="text-[11px] text-white/90">
                    Check your completed tasks &amp; submit before auto-submit!
                  </p>
                </div>
              </div>

              {autoSubmitCountdown !== null && (
                <div className="px-2.5 py-1 rounded-full bg-black/25 text-white font-mono-numbers text-xs font-bold shrink-0">
                  Auto in {autoSubmitCountdown}s
                </div>
              )}
            </div>

            <div className="p-4 sm:p-5 space-y-4 max-h-[75vh] overflow-y-auto">
              <div className="p-3 rounded-2xl bg-amber-50 border border-amber-200/80 text-xs text-amber-900 flex items-start gap-2">
                <Clock className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <span>
                  Review and check off your tasks for today. If you don&apos;t submit before the timer ends, your current progress will be <strong>automatically submitted</strong> to {groupName}.
                </span>
              </div>

              {/* Interactive Checklist for Current User */}
              <div className="space-y-2">
                <label className="block text-xs font-bold text-slate-700">
                  Your Today&apos;s Tasks ({draftTasks.filter((t) => t.completed).length}/{draftTasks.length} completed)
                </label>

                {draftTasks.map((task) => (
                  <div
                    key={task.id}
                    onClick={() => handleToggleTask(profile.id, task.id)}
                    className={`p-3 rounded-2xl border flex items-center justify-between gap-3 cursor-pointer transition-all ${
                      task.completed
                        ? 'bg-emerald-50/70 border-emerald-200 text-emerald-900'
                        : 'bg-white border-violet-100/90 text-slate-800 hover:bg-violet-50/50'
                    }`}
                  >
                    <span
                      className={`text-xs font-medium ${
                        task.completed ? 'line-through text-slate-500' : ''
                      }`}
                    >
                      {task.text}
                    </span>

                    <div
                      className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 ${
                        task.completed
                          ? 'bg-emerald-500 text-white'
                          : 'border border-violet-300 bg-white'
                      }`}
                    >
                      {task.completed && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-col sm:flex-row gap-2 pt-2">
                <button
                  type="button"
                  disabled={isPosting}
                  onClick={() => handleSendOrUpdateMyTodoList('submitted')}
                  className="flex-1 py-3 rounded-full bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-md shadow-violet-500/25 hover:opacity-95 active:scale-95 transition-all"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Check &amp; Submit Now</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setIsCheckInPromptOpen(false);
                    setAutoSubmitCountdown(null);
                    handleRunAutoSubmit();
                  }}
                  className="py-3 px-4 rounded-full bg-white border border-violet-200 hover:bg-violet-50 text-slate-700 font-semibold text-xs transition-colors"
                >
                  Auto-Submit Now
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 3. Full Group Daily To-Do & Live Progress Board Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-lg rounded-[32px] bg-[#f8f7fc] border border-violet-100/90 shadow-2xl flex flex-col overflow-hidden text-slate-800 max-h-[90vh] animate-droplet-squish">
            {/* Header */}
            <div className="flex items-center justify-between p-4 sm:p-5 border-b border-violet-100/80 bg-white">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-2xl bg-violet-100/80 flex items-center justify-center text-[#8B5CF6]">
                  <CheckSquare className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-display font-bold text-base text-slate-900 tracking-tight">
                    Group To-Do Board
                  </h2>
                  <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
                    <Clock className="w-3 h-3 text-[#8B5CF6]" />
                    <span>{groupName} · Auto-submits at 12:00 ({deadlineInfo.label} left)</span>
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="w-8 h-8 rounded-full bg-slate-100 hover:bg-violet-50 text-slate-500 hover:text-[#8B5CF6] flex items-center justify-center transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Segmented Pill Tabs + Test 12:00 Check-In Button */}
            <div className="px-4 sm:px-5 pt-3 pb-2.5 bg-white/70 border-b border-violet-100/70 flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setActiveTab('group_progress')}
                  className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap ${
                    activeTab === 'group_progress'
                      ? 'bg-[#8B5CF6] text-white shadow-sm shadow-violet-500/25'
                      : 'bg-white border border-violet-100 text-slate-600 hover:text-[#8B5CF6] hover:bg-violet-50/60'
                  }`}
                >
                  Group Progress ({todoLists.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('my_todo')}
                  className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap ${
                    activeTab === 'my_todo'
                      ? 'bg-[#8B5CF6] text-white shadow-sm shadow-violet-500/25'
                      : 'bg-white border border-violet-100 text-slate-600 hover:text-[#8B5CF6] hover:bg-violet-50/60'
                  }`}
                >
                  My To-Do List
                </button>
              </div>

              <button
                type="button"
                onClick={trigger12PmCheckPrompt}
                className="px-2.5 py-1.5 rounded-full bg-amber-50 hover:bg-amber-100 border border-amber-200/80 text-amber-800 text-[11px] font-bold flex items-center gap-1 transition-colors whitespace-nowrap"
                title="Test the 12:00 Check & Auto-Submit flow right now"
              >
                <Bell className="w-3.5 h-3.5 text-amber-600" />
                <span>Test 12:00 Check-In</span>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 sm:p-5 overflow-y-auto flex-1 space-y-4">
              {activeTab === 'group_progress' ? (
                /* TAB 1: TodoBoard Component — Real-Time Member Progress Bars & Automated 12 PM Submission Tracker */
                <TodoBoard
                  groupName={groupName}
                  currentUserId={profile.id}
                  todoLists={todoLists}
                  hasCurrentUserList={Boolean(myTodoList)}
                  isCurrentUserLocked={isMyListLocked}
                  onToggleTask={handleToggleTask}
                  onOpenCreateMyTodo={() => setActiveTab('my_todo')}
                  onTrigger12PmCheckIn={trigger12PmCheckPrompt}
                  onInstantAutoSubmitAll={handleRunAutoSubmit}
                  onSubmitMyListNow={() => handleSendOrUpdateMyTodoList('submitted')}
                />
              ) : (
                /* TAB 2: CREATE / EDIT MY TODAY'S TO-DO LIST */
                <div className="space-y-4">
                  {isMyListLocked && (
                    <div className="p-3 rounded-2xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                        <span>
                          Your list for today is{' '}
                          <strong>
                            {myTodoList?.status === 'auto_submitted'
                              ? 'Auto-Submitted'
                              : 'Submitted'}
                          </strong>
                          .
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          upsertMemberDailyTodoList(
                            conversationId,
                            profile,
                            draftTasks,
                            'in_progress',
                            members
                          ).then(setTodoLists)
                        }
                        className="text-[11px] font-bold text-emerald-700 underline shrink-0"
                      >
                        Re-open to edit
                      </button>
                    </div>
                  )}

                  {/* Add New Task Input */}
                  {!isMyListLocked && (
                    <form onSubmit={handleAddDraftTask} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={newTaskText}
                        onChange={(e) => setNewTaskText(e.target.value)}
                        placeholder="Add a task for today (e.g. Finish chapter 4)..."
                        className="flex-1 py-2.5 px-4 rounded-full text-xs bg-white border border-violet-200/80 text-slate-900 placeholder-slate-400 focus:outline-none focus:border-[#8B5CF6] transition-all shadow-2xs"
                      />
                      <button
                        type="submit"
                        disabled={!newTaskText.trim()}
                        className="px-4 py-2.5 rounded-full bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] text-white text-xs font-bold hover:opacity-95 disabled:opacity-40 transition-all shrink-0 flex items-center gap-1 shadow-xs"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add Task</span>
                      </button>
                    </form>
                  )}

                  {/* Draft Tasks List */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-slate-500 px-1">
                      <span className="font-semibold text-slate-700">
                        My Today&apos;s Tasks ({draftTasks.filter((t) => t.completed).length}/
                        {draftTasks.length} completed)
                      </span>
                      <span>Tap a task to check/uncheck</span>
                    </div>

                    {draftTasks.length === 0 ? (
                      <div className="py-8 text-center text-xs text-slate-400 bg-white rounded-2xl border border-dashed border-violet-200/80">
                        Add at least 1 task above to share your Today&apos;s To-Do list with the group.
                      </div>
                    ) : (
                      draftTasks.map((task) => (
                        <div
                          key={task.id}
                          className={`p-3 rounded-2xl border flex items-center justify-between gap-2.5 transition-all ${
                            task.completed
                              ? 'bg-emerald-50/70 border-emerald-200'
                              : 'bg-white border-violet-100/90 shadow-2xs'
                          }`}
                        >
                          <div
                            onClick={() => handleToggleTask(profile.id, task.id)}
                            className="flex items-center gap-2.5 flex-1 cursor-pointer min-w-0"
                          >
                            <div
                              className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                                task.completed
                                  ? 'bg-emerald-500 text-white'
                                  : 'bg-white border border-violet-300'
                              }`}
                            >
                              {task.completed && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                            </div>
                            <span
                              className={`text-xs font-medium truncate ${
                                task.completed ? 'line-through text-slate-400' : 'text-slate-800'
                              }`}
                            >
                              {task.text}
                            </span>
                          </div>

                          {!isMyListLocked && (
                            <button
                              type="button"
                              onClick={() => handleRemoveDraftTask(task.id)}
                              className="text-slate-400 hover:text-rose-500 p-1 transition-colors shrink-0"
                              title="Remove task"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>

                  {/* Send to Group / Submit Final Buttons */}
                  {!isMyListLocked && (
                    <div className="flex flex-col sm:flex-row gap-2.5 pt-2">
                      <button
                        type="button"
                        disabled={draftTasks.length === 0 || isPosting}
                        onClick={() => handleSendOrUpdateMyTodoList('in_progress')}
                        className="flex-1 py-3 rounded-full bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] text-white font-bold text-xs flex items-center justify-center gap-2 shadow-md shadow-violet-500/25 hover:opacity-95 active:scale-95 transition-all disabled:opacity-50"
                      >
                        <Send className="w-3.5 h-3.5" />
                        <span>
                          {myTodoList ? 'Update & Share Progress in Group' : "Send Today's To-Do to Group"}
                        </span>
                      </button>

                      <button
                        type="button"
                        disabled={draftTasks.length === 0 || isPosting}
                        onClick={() => handleSendOrUpdateMyTodoList('submitted')}
                        className="py-3 px-4 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition-all disabled:opacity-50 whitespace-nowrap"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Check &amp; Final Submit</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
