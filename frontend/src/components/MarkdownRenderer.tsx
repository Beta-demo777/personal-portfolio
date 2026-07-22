import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function safeUrl(url: string) {
  const normalized = url.trim().toLocaleLowerCase();
  if (
    normalized.startsWith('https://')
    || normalized.startsWith('http://')
    || normalized.startsWith('mailto:')
    || normalized.startsWith('/')
    || normalized.startsWith('./')
    || normalized.startsWith('../')
    || normalized.startsWith('#')
  ) return url;
  return '';
}

export default function MarkdownRenderer({ content, className = '' }: { content: string; className?: string }) {
  return (
    <div className={`space-y-4 text-sm leading-7 text-zinc-300 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
          h1: ({ children }) => <h1 className="mt-8 text-3xl font-bold tracking-tight text-white first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-8 border-b border-white/[0.07] pb-2 text-2xl font-bold tracking-tight text-white">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-7 text-xl font-semibold text-white">{children}</h3>,
          p: ({ children }) => <p className="whitespace-pre-wrap text-zinc-300">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
          em: ({ children }) => <em className="text-zinc-200">{children}</em>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-300 underline decoration-indigo-400/35 underline-offset-4 transition hover:text-indigo-200">{children}</a>,
          ul: ({ children }) => <ul className="list-disc space-y-1.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1.5 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-1 text-zinc-300 marker:text-indigo-400">{children}</li>,
          blockquote: ({ children }) => <blockquote className="border-l-2 border-indigo-400/50 bg-indigo-400/[0.04] px-4 py-3 text-zinc-400">{children}</blockquote>,
          pre: ({ children }) => <pre className="overflow-x-auto rounded-xl border border-white/[0.07] bg-black/45 p-4 text-xs leading-6 text-zinc-300">{children}</pre>,
          code: ({ className: codeClassName, children }) => codeClassName
            ? <code className={`${codeClassName} font-mono`}>{children}</code>
            : <code className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.9em] text-indigo-200">{children}</code>,
          hr: () => <hr className="my-8 border-white/[0.08]" />,
          img: ({ src, alt }) => <img src={src} alt={alt || ''} loading="lazy" decoding="async" className="max-h-[560px] w-full rounded-2xl bg-black/30 object-contain" />,
          table: ({ children }) => <div className="overflow-x-auto rounded-xl border border-white/[0.08]"><table className="w-full border-collapse text-left text-xs">{children}</table></div>,
          thead: ({ children }) => <thead className="bg-white/[0.05] text-zinc-200">{children}</thead>,
          th: ({ children }) => <th className="border-b border-white/[0.08] px-3 py-2.5 font-medium">{children}</th>,
          td: ({ children }) => <td className="border-b border-white/[0.05] px-3 py-2.5 text-zinc-400">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
