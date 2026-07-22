import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ExternalLink,
  LoaderCircle,
  Monitor,
  RefreshCw,
  Smartphone,
  Tablet,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useModalA11y } from './useModalA11y';

export type PreviewViewport = 'desktop' | 'tablet' | 'mobile';
export type PreviewPresentation = 'modal' | 'panel';
type PreviewZoom = 'fit' | 'actual';

export interface ResponsivePreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  title?: string;
  iframeTitle?: string;
  initialViewport?: PreviewViewport;
  presentation?: PreviewPresentation;
  showOpenExternal?: boolean;
  sandbox?: string;
  previewContent?: unknown;
  onIframeLoad?: () => void;
  className?: string;
}

interface ViewportDefinition {
  id: PreviewViewport;
  label: string;
  width: number;
  height: number;
  icon: LucideIcon;
}

export const previewViewports: ViewportDefinition[] = [
  { id: 'desktop', label: '桌面', width: 1440, height: 900, icon: Monitor },
  { id: 'tablet', label: '平板', width: 768, height: 1024, icon: Tablet },
  { id: 'mobile', label: '手机', width: 390, height: 844, icon: Smartphone },
];

export function ResponsivePreview({
  open,
  onOpenChange,
  url,
  title = '实时站点预览',
  iframeTitle,
  initialViewport = 'desktop',
  presentation = 'modal',
  showOpenExternal = true,
  sandbox,
  previewContent,
  onIframeLoad,
  className = '',
}: ResponsivePreviewProps) {
  const [viewport, setViewport] = useState<PreviewViewport>(initialViewport);
  const [zoom, setZoom] = useState<PreviewZoom>('fit');
  const [frameKey, setFrameKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [previewAreaSize, setPreviewAreaSize] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const previewAreaRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const titleId = useId();
  const currentViewport = previewViewports.find((item) => item.id === viewport) ?? previewViewports[0];
  const isModal = presentation === 'modal';

  useEffect(() => {
    if (open) setLoading(true);
  }, [open, url, frameKey]);

  useEffect(() => {
    if (!open || !previewContent || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(
      { type: 'portfolio-content-preview', payload: previewContent },
      window.location.origin,
    );
  }, [frameKey, open, previewContent, url]);

  useEffect(() => {
    if (!open || !previewAreaRef.current) return;

    const previewArea = previewAreaRef.current;
    const updatePreviewAreaSize = () => {
      const styles = window.getComputedStyle(previewArea);
      const horizontalPadding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
      const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
      setPreviewAreaSize({
        width: Math.max(0, previewArea.clientWidth - horizontalPadding),
        height: Math.max(0, previewArea.clientHeight - verticalPadding),
      });
    };

    updatePreviewAreaSize();
    const resizeObserver = new ResizeObserver(updatePreviewAreaSize);
    resizeObserver.observe(previewArea);
    return () => resizeObserver.disconnect();
  }, [open]);

  useModalA11y({
    active: open && isModal,
    containerRef,
    initialFocusRef: closeButtonRef,
    onClose: () => onOpenChange(false),
  });

  if (!open || typeof document === 'undefined') return null;

  const fitScale = previewAreaSize.width > 0 && previewAreaSize.height > 0
    ? Math.min(
        1,
        previewAreaSize.width / currentViewport.width,
        previewAreaSize.height / currentViewport.height,
      )
    : 1;
  const previewScale = zoom === 'fit' ? fitScale : 1;

  const content = (
    <div
      ref={containerRef}
      role={isModal ? 'dialog' : 'region'}
      aria-modal={isModal ? true : undefined}
      aria-labelledby={titleId}
      tabIndex={-1}
      className={`flex min-h-0 w-full flex-col overflow-hidden rounded-lg border border-white/10 bg-[#0a0c12] shadow-xl shadow-black/50 outline-none ${
        isModal ? 'h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)]' : 'h-[760px]'
      } ${className}`}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/[0.08] bg-[#10131b]/95 px-3 py-3 sm:px-4">
        <div className="mr-auto min-w-0">
          <h2 id={titleId} className="truncate text-sm font-semibold text-white">{title}</h2>
          <p className="mt-0.5 truncate text-xs text-zinc-500">{url || '尚未设置预览地址'}</p>
        </div>

        <div className="order-3 flex w-full items-center rounded-lg border border-white/[0.08] bg-black/20 p-1 sm:order-none sm:w-auto" role="group" aria-label="预览屏幕尺寸">
          {previewViewports.map((item) => {
            const Icon = item.icon;
            const selected = item.id === viewport;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setViewport(item.id)}
                className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition sm:flex-none ${
                  selected ? 'bg-indigo-500/15 text-indigo-200 shadow-sm ring-1 ring-inset ring-indigo-400/20' : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300'
                }`}
              >
                <Icon size={14} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        <span className="hidden text-xs tabular-nums text-zinc-500 lg:inline">
          {currentViewport.width} × {currentViewport.height}
        </span>
        <div
          className="order-4 flex w-full items-center rounded-lg border border-white/[0.08] bg-black/20 p-1 sm:order-none sm:w-auto"
          role="group"
          aria-label="预览缩放"
        >
          <button
            type="button"
            aria-pressed={zoom === 'fit'}
            onClick={() => setZoom('fit')}
            className={`flex min-h-11 flex-1 items-center justify-center rounded-md px-3 py-2 text-xs font-medium transition sm:flex-none ${
              zoom === 'fit'
                ? 'bg-indigo-500/15 text-indigo-200 shadow-sm ring-1 ring-inset ring-indigo-400/20'
                : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300'
            }`}
          >
            适应窗口
          </button>
          <button
            type="button"
            aria-pressed={zoom === 'actual'}
            onClick={() => setZoom('actual')}
            className={`flex min-h-11 flex-1 items-center justify-center rounded-md px-3 py-2 text-xs font-medium transition sm:flex-none ${
              zoom === 'actual'
                ? 'bg-indigo-500/15 text-indigo-200 shadow-sm ring-1 ring-inset ring-indigo-400/20'
                : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300'
            }`}
          >
            100%
          </button>
        </div>
        <button
          type="button"
          onClick={() => setFrameKey((key) => key + 1)}
          disabled={!url}
          aria-label="刷新预览"
          title="刷新预览"
          className="grid h-11 w-11 place-items-center rounded-lg border border-white/[0.08] text-zinc-400 transition hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-500/10 disabled:opacity-30"
        >
          <RefreshCw size={15} aria-hidden="true" />
        </button>
        {showOpenExternal && url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label="打开已发布站点"
            title="打开已发布站点"
            className="grid h-11 w-11 place-items-center rounded-lg border border-white/[0.08] text-zinc-400 transition hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-500/10"
          >
            <ExternalLink size={15} aria-hidden="true" />
          </a>
        )}
        <button
          ref={closeButtonRef}
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="关闭预览"
          className="grid h-11 w-11 place-items-center rounded-lg border border-white/[0.08] text-zinc-400 transition hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-500/10"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <div ref={previewAreaRef} className="relative min-h-0 flex-1 overflow-auto bg-[#07080c] p-3 sm:p-5">
        <div
          className="relative mx-auto"
          style={{
            width: `${currentViewport.width * previewScale}px`,
            height: `${currentViewport.height * previewScale}px`,
          }}
        >
          <div
            className="relative origin-top-left overflow-hidden rounded-lg border border-white/[0.09] bg-white shadow-lg shadow-black/30 transition-transform duration-300"
            style={{
              width: `${currentViewport.width}px`,
              height: `${currentViewport.height}px`,
              transform: `scale(${previewScale})`,
            }}
          >
            {loading && url && (
              <div className="absolute inset-0 z-10 grid place-items-center bg-[#0d1017] text-zinc-500" aria-live="polite">
                <span className="flex items-center gap-2 text-xs">
                  <LoaderCircle size={16} className="animate-spin text-indigo-300" aria-hidden="true" />
                  正在加载预览…
                </span>
              </div>
            )}
            {url ? (
              <iframe
                ref={iframeRef}
                key={`${url}-${frameKey}`}
                src={url}
                title={iframeTitle ?? `${title}－${currentViewport.label}视图`}
                sandbox={sandbox}
                referrerPolicy="strict-origin-when-cross-origin"
                onLoad={() => {
                  setLoading(false);
                  if (previewContent && iframeRef.current?.contentWindow) {
                    iframeRef.current.contentWindow.postMessage(
                      { type: 'portfolio-content-preview', payload: previewContent },
                      window.location.origin,
                    );
                  }
                  onIframeLoad?.();
                }}
                className="h-full w-full border-0 bg-white"
              />
            ) : (
              <div className="grid h-full place-items-center bg-[#0d1017] px-6 text-center text-sm text-zinc-500">
                请先配置可访问的站点预览地址
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  if (!isModal) return content;

  return createPortal(
    <div
      className="fixed inset-0 z-[105] grid place-items-center bg-black/80 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      {content}
    </div>,
    document.body,
  );
}
