import { expect, test, type Page } from '@playwright/test';
import {
  ADMIN_DRAFT_DATABASE_NAME,
  ADMIN_DRAFT_OBJECT_STORE_NAME,
  ADMIN_DRAFT_RECORD_KEY,
  LEGACY_ADMIN_DRAFT_STORAGE_KEY,
  type CurrentAdminDraft,
} from '../src/admin/draftStorage';
import { DEFAULT_SITE_CONTENT } from '../src/content';
import { mockAdminApi } from './support';

const DRAFT_DATABASE = {
  databaseName: ADMIN_DRAFT_DATABASE_NAME,
  objectStoreName: ADMIN_DRAFT_OBJECT_STORE_NAME,
  recordKey: ADMIN_DRAFT_RECORD_KEY,
};

async function writeDraftRecord(page: Page, value: unknown): Promise<void> {
  await page.goto('/healthz');
  await page.evaluate(async ({ database, record }) => new Promise<void>((resolve, reject) => {
    const openRequest = indexedDB.open(database.databaseName, 1);
    openRequest.onupgradeneeded = () => {
      if (!openRequest.result.objectStoreNames.contains(database.objectStoreName)) {
        openRequest.result.createObjectStore(database.objectStoreName);
      }
    };
    openRequest.onerror = () => reject(openRequest.error ?? new Error('Unable to open draft database'));
    openRequest.onsuccess = () => {
      const connection = openRequest.result;
      const transaction = connection.transaction(database.objectStoreName, 'readwrite');
      transaction.objectStore(database.objectStoreName).put(record, database.recordKey);
      transaction.oncomplete = () => {
        connection.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to write draft'));
    };
  }), { database: DRAFT_DATABASE, record: value });
}

async function readDraftRecord<T = unknown>(page: Page): Promise<T | null> {
  return page.evaluate(async (database) => new Promise<T | null>((resolve, reject) => {
    const openRequest = indexedDB.open(database.databaseName, 1);
    openRequest.onupgradeneeded = () => {
      if (!openRequest.result.objectStoreNames.contains(database.objectStoreName)) {
        openRequest.result.createObjectStore(database.objectStoreName);
      }
    };
    openRequest.onerror = () => reject(openRequest.error ?? new Error('Unable to open draft database'));
    openRequest.onsuccess = () => {
      const connection = openRequest.result;
      const transaction = connection.transaction(database.objectStoreName, 'readonly');
      const readRequest = transaction.objectStore(database.objectStoreName).get(database.recordKey);
      readRequest.onsuccess = () => {
        connection.close();
        resolve(readRequest.result === undefined ? null : readRequest.result as T);
      };
      readRequest.onerror = () => reject(readRequest.error ?? new Error('Unable to read draft'));
    };
  }), DRAFT_DATABASE);
}

async function writeLegacyDraft(page: Page, title: string): Promise<void> {
  const content = structuredClone(DEFAULT_SITE_CONTENT);
  content.siteSettings.siteTitle = title;
  await page.goto('/healthz');
  await page.evaluate(({ key, draftContent }) => {
    localStorage.setItem(key, JSON.stringify({
      content: draftContent,
      savedAt: '2026-07-17T09:00:00.000Z',
    }));
  }, { key: LEGACY_ADMIN_DRAFT_STORAGE_KEY, draftContent: content });
}

test('keeps a valid legacy safety copy when only the IndexedDB draft is corrupt', async ({ page }) => {
  const legacyTitle = '仍然有效的旧版本地备份';
  await writeLegacyDraft(page, legacyTitle);
  await writeDraftRecord(page, {
    kind: 'current',
    schemaVersion: 2,
    baseEtag: '"content-v1"',
    baseContent: DEFAULT_SITE_CONTENT,
    content: { siteSettings: { siteTitle: 42 } },
    savedAt: '2026-07-17T09:00:00.000Z',
  });
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' }],
  });

  await page.goto('/admin');

  await expect(page.getByText('本地草稿需要明确选择')).toBeVisible();
  await expect.poll(() => readDraftRecord(page)).toBeNull();
  const legacy = await page.evaluate((key) => localStorage.getItem(key), LEGACY_ADMIN_DRAFT_STORAGE_KEY);
  expect(legacy).not.toBeNull();
  expect(JSON.parse(legacy ?? '{}')).toMatchObject({
    content: { siteSettings: { siteTitle: legacyTitle } },
  });
});

