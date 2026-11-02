import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Trash2, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  autoRecoverCount: number;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      autoRecoverCount: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.warn('Spark App Error caught by ErrorBoundary:', error, errorInfo);

    // Silent auto-recovery on the first error so users on mobile Chrome are never stuck
    if (this.state.autoRecoverCount < 1) {
      try {
        // Sanitize any corrupted transient cache entries while keeping user auth & profile intact
        const transientKeys = ['spark_cached_messages', 'spark_real_conversations'];
        transientKeys.forEach((k) => {
          const val = localStorage.getItem(k);
          if (val) {
            try {
              JSON.parse(val);
            } catch {
              localStorage.removeItem(k);
            }
          }
        });
      } catch {}

      this.setState((prev) => ({
        hasError: false,
        error: null,
        errorInfo: null,
        autoRecoverCount: prev.autoRecoverCount + 1,
      }));
      return;
    }

    this.setState({
      error,
      errorInfo,
    });
  }

  handleReload = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  handleResetAndReload = () => {
    try {
      const keysToClear = [
        'spark_active_local_session',
        'spark_user_profile',
        'spark_stay_signed_in',
        'spark_real_conversations',
        'spark_cached_messages',
        'spark_daily_quests',
        'spark_user_stories',
      ];
      keysToClear.forEach((k) => localStorage.removeItem(k));
    } catch {}
    window.location.href = window.location.pathname;
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen w-full flex items-center justify-center p-4 bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white font-sans">
          <div className="w-full max-w-md bg-white/10 backdrop-blur-xl border border-white/20 rounded-3xl p-6 sm:p-8 shadow-2xl text-center flex flex-col items-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-rose-500 to-amber-500 flex items-center justify-center text-white shadow-lg shadow-rose-500/30 mb-5">
              <AlertTriangle className="w-8 h-8 animate-pulse" />
            </div>

            <h1 className="font-display font-extrabold text-2xl tracking-tight text-white mb-2">
              Quick Recovery
            </h1>
            <p className="text-sm text-slate-300 mb-6 max-w-sm">
              Spark refreshed a temporary view state. Your account data in Supabase is completely safe.
            </p>

            <div className="flex flex-col sm:flex-row gap-3 w-full">
              <button
                onClick={this.handleReload}
                className="flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-pink-500 to-rose-500 hover:from-pink-600 hover:to-rose-600 font-semibold text-sm text-white shadow-lg shadow-rose-500/25 flex items-center justify-center gap-2 transition-all active:scale-95"
              >
                <RefreshCw className="w-4 h-4" />
                Continue to Spark
              </button>

              <button
                onClick={this.handleResetAndReload}
                className="flex-1 py-3 px-4 rounded-xl bg-white/10 hover:bg-white/20 font-semibold text-sm text-slate-200 border border-white/15 flex items-center justify-center gap-2 transition-all active:scale-95"
                title="Clears local cache if a corrupted message or state triggered the issue"
              >
                <Trash2 className="w-4 h-4 text-amber-300" />
                Reset Cache
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
