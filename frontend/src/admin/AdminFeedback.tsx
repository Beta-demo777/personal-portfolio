import type { ReactNode } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  Info,
  LoaderCircle,
  RotateCcw,
  ShieldAlert,
  X,
} from 'lucide-react';

export type AdminNoticeTone = 'success' | 'error' | 'warning' | 'info';

export interface AdminNotice {
  code: string;
  message: string;
  tone: AdminNoticeTone;
}

export type ResourceStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'stale';

export interface ResourceState {
  status: ResourceStatus;
  error?: string;
}

export const IDLE_RESOURCE_STATE: ResourceState = { status: 'idle' };

export function beginResourceLoad(current: ResourceState): ResourceState {
  return current.status === 'ready' || current.status === 'stale'
    ? { status: 'stale' }
    : { status: 'loading' };
}

export function completeResourceLoad(itemCount: number): ResourceState {
  return { status: itemCount > 0 ? 'ready' : 'empty' };
}

export function failResourceLoad(current: ResourceState, error: string): ResourceState {
  return current.status === 'stale'
    ? { status: 'stale', error }
    : { status: 'error', error };
}

const noticeStyles: Record<AdminNoticeTone, string> = {
  success: 'border-emerald-400/20 bg-[#0d1d18] text-emerald-200',
  error: 'border-rose-400/20 bg-[#221015] text-rose-200',
  warning: 'border-amber-400/20 bg-[#241b0c] text-amber-100',
  info: 'border-sky-400/20 bg-[#0c1b24] text-sky-100',
};

const noticeIcons: Record<AdminNoticeTone, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: ShieldAlert,
  warning: CircleAlert,
  info: Info,
};

export function AdminNoticeToast({ notice, onDismiss }: { notice: AdminNotice; onDismiss: () => void }) {
  const Icon = noticeIcons[notice.tone];
  const assertive = notice.tone === 'error' || notice.tone === 'warning';
  return (
    <div
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
      data-notice-code={notice.code}
      data-tone={notice.tone}
      className={`fixed right-4 top-[84px] z-40 flex max-w-[calc(100vw-2rem)] items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-xl sm:right-6 ${noticeStyles[notice.tone]}`}
    >
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="leading-relaxed">{notice.message}</span>
      <button
        type="button"
        aria-label="关闭提示"
        onClick={onDismiss}
        className="ml-2 grid h-8 w-8 shrink-0 place-items-center rounded text-current opacity-60 transition hover:bg-white/[0.05] hover:opacity-100"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function AdminAuthUnavailableState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#07080c] px-5 py-10 text-white">
      <section aria-labelledby="admin-auth-unavailable" className="w-full max-w-md border border-rose-400/20 bg-[#111017] p-6 sm:p-7">
        <span className="grid h-11 w-11 place-items-center rounded-lg border border-rose-400/20 bg-rose-400/[0.08] text-rose-200">
          <ShieldAlert size={18} aria-hidden="true" />
        </span>
        <h1 id="admin-auth-unavailable" className="mt-5 text-xl font-semibold">认证服务暂时不可用</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-400">当前无法确认登录状态，因此没有显示登录表单。请在服务恢复后重试。</p>
        <p role="alert" className="mt-4 border-l-2 border-rose-400/50 pl-3 text-sm leading-6 text-rose-200">{error}</p>
        <button type="button" onClick={onRetry} className="mt-6 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-indigo-500 px-4 text-sm font-medium hover:bg-indigo-400">
          <RotateCcw size={15} aria-hidden="true" />重新检查登录状态
        </button>
      </section>
    </main>
  );
}

export function AdminContentLoadState({
  status,
  error,
  onRetry,
  onLogout,
}: {
  status: 'loading' | 'error';
  error?: string;
  onRetry: () => void;
  onLogout: () => void;
}) {
  if (status === 'loading') {
    return (
      <main className="grid min-h-screen place-items-center bg-[#07080c] px-5 text-zinc-400">
        <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
          <div className="grid h-12 w-12 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-indigo-300">
            <LoaderCircle size={20} className="animate-spin" aria-hidden="true" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-zinc-200">正在读取工作台内容</p>
            <p className="mt-1 text-xs text-zinc-500">登录状态已确认</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#07080c] px-5 py-10 text-white">
      <section aria-labelledby="admin-content-load-error" className="w-full max-w-md border border-rose-400/20 bg-[#111017] p-6 sm:p-7">
        <span className="grid h-11 w-11 place-items-center rounded-lg border border-rose-400/20 bg-rose-400/[0.08] text-rose-200">
          <ShieldAlert size={18} aria-hidden="true" />
        </span>
        <h1 id="admin-content-load-error" className="mt-5 text-xl font-semibold">工作台内容暂时无法载入</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-400">登录状态仍然有效，没有返回登录页。请重试内容请求，当前浏览器中的本地备份不会被清除。</p>
        {error && <p role="alert" className="mt-4 border-l-2 border-rose-400/50 pl-3 text-sm leading-6 text-rose-200">{error}</p>}
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <button type="button" onClick={onRetry} className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-indigo-500 px-4 text-sm font-medium hover:bg-indigo-400">
            <RotateCcw size={15} aria-hidden="true" />重试载入内容
          </button>
          <button type="button" onClick={onLogout} className="min-h-11 rounded-lg border border-white/[0.09] px-4 text-sm text-zinc-400 hover:bg-white/[0.04] hover:text-white">退出登录</button>
        </div>
      </section>
    </main>
  );
}

export function InlineResourceState({
  state,
  loadingLabel,
  errorTitle,
  onRetry,
  children,
}: {
  state: ResourceState;
  loadingLabel: string;
  errorTitle: string;
  onRetry: () => void;
  children?: ReactNode;
}) {
  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <div className="grid min-h-40 place-items-center text-xs text-zinc-500" role="status" aria-live="polite">
        <span className="flex items-center gap-2"><LoaderCircle size={15} className="animate-spin" aria-hidden="true" />{loadingLabel}</span>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="grid min-h-40 place-items-center border border-rose-400/15 bg-rose-400/[0.035] px-5 text-center">
        <div>
          <CircleAlert size={19} className="mx-auto text-rose-300" aria-hidden="true" />
          <h3 className="mt-3 text-sm font-medium text-rose-100">{errorTitle}</h3>
          {state.error && <p role="alert" className="mt-1 text-xs leading-5 text-rose-200/70">{state.error}</p>}
          <button type="button" onClick={onRetry} className="mt-4 min-h-11 rounded-lg border border-rose-300/20 px-4 text-xs text-rose-100 hover:bg-rose-300/[0.07]">
            重新加载
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