test('fails closed when an invalid IndexedDB draft cannot be deleted', async ({ page }) => {
  const invalidDraft = {
    kind: 'current',
    schemaVersion: 2,
    baseEtag: '"content-v1"',
    baseContent: structuredClone(DEFAULT_SITE_CONTENT),
    content: { siteSettings: { siteTitle: '删除失败时必须保留的损坏草稿' } },
    savedAt: '2026-07-17T09:02:00.000Z',
  };
  await writeDraftRecord(page, invalidDraft);
  await page.addInitScript({
    content: `
      (() => {
        const originalTransaction = IDBDatabase.prototype.transaction;
        let draftWriteTransactions = 0;
        IDBDatabase.prototype.transaction = function (storeNames, mode, options) {
          const names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames);
          if (mode === 'readwrite' && names.includes('drafts')) {
            draftWriteTransactions += 1;
            if (draftWriteTransactions === 2) {
              throw new DOMException('Temporary draft delete failure', 'AbortError');
            }
          }
          return originalTransaction.call(this, storeNames, mode, options);
        };
      })();
    `,
  });
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' }],
  });

  await page.goto('/admin');

  await expect(page.getByRole('heading', { name: '工作台内容暂时无法载入' })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存全部更改' })).toHaveCount(0);
  expect(await readDraftRecord(page)).toEqual(invalidDraft);
});

test('removes an identical current draft without deleting an uninspected legacy safety copy', async ({ page }) => {
  const legacyTitle = '不能被 current 清理误删的旧版草稿';
  await writeLegacyDraft(page, legacyTitle);
  await writeDraftRecord(page, {
    kind: 'current',
    schemaVersion: 2,
    baseEtag: '"content-v1"',
    baseContent: structuredClone(DEFAULT_SITE_CONTENT),
    content: structuredClone(DEFAULT_SITE_CONTENT),
    savedAt: '2026-07-17T09:05:00.000Z',
  } satisfies CurrentAdminDraft);
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' }],
  });

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();
  await expect.poll(() => readDraftRecord(page)).toBeNull();
  expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_ADMIN_DRAFT_STORAGE_KEY))
    .not.toBeNull();

  await page.reload();
  await expect(page.getByText('本地草稿需要明确选择')).toBeVisible();
  const legacy = await page.evaluate((key) => localStorage.getItem(key), LEGACY_ADMIN_DRAFT_STORAGE_KEY);
  expect(JSON.parse(legacy ?? '{}')).toMatchObject({
    content: { siteSettings: { siteTitle: legacyTitle } },
  });
});

test('fails closed and preserves a future-version IndexedDB draft', async ({ page }) => {
  const futureDraft = {
    kind: 'current',
    schemaVersion: 3,
    baseEtag: '"future-content"',
    baseContent: DEFAULT_SITE_CONTENT,
    content: DEFAULT_SITE_CONTENT,
    savedAt: '2026-07-17T09:00:00.000Z',
  };
  await writeDraftRecord(page, futureDraft);
  await writeLegacyDraft(page, '不应覆盖未来版本草稿');
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' }],
  });

  await page.goto('/admin');

  await expect(page.getByRole('heading', { name: '工作台内容暂时无法载入' })).toBeVisible();
  await expect(page.getByText('当前版本无法安全处理的较新草稿')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存全部更改' })).toHaveCount(0);
  expect(await readDraftRecord(page)).toEqual(futureDraft);
  expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_ADMIN_DRAFT_STORAGE_KEY)).not.toBeNull();
});

