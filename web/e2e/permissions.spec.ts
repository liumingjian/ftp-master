import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { ADMINISTRATOR_PASSWORD, ADMINISTRATOR_USERNAME, signIn } from './signin'

const browse = 1
const uploadRight = 4
const deleteRight = 16
const fullControl = 63

async function createUser(request: APIRequestContext, username: string, displayName = username): Promise<number> {
  const registration = await request.post('/api/registrations', {
    data: { username, displayName, organizationHint: 'Default', password: ADMINISTRATOR_PASSWORD },
  })
  expect(registration.status()).toBe(201)
  const users = await (await request.get('/api/registrations')).json()
  const { id } = users.find((entry: { username: string }) => entry.username === username)
  const activation = await request.post(`/api/registrations/${id}/activate`, { data: { organizationId: 1 } })
  expect(activation.status()).toBe(204)
  return id
}

async function folder(request: APIRequestContext, name: string, parentId?: number): Promise<number> {
  const response = await request.post('/api/tree', { data: { name, parentId } })
  expect(response.status()).toBe(201)
  return (await response.json()).id
}

async function grant(request: APIRequestContext, node: number, user: number, rights: number) {
  const response = await request.post(`/api/tree/${node}/grants`, {
    data: { principalKind: 'user', principalId: user, rights, scope: 'subtree' },
  })
  expect(response.status()).toBe(201)
}

async function upload(page: Page, parent: number, name: string) {
  await page.goto(`/#item=${parent}`)
  await page.getByLabel('上传文件', { exact: true }).setInputFiles({
    name, mimeType: 'text/plain', buffer: Buffer.from('search permissions'),
  })
  await expect(page.getByRole('button', { name: '更多操作 ' + name, exact: true })).toBeVisible()
}

test('non-admin search uses Delete on each result’s source directory', async ({ page, browser }) => {
  test.setTimeout(60_000)
  const suffix = Date.now()
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await expect(page.getByTestId('current-user')).toBeVisible()
  const username = `search-${suffix}`
  const user = await createUser(page.request, username)
  const removable = await folder(page.request, `Removable-${suffix}`)
  const readonly = await folder(page.request, `Readonly-${suffix}`)
  const hidden = await folder(page.request, `Hidden-${suffix}`)
  await grant(page.request, removable, user, browse | uploadRight | deleteRight)
  await grant(page.request, readonly, user, browse)
  const movableFile = `Search-${suffix}-movable.txt`
  const fixedFile = `Search-${suffix}-fixed.txt`
  const hiddenFile = `Search-${suffix}-hidden.txt`
  await upload(page, removable, movableFile)
  await upload(page, readonly, fixedFile)
  await upload(page, hidden, hiddenFile)
  const [fixed] = await (await page.request.get('/api/tree/search', { params: { q: fixedFile } })).json()
  await grant(page.request, fixed.id, user, browse | deleteRight)

  const reader = await browser.newPage()
  try {
    await reader.goto(`/#item=${removable}`)
    await signIn(reader, username, ADMINISTRATOR_PASSWORD)
    await expect(reader.getByRole('navigation', { name: '目录路径' })).toContainText(`Removable-${suffix}`)
    const query = reader.getByRole('textbox', { name: '按文件名搜索' })
    await query.fill(`Search-${suffix}`)
    await query.press('Enter')
    const table = reader.getByRole('table', { name: '文件列表' })
    await expect(table.getByRole('button', { name: fixedFile, exact: true })).toBeVisible()
    await expect(table.getByRole('button', { name: hiddenFile, exact: true })).toHaveCount(0)
    await table.getByRole('button', { name: '更多操作 ' + fixedFile, exact: true }).click()
    const fixedMenu = reader.getByRole('menu', { name: '操作 ' + fixedFile })
    await expect(fixedMenu).toBeVisible()
    await expect(fixedMenu.getByRole('menuitem', { name: '移动', exact: true })).toHaveCount(0)
    await reader.keyboard.press('Escape')
    await table.getByRole('button', { name: '更多操作 ' + movableFile, exact: true }).click()
    const movableMenu = reader.getByRole('menu', { name: '操作 ' + movableFile })
    await expect(movableMenu.getByRole('menuitem', { name: '移动', exact: true })).toBeVisible()
  } finally {
    await reader.close()
  }
})

