import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  ADMIN_DRAFT_DATABASE_NAME,
  ADMIN_DRAFT_OBJECT_STORE_NAME,
  ADMIN_DRAFT_RECORD_KEY,
  LEGACY_ADMIN_DRAFT_SCHEMA_VERSION,
  LEGACY_ADMIN_DRAFT_STORAGE_KEY,
  type CurrentAdminDraft,
} from '../src/admin/draftStorage';
import { DEFAULT_SITE_CONTENT } from '../src/content';
import { mockAdminApi } from './support';

const ADMIN_DRAFT_DATABASE = {
  databaseName: ADMIN_DRAFT_DATABASE_NAME,
  objectStoreName: ADMIN_DRAFT_OBJECT_STORE_NAME,
  recordKey: ADMIN_DRAFT_RECORD_KEY,
};

async function writePersistedAdminDraft(page: Page, draft: unknown): Promise<void> {
  await page.goto('/healthz');
  await page.evaluate(async ({ database, value }) => {
    await new Promise<void>((resolve, reject) => {
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
        transaction.objectStore(database.objectStoreName).put(value, database.recordKey);
        transaction.oncomplete = () => {
          connection.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error ?? new Error('Unable to seed draft'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Draft seed was aborted'));
      };
    });
  }, { database: ADMIN_DRAFT_DATABASE, value: draft });
}

async function readPersistedAdminDraft<T = unknown>(page: Page): Promise<T | null> {
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
      let value: T | null = null;
      readRequest.onsuccess = () => {
        value = readRequest.result === undefined ? null : readRequest.result as T;
      };
      readRequest.onerror = () => reject(readRequest.error ?? new Error('Unable to read draft'));
      transaction.oncomplete = () => {
        connection.close();
        resolve(value);
      };
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to read draft'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Draft read was aborted'));
    };
  }), ADMIN_DRAFT_DATABASE);
}

async function writeLegacyAdminDraft(page: Page, content: unknown): Promise<void> {
  await page.goto('/healthz');
  await page.evaluate(({ key, schemaVersion, value }) => {
    localStorage.setItem(key, JSON.stringify({
      schemaVersion,
      content: value,
      savedAt: '2026-07-17T09:00:00.000Z',
    }));
  }, {
    key: LEGACY_ADMIN_DRAFT_STORAGE_KEY,
    schemaVersion: LEGACY_ADMIN_DRAFT_SCHEMA_VERSION,
    value: content,
  });
}

async function readLegacyAdminDraft(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), LEGACY_ADMIN_DRAFT_STORAGE_KEY);
}

test('shows a specific login error after rejected credentials', async ({ page }) => {
  await mockAdminApi(page, { authenticated: false, loginStatus: 401 });
  await page.goto('/admin');

  const password = page.getByLabel('管理员密码');
  await expect(password).toBeFocused();
  await password.fill('incorrect-e2e-password');
  await password.press('Enter');
  await expect(page.getByRole('alert')).toContainText('管理员密码错误');
  await expect(password).toBeEnabled();
});