test('fails closed when the IndexedDB draft cannot be read and never overwrites the unknown record', async ({ page }) => {
  const unknownDraft = {
    kind: 'current',
    schemaVersion: 2,
    baseEtag: '"content-v1"',
    baseContent: structuredClone(DEFAULT_SITE_CONTENT),
    content: structuredClone(DEFAULT_SITE_CONTENT),
    savedAt: '2026-07-17T09:10:00.000Z',
  } satisfies CurrentAdminDraft;
  unknownDraft.content.siteSettings.siteTitle = '读取失败时必须保留的未知草稿';
  await writeDraftRecord(page, unknownDraft);
  await page.addInitScript({
    content: `
      (() => {
        const originalTransaction = IDBDatabase.prototype.transaction;
        let failed = false;
        IDBDatabase.prototype.transaction = function (storeNames, mode, options) {
          const names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames);
          if (!failed && mode === 'readonly' && names.includes('drafts')) {
            failed = true;
            throw new DOMException('Temporary draft read failure', 'AbortError');
          }
          return originalTransaction.call(this, storeNames, mode, options);
        };
      })();
    `,
  });
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' }],
  });

  await page.goto('/admin');

  await expect(page.getByRole('heading', { name: '工作台内容暂时无法载入' })).toBeVisible();
  await expect(page.getByText('无法确认浏览器中是否存在未保存草稿')).toBeVisible();
  expect(await readDraftRecord(page)).toEqual(unknownDraft);
});

test('persists edits made during a pending PUT before the response returns', async ({ page }) => {
  const requestTitle = '延迟 PUT 中的标题';
  const pendingDescription = '响应前已立即写入 IndexedDB 的内容';
  let saveRequests = 0;
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' }],
    saveResponses: [{ body: { saved: true }, etag: '"content-v2"', delayMs: 3_000 }],
    onSaveRequest: () => { saveRequests += 1; },
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();
  await page.getByRole('button', { name: '全局设置' }).click();

  await page.getByLabel('浏览器标题 / SEO 标题').fill(requestTitle);
  await page.getByRole('button', { name: '保存全部更改' }).click();
  await expect.poll(() => saveRequests).toBe(1);
  await page.getByLabel('站点描述').fill(pendingDescription);

  await expect.poll(async () => (
    await readDraftRecord<CurrentAdminDraft>(page)
  )?.content.siteSettings.siteDescription, { timeout: 1_000 }).toBe(pendingDescription);

  await page.reload();
  await expect(page.locator('[data-notice-code="LOCAL_DRAFT_RESTORED"]')).toBeVisible();
  await page.getByRole('button', { name: '全局设置' }).click();
  await expect(page.getByLabel('浏览器标题 / SEO 标题')).toHaveValue(requestTitle);
  await expect(page.getByLabel('站点描述')).toHaveValue(pendingDescription);
});

