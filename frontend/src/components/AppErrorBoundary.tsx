import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  failed: boolean;
}

export default class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Application render failed', {
      name: error.name,
      componentStack: info.componentStack || undefined,
    });
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <main className="grid min-h-screen place-items-center bg-[#07080c] px-5 text-zinc-100">
        <div role="alert" className="w-full max-w-md border border-rose-400/20 bg-[#151015] p-6 text-center">
          <TriangleAlert aria-hidden="true" className="mx-auto text-rose-300" size={24} />
          <h1 className="mt-4 text-base font-semibold">页面暂时无法显示</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-400">重新加载后仍然失败时，请稍后再试。</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mx-auto mt-5 flex min-h-11 items-center gap-2 bg-white px-4 text-sm font-medium text-black transition hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            <RefreshCw aria-hidden="true" size={15} />
            重新加载
          </button>
        </div>
      </main>
    );
  }
}
