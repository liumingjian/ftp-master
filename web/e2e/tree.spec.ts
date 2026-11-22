import { expect, test } from "@playwright/test";
import {
  ADMINISTRATOR_USERNAME,
  ADMINISTRATOR_PASSWORD,
  signIn,
} from "./signin";
import { createAndOpenFolder } from "./explorer";

test("Administrator grants a directory and another User can browse it", async ({
  page,
  browser,
}) => {
  const suffix = Date.now().toString();
  const username = `tree-${suffix}`;
  expect(
    (
      await page.request.post("/api/registrations", {
        data: {
          username,
          displayName: "Reader",
          organizationHint: "Default",
          password: ADMINISTRATOR_PASSWORD,
        },
      })
    ).status(),
  ).toBe(201);
  await page.goto("/sign-in");
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD);
  await expect(page.getByTestId("current-user")).toBeVisible();
  const registrations = await (
    await page.request.get("/api/registrations")
  ).json();
  const userId = String(
    registrations.find((r: { username: string }) => r.username === username).id,
  );
  expect(
    (
      await page.request.post("/api/registrations/" + userId + "/activate", {
        data: { organizationId: 1 },
      })
    ).status(),
  ).toBe(204);
  const panel = page.getByRole("region", { name: "共享目录" });
  const groupName = `Readers-${suffix}`;
  const groupResponse = await page.request.post("/api/user-groups", { data: { name: groupName } });
  expect(groupResponse.status()).toBe(201);
  const group = await groupResponse.json();
  expect((await page.request.put(`/api/user-groups/${group.id}/members`, {
    data: { userIds: [Number(userId)] },
  })).status()).toBe(204);
  const name = `Granted-${suffix}`;
  await createAndOpenFolder(page, name);
  await panel.getByRole("button", { name: "管理当前权限" }).click();
  const permissions = page.getByRole("region", {name: "权限管理"});
  await permissions.getByText("添加人员、组织或用户组", { exact: true }).click();
  await permissions.getByRole("searchbox", { name: "搜索用户组" }).fill(groupName);
  await permissions.getByRole("button", { name: groupName + " 1 位成员", exact: true }).click();
  await permissions.getByLabel("修改", {exact:true}).check();
  await permissions.getByRole("button", {name:"添加到草稿"}).click();
  await expect(permissions.getByRole("cell", {name:"自定义 · 待保存"})).toBeVisible();
  await permissions.getByRole("button", { name: "保存全部授权" }).click();
  await expect(permissions.getByText("授权已保存", { exact: true })).toBeVisible();
  await permissions.getByRole('button', { name: '返回目录', exact: true }).click();
  await createAndOpenFolder(page, 'Inherited');
  await panel.getByRole('button', { name: '管理当前权限' }).click();
  await expect(permissions.getByRole('button', { name: '从上层继承 · 1' })).toHaveAttribute('aria-expanded', 'true');
  await expect(permissions.getByRole('button', { name: '/' + name, exact: true })).toBeVisible();
  await expect(permissions.getByLabel('修改（继承）')).toBeVisible();
  const context = await browser.newContext();
  const reader = await context.newPage();
  await reader.goto("/sign-in");
  await signIn(reader, username, ADMINISTRATOR_PASSWORD);
  const files = reader.getByRole("region", { name: "共享目录" });
  await expect(files.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(files.getByRole("button", { name: "创建目录" })).toHaveCount(0);
  await files.getByRole("button", { name, exact: true }).click();
  await expect(
    files.getByRole("navigation", { name: "目录路径" }),
  ).toContainText(name);
  await expect(files.getByRole("button", { name: "保存授权" })).toHaveCount(0);
  await context.close();
});

