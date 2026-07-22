import { describe, expect, it } from 'vitest';
import {
  beginResourceLoad,
  completeResourceLoad,
  failResourceLoad,
  type ResourceState,
} from './AdminFeedback';

describe('admin resource state transitions', () => {
  it('uses a blocking loading state until the first result is available', () => {
    expect(beginResourceLoad({ status: 'idle' })).toEqual({ status: 'loading' });
    expect(completeResourceLoad(0)).toEqual({ status: 'empty' });
    expect(completeResourceLoad(2)).toEqual({ status: 'ready' });
  });

  it('keeps prior results visible as stale while refreshing or after a refresh failure', () => {
    const refreshing = beginResourceLoad({ status: 'ready' });
    expect(refreshing).toEqual({ status: 'stale' });
    expect(failResourceLoad(refreshing, '刷新失败')).toEqual({ status: 'stale', error: '刷新失败' });
  });

  it('uses an inline error when no prior result can be shown', () => {
    const loading: ResourceState = { status: 'loading' };
    expect(failResourceLoad(loading, '读取失败')).toEqual({ status: 'error', error: '读取失败' });
  });
});
