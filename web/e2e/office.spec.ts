/// <reference lib="dom" />

import { expect, test } from '@playwright/test';
import { ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD, signIn } from './signin';

test('Office edit entries require presence, Modify, supported actual format and at most 25 MiB', async ({page}) => {
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
  await expect(page.locator('a[data-ftp-office-edit]')).toHaveCount(0);
  await page.evaluate(() => document.documentElement.setAttribute('data-ftp-office-plugin', '0.1.0'));
  await expect(page.locator('a[data-ftp-office-edit]')).toHaveCount(5);
  for (const node of nodes) {
    const link = page.getByRole('link', {name: `在线编辑 ${node.name}`});
    await expect(link).toHaveAttribute('href', `/api/files/${node.id}/office-edits`);
    await expect(link).toHaveAttribute('data-ftp-office-version', String(node.latestVersion.id));
    await expect(link).toHaveAttribute('target', '_blank');
  }
  for (const link of await page.locator('a[download]').all()) {
    expect(new URL((await link.getAttribute('href'))!, page.url()).pathname).not.toMatch(/\.(doc|docx|wps|xls|xlsx)$/i);
    await expect(link).not.toHaveAttribute('data-ftp-office-edit');
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-ftp-office-plugin', '  '));
  await expect(page.locator('a[data-ftp-office-edit]')).toHaveCount(0);
  await page.evaluate(() => document.documentElement.removeAttribute('data-ftp-office-plugin'));
  await expect(page.locator('a[data-ftp-office-edit]')).toHaveCount(0);
});

// This substitutes only the extension and native WPS process; every HTTP call
// and storage operation below reaches the real application and local stores.
for (const format of ['docx', 'xlsx']) {
  test(`simulated plugin and WPS deliver and save ${format} through real endpoints`, async ({page}) => {
    const { readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const bytes = await readFile(new URL(`./fixtures/office.${format}`, import.meta.url));
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-ftp-office-plugin', '0.1.0'));
    });
    await page.goto('/sign-in');
    await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD);
    const panel = page.getByRole('region', {name: '共享目录'});
    const dir = `Office-${format}-${Date.now()}`;
    await panel.getByLabel('目录名称').fill(dir);
    await panel.getByRole('button', {name: '创建目录'}).click();
    await panel.getByRole('button', {name: dir, exact: true}).click();
    const name = `office.${format}`;
    const dirs = await (await page.request.get('/api/tree')).json();
    const parentId = dirs.find((entry: {name: string}) => entry.name === dir).id;
    const session = await (await page.request.post('/api/uploads', {data: {parentId, name, size: bytes.length}})).json();
    const parts = await (await page.request.post(`/api/uploads/${session.id}/parts`, {data: {numbers: [1]}})).json();
    expect((await page.request.put(parts[0].url, {data: bytes})).status()).toBe(200);
    expect((await page.request.post(`/api/uploads/${session.id}/complete`)).status()).toBe(200);
    await panel.getByRole('button', {name:'根目录', exact:true}).click();
    await panel.getByRole('button', {name:dir, exact:true}).click();
    const link = panel.getByRole('link', {name: `在线编辑 ${name}`});
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
    }, {content: Array.from(bytes), md5: createHash('md5').update(bytes).digest('hex'), format});
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
    const pendingDownload = page.waitForEvent('download');
    await panel.getByRole('link', {name: `下载 ${name}`, exact:true}).click();
    const download = await pendingDownload;
    expect(download.suggestedFilename()).toBe(name);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);

    await page.getByRole('button', {name:'文件版本', exact:true}).click();
    await expect(page.getByRole('region', {name:'文件版本'})).toContainText(`版本 ${result.receipt.Data.versionId} ·`);
  });
}
