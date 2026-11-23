/// <reference lib="dom" />

import { expect, test } from '@playwright/test';
import { ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD, signIn } from './signin'
import { createAndOpenFolder } from './explorer'

test('Office file names preview and row edit icons follow the plugin capabilities', async ({page}) => {
  const formats = ['doc', 'docx', 'wps', 'xls', 'xlsx'];
  const nodes = formats.map((format, index) => ({id: index + 100, name: `renamed-${format}.txt`, isFile: true, rights: 11, traversable: false, latestVersion: {id: index + 200, format, size: 26214400}}));
  const rejected = [
    {...nodes[0], id: 110, name: 'no-modify.doc', rights: 3},
    {...nodes[0], id: 111, name: 'too-large.doc', latestVersion: {id: 211, format: 'doc', size: 26214401}},
    {...nodes[0], id: 112, name: 'fake.doc', latestVersion: {id: 212, format: 'txt', size: 1}},
    {...nodes[0], id: 113, name: 'directory.doc', isFile: false},
    {...nodes[0], id: 114, name: 'no-version.doc', latestVersion: undefined},
  ];
  await page.route('**/api/tree', route => route.request().method() === 'GET' ? route.fulfill({json: [...nodes, ...rejected]}) : route.continue());
  await page.goto('/sign-in');
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD);
  await expect(page.getByTestId('current-user')).toBeVisible();
  const officeName = nodes[1].name;
  const fileList = page.getByRole('table', {name: '文件列表'});
  const editLink = fileList.getByRole('link', {name: `在线编辑 ${officeName}`});
  async function expectPluginPrompt(click: () => Promise<void>) {
    const prompt = page.waitForEvent('dialog').then(async dialog => {
      const message = dialog.message();
      await dialog.accept();
      return message;
    });
    const [message] = await Promise.all([prompt, click()]);
    expect(message).toContain('当前站点未检测到可用的 WPS 编辑插件');
    expect(message).toContain(new URL(page.url()).origin);
  }
  await expect(editLink).toBeEnabled();
  await expectPluginPrompt(() => editLink.click());
  await fileList.getByRole('button', {name: '详情与操作 ' + officeName}).click();
  const detail = page.getByRole('complementary', {name:'项目详情'});
  await detail.getByLabel('更多操作').click();
  await expectPluginPrompt(() => detail.getByRole('link', {name: `在线编辑 ${officeName}`}).press('Enter'));
  await detail.getByRole('button', {name:'关闭详情'}).click();
  await page.getByRole('button', {name: officeName, exact: true}).click();
  const viewer = page.getByRole('dialog', {name: officeName});
  await expect(viewer.getByText('在线预览需要支持预览的 ftp-master WPS 插件')).toBeVisible();
  await expect(viewer.getByRole('link', {name: '下载', exact: true})).toBeVisible();
  await expect(viewer.getByText('在线编辑', {exact: true})).toHaveCount(0);
  await viewer.getByRole('button', {name: '关闭文件查看'}).click();
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-ftp-office-plugin', '0.1.0');
    document.documentElement.setAttribute('data-ftp-office-preview', '1');
  });
  await expect(editLink).toBeVisible();
  await expect(editLink).toHaveAttribute('href', `/api/files/${nodes[1].id}/office-edits`);
  await expect(editLink).toHaveAttribute('data-ftp-office-version', String(nodes[1].latestVersion.id));
  await expect(editLink).toHaveAttribute('target', '_blank');
  await expect(fileList.locator('a[data-ftp-office-edit]')).toHaveCount(nodes.length);
  const preview = fileList.getByRole('link', {name: officeName, exact: true});
  await expect(preview).toHaveAttribute('data-ftp-office-preview', '1');
  await expect(preview).toHaveAttribute('data-ftp-office-version', String(nodes[1].latestVersion.id));
  await expect(fileList.getByRole('link', {name: 'no-modify.doc', exact: true})).toHaveAttribute('data-ftp-office-preview', '1');
  await expect(fileList.getByRole('link', {name: '在线编辑 no-modify.doc'})).toHaveCount(0);
  await preview.click();
  await expect(viewer).toHaveCount(0);
  for (const link of await page.locator('a[download]').all()) {
    expect(new URL((await link.getAttribute('href'))!, page.url()).pathname).not.toMatch(/\.(doc|docx|wps|xls|xlsx)$/i);
    await expect(link).not.toHaveAttribute('data-ftp-office-edit');
  }
  await expect(editLink).toBeVisible();
  await expectPluginPrompt(() => editLink.click()); // A stale marker alone cannot open an editor.
  await page.evaluate(() => document.documentElement.removeAttribute('data-ftp-office-plugin'));
  await expect(editLink).toBeEnabled();
});

