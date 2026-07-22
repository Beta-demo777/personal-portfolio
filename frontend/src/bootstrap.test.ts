import { describe, expect, it } from 'vitest';
import { injectDocument } from '../server/publicSite';
import { BOOTSTRAP_ELEMENT_ID, parsePublicBootstrap, serializePublicBootstrap } from './bootstrap';
import { DEFAULT_SITE_CONTENT } from './content';

describe('public SSR bootstrap', () => {
  it('escapes HTML-sensitive state and restores the serialized snapshot', () => {
    const content = {
      ...DEFAULT_SITE_CONTENT,
      siteSettings: {
        ...DEFAULT_SITE_CONTENT.siteSettings,
        siteTitle: '</template><script>alert(1)</script>&quot;&#34;&amp;>',
      },
    };
    const serialized = serializePublicBootstrap({ content, status: 'ready', renderYear: 2026 });
    expect(serialized).not.toContain('<');
    expect(serialized).not.toContain('>');
    expect(serialized).not.toContain('&');

    const renderedDocument = injectDocument(
      `<!doctype html><html><head>
<!--portfolio-default-head-start--><title>fallback</title><!--portfolio-default-head-end-->
</head><body><div id="root"><!--portfolio-app--></div><!--portfolio-bootstrap--></body></html>`,
      '<title>SSR title</title>',
      '<main>SSR application</main>',
      serialized,
    );
    const parsedDocument = new DOMParser().parseFromString(renderedDocument, 'text/html');
    expect(renderedDocument).toContain('\\u0026quot;');
    expect(renderedDocument).toContain('\\u003c/template\\u003e');
    expect(parsePublicBootstrap(parsedDocument)).toMatchObject({
      status: 'ready',
      renderYear: 2026,
      content: { siteSettings: { siteTitle: content.siteSettings.siteTitle } },
    });
  });

  it('rejects missing and malformed bootstrap state', () => {
    document.body.innerHTML = '';
    expect(parsePublicBootstrap(document)).toBeNull();
    document.body.innerHTML = `<template id="${BOOTSTRAP_ELEMENT_ID}">{invalid</template>`;
    expect(parsePublicBootstrap(document)).toBeNull();

    document.body.innerHTML = `<template id="${BOOTSTRAP_ELEMENT_ID}">${JSON.stringify({
      content: { blogPosts: {} },
      status: 'ready',
      renderYear: 2026,
    })}</template>`;
    expect(parsePublicBootstrap(document)).toBeNull();
  });
});
