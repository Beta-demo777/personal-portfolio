import { useEffect, useRef, type RefObject } from 'react';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface ModalA11yOptions {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  closeOnEscape?: boolean;
  lockBodyScroll?: boolean;
}

/** Shared focus management for the admin's custom modal surfaces. */
export function useModalA11y({
  active,
  containerRef,
  initialFocusRef,
  onClose,
  closeOnEscape = true,
  lockBodyScroll = true,
}: ModalA11yOptions) {
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active || typeof document === 'undefined') return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;

    if (lockBodyScroll) document.body.style.overflow = 'hidden';

    const focusFrame = window.requestAnimationFrame(() => {
      const fallback = containerRef.current?.querySelector<HTMLElement>(focusableSelector);
      (initialFocusRef?.current ?? fallback ?? containerRef.current)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeOnEscape) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab' || !containerRef.current) return;

      const queriedElements: HTMLElement[] = Array.from(
        containerRef.current.querySelectorAll<HTMLElement>(focusableSelector),
      );
      const focusableElements = queriedElements.filter(
        (element) => element.getAttribute('aria-hidden') !== 'true',
      );

      if (focusableElements.length === 0) {
        event.preventDefault();
        containerRef.current.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      if (lockBodyScroll) document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [active, closeOnEscape, containerRef, initialFocusRef, lockBodyScroll]);
}
