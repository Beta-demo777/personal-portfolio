import { useEffect, useRef, useState } from 'react';

function normalizedText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function decodedHashTarget(hash: string): string | null {
  if (!hash.startsWith('#') || hash.length === 1) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return hash.slice(1);
  }
}

function focusElement(element: HTMLElement): void {
  if (!element.matches('a[href], button, input, select, textarea, [tabindex]')) {
    element.tabIndex = -1;
  }
  element.focus({ preventScroll: false });
}

export default function RouteAccessibility({
  routeKey,
  headingText,
  hash,
}: {
  routeKey: string;
  headingText: string;
  hash: string;
}) {
  const previousRouteKey = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    const firstRender = previousRouteKey.current === null;
    if (!firstRender && previousRouteKey.current === routeKey) return;
    previousRouteKey.current = routeKey;

    const hashTarget = decodedHashTarget(hash);
    if (firstRender && !hashTarget) return;

    let disposed = false;
    let fallbackTimer: number | undefined;
    let announceTimer: number | undefined;
    const main = document.getElementById('main-content');
    if (!(main instanceof HTMLElement)) return;

    if (!firstRender) {
      setAnnouncement('');
      announceTimer = window.setTimeout(() => {
        if (!disposed) setAnnouncement(`已进入：${headingText}`);
      }, 0);
    }

    const tryFocus = (): boolean => {
      if (disposed) return true;
      if (hashTarget) {
        const target = document.getElementById(hashTarget);
        if (target instanceof HTMLElement) {
          focusElement(target);
          return true;
        }
        return false;
      }

      // Project details own their focus trap. Route focus must not move focus
      // back to the page underneath an open modal.
      if (main.querySelector('[role="dialog"][aria-modal="true"]')) return true;

      const expected = normalizedText(headingText);
      const heading = Array.from(main.querySelectorAll<HTMLElement>('h1'))
        .find((candidate) => {
          const candidateText = normalizedText(candidate.textContent);
          return candidateText === expected
            || candidateText.replace(/\s/g, '') === expected.replace(/\s/g, '');
        });
      if (!heading) return false;
      focusElement(heading);
      return true;
    };

    if (tryFocus()) {
      return () => {
        disposed = true;
        if (announceTimer !== undefined) window.clearTimeout(announceTimer);
      };
    }

    const observer = new MutationObserver(() => {
      if (tryFocus()) {
        observer.disconnect();
        if (fallbackTimer !== undefined) {
          window.clearTimeout(fallbackTimer);
          fallbackTimer = undefined;
        }
      }
    });
    observer.observe(main, { childList: true, subtree: true });
    fallbackTimer = window.setTimeout(() => {
      observer.disconnect();
      if (!disposed && !hashTarget && !main.querySelector('[role="dialog"][aria-modal="true"]')) {
        focusElement(main);
      }
    }, 1_500);

    return () => {
      disposed = true;
      observer.disconnect();
      if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
      if (announceTimer !== undefined) window.clearTimeout(announceTimer);
    };
  }, [hash, headingText, routeKey]);

  return (
    <span
      id="public-route-announcer"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {announcement}
    </span>
  );
}
