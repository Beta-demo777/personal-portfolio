import { lazy, StrictMode, Suspense } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import { parsePublicBootstrap } from './bootstrap.ts';
import { SiteContentProvider } from './content.tsx';
import AppErrorBoundary from './components/AppErrorBoundary.tsx';
import './index.css';

const isAdmin = window.location.pathname.startsWith('/admin');
const AdminApp = lazy(() => import('./AdminApp.tsx'));

if (isAdmin) {
  document.title = '内容管理 | Beta-Demo777';
  document.querySelector<HTMLMetaElement>('meta[name="robots"]')?.setAttribute('content', 'noindex, nofollow');
  document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.remove();
}

const loadingScreen = (
  <div role="status" aria-live="polite" className="grid min-h-screen place-items-center bg-[#07080c] text-xs text-zinc-500">
    <span className="flex items-center gap-2"><span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />正在加载站点…</span>
  </div>
);

const root = document.getElementById('root')!;
const bootstrap = isAdmin ? null : parsePublicBootstrap(document);
const application = (
  <StrictMode>
    <AppErrorBoundary>
      {isAdmin ? (
        <Suspense fallback={loadingScreen}><AdminApp /></Suspense>
      ) : (
        <BrowserRouter>
          <SiteContentProvider
            initialContent={bootstrap?.content}
            initialStatus={bootstrap?.status}
          >
            <App renderYear={bootstrap?.renderYear} />
          </SiteContentProvider>
        </BrowserRouter>
      )}
    </AppErrorBoundary>
  </StrictMode>
);

if (!isAdmin && root.hasChildNodes() && bootstrap) {
  hydrateRoot(root, application);
} else {
  createRoot(root).render(application);
}