// This substitutes only the extension and native WPS process; every HTTP call
// and storage operation below reaches the real application and local stores.
for (const format of ['docx', 'xlsx']) {
  test(`simulated plugin and WPS deliver and save ${format} through real endpoints`, async ({page}) => {
    const { readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const bytes = await readFile(new URL(`./fixtures/office.${format}`, import.meta.url));
    const editedBytes = await readFile(new URL(`./fixtures/office-edited.${format}`, import.meta.url));
    expect(editedBytes).not.toEqual(bytes);
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-ftp-office-plugin', '0.1.0'));
    });
    await page.goto('/sign-in');
    await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD);
    const panel = page.getByRole('region', {name: '共享目录'});
    const dir = `Office-${format}-${Date.now()}`;
    await createAndOpenFolder(page, dir);
    const name = `office.${format}`;
    const dirs = await (await page.request.get('/api/tree')).json();
    const parentId = dirs.find((entry: {name: string}) => entry.name === dir).id;
    const session = await (await page.request.post('/api/uploads', {data: {parentId, name, size: bytes.length}})).json();
    const parts = await (await page.request.post(`/api/uploads/${session.id}/parts`, {data: {numbers: [1]}})).json();
    expect((await page.request.put(parts[0].url, {data: bytes})).status()).toBe(200);
    expect((await page.request.post(`/api/uploads/${session.id}/complete`)).status()).toBe(200);
    await panel.getByRole('button', {name:'根目录', exact:true}).click();
    await panel.getByRole('button', {name:dir, exact:true}).click();
    const link = panel.getByRole('link', {name: `在线编辑 ${name}`, exact: true});
    await expect(link).toBeVisible();
    const baseVersion = Number(await link.getAttribute('data-ftp-office-version'));
    await page.evaluate(({content, md5, format}) => {
      const state = window as typeof window & {officeResult?: Promise<Record<string, unknown>>};
      document.addEventListener('click', event => {
        const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[data-ftp-office-edit="1"]');
        if (!anchor || anchor.origin !== location.origin) return;
        event.preventDefault();
        state.officeResult = (async () => {
          const start = await fetch(anchor.href, {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({versionId: Number(anchor.dataset.ftpOfficeVersion)})});
          if (start.status !== 201) throw new Error(`start ${start.status}`);
          const permit = await start.json();
          const before = await (await fetch(permit.deliveryCheckUrl)).json();
          const gateway = await fetch(permit.documentUrl, {credentials:'omit', redirect:'error'});
          const downloaded = Array.from(new Uint8Array(await gateway.arrayBuffer()));
          const after = await (await fetch(permit.deliveryCheckUrl)).json();
          if (!after.delivered) throw new Error('editor remains locked');
          const body = new FormData();
          if (format === 'docx') {
            body.append('filedata', new Blob([new Uint8Array(content)]), 'office.docx');
            body.append('filename', 'office.docx');
            body.append('md5sum', md5);
          } else body.append('file', new Blob([new Uint8Array(content)]), '');
          const save = await fetch(permit.saveUrl, {method: 'POST', body});
          return {before: before.delivered, after: after.delivered, downloaded, gateway: gateway.status, save: save.status, receipt: await save.json()};
        })();
      }, true);
    }, {content: Array.from(editedBytes), md5: createHash('md5').update(editedBytes).digest('hex'), format});
    await link.click();
    const result = await page.evaluate(async () => (window as typeof window & {officeResult: Promise<any>}).officeResult);
    expect(result.before).toBe(false);
    expect(result.after).toBe(true);
    expect(result.gateway).toBe(200);
    expect(Buffer.from(result.downloaded)).toEqual(bytes);
    expect(result.save).toBe(200);
    expect(result.receipt.Success).toBe(true);
    expect(result.receipt.Data.baseVersionId).toBe(baseVersion);
    expect(result.receipt.Data.versionId).not.toBe(baseVersion);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(link).toHaveAttribute('data-ftp-office-version', String(result.receipt.Data.versionId));
    await expect(page.getByRole('dialog', {name})).toHaveCount(0);
    const pendingDownload = page.waitForEvent('download');
    await panel.getByRole('link', {name: `下载 ${name}`, exact:true}).click();
    const download = await pendingDownload;
    expect(download.suggestedFilename()).toBe(name);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(editedBytes);

    await page.getByRole('button', {name: `详情与操作 ${name}`, exact:true}).click();
    await page.getByRole('button', {name:'版本历史', exact:true}).click();
    await expect(page.getByRole('region', {name:'文件版本'})).toContainText(`版本 ${result.receipt.Data.versionId} ·`);
  });
}
