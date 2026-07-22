import type { SiteContent, SiteContentStatus } from './content';
import { isSiteContent } from './contentValidation';

export const BOOTSTRAP_ELEMENT_ID = 'portfolio-bootstrap';

export interface PublicBootstrap {
  content: SiteContent;
  status: Exclude<SiteContentStatus, 'loading'>;
  renderYear: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePublicBootstrap(documentRoot: Document): PublicBootstrap | null {
  const element = documentRoot.getElementById(BOOTSTRAP_ELEMENT_ID);
  const serialized = element instanceof HTMLTemplateElement
    ? element.content.textContent
    : element?.textContent;
  if (!serialized?.trim()) return null;

  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || !isSiteContent(parsed.content)) return null;
    if (parsed.status !== 'ready' && parsed.status !== 'stale' && parsed.status !== 'unavailable') return null;
    if (!Number.isInteger(parsed.renderYear) || Number(parsed.renderYear) < 2000 || Number(parsed.renderYear) > 9999) {
      return null;
    }
    return parsed as unknown as PublicBootstrap;
  } catch {
    return null;
  }
}

export function serializePublicBootstrap(bootstrap: PublicBootstrap): string {
  return JSON.stringify(bootstrap)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