test('keeps an authenticated session on a retryable content loading error', async ({ page }) => {
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [
      { status: 503, body: { detail: 'database unavailable' } },
      { body: DEFAULT_SITE_CONTENT, etag: '"content-after-retry"' },
    ],
  });
  await page.goto('/admin');

  await expect(page.getByRole('heading', { name: '工作台内容暂时无法载入' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '管理员登录' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('HTTP 503');

  await page.getByRole('button', { name: '重试载入内容' }).click();
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();
});

test('keeps the desktop workspace flush and sidebar copy stable while collapsing', async ({ page }) => {
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"layout-content"' }],
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();

  const sidebar = page.locator('#admin-sidebar');
  const shell = page.locator('#admin-shell');
  const header = shell.locator(':scope > header');
  const main = shell.locator(':scope > main');
  const workspace = page.locator('#admin-workspace');
  const articleCopy = page
    .getByRole('button', { name: '博客文章' })
    .locator('.admin-sidebar-copy');

  const geometry = await page.evaluate(() => {
    const requiredElement = (selector: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing layout element: ${selector}`);
      return element;
    };
    const box = (selector: string) => requiredElement(selector).getBoundingClientRect();
    const surface = (selector: string) => {
      const style = getComputedStyle(requiredElement(selector));
      return {
        borderRadius: style.borderRadius,
        borderWidth: style.borderWidth,
        margin: style.margin,
      };
    };
    const sidebarBox = box('#admin-sidebar');
    const headerBox = box('#admin-shell > header');
    const mainBox = box('#admin-shell > main');
    const workspaceBox = box('#admin-workspace');
    return {
      sidebarRight: Math.round(sidebarBox.right),
      headerBottom: Math.round(headerBox.bottom),
      mainLeft: Math.round(mainBox.left),
      mainTop: Math.round(mainBox.top),
      workspaceLeft: Math.round(workspaceBox.left),
      workspaceTop: Math.round(workspaceBox.top),
      shellSurface: surface('#admin-shell'),
      mainSurface: surface('#admin-shell > main'),
      workspaceSurface: surface('#admin-workspace'),
    };
  });

  expect(geometry.mainLeft).toBe(geometry.sidebarRight);
  expect(geometry.mainTop).toBe(geometry.headerBottom);
  expect(geometry.workspaceLeft).toBe(geometry.mainLeft);
  expect(geometry.workspaceTop).toBe(geometry.mainTop);
  for (const surface of [
    geometry.shellSurface,
    geometry.mainSurface,
    geometry.workspaceSurface,
  ]) {
    expect(surface).toEqual({
      borderRadius: '0px',
      borderWidth: '0px',
      margin: '0px',
    });
  }

  await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
  await expect(articleCopy).toHaveCSS('opacity', '1');
  const expandedCopyWidth = await articleCopy.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  await articleCopy.evaluate((element) => {
    element.setAttribute('data-e2e-stable-copy', 'true');
  });

  await page.getByRole('button', { name: '折叠侧边栏' }).click();
  await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
  await expect(articleCopy).toHaveAttribute('data-e2e-stable-copy', 'true');
  await expect(articleCopy).toHaveCSS('opacity', '0');
  await expect.poll(
    () => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width)),
  ).toBe(80);
  await expect.poll(
    () => shell.evaluate((element) => getComputedStyle(element).paddingLeft),
  ).toBe('80px');
  expect(await articleCopy.evaluate(
    (element) => element.getBoundingClientRect().width,
  )).toBeCloseTo(expandedCopyWidth, 5);

  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
  await expect(articleCopy).toHaveAttribute('data-e2e-stable-copy', 'true');
  await expect(articleCopy).toHaveCSS('opacity', '1');
  await expect.poll(
    () => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width)),
  ).toBe(256);
  await expect.poll(
    () => shell.evaluate((element) => getComputedStyle(element).paddingLeft),
  ).toBe('256px');

  await expect(header).toBeVisible();
  await expect(main).toBeVisible();
  await expect(workspace).toBeVisible();
});

test('rejects a partial administrator document instead of filling it with defaults', async ({ page }) => {
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{
      body: {
        siteSettings: DEFAULT_SITE_CONTENT.siteSettings,
        blogPosts: DEFAULT_SITE_CONTENT.blogPosts,
      },
      etag: '"partial-content"',
      requestId: 'partial-content-response',
    }],
  });
  await page.goto('/admin');

  await expect(page.getByRole('heading', { name: '工作台内容暂时无法载入' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('后台返回的数据格式不正确');
  await expect(page.getByRole('alert')).toContainText('partial-content-response');
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toHaveCount(0);
});

test('automatically restores an IndexedDB v2 draft when its base ETag still matches', async ({ page }) => {
  const baseContent = structuredClone(DEFAULT_SITE_CONTENT);
  const localContent = structuredClone(baseContent);
  localContent.siteSettings.siteTitle = '同版本自动恢复的本地标题';
  const draft: CurrentAdminDraft = {
    kind: 'current',
    schemaVersion: 2,
    baseEtag: '"content-v1"',
    baseContent,
    content: localContent,
    savedAt: '2026-07-17T09:00:00.000Z',
  };

  await writePersistedAdminDraft(page, draft);
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: baseContent, etag: '"content-v1"' }],
  });
  await page.goto('/admin');

  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();
  await page.getByRole('button', { name: '全局设置' }).click();
  await expect(page.getByLabel('浏览器标题 / SEO 标题')).toHaveValue('同版本自动恢复的本地标题');
  await expect(page.getByRole('heading', { name: '检测到保存冲突' })).toHaveCount(0);
  await expect(page.getByText('检测到未保存的本地备份')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存全部更改' })).toBeEnabled();

  expect(await readPersistedAdminDraft<CurrentAdminDraft>(page)).toMatchObject({
    kind: 'current',
    schemaVersion: 2,
    baseEtag: '"content-v1"',
    baseContent: { siteSettings: { siteTitle: baseContent.siteSettings.siteTitle } },
    content: { siteSettings: { siteTitle: '同版本自动恢复的本地标题' } },
  });
});

test('hands the editor lock and unsaved draft to a waiting tab', async ({ page }) => {
  const serverContent = structuredClone(DEFAULT_SITE_CONTENT);
  const firstTabTitle = '标签页 A 尚未保存的标题';
  const secondTabTitle = '标签页 B 接手后继续编辑的标题';
  const secondPage = await page.context().newPage();
  let secondPageContentRequests = 0;

  secondPage.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.endsWith('/admin/content')) {
      secondPageContentRequests += 1;
    }
  });
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: serverContent, etag: '"content-v1"' }],
  });
  await mockAdminApi(secondPage, {
    authenticated: true,
    contentResponses: [{ body: serverContent, etag: '"content-v1"' }],
  });

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();
  await secondPage.goto('/admin');
  await expect(secondPage.getByRole('heading', { name: '另一个标签页正在编辑' })).toBeVisible();
  await expect(secondPage.getByText('每 2 秒自动重试')).toBeVisible();
  await expect(secondPage.getByRole('heading', { name: '今天要处理的内容' })).toHaveCount(0);
  expect(secondPageContentRequests).toBe(0);

  await page.getByRole('button', { name: '全局设置' }).click();
  await page.getByLabel('浏览器标题 / SEO 标题').fill(firstTabTitle);
  await expect.poll(async () => (
    await readPersistedAdminDraft<CurrentAdminDraft>(page)
  )?.content.siteSettings.siteTitle).toBe(firstTabTitle);

  await page.close();

  await expect(secondPage.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible({
    timeout: 7_500,
  });
  expect(secondPageContentRequests).toBe(1);
  await expect(secondPage.locator('[data-notice-code="LOCAL_DRAFT_RESTORED"]')).toBeVisible();
  await secondPage.getByRole('button', { name: '全局设置' }).click();
  const recoveredTitle = secondPage.getByLabel('浏览器标题 / SEO 标题');
  await expect(recoveredTitle).toHaveValue(firstTabTitle);
  await expect(recoveredTitle).toBeEditable();
  await expect(secondPage.getByRole('button', { name: '保存全部更改' })).toBeEnabled();
  expect(await readPersistedAdminDraft<CurrentAdminDraft>(secondPage)).toMatchObject({
    kind: 'current',
    schemaVersion: 2,
    baseEtag: '"content-v1"',
    baseContent: {
      siteSettings: {
        siteTitle: serverContent.siteSettings.siteTitle,
      },
    },
    content: {
      siteSettings: {
        siteTitle: firstTabTitle,
      },
    },
  });

  await recoveredTitle.fill(secondTabTitle);
  await expect.poll(async () => (
    await readPersistedAdminDraft<CurrentAdminDraft>(secondPage)
  )?.content.siteSettings.siteTitle).toBe(secondTabTitle);
  expect(secondPageContentRequests).toBe(1);
});

test('requires an explicit whole-document choice before migrating a legacy v1 draft', async ({ page }) => {
  const serverContent = structuredClone(DEFAULT_SITE_CONTENT);
  serverContent.siteSettings.siteTitle = '当前服务器整份内容';
  const legacyContent = structuredClone(DEFAULT_SITE_CONTENT);
  legacyContent.siteSettings.siteTitle = '旧版浏览器中的整份本地草稿';
  legacyContent.siteSettings.siteDescription = '旧版草稿独立修改的描述';
  const saveRequests: Array<{ body: unknown; headers: Record<string, string> }> = [];

  await writeLegacyAdminDraft(page, legacyContent);
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: serverContent, etag: '"content-v5"' }],
    onSaveRequest: (request) => saveRequests.push(request),
  });
  await page.goto('/admin');

  await expect(page.getByText('本地草稿需要明确选择')).toBeVisible();
  await expect(page.getByRole('button', { name: '保留服务器版本' })).toBeVisible();
  await expect(page.getByRole('button', { name: '采用整个本地草稿' })).toBeVisible();
  await page.getByRole('button', { name: '全局设置' }).click();

  const workspace = page.locator('#admin-workspace');
  const titleInput = page.getByLabel('浏览器标题 / SEO 标题');
  const saveAll = page.getByRole('button', { name: '保存全部更改' });
  await expect(workspace).toHaveAttribute('inert', '');
  await expect(workspace).toHaveAttribute('aria-disabled', 'true');
  await expect(titleInput).toHaveValue('当前服务器整份内容');
  await expect(titleInput).not.toBeEditable();
  await expect(saveAll).toBeDisabled();

  await expect(page.getByRole('button', { name: '打开快捷命令' })).toBeDisabled();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: '快捷操作' })).toHaveCount(0);
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(200);
  expect(saveRequests).toHaveLength(0);
  expect(await readLegacyAdminDraft(page)).not.toBeNull();
  expect(await readPersistedAdminDraft(page)).toBeNull();

  await page.getByRole('button', { name: '采用整个本地草稿' }).click();
  await expect(page.getByText('本地草稿需要明确选择')).toHaveCount(0);
  await expect(workspace).not.toHaveAttribute('inert', '');
  await expect(workspace).not.toHaveAttribute('aria-disabled', 'true');
  await expect(titleInput).toHaveValue('旧版浏览器中的整份本地草稿');
  await expect(page.getByLabel('站点描述')).toHaveValue('旧版草稿独立修改的描述');
  await expect(titleInput).toBeEditable();
  await expect(saveAll).toBeEnabled();
  expect(await readLegacyAdminDraft(page)).toBeNull();

  expect(await readPersistedAdminDraft<CurrentAdminDraft>(page)).toMatchObject({
    kind: 'current',
    schemaVersion: 2,
    baseEtag: '"content-v5"',
    baseContent: {
      siteSettings: {
        siteTitle: '当前服务器整份内容',
      },
    },
    content: {
      siteSettings: {
        siteTitle: '旧版浏览器中的整份本地草稿',
        siteDescription: '旧版草稿独立修改的描述',
      },
    },
  });
});

test('automatically merges a conflict-free v2 draft and keeps it until PUT succeeds', async ({ page }) => {
  const baseContent = structuredClone(DEFAULT_SITE_CONTENT);
  const localContent = structuredClone(baseContent);
  localContent.siteSettings.siteTitle = '本地独立修改的标题';
  const serverContent = structuredClone(baseContent);
  serverContent.siteSettings.siteDescription = '服务器独立修改的描述';
  const saveRequests: Array<{ body: unknown; headers: Record<string, string> }> = [];

  await writePersistedAdminDraft(page, {
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
    saveResponses: [{ body: { saved: true }, etag: '"content-v3"', delayMs: 1_000 }],
    onSaveRequest: (request) => saveRequests.push(request),
  });
  await page.goto('/admin');

  await expect(page.locator('[data-notice-code="LOCAL_DRAFT_AUTO_MERGED"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: '检测到保存冲突' })).toHaveCount(0);
  await expect(page.getByText('本地草稿需要明确选择')).toHaveCount(0);
  await page.getByRole('button', { name: '全局设置' }).click();
  await expect(page.getByLabel('浏览器标题 / SEO 标题')).toHaveValue('本地独立修改的标题');
  await expect(page.getByLabel('站点描述')).toHaveValue('服务器独立修改的描述');

  await expect.poll(async () => {
    const draft = await readPersistedAdminDraft<CurrentAdminDraft>(page);
    return draft && {
      baseEtag: draft.baseEtag,
      baseTitle: draft.baseContent.siteSettings.siteTitle,
      baseDescription: draft.baseContent.siteSettings.siteDescription,
      mergedTitle: draft.content.siteSettings.siteTitle,
      mergedDescription: draft.content.siteSettings.siteDescription,
    };
  }).toEqual({
    baseEtag: '"content-v2"',
    baseTitle: serverContent.siteSettings.siteTitle,
    baseDescription: '服务器独立修改的描述',
    mergedTitle: '本地独立修改的标题',
    mergedDescription: '服务器独立修改的描述',
  });

  await page.getByRole('button', { name: '保存全部更改' }).click();
  await expect.poll(() => saveRequests.length).toBe(1);
  expect(await readPersistedAdminDraft<CurrentAdminDraft>(page)).toMatchObject({
    baseEtag: '"content-v2"',
    content: {
      siteSettings: {
        siteTitle: '本地独立修改的标题',
        siteDescription: '服务器独立修改的描述',
      },
    },
  });

  await expect(page.locator('[data-notice-code="SAVE_SUCCEEDED"]')).toBeVisible();
  await expect.poll(() => readPersistedAdminDraft(page)).toBeNull();
  expect(saveRequests[0].headers['if-match']).toBe('"content-v2"');
  expect(saveRequests[0].body).toMatchObject({
    siteSettings: {
      siteTitle: '本地独立修改的标题',
      siteDescription: '服务器独立修改的描述',
    },
  });
});

test('keeps edits made while a PUT is in flight rebased onto the returned ETag', async ({ page }) => {
  const serverContent = structuredClone(DEFAULT_SITE_CONTENT);
  const requestTitle = '本次 PUT 请求中的标题';
  const laterDescription = 'PUT 尚未返回时继续编辑的描述';
  const saveRequests: Array<{ body: unknown; headers: Record<string, string> }> = [];

  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: serverContent, etag: '"content-v1"' }],
    saveResponses: [{ body: { saved: true }, etag: '"content-v2"', delayMs: 1_200 }],
    onSaveRequest: (request) => saveRequests.push(request),
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();
  await page.getByRole('button', { name: '全局设置' }).click();

  const titleInput = page.getByLabel('浏览器标题 / SEO 标题');
  const descriptionInput = page.getByLabel('站点描述');
  await titleInput.fill(requestTitle);
  await page.getByRole('button', { name: '保存全部更改' }).click();
  await expect.poll(() => saveRequests.length).toBe(1);
  await descriptionInput.fill(laterDescription);

  await expect(page.locator('[data-notice-code="SAVE_SUCCEEDED"]')).toBeVisible();
  await expect(titleInput).toHaveValue(requestTitle);
  await expect(descriptionInput).toHaveValue(laterDescription);
  await expect(page.getByRole('button', { name: '保存全部更改' })).toBeEnabled();
  expect(saveRequests[0].headers['if-match']).toBe('"content-v1"');
  expect(saveRequests[0].body).toMatchObject({
    siteSettings: {
      siteTitle: requestTitle,
      siteDescription: serverContent.siteSettings.siteDescription,
    },
  });

  await expect.poll(async () => {
    const draft = await readPersistedAdminDraft<CurrentAdminDraft>(page);
    return draft && {
      baseEtag: draft.baseEtag,
      baseTitle: draft.baseContent.siteSettings.siteTitle,
      baseDescription: draft.baseContent.siteSettings.siteDescription,
      currentTitle: draft.content.siteSettings.siteTitle,
      currentDescription: draft.content.siteSettings.siteDescription,
    };
  }).toEqual({
    baseEtag: '"content-v2"',
    baseTitle: requestTitle,
    baseDescription: serverContent.siteSettings.siteDescription,
    currentTitle: requestTitle,
    currentDescription: laterDescription,
  });
});

test('preserves a v2 local candidate across refresh and requires an explicit conflict choice', async ({ page }) => {
  const baseContent = structuredClone(DEFAULT_SITE_CONTENT);
  const serverContent = structuredClone(DEFAULT_SITE_CONTENT);
  serverContent.siteSettings.siteTitle = '服务器会话中的标题';
  serverContent.siteSettings.siteDescription = '服务器会话独立修改的描述';
  const localTitle = '刷新后仍应保留的本地标题';
  const saveRequests: Array<{ body: unknown; headers: Record<string, string> }> = [];

  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [
      { body: baseContent, etag: '"content-v1"' },
      { body: serverContent, etag: '"content-v2"' },
    ],
    saveResponses: [
      {
        status: 409,
        body: {
          detail: {
            code: 'CONTENT_VERSION_CONFLICT',
            message: 'Content changed in another session. Reload before publishing.',
          },
        },
        requestId: 'conflict-request',
      },
      { body: { saved: true }, etag: '"content-v3"' },
    ],
    onSaveRequest: (request) => saveRequests.push(request),
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();

  await page.getByRole('button', { name: '全局设置' }).click();
  const titleInput = page.getByLabel('浏览器标题 / SEO 标题');
  await titleInput.fill(localTitle);
  await page.getByLabel('品牌缩写').fill('LOCAL');
  await page.getByRole('button', { name: '保存全部更改' }).click();

  const conflictNotice = page.locator('[data-notice-code="SAVE_CONFLICT"]');
  await expect(conflictNotice).toBeVisible();
  await expect(conflictNotice).toHaveAttribute('data-tone', 'warning');
  await expect(page.getByRole('heading', { name: '检测到保存冲突' })).toBeVisible();
  await expect(titleInput).toHaveValue(localTitle);

  await expect.poll(async () => (
    await readPersistedAdminDraft<CurrentAdminDraft>(page)
  )?.content.siteSettings.siteTitle).toBe(localTitle);
  const draftBeforeRefresh = await readPersistedAdminDraft<CurrentAdminDraft>(page);
  expect(draftBeforeRefresh).toMatchObject({
    kind: 'current',
    schemaVersion: 2,
    baseEtag: '"content-v1"',
    baseContent: { siteSettings: { siteTitle: baseContent.siteSettings.siteTitle } },
    content: {
      siteSettings: {
        siteTitle: localTitle,
        brandInitials: 'LOCAL',
      },
    },
  });

  await page.reload();
  await expect(page.getByRole('heading', { name: '检测到保存冲突' })).toBeVisible();
  await page.getByRole('button', { name: '全局设置' }).click();
  await expect(page.getByLabel('浏览器标题 / SEO 标题')).toHaveValue('服务器会话中的标题');
  await expect(page.getByLabel('站点描述')).toHaveValue('服务器会话独立修改的描述');
  await expect(page.getByLabel('品牌缩写')).toHaveValue('LOCAL');
  await expect(page.getByText('冲突字段：siteSettings.siteTitle')).toBeVisible();

  const serverChoice = page.getByRole('button', { name: '冲突字段采用服务器值' });
  const localChoice = page.getByRole('button', { name: '冲突字段采用本地值' });
  const saveMerged = page.getByRole('button', { name: /保存合并结果|请先选择冲突版本/ });
  await expect(serverChoice).toHaveAttribute('aria-pressed', 'false');
  await expect(localChoice).toHaveAttribute('aria-pressed', 'false');
  await expect(saveMerged).toBeDisabled();
  await expect(page.getByRole('button', { name: '保存全部更改' })).toBeDisabled();

  await page.waitForTimeout(1_800);
  expect(await readPersistedAdminDraft<CurrentAdminDraft>(page)).toMatchObject({
    baseEtag: '"content-v1"',
    baseContent: { siteSettings: { siteTitle: baseContent.siteSettings.siteTitle } },
    content: {
      siteSettings: {
        siteTitle: localTitle,
        brandInitials: 'LOCAL',
      },
    },
  });

  await page.reload();
  await expect(page.getByRole('heading', { name: '检测到保存冲突' })).toBeVisible();
  await expect(serverChoice).toHaveAttribute('aria-pressed', 'false');
  await expect(localChoice).toHaveAttribute('aria-pressed', 'false');
  await expect(saveMerged).toBeDisabled();
  await page.waitForTimeout(1_800);
  expect(await readPersistedAdminDraft<CurrentAdminDraft>(page)).toMatchObject({
    baseEtag: '"content-v1"',
    content: { siteSettings: { siteTitle: localTitle } },
  });

  await localChoice.click();
  await page.getByRole('button', { name: '全局设置' }).click();
  await expect(page.getByLabel('浏览器标题 / SEO 标题')).toHaveValue(localTitle);
  await expect(page.getByLabel('站点描述')).toHaveValue('服务器会话独立修改的描述');
  await expect(page.getByLabel('品牌缩写')).toHaveValue('LOCAL');
  await expect(localChoice).toHaveAttribute('aria-pressed', 'true');
  await expect(saveMerged).toBeEnabled();

  await expect.poll(async () => {
    const draft = await readPersistedAdminDraft<CurrentAdminDraft>(page);
    return draft && {
      baseEtag: draft.baseEtag,
      baseTitle: draft.baseContent.siteSettings.siteTitle,
      localTitle: draft.content.siteSettings.siteTitle,
      serverDescription: draft.content.siteSettings.siteDescription,
    };
  }).toEqual({
    baseEtag: '"content-v2"',
    baseTitle: '服务器会话中的标题',
    localTitle,
    serverDescription: '服务器会话独立修改的描述',
  });

  await page.getByRole('button', { name: '保存合并结果' }).click();

  await expect(page.locator('[data-notice-code="SAVE_SUCCEEDED"]')).toHaveAttribute('data-tone', 'success');
  await expect(page.getByRole('heading', { name: '检测到保存冲突' })).toHaveCount(0);
  expect(saveRequests).toHaveLength(2);
  expect(saveRequests[0].headers['if-match']).toBe('"content-v1"');
  expect(saveRequests[1].headers['if-match']).toBe('"content-v2"');
  expect(saveRequests[1].body).toMatchObject({
    siteSettings: {
      siteTitle: localTitle,
      siteDescription: '服务器会话独立修改的描述',
      brandInitials: 'LOCAL',
    },
  });
  await expect.poll(() => readPersistedAdminDraft(page)).toBeNull();
});

test('ignores a corrupt IndexedDB draft while retaining validated server content', async ({ page }) => {
  const serverContent = structuredClone(DEFAULT_SITE_CONTENT);
  serverContent.siteSettings.siteTitle = '服务器中的有效内容';
  const corruptDraft = structuredClone(DEFAULT_SITE_CONTENT) as unknown as Record<string, unknown>;
  corruptDraft.siteSettings = { siteTitle: 42 };

  await writePersistedAdminDraft(page, {
    kind: 'current',
    schemaVersion: 2,
    baseEtag: '"corrupt-base"',
    baseContent: DEFAULT_SITE_CONTENT,
    content: corruptDraft,
    savedAt: '2026-07-17T09:00:00.000Z',
  });
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: serverContent, etag: '"valid-server-content"' }],
  });
  await page.goto('/admin');

  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();
  await page.getByRole('button', { name: '全局设置' }).click();
  await expect(page.getByLabel('浏览器标题 / SEO 标题')).toHaveValue('服务器中的有效内容');
  await expect(page.getByText('检测到未保存的本地备份')).toHaveCount(0);
  await expect.poll(() => readPersistedAdminDraft(page)).toBeNull();
});

test('renders retryable and stale states for media and revisions', async ({ page }) => {
  const mediaItem = {
    filename: 'retry-photo.webp',
    url: '/uploads/retry-photo.webp',
    contentType: 'image/webp',
    sizeBytes: 2048,
    uploadedAt: '2026-07-17T08:00:00Z',
    referenced: false,
    references: [],
  };
  const revision = {
    id: 27,
    createdAt: '2026-07-17T08:00:00Z',
    reason: 'e2e snapshot',
    summary: { posts: 2, drafts: 1, projects: 3, skillGroups: 2, sizeBytes: 4096 },
  };
  await mockAdminApi(page, {
    authenticated: true,
    mediaResponses: [
      { status: 503 },
      { body: { items: [mediaItem] } },
      { status: 503 },
    ],
    revisionResponses: [
      { status: 503 },
      { body: { items: [revision] } },
      { status: 503 },
    ],
  });
  await page.goto('/admin');

  await page.getByRole('button', { name: '媒体资源库' }).click();
  await expect(page.getByRole('heading', { name: '媒体资源加载失败' })).toBeVisible();
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByText('retry-photo.webp', { exact: true })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: '搜索媒体资源' })).toBeVisible();
  await page.getByRole('button', { name: '刷新媒体资源' }).click();
  await expect(page.getByText('媒体刷新失败，当前显示上次结果。')).toBeVisible();
  await expect(page.getByText('retry-photo.webp', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '打开版本历史' }).click();
  const revisions = page.getByRole('dialog', { name: '内容版本历史' });
  await expect(revisions.getByRole('heading', { name: '版本历史加载失败' })).toBeVisible();
  await revisions.getByRole('button', { name: '重新加载' }).click();
  await expect(revisions.getByText('#27')).toBeVisible();
  await revisions.getByRole('button', { name: '关闭版本历史' }).click();
  await page.getByRole('button', { name: '打开版本历史' }).click();
  await expect(revisions.getByText('版本历史刷新失败，当前显示上次结果。')).toBeVisible();
  await expect(revisions.getByText('#27')).toBeVisible();
});

test('keeps only the latest concurrent media and revision responses', async ({ page }) => {
  const mediaItem = (filename: string) => ({
    filename,
    url: `/uploads/${filename}`,
    contentType: 'image/webp',
    sizeBytes: 2048,
    uploadedAt: '2026-07-17T08:00:00Z',
    referenced: false,
    references: [],
  });
  const revision = (id: number) => ({
    id,
    createdAt: '2026-07-17T08:00:00Z',
    reason: 'concurrency check',
    summary: { posts: 2, drafts: 1, projects: 3, skillGroups: 2, sizeBytes: 4096 },
  });
  await mockAdminApi(page, {
    authenticated: true,
    mediaResponses: [
      { body: { items: [mediaItem('stale-media.webp')] }, delayMs: 400 },
      { body: { items: [mediaItem('latest-media.webp')] } },
    ],
    revisionResponses: [
      { body: { items: [revision(31)] }, delayMs: 400 },
      { body: { items: [revision(32)] } },
    ],
  });
  await page.goto('/admin');

  const firstMediaRequest = page.waitForRequest((request) => (
    request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/admin/media')
  ));
  await page.getByRole('button', { name: '媒体资源库' }).click();
  await firstMediaRequest;
  await page.getByRole('button', { name: '刷新媒体资源' }).click();
  await expect(page.getByText('latest-media.webp', { exact: true })).toBeVisible();
  await page.waitForTimeout(450);
  await expect(page.getByText('stale-media.webp', { exact: true })).toHaveCount(0);

  const firstRevisionRequest = page.waitForRequest((request) => (
    request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/admin/revisions')
  ));
  await page.getByRole('button', { name: '打开版本历史' }).click();
  await firstRevisionRequest;
  const revisions = page.getByRole('dialog', { name: '内容版本历史' });
  await revisions.getByRole('button', { name: '关闭版本历史' }).click();
  await page.getByRole('button', { name: '打开版本历史' }).click();
  await expect(revisions.getByText('#32')).toBeVisible();
  await page.waitForTimeout(450);
  await expect(revisions.getByText('#31')).toHaveCount(0);
});

test('surfaces missing media references and keeps the failed save as a local draft', async ({ page }) => {
  const missingFilename = 'missing-cover.webp';
  const serverContent = structuredClone(DEFAULT_SITE_CONTENT);
  serverContent.blogPosts[0].coverImage = `/uploads/${missingFilename}`;
  const saveRequests: Array<{ body: unknown; headers: Record<string, string> }> = [];
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: serverContent, etag: '"content-with-missing-media"' }],
    saveResponses: [{
      status: 409,
      requestId: 'missing-media-save',
      body: {
        detail: {
          code: 'MEDIA_REFERENCE_MISSING',
          message: 'Content references missing media',
          details: { filenames: [missingFilename] },
        },
      },
    }],
    onSaveRequest: (request) => saveRequests.push(request),
  });
  await page.goto('/admin');

  await page.getByRole('button', { name: '全局设置' }).click();
  await page.getByLabel('站点描述').fill('触发缺失媒体检查的未保存更改');
  await page.getByRole('button', { name: '保存全部更改' }).click();

  await expect(page.locator('[data-notice-code="SAVE_MEDIA_REFERENCE_MISSING"]')).toContainText(missingFilename);
  await expect(page.locator('[data-notice-code="SAVE_MEDIA_REFERENCE_MISSING"]')).toContainText('$.blogPosts[0].coverImage');
  await expect(page.getByRole('heading', { name: '媒体资源库', level: 2 })).toBeVisible();
  expect(saveRequests).toHaveLength(1);
  await expect.poll(async () => (
    await readPersistedAdminDraft<CurrentAdminDraft>(page)
  )?.content.siteSettings.siteDescription).toBe('触发缺失媒体检查的未保存更改');
});

test('keeps a media delete dialog blocked when the server reports live references', async ({ page }) => {
  const filename = 'referenced-after-refresh.webp';
  const initialMedia = {
    filename,
    url: `/uploads/${filename}`,
    contentType: 'image/webp',
    sizeBytes: 2048,
    uploadedAt: '2026-07-17T08:00:00Z',
    referenced: false,
    references: [],
  };
  const references = ['blogPosts[0].coverImage', 'revisions[42]'];
  await mockAdminApi(page, {
    authenticated: true,
    mediaResponses: [
      { body: { items: [initialMedia] } },
      { body: { items: [{ ...initialMedia, referenced: true, references }] } },
    ],
    mediaDeleteResponses: [{
      status: 409,
      requestId: 'media-still-referenced',
      body: {
        detail: {
          code: 'MEDIA_STILL_REFERENCED',
          message: 'Media is still referenced',
          details: { references },
        },
      },
    }],
  });
  await page.goto('/admin');

  await page.getByRole('button', { name: '媒体资源库' }).click();
  await expect(page.getByText(filename, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '删除' }).click();
  const confirmation = page.getByRole('alertdialog', { name: '删除这张图片？' });
  await confirmation.getByRole('button', { name: '删除图片' }).click();

  await expect(confirmation.getByRole('alert')).toContainText('图片仍被引用，无法删除');
  await expect(confirmation.getByRole('alert')).toContainText('blogPosts[0].coverImage');
  await expect(confirmation.getByRole('button', { name: '删除图片' })).toBeDisabled();
  await expect(page.locator('[data-notice-code="CONFIRMED_ACTION_FAILED"]')).toBeAttached();
  await expect(page.getByText(filename, { exact: true })).toBeVisible();
  await expect(page.getByText('使用中')).toBeVisible();
});

test('keeps editor content unchanged when a revision is structurally incompatible', async ({ page }) => {
  const serverContent = structuredClone(DEFAULT_SITE_CONTENT);
  serverContent.siteSettings.siteTitle = '载入历史版本前的服务器标题';
  const revision = {
    id: 42,
    createdAt: '2026-07-17T08:00:00Z',
    reason: 'incompatible e2e snapshot',
    summary: { posts: 2, drafts: 1, projects: 3, skillGroups: 2, sizeBytes: 4096 },
  };
  await mockAdminApi(page, {
    authenticated: true,
    contentResponses: [{ body: serverContent, etag: '"revision-test-content"' }],
    revisionResponses: [{ body: { items: [revision] } }],
    revisionReadResponses: [{
      status: 409,
      requestId: 'revision-incompatible',
      body: {
        detail: {
          code: 'REVISION_INCOMPATIBLE',
          message: 'Revision payload is incompatible',
          details: { revisionId: revision.id },
        },
      },
    }],
  });
  await page.goto('/admin');

  await page.getByRole('button', { name: '打开版本历史' }).click();
  const revisions = page.getByRole('dialog', { name: '内容版本历史' });
  await expect(revisions.getByText('#42')).toBeVisible();
  await revisions.getByRole('button', { name: '载入到编辑器' }).click();
  const confirmation = page.getByRole('alertdialog', { name: '载入该历史版本？' });
  await confirmation.getByRole('button', { name: '载入版本' }).click();

  await expect(confirmation.getByRole('alert')).toContainText('该历史版本与当前内容结构不兼容');
  await expect(page.locator('[data-notice-code="CONFIRMED_ACTION_FAILED"]')).toBeAttached();
  await confirmation.getByRole('button', { name: '关闭对话框' }).click();
  await page.getByRole('button', { name: '全局设置' }).click();
  await expect(page.getByLabel('浏览器标题 / SEO 标题')).toHaveValue('载入历史版本前的服务器标题');
  await expect(page.getByRole('button', { name: '保存全部更改' })).toBeDisabled();
});

test('exposes explicit accessible names for admin search and icon delete controls', async ({ page }) => {
  await mockAdminApi(page, { authenticated: true, contentResponses: [{ body: DEFAULT_SITE_CONTENT, etag: '"accessible-content"' }] });
  await page.goto('/admin');

  await page.getByRole('button', { name: '作品项目' }).click();
  await expect(page.getByRole('searchbox', { name: '搜索作品项目' })).toBeVisible();
  await page.getByRole('button', { name: '博客文章' }).click();
  await expect(page.getByRole('searchbox', { name: '搜索博客文章' })).toBeVisible();
  await page.getByRole('button', { name: '全局设置' }).click();
  await expect(page.getByRole('button', { name: /^删除导航 / }).first()).toBeVisible();
});

test('traps and restores keyboard focus for the mobile sidebar and revision dialog', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockAdminApi(page, { authenticated: true });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '今天要处理的内容' })).toBeVisible();

  const openNavigation = page.getByRole('button', { name: '打开导航' });
  await openNavigation.focus();
  await page.keyboard.press('Enter');
  const sidebar = page.getByRole('dialog', { name: '后台主导航' });
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole('button', { name: '关闭导航' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await sidebar.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeHidden();
  await expect(openNavigation).toBeFocused();

  const openRevisions = page.getByRole('button', { name: '打开版本历史' });
  await openRevisions.focus();
  await page.keyboard.press('Enter');
  const revisions = page.getByRole('dialog', { name: '内容版本历史' });
  const closeRevisions = revisions.getByRole('button', { name: '关闭版本历史' });
  await expect(closeRevisions).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closeRevisions).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(revisions).toBeHidden();
  await expect(openRevisions).toBeFocused();
});

test('has no serious or critical axe violations on the login screen', async ({ page }) => {
  await mockAdminApi(page, { authenticated: false });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();

  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const violations = result.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map((node) => node.target) })),
  ).toEqual([]);
});
