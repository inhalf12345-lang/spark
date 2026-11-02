import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Trash2, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Spark Uncaught App Error:', error, errorInfo);
    this.setState({
      error,
      errorInfo,
    });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleResetAndReload = () => {
    try {
      // Clear potentially corrupted local chat caches while preserving essentials
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
              Something went wrong
            </h1>
            <p className="text-sm text-slate-300 mb-6 max-w-sm">
              Spark encountered an unexpected rendering error. Your account data in Supabase is safe.
            </p>

            {this.state.error && (
              <div className="w-full bg-black/40 rounded-xl p-3 mb-6 text-left border border-white/10 max-h-32 overflow-y-auto">
                <p className="text-xs font-mono text-rose-300 break-words font-medium">
                  {this.state.error.message || String(this.state.error)}
                </p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3 w-full">
              <button
                onClick={this.handleReload}
                className="flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-pink-500 to-rose-500 hover:from-pink-600 hover:to-rose-600 font-semibold text-sm text-white shadow-lg shadow-rose-500/25 flex items-center justify-center gap-2 transition-all active:scale-95"
              >
                <RefreshCw className="w-4 h-4" />
                Reload Page
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
