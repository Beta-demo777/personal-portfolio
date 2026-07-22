import { LoaderCircle, TriangleAlert } from 'lucide-react';
import type { SiteContentStatus } from '../content';

export default function RouteContentPending({
  resource,
  status,
}: {
  resource: '文章' | '项目';
  status: Exclude<SiteContentStatus, 'ready'>;
}) {
  const loading = status === 'loading';
  const Icon = loading ? LoaderCircle : TriangleAlert;
  return (
    <section
      role="status"
      aria-live="polite"
      className="mx-auto grid min-h-[calc(100svh-12rem)] max-w-2xl place-items-center px-5 py-16 text-center"
    >
      <div>
        <Icon
          aria-hidden="true"
          size={22}
          className={`mx-auto ${loading ? 'animate-spin text-indigo-300' : 'text-amber-300'}`}
        />
        <h1 className="mt-4 text-lg font-semibold text-white">
          {loading ? `正在读取${resource}` : `${resource}内容暂时无法读取`}
        </h1>
        {!loading && <p className="mt-2 text-sm text-zinc-500">请稍后重新加载页面。</p>}
      </div>
    </section>
  );
}