test('a delayed save owner cannot delete the next tab draft after logout handoff', async ({ page }) => {
  const waitingPage = await page.context().newPage();
  const firstTitle = '标签页 A 请求中的标题';
  const secondTitle = '标签页 B 接手后的草稿';
  let firstSaveRequests = 0;
  await mockAdminApi(page, {
    authenticated: true,
    logoutStatus: 200,
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' }],
    saveResponses: [{ body: { saved: true }, etag: '"content-v2"', delayMs: 2_500 }],
    onSaveRequest: () => { firstSaveRequests += 1; },
  });
  await mockAdminApi(waitingPage, {
    authenticated: true,
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' }],
  });

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();
  await waitingPage.goto('/admin');
  await expect(waitingPage.getByRole('heading', { name: '另一个标签页正在编辑' })).toBeVisible();

  await page.getByRole('button', { name: '全局设置' }).click();
  await page.getByLabel('浏览器标题 / SEO 标题').fill(firstTitle);
  await page.getByRole('button', { name: '保存全部更改' }).click();
  await expect.poll(() => firstSaveRequests).toBe(1);
  page.once('dialog', (dialog) => { void dialog.accept(); });
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();

  await expect(waitingPage.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible({
    timeout: 7_500,
  });
  await waitingPage.getByRole('button', { name: '全局设置' }).click();
  const titleInput = waitingPage.getByLabel('浏览器标题 / SEO 标题');
  await titleInput.fill(secondTitle);
  await expect.poll(async () => (
    await readDraftRecord<CurrentAdminDraft>(waitingPage)
  )?.content.siteSettings.siteTitle).toBe(secondTitle);

  await waitingPage.waitForTimeout(2_800);
  await expect.poll(async () => (
    await readDraftRecord<CurrentAdminDraft>(waitingPage)
  )?.content.siteSettings.siteTitle).toBe(secondTitle);

  await waitingPage.reload();
  await expect(waitingPage.locator('[data-notice-code="LOCAL_DRAFT_RESTORED"]')).toBeVisible();
  await waitingPage.getByRole('button', { name: '全局设置' }).click();
  await expect(waitingPage.getByLabel('浏览器标题 / SEO 标题')).toHaveValue(secondTitle);
});

test('reloads server content and the latest shared draft after a non-save request expires the session', async ({ page }) => {
  const secondPage = await page.context().newPage();
  const firstTitle = '标签页 A 过期前的内存内容';
  const secondTitle = '标签页 B 接管后的最新草稿';
  let firstPageContentRequests = 0;
  await mockAdminApi(page, {
    authenticated: true,
    loginStatus: 200,
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' }],
    mediaResponses: [
      { status: 401, body: { detail: 'Session expired' } },
      { status: 200, body: { items: [] } },
    ],
    onContentRequest: () => { firstPageContentRequests += 1; },
  });
  await mockAdminApi(secondPage, {
    authenticated: true,
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' }],
  });

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();
  await page.getByRole('button', { name: '全局设置' }).click();
  await page.getByLabel('浏览器标题 / SEO 标题').fill(firstTitle);
  await expect.poll(async () => (
    await readDraftRecord<CurrentAdminDraft>(page)
  )?.content.siteSettings.siteTitle).toBe(firstTitle);

  await page.getByRole('button', { name: '媒体资源库' }).click();
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();

  await secondPage.goto('/admin');
  await expect(secondPage.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();
  await secondPage.getByRole('button', { name: '全局设置' }).click();
  await secondPage.getByLabel('浏览器标题 / SEO 标题').fill(secondTitle);
  await expect.poll(async () => (
    await readDraftRecord<CurrentAdminDraft>(secondPage)
  )?.content.siteSettings.siteTitle).toBe(secondTitle);
  await secondPage.close();

  await page.getByLabel('管理员密码').fill('correct-password');
  await page.getByRole('button', { name: '进入工作台' }).click();

  await expect.poll(() => firstPageContentRequests).toBe(2);
  await expect(page.locator('[data-notice-code="LOCAL_DRAFT_RESTORED"]')).toBeVisible();
  await page.getByRole('button', { name: '全局设置' }).click();
  await expect(page.getByLabel('浏览器标题 / SEO 标题')).toHaveValue(secondTitle);
});

test('ignores a delayed revisions 401 from the session that logged out', async ({ page }) => {
  let releaseOldRevisionResponse!: () => void;
  const oldRevisionResponseGate = new Promise<void>((resolve) => {
    releaseOldRevisionResponse = resolve;
  });
  const oldRequestId = 'e2e-old-session-revisions';
  const newRevisionReason = '新会话的版本记录';
  await mockAdminApi(page, {
    authenticated: true,
    loginStatus: 200,
    logoutStatus: 200,
    contentResponses: [
      { body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' },
      { body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' },
    ],
    revisionResponses: [
      {
        status: 401,
        body: { detail: 'Session expired' },
        requestId: oldRequestId,
        waitFor: oldRevisionResponseGate,
      },
      {
        status: 200,
        requestId: 'e2e-new-session-revisions',
        body: {
          items: [{ id: 42, createdAt: '2026-07-17T10:00:00.000Z', reason: newRevisionReason }],
          total: 1,
          limit: 30,
          offset: 0,
        },
      },
    ],
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();

  const oldRevisionRequest = page.waitForRequest((request) => (
    request.method() === 'GET' && request.url().endsWith('/backend/api/v1/admin/revisions?limit=30')
  ));
  const oldRevisionResponse = page.waitForResponse((response) => (
    response.headers()['x-request-id'] === oldRequestId
  ));
  await page.getByRole('button', { name: '打开版本历史' }).click();
  await oldRevisionRequest;
  await page.getByRole('button', { name: '关闭版本历史' }).click();

  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  await page.getByLabel('管理员密码').fill('correct-password');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();

  releaseOldRevisionResponse();
  await oldRevisionResponse;
  await page.waitForTimeout(250);
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '管理员登录' })).toHaveCount(0);

  await page.getByRole('button', { name: '打开版本历史' }).click();
  const revisions = page.getByRole('dialog', { name: '内容版本历史' });
  await expect(revisions.getByText(newRevisionReason)).toBeVisible();
  await expect(revisions.getByText('版本历史加载失败')).toHaveCount(0);
});

test('flushes the latest edit before a revisions 401 cancels the debounce timer', async ({ page }) => {
  const title = '会话过期前不足 300ms 的最后一次编辑';
  await page.addInitScript({
    content: `
      (() => {
        const nativeSetTimeout = window.setTimeout.bind(window);
        window.setTimeout = function (handler, delay, ...args) {
          return nativeSetTimeout(handler, delay === 300 ? 30_000 : delay, ...args);
        };
      })();
    `,
  });
  await mockAdminApi(page, {
    authenticated: true,
    loginStatus: 200,
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' }],
    revisionResponses: [{ status: 401, body: { detail: 'Session expired' } }],
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();
  await page.getByRole('button', { name: '全局设置' }).click();

  await page.getByLabel('浏览器标题 / SEO 标题').fill(title);
  expect(await readDraftRecord(page)).toBeNull();
  await page.getByRole('button', { name: '打开版本历史' }).click();

  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  await expect.poll(async () => (
    await readDraftRecord<CurrentAdminDraft>(page)
  )?.content.siteSettings.siteTitle).toBe(title);

  await page.getByLabel('管理员密码').fill('correct-password');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.locator('[data-notice-code="LOCAL_DRAFT_RESTORED"]')).toBeVisible();
  await page.getByRole('button', { name: '全局设置' }).click();
  await expect(page.getByLabel('浏览器标题 / SEO 标题')).toHaveValue(title);
});

test('closes a portal confirmation and rejects its stale action while the session expires', async ({ page }) => {
  let releaseRevisionResponse!: () => void;
  const revisionResponseGate = new Promise<void>((resolve) => {
    releaseRevisionResponse = resolve;
  });
  const expiringRequestId = 'e2e-expiring-session-revisions';
  const retainedProject = DEFAULT_SITE_CONTENT.projects[0];
  await page.addInitScript({
    content: `
      (() => {
        const nativeSetTimeout = window.setTimeout.bind(window);
        window.setTimeout = function (handler, delay, ...args) {
          return nativeSetTimeout(handler, delay === 300 ? 30_000 : delay, ...args);
        };

        const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
        if (!descriptor || !descriptor.get || !descriptor.set) return;
        Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          get: descriptor.get,
          set(listener) {
            if (typeof listener !== 'function') {
              descriptor.set.call(this, listener);
              return;
            }
            descriptor.set.call(this, function (event) {
              if (window.__delayAdminDraftCompletion) {
                nativeSetTimeout(() => listener.call(this, event), 2_000);
                return;
              }
              listener.call(this, event);
            });
          },
        });
        window.__adminDraftCompletionPatchInstalled = true;
        window.__delayAdminDraftCompletion = false;
      })();
    `,
  });
  await mockAdminApi(page, {
    authenticated: true,
    loginStatus: 200,
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' }],
    revisionResponses: [{
      status: 401,
      body: { detail: 'Session expired' },
      requestId: expiringRequestId,
      waitFor: revisionResponseGate,
    }],
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();
  expect(await page.evaluate(() => (
    window as typeof window & { __adminDraftCompletionPatchInstalled?: boolean }
  ).__adminDraftCompletionPatchInstalled)).toBe(true);

  await page.getByRole('button', { name: '全局设置' }).click();
  await page.getByLabel('浏览器标题 / SEO 标题').fill('Portal 会话结束保护');
  const revisionRequest = page.waitForRequest((request) => (
    request.method() === 'GET' && request.url().endsWith('/backend/api/v1/admin/revisions?limit=30')
  ));
  const revisionResponse = page.waitForResponse((response) => (
    response.headers()['x-request-id'] === expiringRequestId
  ));
  await page.getByRole('button', { name: '打开版本历史' }).click();
  await revisionRequest;
  await page.getByRole('button', { name: '关闭版本历史' }).click();
  await page.getByRole('button', { name: '作品项目' }).click();
  await page.getByRole('button', { name: '删除项目', exact: true }).click();

  const confirmation = page.getByRole('alertdialog', { name: `删除项目“${retainedProject.title}”？` });
  const confirmButton = confirmation.getByRole('button', { name: '删除项目' });
  await expect(confirmation).toBeVisible();
  await confirmButton.evaluate((button) => {
    const propsKey = Object.keys(button).find((key) => key.startsWith('__reactProps$'));
    const props = propsKey
      ? (button as unknown as Record<string, { onClick?: unknown }>)[propsKey]
      : undefined;
    if (typeof props?.onClick !== 'function') throw new Error('Unable to capture the stale confirm callback');
    (window as typeof window & { __invokeStaleAdminConfirm?: () => void })
      .__invokeStaleAdminConfirm = props.onClick as () => void;
  });
  await page.evaluate(() => {
    (window as typeof window & { __delayAdminDraftCompletion?: boolean })
      .__delayAdminDraftCompletion = true;
  });

  releaseRevisionResponse();
  await revisionResponse;
  const endingWorkspace = page.locator('#root > [aria-busy="true"]');
  await expect(endingWorkspace).toBeVisible();
  await expect(confirmation).toHaveCount(0);
  await page.evaluate(() => {
    (window as typeof window & { __invokeStaleAdminConfirm?: () => void })
      .__invokeStaleAdminConfirm?.();
  });
  await expect(page.getByText(retainedProject.title, { exact: true }).first()).toBeVisible();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
});

test('flushes an edit to IndexedDB before immediate logout cancels the debounce timer', async ({ page }) => {
  const title = '退出前不足 300ms 的最后一次编辑';
  await mockAdminApi(page, {
    authenticated: true,
    loginStatus: 200,
    logoutStatus: 200,
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' }],
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();
  await page.getByRole('button', { name: '全局设置' }).click();

  await page.getByLabel('浏览器标题 / SEO 标题').fill(title);
  page.once('dialog', (dialog) => { void dialog.accept(); });
  await page.getByRole('button', { name: '退出登录' }).click();

  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  await expect.poll(async () => (
    await readDraftRecord<CurrentAdminDraft>(page)
  )?.content.siteSettings.siteTitle).toBe(title);

  await page.getByLabel('管理员密码').fill('correct-password');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.locator('[data-notice-code="LOCAL_DRAFT_RESTORED"]')).toBeVisible();
  await page.getByRole('button', { name: '全局设置' }).click();
  await expect(page.getByLabel('浏览器标题 / SEO 标题')).toHaveValue(title);
});

test('keeps the workspace non-editable while a delayed logout preserves its click-time snapshot', async ({ page }) => {
  const snapshotTitle = '点击退出时的最终快照';
  await mockAdminApi(page, {
    authenticated: true,
    loginStatus: 200,
    logoutResponse: {
      status: 200,
      body: { authenticated: false },
      requestId: 'e2e-delayed-admin-logout',
      delayMs: 2_000,
    },
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' }],
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();
  await page.getByRole('button', { name: '全局设置' }).click();
  const titleInput = page.getByLabel('浏览器标题 / SEO 标题');
  await titleInput.fill(snapshotTitle);

  const logoutRequest = page.waitForRequest((request) => (
    request.method() === 'POST' && request.url().endsWith('/backend/api/v1/admin/logout')
  ));
  page.once('dialog', (dialog) => { void dialog.accept(); });
  await page.getByRole('button', { name: '退出登录' }).click();
  await logoutRequest;

  await expect(titleInput).not.toBeEditable();
  await expect.poll(async () => (
    await readDraftRecord<CurrentAdminDraft>(page)
  )?.content.siteSettings.siteTitle).toBe(snapshotTitle);
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  expect((await readDraftRecord<CurrentAdminDraft>(page))?.content.siteSettings.siteTitle)
    .toBe(snapshotTitle);
});

test('legacy choice blocks command and revision mutations without changing either draft source', async ({ page }) => {
  const legacyTitle = '等待整份选择的 legacy 标题';
  await writeLegacyDraft(page, legacyTitle);
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"content-v1"' }],
  });
  await page.goto('/admin');
  await expect(page.getByText('本地草稿需要明确选择')).toBeVisible();
  const legacyBefore = await page.evaluate((key) => localStorage.getItem(key), LEGACY_ADMIN_DRAFT_STORAGE_KEY);

  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: '快捷操作' })).toHaveCount(0);
  const revisionsButton = page.getByRole('button', { name: '打开版本历史' });
  await expect(revisionsButton).toBeDisabled();
  await revisionsButton.dispatchEvent('click');
  await expect(page.getByRole('dialog', { name: '内容版本历史' })).toHaveCount(0);
  await page.waitForTimeout(500);

  expect(await readDraftRecord(page)).toBeNull();
  expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_ADMIN_DRAFT_STORAGE_KEY))
    .toBe(legacyBefore);
  await expect(page.getByText('本地草稿需要明确选择')).toBeVisible();
});

test('an unresolved merge conflict blocks command and revision mutations without changing the candidate', async ({ page }) => {
  const baseContent = structuredClone(DEFAULT_SITE_CONTENT);
  const localContent = structuredClone(baseContent);
  localContent.siteSettings.siteTitle = '冲突中的本地标题';
  const serverContent = structuredClone(baseContent);
  serverContent.siteSettings.siteTitle = '冲突中的服务器标题';
  await writeDraftRecord(page, {
    kind: 'current',
    schemaVersion: 2,
    baseEtag: '"content-v1"',
    baseContent,
    content: localContent,
    savedAt: '2026-07-17T09:00:00.000Z',
  } satisfies CurrentAdminDraft);
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: serverContent, etag: '"content-v2"' }],
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '检测到保存冲突' })).toBeVisible();
  await page.waitForTimeout(500);
  const draftBefore = await readDraftRecord<CurrentAdminDraft>(page);

  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: '快捷操作' })).toHaveCount(0);
  const revisionsButton = page.getByRole('button', { name: '打开版本历史' });
  await expect(revisionsButton).toBeDisabled();
  await revisionsButton.dispatchEvent('click');
  await expect(page.getByRole('dialog', { name: '内容版本历史' })).toHaveCount(0);
  await page.waitForTimeout(500);

  expect(await readDraftRecord<CurrentAdminDraft>(page)).toEqual(draftBefore);
  await expect(page.getByRole('heading', { name: '检测到保存冲突' })).toBeVisible();
});
