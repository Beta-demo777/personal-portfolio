import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, LoaderCircle, ShieldAlert, X } from 'lucide-react';
import { useModalA11y } from './useModalA11y';

export type ConfirmDialogTone = 'danger' | 'warning' | 'primary';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirmError?: (error: unknown) => string | void;
}

const toneStyles: Record<ConfirmDialogTone, { icon: string; button: string }> = {
  danger: {
    icon: 'border-red-400/20 bg-red-500/10 text-red-300',
    button: 'bg-red-500 text-white hover:bg-red-400 focus-visible:ring-red-400/30',
  },
  warning: {
    icon: 'border-amber-400/20 bg-amber-500/10 text-amber-300',
    button: 'bg-amber-400 text-amber-950 hover:bg-amber-300 focus-visible:ring-amber-300/30',
  },
  primary: {
    icon: 'border-indigo-400/20 bg-indigo-500/10 text-indigo-300',
    button: 'bg-indigo-500 text-white hover:bg-indigo-400 focus-visible:ring-indigo-400/30',
  },
};

export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel = '确认删除',
  cancelLabel = '取消',
  tone = 'danger',
  busy = false,
  confirmDisabled = false,
  onConfirmError,
}: ConfirmDialogProps) {
  const [internalBusy, setInternalBusy] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const isBusy = busy || internalBusy;
  const styles = toneStyles[tone];
  const Icon = tone === 'danger' ? ShieldAlert : AlertTriangle;

  useEffect(() => {
    if (!open) setConfirmError('');
  }, [open]);

  const requestClose = () => {
    if (!isBusy) onOpenChange(false);
  };

  useModalA11y({
    active: open,
    containerRef: dialogRef,
    initialFocusRef: cancelButtonRef,
    onClose: requestClose,
    closeOnEscape: !isBusy,
  });

  const handleConfirm = async () => {
    if (isBusy || confirmDisabled) return;

    setConfirmError('');
    setInternalBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (error) {
      const handledMessage = onConfirmError?.(error);
      setConfirmError(typeof handledMessage === 'string'
        ? handledMessage
        : error instanceof Error ? error.message : '操作失败，请稍后重试');
    } finally {
      setInternalBusy(false);
    }
  };

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[110] grid place-items-center bg-black/75 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={[
          description ? descriptionId : '',
          confirmError ? errorId : '',
        ].filter(Boolean).join(' ') || undefined}
        aria-busy={isBusy}
        tabIndex={-1}
        className="relative w-full max-w-md overflow-hidden rounded-lg border border-white/10 bg-[#10131b]/98 p-5 shadow-xl shadow-black/50 outline-none sm:p-6"
      >
        <button
          type="button"
          onClick={requestClose}
          disabled={isBusy}
          aria-label="关闭对话框"
          className="absolute right-3 top-3 grid h-11 w-11 place-items-center rounded-lg text-zinc-500 transition hover:bg-white/[0.05] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/30 disabled:opacity-40"
        >
          <X size={16} aria-hidden="true" />
        </button>

        <span className={`relative grid h-11 w-11 place-items-center rounded-lg border ${styles.icon}`}>
          <Icon size={21} aria-hidden="true" />
        </span>
        <h2 id={titleId} className="relative mt-5 pr-8 text-lg font-semibold text-white">{title}</h2>
        {description && (
          <div id={descriptionId} className="relative mt-2 text-sm leading-6 text-zinc-400">
            {description}
          </div>
        )}
        {confirmError && (
          <p id={errorId} role="alert" className="relative mt-4 border-l-2 border-rose-400/60 pl-3 text-sm leading-6 text-rose-200">
            {confirmError}
          </p>
        )}

        <div className="relative mt-7 flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={requestClose}
            disabled={isBusy}
            className="min-h-11 rounded-lg border border-white/[0.09] bg-white/[0.035] px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-white/[0.15] hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={isBusy || confirmDisabled}
            className={`inline-flex min-h-11 min-w-28 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-4 disabled:cursor-not-allowed disabled:opacity-45 ${styles.button}`}
          >
            {isBusy && <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />}
            {isBusy ? '正在处理…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
