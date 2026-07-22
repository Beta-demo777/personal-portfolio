import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('keeps a failed action open and exposes the handled error inside the alert dialog', async () => {
    const onOpenChange = vi.fn();
    const onConfirmError = vi.fn(() => '图片仍被站点内容引用，无法删除');

    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="删除这张图片？"
        confirmLabel="删除图片"
        onConfirm={async () => { throw new Error('raw failure'); }}
        onConfirmError={onConfirmError}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '删除图片' }));

    const dialog = screen.getByRole('alertdialog');
    await waitFor(() => expect(onConfirmError).toHaveBeenCalledOnce());
    expect(dialog).toContainElement(screen.getByRole('alert'));
    expect(screen.getByRole('alert')).toHaveTextContent('图片仍被站点内容引用，无法删除');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('closes after a successful action', async () => {
    const onOpenChange = vi.fn();

    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="确认操作？"
        confirmLabel="确认"
        onConfirm={async () => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