test('file details dismiss from the surrounding workspace and keep active rename input', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await createAndOpenFolder(page, `Details-${Date.now()}`)
  await page.getByLabel('上传文件', { exact: true }).setInputFiles({
    name: 'details.txt', mimeType: 'text/plain', buffer: Buffer.from('File details'),
  })

  const open = page.getByRole('button', { name: '更多操作 details.txt', exact: true })
  const detail = page.getByRole('complementary', { name: '项目详情' })
  await open.click()
  await detail.getByRole('heading', { name: 'details.txt' }).click()
  await expect(detail).toBeVisible()
  await page.mouse.click(400, 650)
  await expect(detail).toHaveCount(0)

  await open.click()
  await detail.getByRole('button', { name: '重命名' }).click()
  await detail.getByLabel('新名称').fill('draft.txt')
  await page.mouse.click(400, 650)
  await expect(detail.getByLabel('新名称')).toHaveValue('draft.txt')
  await detail.getByRole('button', { name: '取消' }).click()
  await expect(detail.getByLabel('新名称')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(detail).toHaveCount(0)
  await expect(open).toBeFocused()
})

test('clicking an image opens only the preview and uses the saved format after rename', async ({ page }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await createAndOpenFolder(page, `Preview-${Date.now()}`)
  await page.getByLabel('上传文件', { exact: true }).setInputFiles({
    name: 'image.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf2sAAAAASUVORK5CYII=', 'base64'),
  })
  await page.getByRole('button', { name: '更多操作 image.png' }).click()
  await page.getByRole('button', { name: '重命名', exact: true }).click()
  await page.getByLabel('新名称').fill('image-renamed')
  await page.getByRole('button', { name: '保存名称', exact: true }).click()
  await page.getByRole('button', { name: '关闭详情' }).click()

  const filename = page.getByRole('button', { name: 'image-renamed', exact: true })
  await filename.click()
  const viewer = page.getByRole('dialog', { name: 'image-renamed' })
  const image = viewer.getByRole('img', { name: 'image-renamed' })
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1)
  await expect(viewer.getByRole('button', { name: '重命名' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(filename).toBeFocused()
  await expect(page.getByRole('complementary', { name: '项目详情' })).toHaveCount(0)
})

test("Administrator renames and moves a directory using the destination picker", async ({page})=>{
 const suffix=Date.now().toString();
 await page.goto("/sign-in");await signIn(page,ADMINISTRATOR_USERNAME,ADMINISTRATOR_PASSWORD);
 await expect(page.getByTestId("current-user")).toBeVisible();
 const create=async(name:string,parentId?:number)=>{const response=await page.request.post("/api/tree",{data:{name,parentId}});expect(response.status()).toBe(201);return await response.json() as {id:number}};
 const source=await create(`Move-source-${suffix}`);const target=await create(`Move-target-${suffix}`);await create(`Original-${suffix}`,source.id);
 await page.reload();await page.getByRole("button",{name:`Move-source-${suffix}`,exact:true}).click();
 await page.getByRole('button', {name: `更多操作 Original-${suffix}`, exact: true}).click()
 await page.getByRole('button', {name: '重命名', exact: true}).click()
 await page.getByLabel('新名称').fill(`Renamed-${suffix}`)
 await page.getByRole('button', {name: '保存名称', exact: true}).click()
 await expect(page.getByRole("button",{name:`Renamed-${suffix}`,exact:true})).toBeVisible();
 await page.getByRole("button",{name:`移动 Renamed-${suffix}`,exact:true}).click();
 const picker=page.getByRole("region",{name:"移动目标"});await picker.getByRole("button",{name:`Move-target-${suffix}`,exact:true}).click();await picker.getByRole("button",{name:"移动到此目录",exact:true}).click();
 await expect(page.getByText("项目已移动",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:`Renamed-${suffix}`,exact:true})).toHaveCount(0);
 const response=await page.request.get(`/api/tree?parentId=${target.id}`);expect((await response.json()).map((n:{name:string})=>n.name)).toContain(`Renamed-${suffix}`);
});

