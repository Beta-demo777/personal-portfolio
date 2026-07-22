import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FileImage,
  Image,
  ImagePlus,
  LoaderCircle,
  Search,
  Upload,
  X,
} from 'lucide-react';
import { useModalA11y } from './useModalA11y';

export interface MediaItem {
  id?: string;
  filename: string;
  url: string;
  thumbnailUrl?: string;
  contentType?: string;
  sizeBytes?: number;
  uploadedAt?: string;
  altText?: string;
}

export interface MediaPickerSelection {
  item: MediaItem;
  altText: string;
}

export type MediaPickerAction = 'insert' | 'cover';

export interface MediaPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: MediaItem[];
  onInsertAtCursor: (selection: MediaPickerSelection) => void | Promise<void>;
  onSetAsCover: (selection: MediaPickerSelection) => void | Promise<void>;
  onUpload?: (file: File) => void | MediaItem | Promise<void | MediaItem>;
  onError?: (error: unknown, action: MediaPickerAction | 'upload') => void;
  loading?: boolean;
  loadError?: string;
  stale?: boolean;
  onRetry?: () => void | Promise<void>;
  uploading?: boolean;
  initialSelectedUrl?: string;
  title?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  closeAfterAction?: boolean;
  acceptedFileTypes?: string;
}

const defaultAcceptedFileTypes = 'image/jpeg,image/png,image/webp,image/gif';

function getItemKey(item: MediaItem) {
  return item.id ?? item.url;
}

