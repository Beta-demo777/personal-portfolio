import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

interface RouteNotFoundProps {
  resource?: '页面' | '文章' | '项目';
}

export default function RouteNotFound({ resource = '页面' }: RouteNotFoundProps) {
  const destination = resource === '文章' ? '/blog' : resource === '项目' ? '/portfolio' : '/';
  return (
    <section className="mx-auto grid min-h-[calc(100svh-12rem)] max-w-2xl place-items-center px-5 py-16 text-center">
      <div>
        <p className="font-mono text-xs uppercase tracking-widest text-indigo-300">404 / Not Found</p>
        <h1 className="mt-4 text-3xl font-semibold text-white">没有找到这个{resource}</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-500">地址可能已经变更，或者内容尚未发布。</p>
        <Link
          to={destination}
          className="mx-auto mt-7 inline-flex min-h-11 items-center gap-2 rounded-lg border border-white/[0.09] bg-white/[0.04] px-4 text-sm text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
        >
          <ArrowLeft size={15} aria-hidden="true" />
          返回{resource === '页面' ? '首页' : `${resource}列表`}
        </Link>
      </div>
    </section>
  );
}
