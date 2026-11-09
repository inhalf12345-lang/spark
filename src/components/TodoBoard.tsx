import React, { useState, useEffect } from 'react';
import {
  CheckCircle2,
  Clock,
  Check,
  Bell,
  Zap,
  Users,
  Plus,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { MemberDailyTodoList } from '../lib/groupTodoService';

export interface TodoBoardProps {
  groupName: string;
  currentUserId: string;
  todoLists: MemberDailyTodoList[];
  hasCurrentUserList: boolean;
  isCurrentUserLocked: boolean;
  onToggleTask: (userId: string, taskId: string) => void;
  onOpenCreateMyTodo: () => void;
  onTrigger12PmCheckIn: () => void;
  onInstantAutoSubmitAll: () => void;
  onSubmitMyListNow?: () => void;
}

function computeNext12Tracker() {
  const now = new Date();
  const nextNoon = new Date(now);
  nextNoon.setHours(12, 0, 0, 0);

  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);

  // Target the next upcoming 12:00 deadline (12:00 PM if before noon, or 12:00 AM end-of-day)
  const target = now.getTime() < nextNoon.getTime() ? nextNoon : nextMidnight;
  const targetLabel = now.getTime() < nextNoon.getTime() ? '12:00 PM Check-In' : '12:00 Auto-Submit';

  const diffMs = Math.max(0, target.getTime() - now.getTime());
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

  const formattedClock = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(
    2,
    '0'
  )}:${String(seconds).padStart(2, '0')}`;

  return {
    hours,
    minutes,
    seconds,
    formattedClock,
    targetLabel,
  };
}

export const TodoBoard: React.FC<TodoBoardProps> = ({
  groupName,
  currentUserId,
  todoLists,
  hasCurrentUserList,
  isCurrentUserLocked,
  onToggleTask,
  onOpenCreateMyTodo,
  onTrigger12PmCheckIn,
  onInstantAutoSubmitAll,
  onSubmitMyListNow,
}) => {
  const [trackerClock, setTrackerClock] = useState(computeNext12Tracker);

  useEffect(() => {
    const timer = setInterval(() => {
      const next = computeNext12Tracker();
      setTrackerClock(next);

      // Automatically trigger 12:00 submission when countdown hits 00:00:00
      if (next.hours === 0 && next.minutes === 0 && next.seconds === 0) {
        onInstantAutoSubmitAll();
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [onInstantAutoSubmitAll]);

  // Group-wide real-time metrics
  const totalTasksAcrossGroup = todoLists.reduce((acc, item) => acc + item.tasks.length, 0);
  const completedTasksAcrossGroup = todoLists.reduce(
    (acc, item) => acc + item.tasks.filter((t) => t.completed).length,
    0
  );
  const overallGroupPct =
    totalTasksAcrossGroup > 0
      ? Math.round((completedTasksAcrossGroup / totalTasksAcrossGroup) * 100)
      : 0;

  const submittedMembersCount = todoLists.filter(
    (item) => item.status === 'submitted' || item.status === 'auto_submitted'
  ).length;
  const pendingAutoSubmitCount = todoLists.filter((item) => item.status === 'in_progress').length;

  const formatShortTime = (iso?: string) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  return (
    <div className="space-y-4">
      {/* 1. Spark Aura Group Tasks Hero Banner & 12:00 Submission Tracker */}
      <div className="p-4 sm:p-5 rounded-3xl bg-gradient-to-br from-[#EDE9FE] via-[#DDD6FE] to-[#C4B5FD] text-slate-900 shadow-[0_8px_24px_rgba(139,92,246,0.12)] border border-violet-200/80 space-y-3.5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="space-y-0.5">
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[#6D28D9]">
              <Clock className="w-3.5 h-3.5 text-[#7C3AED]" />
              <span>Stay on track together 💪</span>
            </div>
            <h3 className="font-display font-extrabold text-sm sm:text-base text-slate-900">
              {groupName} <span className="text-[#7C3AED]">Tasks</span>
            </h3>
          </div>

          <div className="px-3 py-1.5 rounded-2xl bg-white/85 border border-violet-200/80 backdrop-blur-xs text-right shadow-2xs">
            <span className="block text-[9px] uppercase tracking-wider text-slate-500 font-semibold">
              {trackerClock.targetLabel}
            </span>
            <span className="font-mono-numbers font-black text-xs sm:text-sm text-[#7C3AED]">
              {trackerClock.formattedClock}
            </span>
          </div>
        </div>

        {/* Group Aggregate Real-Time Progress Bar */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-700 font-medium flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-[#7C3AED]" />
              <span>
                Squad Completion: <strong className="text-slate-900">{completedTasksAcrossGroup}</strong>/
                {totalTasksAcrossGroup} tasks
              </span>
            </span>
            <span className="font-mono-numbers font-black text-[#6D28D9]">{overallGroupPct}%</span>
          </div>

          <div className="w-full h-2.5 rounded-full bg-white/70 overflow-hidden border border-violet-200/60">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#8B5CF6] via-[#7C3AED] to-emerald-500 transition-all duration-500"
              style={{ width: `${overallGroupPct}%` }}
            />
          </div>
        </div>

        {/* 12:00 Submission Tracker Status Row */}
        <div className="pt-2 flex items-center justify-between gap-2 flex-wrap border-t border-violet-300/50 text-[11px]">
          <div className="flex items-center gap-3">
            <span className="text-emerald-800 font-bold flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
              {submittedMembersCount}/{todoLists.length} Submitted
            </span>
            <span className="text-violet-900 font-semibold flex items-center gap-1">
              <Zap className="w-3.5 h-3.5 text-[#7C3AED]" />
              {pendingAutoSubmitCount} Pending 12:00 Auto-Submit
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            {pendingAutoSubmitCount > 0 && (
              <button
                type="button"
                onClick={onTrigger12PmCheckIn}
                className="px-2.5 py-1 rounded-full bg-white/90 hover:bg-white border border-violet-200 text-[#6D28D9] font-bold text-[11px] flex items-center gap-1 transition-colors cursor-pointer shadow-2xs"
              >
                <Bell className="w-3 h-3" />
                <span>12:00 Check-In</span>
              </button>
            )}
            <button
              type="button"
              onClick={onInstantAutoSubmitAll}
              disabled={pendingAutoSubmitCount === 0}
              className="px-3 py-1 rounded-full bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:opacity-40 text-white font-bold text-[11px] flex items-center gap-1 transition-all cursor-pointer shadow-xs"
              title="Automatically submit all unsubmitted member lists right now"
            >
              <Send className="w-3 h-3" />
              <span>Auto-Submit Pending</span>
            </button>
          </div>
        </div>
      </div>

      {/* 2. Prompt if Current User Has Not Created Their To-Do List Yet */}
      {!hasCurrentUserList && (
        <div className="p-3.5 rounded-2xl bg-violet-50/80 border border-violet-200/80 flex items-center justify-between gap-3">
          <div className="text-xs">
            <p className="font-bold text-slate-900">
              You haven&apos;t shared today&apos;s To-Do list yet!
            </p>
            <p className="text-[11px] text-slate-500">
              Add your tasks so the group can see your live progress bar and include you in the 12:00 check-in.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenCreateMyTodo}
            className="px-4 py-2 rounded-full bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] text-white font-bold text-xs shrink-0 hover:opacity-95 flex items-center gap-1 whitespace-nowrap shadow-sm shadow-violet-500/20 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>+ Add Task</span>
          </button>
        </div>
      )}

      {/* 3. Individual Member Daily To-Do Lists & Real-Time Progress Bars */}
      <div className="space-y-3">
        {todoLists.length === 0 ? (
          <div className="py-8 px-4 text-center rounded-2xl bg-white border border-violet-100/90 text-slate-400 text-xs shadow-2xs">
            No member to-do lists shared today yet. Be the first to share your tasks!
          </div>
        ) : (
          todoLists.map((memberTodo) => {
            const isMe = memberTodo.user_id === currentUserId;
            const doneCount = memberTodo.tasks.filter((t) => t.completed).length;
            const totalCount = memberTodo.tasks.length;
            const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

            return (
              <div
                key={memberTodo.id}
                className={`p-4 rounded-3xl border space-y-3 transition-all ${
                  isMe
                    ? 'bg-white border-violet-200/90 shadow-[0_6px_20px_rgba(139,92,246,0.07)]'
                    : 'bg-white/95 border-violet-100/80 shadow-[0_4px_14px_rgba(42,30,75,0.04)]'
                }`}
              >
                {/* Member Header & Submission Tracker Status */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="relative shrink-0">
                      <img
                        src={memberTodo.avatar_url}
                        alt={memberTodo.username}
                        className="w-9 h-9 rounded-full object-cover bg-white border border-violet-200 shrink-0"
                      />
                      <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-white" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <h4 className="font-display font-bold text-xs sm:text-sm text-slate-900 truncate">
                          {memberTodo.display_name}
                          {isMe ? ' (You)' : ''}
                        </h4>
                        <span className="text-[11px] text-slate-400 font-mono truncate">
                          @{memberTodo.username}
                        </span>
                      </div>

                      <div className="text-[10px] flex items-center gap-2 mt-0.5">
                        {memberTodo.status === 'submitted' ? (
                          <span className="text-emerald-700 font-bold flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                            Done by {memberTodo.display_name}{' '}
                            {memberTodo.submitted_at
                              ? `• ${formatShortTime(memberTodo.submitted_at)}`
                              : ''}
                          </span>
                        ) : memberTodo.status === 'auto_submitted' ? (
                          <span className="text-amber-700 font-bold flex items-center gap-1">
                            <Clock className="w-3 h-3 text-amber-600" />
                            Auto-Submitted at 12:00{' '}
                            {memberTodo.submitted_at
                              ? `(${formatShortTime(memberTodo.submitted_at)})`
                              : ''}
                          </span>
                        ) : (
                          <span className="text-[#8B5CF6] font-semibold flex items-center gap-1">
                            <Zap className="w-3 h-3" />
                            Assigned to {isMe ? 'You' : memberTodo.display_name} • Today
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <span className="font-mono-numbers font-black text-sm text-slate-900">
                      {pct}%
                    </span>
                    <p className="text-[10px] font-mono-numbers text-slate-400">
                      {doneCount}/{totalCount} tasks
                    </p>
                  </div>
                </div>

                {/* Member Real-Time Progress Bar */}
                <div className="w-full h-2 rounded-full bg-violet-100/80 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      pct === 100
                        ? 'bg-emerald-500'
                        : memberTodo.status === 'auto_submitted'
                        ? 'bg-amber-500'
                        : 'bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED]'
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>

                {/* Member Task Checklist */}
                <div className="space-y-2 pt-0.5">
                  {memberTodo.tasks.map((task) => {
                    const isListLocked =
                      memberTodo.status === 'submitted' || memberTodo.status === 'auto_submitted';
                    return (
                      <div
                        key={task.id}
                        onClick={() => {
                          if (!isListLocked) {
                            onToggleTask(memberTodo.user_id, task.id);
                          }
                        }}
                        className={`px-3.5 py-2.5 rounded-2xl border flex items-center justify-between gap-2.5 text-xs transition-all ${
                          !isListLocked
                            ? 'cursor-pointer hover:border-violet-300 hover:bg-violet-50/40'
                            : ''
                        } ${
                          task.completed
                            ? 'bg-emerald-50/60 border-emerald-200/80 text-slate-600'
                            : 'bg-[#f8f7fc] border-violet-100/90 text-slate-800'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                              task.completed
                                ? 'bg-emerald-500 text-white shadow-2xs'
                                : 'border-2 border-violet-300 bg-white'
                            }`}
                          >
                            {task.completed && <Check className="w-3 h-3 stroke-[3]" />}
                          </div>

                          <div className="min-w-0">
                            <span
                              className={`block truncate ${
                                task.completed
                                  ? 'line-through text-slate-400 font-medium'
                                  : 'font-semibold text-slate-800'
                              }`}
                            >
                              {task.text}
                            </span>
                            <span className="text-[10px] text-slate-400">
                              {task.completed
                                ? `Done by ${memberTodo.display_name}`
                                : `Assigned to ${isMe ? 'You' : memberTodo.display_name} • Today`}
                            </span>
                          </div>
                        </div>

                        <img
                          src={memberTodo.avatar_url}
                          alt={memberTodo.username}
                          className="w-6 h-6 rounded-full object-cover bg-white border border-violet-100 shrink-0"
                        />
                      </div>
                    );
                  })}
                </div>

                {/* Quick Submit Action for Current User if In Progress */}
                {isMe && memberTodo.status === 'in_progress' && onSubmitMyListNow && (
                  <div className="pt-1.5 flex items-center justify-between gap-2 border-t border-violet-100/80">
                    <span className="text-[11px] text-slate-500">
                      Tap any task above to update your live progress
                    </span>
                    <button
                      type="button"
                      onClick={onSubmitMyListNow}
                      className="px-3.5 py-1.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[11px] flex items-center gap-1 transition-colors cursor-pointer shadow-2xs"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Check &amp; Submit Final</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