function formatBytes(value?: number) {
  if (value === undefined) return null;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function getMediaMeta(item: MediaItem) {
  return [
    item.contentType?.replace(/^image\//, '').toUpperCase(),
    formatBytes(item.sizeBytes),
  ].filter(Boolean).join(' \u00b7 ');
}

export function MediaPickerDialog({
  open,
  onOpenChange,
  items,
  onInsertAtCursor,
  onSetAsCover,
  onUpload,
  onError,
  loading = false,
  loadError,
  stale = false,
  onRetry,
  uploading = false,
  initialSelectedUrl,
  title = '选择媒体',
  searchPlaceholder = '搜索文件名或替代文本…',
  emptyText = '暂无可用图片',
  closeAfterAction = true,
  acceptedFileTypes = defaultAcceptedFileTypes,
}: MediaPickerDialogProps) {
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [altText, setAltText] = useState('');
  const [internalUploading, setInternalUploading] = useState(false);
  const [pendingAction, setPendingAction] = useState<MediaPickerAction | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const galleryId = useId();
  const isUploading = uploading || internalUploading;
  const isBusy = isUploading || pendingAction !== null;

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return items;

    return items.filter((item) => [
      item.filename,
      item.altText,
      item.contentType,
    ].filter(Boolean).join(' ').toLocaleLowerCase().includes(normalizedQuery));
  }, [items, query]);

  const selectedItem = useMemo(
    () => items.find((item) => getItemKey(item) === selectedKey) ?? null,
    [items, selectedKey],
  );

  useEffect(() => {
    if (!open) return;

    const initialItem = initialSelectedUrl
      ? items.find((item) => item.url === initialSelectedUrl)
      : undefined;
    setQuery('');
    setSelectedKey(initialItem ? getItemKey(initialItem) : null);
    setAltText(initialItem?.altText ?? '');
    setErrorMessage('');
    setPendingAction(null);
  }, [open]);

  useEffect(() => {
    if (!open || selectedKey || !initialSelectedUrl) return;

    const initialItem = items.find((item) => item.url === initialSelectedUrl);
    if (!initialItem) return;
    setSelectedKey(getItemKey(initialItem));
    setAltText(initialItem.altText ?? '');
  }, [initialSelectedUrl, items, open, selectedKey]);

  const requestClose = () => {
    if (!isBusy) onOpenChange(false);
  };

  useModalA11y({
    active: open,
    containerRef: dialogRef,
    initialFocusRef: searchInputRef,
    onClose: requestClose,
    closeOnEscape: !isBusy,
  });

  const selectItem = (item: MediaItem) => {
    setSelectedKey(getItemKey(item));
    setAltText(item.altText ?? '');
    setErrorMessage('');
  };

  const handleUpload = async (file?: File) => {
    if (!file || !onUpload || isUploading) return;

    setInternalUploading(true);
    setErrorMessage('');
    try {
      const uploadedItem = await onUpload(file);
      if (uploadedItem) selectItem(uploadedItem);
    } catch (error) {
      setErrorMessage('上传失败，请重试。');
      onError?.(error, 'upload');
    } finally {
      setInternalUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const runAction = async (action: MediaPickerAction) => {
    if (!selectedItem || isBusy) return;

    setPendingAction(action);
    setErrorMessage('');
    try {
      const selection = { item: selectedItem, altText: altText.trim() };
      if (action === 'insert') await onInsertAtCursor(selection);
      else await onSetAsCover(selection);
      if (closeAfterAction) onOpenChange(false);
    } catch (error) {
      setErrorMessage('操作失败，请重试。');
      onError?.(error, action);
    } finally {
      setPendingAction(null);
    }
  };

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[108] grid place-items-center bg-black/80 sm:p-4 sm:backdrop-blur-md"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={isBusy}
        tabIndex={-1}
        className="flex h-[100dvh] w-full max-w-6xl flex-col overflow-hidden border-white/10 bg-[#0d1017] shadow-[0_30px_100px_-30px_rgba(0,0,0,0.95)] outline-none sm:h-[min(840px,calc(100dvh-2rem))] sm:rounded-lg sm:border"
      >
        <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-white/[0.08] bg-[#10131b] px-4 sm:px-5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-indigo-400/15 bg-indigo-400/[0.08] text-indigo-200">
            <FileImage size={17} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-sm font-semibold text-white">{title}</h2>
            <p className="mt-0.5 text-xs text-zinc-500">媒体库 <span className="text-zinc-700">/</span> {items.length} 张图片</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={isBusy}
            aria-label="关闭媒体选择器"
            title="关闭"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-white/[0.08] text-zinc-500 transition hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_320px] lg:overflow-hidden">
          <section className="flex min-h-[55dvh] min-w-0 flex-col lg:min-h-0" aria-labelledby={galleryId}>
            <h3 id={galleryId} className="sr-only">媒体图片</h3>
            <div className="flex shrink-0 flex-col gap-2 border-b border-white/[0.07] p-3 sm:flex-row sm:p-4">
              <label className="relative min-w-0 flex-1">
                <span className="sr-only">搜索媒体</span>
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  type="search"
                  autoComplete="off"
                  placeholder={searchPlaceholder}
                  className="h-11 w-full rounded-lg border border-white/[0.08] bg-[#090b11] pl-9 pr-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 hover:border-white/[0.14] focus:border-indigo-400/60 focus:ring-4 focus:ring-indigo-500/10"
                />
              </label>
              {onUpload && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={acceptedFileTypes}
                    className="hidden"
                    disabled={isUploading}
                    onChange={(event) => void handleUpload(event.currentTarget.files?.[0])}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                    className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-white/[0.09] bg-white/[0.035] px-4 text-sm font-medium text-zinc-300 transition hover:border-indigo-400/25 hover:bg-indigo-400/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-500/10 disabled:cursor-wait disabled:opacity-50"
                  >
                    {isUploading ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <Upload size={15} aria-hidden="true" />}
                    {isUploading ? '上传中…' : '上传图片'}
                  </button>
                </>
              )}
            </div>

            <div className="min-h-0 flex-1 p-3 sm:p-4 lg:overflow-y-auto">
              {stale && (
                <div role="status" className={`mb-3 flex min-h-11 items-center gap-2 border px-3 text-xs ${loadError ? 'border-amber-400/15 bg-amber-400/[0.05] text-amber-200' : 'border-sky-400/15 bg-sky-400/[0.05] text-sky-200'}`}>
                  <LoaderCircle size={14} className={loadError ? '' : 'animate-spin'} aria-hidden="true" />
                  <span className="min-w-0 flex-1">{loadError ? '媒体刷新失败，当前显示上次结果。' : '正在刷新媒体，当前显示上次结果。'}</span>
                  {loadError && onRetry && <button type="button" onClick={() => { void onRetry(); }} className="min-h-9 shrink-0 px-2 font-medium">重试</button>}
                </div>
              )}
              {loadError && !stale ? (
                <div className="grid min-h-72 place-items-center border border-rose-400/15 bg-rose-400/[0.035] px-5 text-center">
                  <div>
                    <p role="alert" className="text-sm font-medium text-rose-100">{loadError}</p>
                    {onRetry && <button type="button" onClick={() => { void onRetry(); }} className="mt-4 min-h-11 rounded-lg border border-rose-300/20 px-4 text-xs text-rose-100 hover:bg-rose-300/[0.07]">重新加载媒体</button>}
                  </div>
                </div>
              ) : loading ? (
                <div className="grid min-h-72 place-items-center" aria-live="polite">
                  <span className="flex items-center gap-2 text-sm text-zinc-500">
                    <LoaderCircle size={17} className="animate-spin text-indigo-300" aria-hidden="true" />
                    正在读取媒体…
                  </span>
                </div>
              ) : filteredItems.length === 0 ? (
                <div className="grid min-h-72 place-items-center rounded-lg border border-dashed border-white/[0.09] px-5 text-center">
                  <div>
                    <span className="mx-auto grid h-11 w-11 place-items-center rounded-lg border border-white/[0.07] bg-white/[0.025] text-zinc-600">
                      {query ? <Search size={18} aria-hidden="true" /> : <Image size={18} aria-hidden="true" />}
                    </span>
                    <p className="mt-3 text-sm text-zinc-500">{query ? '没有找到匹配的图片' : emptyText}</p>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4" role="listbox" aria-label="可用图片">
                  {filteredItems.map((item) => {
                    const itemKey = getItemKey(item);
                    const selected = itemKey === selectedKey;
                    const mediaMeta = getMediaMeta(item);

                    return (
                      <button
                        key={itemKey}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => selectItem(item)}
                        className={`group min-w-0 overflow-hidden rounded-lg border text-left outline-none transition ${
                          selected
                            ? 'border-indigo-400/60 bg-indigo-400/[0.08] ring-2 ring-indigo-400/15'
                            : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14] hover:bg-white/[0.035]'
                        } focus-visible:ring-4 focus-visible:ring-indigo-500/15`}
                      >
                        <span className="relative block aspect-[4/3] overflow-hidden bg-[#080a0f]">
                          <img
                            src={item.thumbnailUrl ?? item.url}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
                          />
                          {selected && (
                            <span className="absolute inset-0 border-2 border-indigo-300/70" aria-hidden="true" />
                          )}
                        </span>
                        <span className="block px-2.5 py-2.5">
                          <span className="block truncate text-xs font-medium text-zinc-200" title={item.filename}>{item.filename}</span>
                          {mediaMeta && <span className="mt-1 block truncate text-xs text-zinc-500">{mediaMeta}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <aside className="flex min-h-[340px] flex-col border-t border-white/[0.08] bg-[#0a0c12] lg:min-h-0 lg:border-l lg:border-t-0">
            {selectedItem ? (
              <>
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-5">
                  <div className="aspect-[16/10] overflow-hidden rounded-lg border border-white/[0.08] bg-black/25">
                    <img src={selectedItem.url} alt="" className="h-full w-full object-contain" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-100" title={selectedItem.filename}>{selectedItem.filename}</p>
                    {getMediaMeta(selectedItem) && <p className="mt-1 text-xs text-zinc-600">{getMediaMeta(selectedItem)}</p>}
                  </div>
                  <label className="block space-y-2">
                    <span className="text-xs font-medium text-zinc-400">替代文本 <span className="font-normal text-zinc-600">(Alt)</span></span>
                    <textarea
                      value={altText}
                      onChange={(event) => setAltText(event.target.value)}
                      rows={3}
                      placeholder="描述图片中的内容"
                      className="w-full resize-none rounded-lg border border-white/[0.08] bg-[#090b11] px-3 py-2.5 text-sm leading-5 text-zinc-100 outline-none transition placeholder:text-zinc-600 hover:border-white/[0.14] focus:border-indigo-400/60 focus:ring-4 focus:ring-indigo-500/10"
                    />
                  </label>
                  {errorMessage && <p role="alert" className="text-xs text-rose-300">{errorMessage}</p>}
                </div>

                <div className="grid shrink-0 gap-2 border-t border-white/[0.08] p-4 sm:p-5">
                  <button
                    type="button"
                    onClick={() => void runAction('insert')}
                    disabled={isBusy}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-500 px-4 text-sm font-semibold text-white shadow-lg shadow-indigo-950/30 transition hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-400/25 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {pendingAction === 'insert' ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <ImagePlus size={16} aria-hidden="true" />}
                    插入光标处
                  </button>
                  <button
                    type="button"
                    onClick={() => void runAction('cover')}
                    disabled={isBusy}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/[0.1] bg-white/[0.035] px-4 text-sm font-medium text-zinc-200 transition hover:border-white/[0.18] hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/[0.07] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {pendingAction === 'cover' ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Image size={16} aria-hidden="true" />}
                    设为文章封面
                  </button>
                </div>
              </>
            ) : (
              <div className="grid flex-1 place-items-center px-6 text-center">
                <div>
                  <span className="mx-auto grid h-11 w-11 place-items-center rounded-lg border border-white/[0.07] bg-white/[0.025] text-zinc-600">
                    <ImagePlus size={18} aria-hidden="true" />
                  </span>
                  <p className="mt-3 text-sm text-zinc-500">选择一张图片</p>
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
}
