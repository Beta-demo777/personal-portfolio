import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Command, CornerDownLeft, Search, type LucideIcon } from 'lucide-react';
import { useModalA11y } from './useModalA11y';

export interface CommandPaletteAction {
  id: string;
  label: string;
  description?: string;
  group?: string;
  keywords?: string[];
  shortcut?: string;
  icon?: LucideIcon;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: CommandPaletteAction[];
  title?: string;
  placeholder?: string;
  emptyText?: string;
  enableKeyboardShortcut?: boolean;
}

function firstEnabledIndex(actions: CommandPaletteAction[]) {
  return Math.max(0, actions.findIndex((action) => !action.disabled));
}

export function CommandPalette({
  open,
  onOpenChange,
  actions,
  title = '快捷操作',
  placeholder = '搜索页面或操作…',
  emptyText = '没有找到匹配的操作',
  enableKeyboardShortcut = true,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [shortcutLabel, setShortcutLabel] = useState('Ctrl K');
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const listboxId = useId();

  const filteredActions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return actions;

    return actions
      .map((action, order) => {
        const label = action.label.toLocaleLowerCase();
        const haystack = [
          action.label,
          action.description,
          action.group,
          ...(action.keywords ?? []),
        ].filter(Boolean).join(' ').toLocaleLowerCase();

        if (!haystack.includes(normalizedQuery)) return null;
        const rank = label === normalizedQuery ? 0 : label.startsWith(normalizedQuery) ? 1 : 2;
        return { action, order, rank };
      })
      .filter((result): result is NonNullable<typeof result> => result !== null)
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .map(({ action }) => action);
  }, [actions, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
  }, [open]);

  useEffect(() => {
    setActiveIndex(firstEnabledIndex(filteredActions));
  }, [filteredActions]);

  useEffect(() => {
    if (typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)) {
      setShortcutLabel('⌘ K');
    }
  }, []);

  useEffect(() => {
    if (!enableKeyboardShortcut || typeof document === 'undefined') return;

    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key.toLocaleLowerCase() !== 'k' || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      onOpenChange(!open);
    };

    document.addEventListener('keydown', handleShortcut);
    return () => document.removeEventListener('keydown', handleShortcut);
  }, [enableKeyboardShortcut, onOpenChange, open]);

  useModalA11y({
    active: open,
    containerRef: dialogRef,
    initialFocusRef: inputRef,
    onClose: () => onOpenChange(false),
  });

  const selectAction = (action: CommandPaletteAction) => {
    if (action.disabled) return;
    onOpenChange(false);
    void action.onSelect();
  };

  const moveSelection = (direction: 1 | -1) => {
    if (!filteredActions.some((action) => !action.disabled)) return;

    let nextIndex = activeIndex;
    do {
      nextIndex = (nextIndex + direction + filteredActions.length) % filteredActions.length;
    } while (filteredActions[nextIndex]?.disabled);
    setActiveIndex(nextIndex);
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(firstEnabledIndex(filteredActions));
    } else if (event.key === 'End') {
      event.preventDefault();
      const reversedIndex = [...filteredActions].reverse().findIndex((action) => !action.disabled);
      if (reversedIndex >= 0) setActiveIndex(filteredActions.length - 1 - reversedIndex);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const action = filteredActions[activeIndex];
      if (action) selectAction(action);
    }
  };

  const activeDescendantId = filteredActions[activeIndex]
    ? `${listboxId}-option-${activeIndex}`
    : undefined;

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/70 px-3 pt-[12vh] backdrop-blur-sm sm:px-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-white/10 bg-[#10131b]/98 shadow-xl shadow-black/50 outline-none"
      >
        <h2 id={titleId} className="sr-only">{title}</h2>
        <div className="flex items-center gap-3 border-b border-white/[0.08] px-4 sm:px-5">
          <Search size={19} className="shrink-0 text-indigo-300" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeDescendantId}
            aria-autocomplete="list"
            autoComplete="off"
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent py-5 text-sm text-white outline-none placeholder:text-zinc-600 sm:text-base"
          />
          <kbd className="hidden rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-xs font-medium text-zinc-400 sm:block">
            ESC
          </kbd>
        </div>

        <div id={listboxId} role="listbox" aria-label={title} className="max-h-[min(55vh,430px)] overflow-y-auto p-2">
          {filteredActions.length === 0 ? (
            <div className="grid min-h-40 place-items-center px-5 text-center">
              <div>
                <span className="mx-auto grid h-11 w-11 place-items-center rounded-lg border border-white/[0.07] bg-white/[0.03] text-zinc-500">
                  <Command size={19} aria-hidden="true" />
                </span>
                <p className="mt-3 text-sm text-zinc-500">{emptyText}</p>
              </div>
            </div>
          ) : filteredActions.map((action, index) => {
            const Icon = action.icon ?? Command;
            const showGroup = action.group && action.group !== filteredActions[index - 1]?.group;
            const isActive = index === activeIndex;

            return (
              <div key={action.id}>
                {showGroup && (
                  <p className="px-3 pb-1 pt-3 text-xs font-semibold text-zinc-500 first:pt-1">
                    {action.group}
                  </p>
                )}
                <button
                  id={`${listboxId}-option-${index}`}
                  role="option"
                  aria-selected={isActive}
                  disabled={action.disabled}
                  type="button"
                  tabIndex={-1}
                  onMouseEnter={() => !action.disabled && setActiveIndex(index)}
                  onClick={() => selectAction(action)}
                  className={`group flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none transition ${
                    isActive
                      ? 'bg-indigo-500/12 text-white ring-1 ring-inset ring-indigo-400/15'
                      : 'text-zinc-300 hover:bg-white/[0.04]'
                  } disabled:cursor-not-allowed disabled:opacity-35`}
                >
                  <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-md border transition ${
                    isActive
                      ? 'border-indigo-400/20 bg-indigo-400/10 text-indigo-200'
                      : 'border-white/[0.07] bg-white/[0.025] text-zinc-500 group-hover:text-zinc-300'
                  }`}>
                    <Icon size={17} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{action.label}</span>
                    {action.description && <span className="mt-0.5 block truncate text-xs text-zinc-500">{action.description}</span>}
                  </span>
                  {action.shortcut && (
                    <kbd className="shrink-0 rounded-md border border-white/[0.08] bg-black/20 px-2 py-1 text-xs text-zinc-400">
                      {action.shortcut}
                    </kbd>
                  )}
                  {isActive && <CornerDownLeft size={14} className="shrink-0 text-indigo-300/80" aria-hidden="true" />}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex min-h-11 items-center justify-between gap-3 border-t border-white/[0.07] bg-black/15 px-4 py-2.5 text-xs text-zinc-500 sm:px-5">
          <span>↑↓ 导航・↵ 执行・Esc 关闭</span>
          <span>{shortcutLabel} 打开</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