test('a copied file link survives sign-in and header search returns from the recycle bin', async ({ page, browser }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  const folder = `Link-${Date.now()}`
  await createAndOpenFolder(page, folder)
  const filename = `${folder}.txt`
  await page.getByLabel('上传文件', { exact: true }).setInputFiles({
    name: filename, mimeType: 'text/plain', buffer: Buffer.from('Deep link preview'),
  })
  const table = page.getByRole('table', { name: '文件列表' })
  await expect(table.getByRole('button', { name: filename, exact: true })).toBeVisible()
  const search = await page.request.get('/api/tree/search', { params: { q: filename } })
  expect(search.ok()).toBeTruthy()
  const [file] = await search.json()

  const visitor = await browser.newPage()
  try {
    await visitor.goto(`/#item=${file.id}`)
    await signIn(visitor, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
    await expect(visitor.getByRole('region', { name: '文件预览' })).toBeVisible()
    await visitor.getByRole('button', { name: '关闭文件查看' }).click()
    await expect(visitor.getByRole('navigation', { name: '目录路径' })).toContainText(folder)
  } finally {
    await visitor.close()
  }

  await page.getByRole('link', { name: '回收站', exact: true }).click()
  await expect(page.getByRole('region', { name: '回收站' })).toBeVisible()
  const query = page.getByRole('textbox', { name: '按文件名搜索' })
  await query.fill(filename)
  await query.press('Enter')
  await expect(table.getByRole('button', { name: filename, exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '回收站' })).toHaveCount(0)

  const openParent = table.getByRole('link', { name: `打开所在目录 /${folder}` })
  await openParent.click()
  await expect(page.getByRole('heading', { name: folder, exact: true })).toBeVisible()
  await page.goBack()
  await expect(query).toHaveValue(filename)
  await expect(openParent).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  const more = table.getByRole('button', { name: `更多操作 ${filename}` })
  await more.click()
  const details = page.getByRole('dialog', { name: '项目详情' })
  await expect(details).toContainText(`/${folder}`)
  await details.getByRole('button', { name: '文件版本', exact: true }).click()
  await expect(details.getByRole('region', { name: '文件版本' })).toContainText('当前版本')
  await details.getByRole('button', { name: '返回文件详情' }).click()
  await expect(details.getByRole('button', { name: '概览' })).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
  await expect(more).toBeFocused()
})

test('Administrator restores a deleted item into a directory selected in the recycle bin', async ({ page }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  const suffix = Date.now()
  const original = `Restore-source-${suffix}`
  const target = `Restore-target-${suffix}`
  const table = page.getByRole('table', { name: '文件列表' })
  await createAndOpenFolder(page, target)
  await page.getByRole('button', { name: '根目录', exact: true }).click()
  await createAndOpenFolder(page, original)
  await page.getByRole('button', { name: '根目录', exact: true }).click()
  await table.getByRole('button', { name: `更多操作 ${original}`, exact: true }).click()
  await page.getByRole('button', { name: `删除 ${original}`, exact: true }).click()
  await expect(table.getByRole('button', { name: original, exact: true })).toHaveCount(0)

  await page.getByRole('link', { name: '回收站', exact: true }).click()
  const recycle = page.getByRole('region', { name: '回收站', exact: true })
  const entry = recycle.getByRole('listitem').filter({ hasText: original })
  await entry.getByRole('button', { name: '恢复到指定目录', exact: true }).click()
  const picker = recycle.getByRole('region', { name: '选择恢复位置' })
  await expect(picker.getByRole('button', { name: '恢复到此目录' })).toBeDisabled()
  await picker.getByRole('button', { name: target, exact: true }).click()
  await picker.getByRole('button', { name: '恢复到此目录' }).click()
  await expect(recycle.getByRole('status')).toHaveText('项目已恢复')
  await page.getByRole('navigation', { name: '目录树' }).getByRole('link', { name: target, exact: true }).click()
  await expect(table.getByRole('button', { name: original, exact: true })).toBeVisible()
})
