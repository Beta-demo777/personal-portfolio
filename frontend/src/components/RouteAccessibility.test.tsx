import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import RouteAccessibility from './RouteAccessibility';

describe('RouteAccessibility', () => {
  it('does not steal focus on an ordinary first render and focuses the new route heading', async () => {
    const { rerender } = render(
      <>
        <RouteAccessibility routeKey="/blog" headingText="博客" hash="" />
        <main id="main-content" tabIndex={-1}><h1>博客</h1></main>
      </>,
    );
    expect(document.querySelector('h1')).not.toHaveFocus();

    rerender(
      <>
        <RouteAccessibility routeKey="/blog/article" headingText="文章标题" hash="" />
        <main id="main-content" tabIndex={-1}><h1>文章标题</h1></main>
      </>,
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: '文章标题' })).toHaveFocus());
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已进入：文章标题'));
  });

  it('honors a hash target on the initial route', async () => {
    render(
      <>
        <RouteAccessibility routeKey="/about#contact" headingText="关于" hash="#contact" />
        <main id="main-content" tabIndex={-1}>
          <h1>关于</h1>
          <section id="contact">联系</section>
        </main>
      </>,
    );

    await waitFor(() => expect(document.getElementById('contact')).toHaveFocus());
    expect(document.getElementById('contact')).toHaveAttribute('tabindex', '-1');
  });

  it('leaves route focus to an open modal', async () => {
    const { rerender } = render(
      <>
        <RouteAccessibility routeKey="/portfolio" headingText="作品集" hash="" />
        <main id="main-content" tabIndex={-1}><h1>作品集</h1><button>原焦点</button></main>
      </>,
    );
    const original = screen.getByRole('button', { name: '原焦点' });
    original.focus();

    rerender(
      <>
        <RouteAccessibility routeKey="/portfolio/project" headingText="项目" hash="" />
        <main id="main-content" tabIndex={-1}>
          <h1>作品集</h1>
          <button>原焦点</button>
          <div role="dialog" aria-modal="true" aria-label="项目"><button>关闭</button></div>
        </main>
      </>,
    );

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已进入：项目'));
    expect(screen.getByRole('heading', { name: '作品集' })).not.toHaveFocus();
  });
});