test('delegated permissions show direct badges on visible, manageable branches', async ({ page, browser }) => {
  test.setTimeout(60_000)
  const suffix = Date.now()
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  const username = `delegate-${suffix}`
  const user = await createUser(page.request, username)
  const recipient = await createUser(page.request, `recipient-${suffix}`)
  const additionalRecipient = await createUser(page.request, `additional-recipient-${suffix}`)
  const root = await folder(page.request, `Delegated-${suffix}`)
  const outside = await folder(page.request, `Outside-${suffix}`)
  const granted = await folder(page.request, 'Has direct grants', root)
  await folder(page.request, 'Inherits only', root)
  await grant(page.request, root, user, fullControl)
  await grant(page.request, granted, recipient, browse)
  await grant(page.request, outside, user, browse)
  const many = await folder(page.request, 'Many individual grants', root)
  const prefix = `badge-${suffix}-`
  const csv = ['username,display_name,password,organization_id', ...Array.from({ length: 10 }, (_, index) =>
    `${prefix}${index},Reader,${ADMINISTRATOR_PASSWORD},1`)].join('\n')
  expect((await page.request.post('/api/users/import', { data: { csv } })).status()).toBe(201)
  const users: { id: number; username: string }[] = await (await page.request.get('/api/managed-users')).json()
  const add = users.filter(entry => entry.username.startsWith(prefix)).map(entry => ({
    principalKind: 'user', principalId: entry.id, rights: browse, scope: 'subtree',
  }))
  expect(add).toHaveLength(10)
  expect((await page.request.post(`/api/tree/${many}/grant-draft`, { data: { add, remove: [] } })).status()).toBe(204)

  const delegate = await browser.newPage()
  try {
    await delegate.goto(`/#item=${root}`)
    await signIn(delegate, username, ADMINISTRATOR_PASSWORD)
    await delegate.getByRole('button', { name: '管理当前权限' }).click()
    const tree = delegate.getByRole('navigation', { name: '授权目录树' })
    const branch = tree.getByRole('button', { name: /Has direct grants/ })
    await expect(branch.locator('.pill')).toHaveText('1')
    const manyGrants = tree.getByRole('button', { name: /Many individual grants/ })
    await expect(manyGrants.getByRole('img', { name: '10 条个人授权' })).toBeVisible()
    await expect(tree.getByRole('button', { name: 'Inherits only' }).locator('.pill')).toHaveCount(0)
    await expect(tree.getByRole('button', { name: `Outside-${suffix}` }).locator('.pill')).toHaveCount(0)
    await branch.click()
    await expect(tree.getByRole('button', { name: new RegExp(`Delegated-${suffix}`) }).locator('.pill')).toHaveText('1')
    const permissions = delegate.getByRole('region', { name: '权限管理' })
    await expect(permissions.getByText('直接授权 · 1', { exact: true })).toBeVisible()
    const inherited = permissions.getByRole('row').filter({ has: delegate.getByLabel('授权（继承）') })
    await expect(inherited).toBeVisible()
    await expect(inherited.getByRole('checkbox')).toHaveCount(0)
    await permissions.getByText('添加人员、组织或用户组', { exact: true }).click()
    await permissions.getByRole('group', { name: '授权对象类型' }).getByRole('button', { name: '用户', exact: true }).click()
    await permissions.getByLabel('用户编号').fill(String(additionalRecipient))
    await permissions.getByRole('button', { name: '添加到草稿' }).click()
    await permissions.getByRole('button', { name: '保存全部授权' }).click()
    await expect(permissions.getByText('授权已保存', { exact: true })).toBeVisible()
    await expect(branch.locator('.pill')).toHaveText('2')
    expect((await delegate.request.get(`/api/tree/${outside}/grants`)).status()).toBe(403)
    await tree.getByRole('button', { name: `Outside-${suffix}` }).click()
    await expect(permissions.getByText('当前项目没有授权权限，可查看自己的有效权限。')).toBeVisible()
    await expect(permissions.getByText('添加人员、组织或用户组', { exact: true })).toHaveCount(0)
  } finally {
    await delegate.close()
  }
})

test('creator handover distinguishes namesakes and applies only the saved draft', async ({page}) => {
  const suffix = Date.now()
  const username = `successor-${suffix}`
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await expect(page.getByTestId('current-user')).toBeVisible()
  await createUser(page.request, `namesake-${suffix}`, '接任测试')
  const successor = await createUser(page.request, username, '接任测试')
  const parent = await folder(page.request, `Handover-${suffix}`)
  const file = '移交测试.txt'
  await upload(page, parent, file)
  await page.getByRole('button', {name: '更多操作 ' + file, exact: true}).click()
  await page.getByRole('menu', {name: '操作 ' + file}).getByRole('menuitem', {name: '管理权限', exact: true}).click()
  await page.getByRole('button', {name:'转移创建者'}).click()
  const form = page.getByRole('group', {name:'转移创建者'})
  await form.getByRole('searchbox').fill('接任测试')
  await form.getByRole('button', {name:`接任测试（${username}）`}).click()
  await form.getByRole('button', {name:'加入移交草稿'}).click()
  await expect(page.locator('.grant-save')).toContainText(file)
  await expect(page.locator('.grant-save')).toContainText(username)
  await page.getByRole('button', {name:'保存全部授权'}).click()
  await expect(page.getByText('授权已保存', {exact:true})).toBeVisible()
  await page.locator('.permission-inspection > summary').click()
  const query = page.getByRole('region', {name:'有效权限查询'})
  await query.getByRole('searchbox').fill(username)
  await query.getByRole('button', {name:`接任测试（${username}）`}).click()
  const result = page.waitForResponse(res => res.url().includes('/permission?userId=' + successor))
  await query.getByRole('button', {name:'查询用户有效权限'}).click()
  expect((await (await result).json()).rights).toBe(63)
})
