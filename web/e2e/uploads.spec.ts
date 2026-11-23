import { expect, test } from '@playwright/test'
import { ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD, signIn } from './signin'
import { createAndOpenFolder, openAccountPage, openManagementPage } from './explorer'

test('upload settings separate the active rules from the editor', async ({ page }) => {
  await page.route('**/api/upload-policy', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { blockedExtensions: ['exe'] } })
      return
    }
    const { blockedExtensions } = route.request().postDataJSON()
    expect(blockedExtensions).toEqual(['.BAT', 'cmd'])
    await route.fulfill({ json: { blockedExtensions: ['bat', 'cmd'] } })
  })
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  await openManagementPage(page, '系统设置')
  const panel = page.getByRole('region', { name: '上传扩展名限制' })
  const edit = panel.getByRole('button', { name: '编辑规则' })
  const draft = panel.getByRole('textbox', { name: '禁止扩展名' })
  const activeRules = panel.getByRole('list', { name: '当前禁止的扩展名' })

  await expect(activeRules).toContainText('.exe')
  await expect(draft).toHaveCount(0)
  await edit.click()
  await expect(draft).toBeFocused()
  await draft.fill('bat')
  await panel.getByRole('button', { name: '取消' }).click()
  await expect(edit).toBeFocused()
  await expect(activeRules).toContainText('.exe')
  await edit.click()
  await draft.fill('.BAT，cmd')
  await panel.getByRole('button', { name: '保存上传限制' }).click()
  await expect(activeRules).toContainText('.bat')
  await expect(activeRules).toContainText('.cmd')
  await expect(panel.getByRole('status')).toHaveText('上传限制已保存')
})

test('browser sends real multipart bytes to public storage and shows in-place progress', async ({ page }) => {
  await page.clock.install()
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  const panel = page.getByRole('region', { name: '共享目录' })
  const dir = `Upload-${Date.now()}`
  await createAndOpenFolder(page, dir)
  const transferRow = panel.locator('tr.transfer-row')
  await expect(transferRow).toHaveAttribute('hidden', '')
  const storageResponses: number[] = []
  page.on('response', response => {if (response.request().method() === 'PUT' && response.url().includes('uploadId=')) storageResponses.push(response.status())})
  const [picker] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }),
    panel.getByRole('button', { name: '点击选择文件，或拖到这里上传' }).click({ position: { x: 24, y: 24 } }),
  ])
  await picker.setFiles({ name: 'multipart.txt', mimeType: 'text/plain', buffer: Buffer.alloc(9 * 1024 * 1024, 65) })
  await expect(panel.getByRole('status', { name: '上传进度' })).toContainText('上传完成', {timeout: 60000})
  await expect(transferRow).toBeVisible()
  await expect(panel.getByRole('status', { name: '上传进度' })).not.toContainText('剩余')
  await page.clock.fastForward(3500)
  await expect(panel.getByRole('status', { name: '上传进度' })).toHaveCount(0)
  await expect(transferRow).toHaveAttribute('hidden', '')
  await expect(panel.getByRole('button', { name: 'multipart.txt', exact: true })).toBeVisible()
  expect(storageResponses).toEqual([200, 200])
  await panel.getByLabel('上传文件',{exact:true}).setInputFiles({ name: 'blocked.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('no') })
  await expect(panel.getByRole('status', { name: '上传进度' })).toContainText('blocked extension')
  await page.clock.fastForward(3500)
  await expect(panel.getByRole('status', { name: '上传进度' })).toContainText('blocked extension')
  expect(storageResponses).toEqual([200, 200])
})

test('Office filenames download through extensionless links using the native browser manager', async ({ page }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  const panel = page.getByRole('region', { name: '共享目录' })
  const dir = `Download-${Date.now()}`
  await createAndOpenFolder(page, dir)
  const bytes = Buffer.from('immutable Office download bytes')
  await panel.getByLabel('上传文件',{exact:true}).setInputFiles({name: '报告.docx', mimeType: 'application/octet-stream', buffer: bytes})
  await expect(panel.getByRole('status', {name: '上传进度'})).toContainText('上传完成')
  const link = panel.getByRole('link', {name: '下载 报告.docx'})
  const href = await link.getAttribute('href')
  expect(new URL(href!, page.url()).pathname).not.toMatch(/\.(doc|docx|wps|xls|xlsx)$/i)
  const pending = page.waitForEvent('download')
  await link.click()
  const download = await pending
  expect(download.suggestedFilename()).toBe('报告.docx')
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks)).toEqual(bytes)
})

test('same-name uploads ask on the row and preserve both choices', async ({ page }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  const panel = page.getByRole('region', { name: '共享目录' })
  const dir = `Clash-${Date.now()}`
  await createAndOpenFolder(page, dir)
  const file = { name: 'same.txt', mimeType: 'text/plain', buffer: Buffer.from('first') }
  await panel.getByLabel('上传文件',{exact:true}).setInputFiles(file)
  await expect(panel.getByRole('status', { name: '上传进度' })).toContainText('上传完成')
  for (const choice of ['存为新版本', '保留两者']) {
    await panel.getByLabel('上传文件',{exact:true}).setInputFiles({ ...file, buffer: Buffer.from(choice) })
    await expect(panel.getByRole('button', { name: '存为新版本', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: '保留两者', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: choice, exact: true }).click()
    await expect(panel.getByRole('status', { name: '上传进度' })).toContainText('上传完成')
  }
  await expect(panel.getByRole('button', { name: 'same.txt', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'same (1).txt', exact: true })).toBeVisible()
})

test('reload resumes only missing stored parts and rejects a different file', async ({page}) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  const panel = page.getByRole('region', {name:'共享目录'})
  const dir = `Resume-${Date.now()}`
  await createAndOpenFolder(page, dir)
  let interrupted = false
  await page.route('**/*partNumber=2*', async route => { interrupted = true; await route.abort() })
  const file = {name:'resume.txt',mimeType:'text/plain',buffer:Buffer.alloc(9*1024*1024,66)}
  await panel.getByLabel('上传文件', {exact:true}).setInputFiles(file)
  await expect.poll(() => interrupted).toBe(true)
  await expect(panel.getByLabel('重新选择文件')).toBeVisible()
  await page.reload()
  await panel.getByLabel('重新选择文件').setInputFiles({...file,name:'wrong.txt'})
  await expect(panel.getByRole('status',{name:'上传进度'})).toContainText('不匹配')
  await page.unroute('**/*partNumber=2*')
  const sent: string[]=[]
  page.on('request',r=>{if(r.method()==='PUT' && r.url().includes('uploadId=')) sent.push(new URL(r.url()).searchParams.get('partNumber')!)})
  const chooser = page.waitForEvent('filechooser')
  await panel.getByRole('button', { name: '继续上传', exact: true }).click()
  await (await chooser).setFiles(file)
  await expect(panel.getByRole('status',{name:'上传进度'})).toContainText('上传完成',{timeout:60000})
  expect(sent).toEqual(['2'])
  const pending=page.waitForEvent('download')
  await panel.getByRole('link',{name:'下载 resume.txt'}).click()
  const stream=await (await pending).createReadStream()
  const chunks:Buffer[]=[]
  for await(const chunk of stream!) chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks)).toEqual(file.buffer)
})

test('folder manifests publish nested structure together after all transfers finish', async ({page}) => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'folder-upload-'))
  const root=path.join(temp,'Batch')
  await fs.mkdir(path.join(root,'nested'),{recursive:true})
  await fs.writeFile(path.join(root,'a.txt'),'one')
  await fs.writeFile(path.join(root,'nested','b.txt'),'two')
  try {
    await page.clock.install()
    await page.goto('/sign-in')
    await signIn(page,ADMINISTRATOR_USERNAME,ADMINISTRATOR_PASSWORD)
    const panel=page.getByRole('region',{name:'共享目录'})
    const name=`Folder-${Date.now()}`
    await createAndOpenFolder(page, name)
    await panel.getByRole('table', {name:'文件列表'}).getByLabel('选择文件夹', {exact:true}).setInputFiles(root)
    await expect(panel.getByRole('status',{name:'文件夹上传进度'})).toContainText('2/2 个文件 · 上传完成')
    await page.clock.fastForward(3500)
    await expect(panel.getByRole('status',{name:'文件夹上传进度'})).toHaveCount(0)
    await panel.getByRole('button',{name:'Batch',exact:true}).click()
    await expect(panel.getByRole('button',{name:'a.txt',exact:true})).toBeVisible()
    await panel.getByRole('button',{name:'nested',exact:true}).click()
    await expect(panel.getByRole('button',{name:'b.txt',exact:true})).toBeVisible()
  } finally {await fs.rm(temp,{recursive:true,force:true})}
})

test('offline uploads resume automatically and leave prompt is limited to running transfers', async ({page,context})=>{
 await page.goto('/sign-in');await signIn(page,ADMINISTRATOR_USERNAME,ADMINISTRATOR_PASSWORD)
 const panel=page.getByRole('region',{name:'共享目录'}),name=`Offline-${Date.now()}`
 await createAndOpenFolder(page, name)
 let interrupted=false
 let promptWhileRunning=false
 await page.route('**/*partNumber=2*',async route=>{if(interrupted){await route.continue();return};interrupted=true;promptWhileRunning=await page.evaluate("(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented})()");await context.setOffline(true);await route.abort()})
 await panel.getByLabel('上传文件',{exact:true}).setInputFiles({name:'offline.txt',mimeType:'text/plain',buffer:Buffer.alloc(9*1024*1024,70)})
 await expect(panel.getByRole('alert')).toContainText('已保存的分片会保留')
 await expect(panel.getByLabel('重新选择文件')).toBeVisible()
 expect(promptWhileRunning).toBe(true)
 await context.setOffline(false)
 await expect(panel.getByRole('status',{name:'上传进度'})).toContainText('上传完成',{timeout:60000})
 expect(await page.evaluate("(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented})()")).toBe(false)
})

test('folder PUT progress and active rows share one destination pill; empty drops survive',async({page})=>{
 await page.goto('/sign-in');await signIn(page,ADMINISTRATOR_USERNAME,ADMINISTRATOR_PASSWORD)
 const panel=page.getByRole('region',{name:'共享目录'}),name=`Review-${Date.now()}`
 await createAndOpenFolder(page, name)
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve)
 await page.route('**/*partNumber=2*',async route=>{await gate;await route.continue()})
 // Chromium's drop-entry boundary carries directories that a FileList omits.
 await expect(panel.getByRole('table', {name:'文件列表'}).getByLabel('选择文件夹', {exact:true})).toBeAttached()
 await panel.getByRole('table', {name:'文件列表'}).evaluate(table=>{
  const directory=(name:string,children:unknown[])=>({name,isFile:false,isDirectory:true,createReader:()=>{let read=false;return {readEntries:(done:(entries:unknown[])=>void)=>{done(read?[]:children);read=true}}}})
  const file={name:'large.txt',isFile:true,isDirectory:false,file:(done:(file:File)=>void)=>done(new File([new Uint8Array(9*1024*1024)],'large.txt'))}
  const root=directory('Batch',[file,directory('empty',[directory('leaf',[])])])
  const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{items:[{webkitGetAsEntry:()=>root}]}});table.dispatchEvent(event)
 })
 await expect(panel.getByRole('status',{name:'文件夹上传进度'})).toContainText('8388608/9437184 字节')
 await panel.getByLabel('上传文件',{exact:true}).setInputFiles({name:'single.txt',mimeType:'text/plain',buffer:Buffer.alloc(9*1024*1024)})
 await expect(panel.getByRole('status',{name:'上传进度',exact:true})).toContainText('上传中')
 await panel.getByRole('navigation',{name:'目录路径'}).getByRole('button',{name:'根目录',exact:true}).click()
 const pill=page.locator('.shell-header summary').filter({hasText:'其他目录上传'})
 await expect(pill).toHaveCount(1);await expect(pill).toHaveText('其他目录上传 2')
 await pill.click();await page.locator('.shell-header').getByRole('button',{name,exact:true}).click()
 await expect(pill).toHaveCount(0)
 release()
 await expect(panel.getByRole('status',{name:'文件夹上传进度'})).toContainText('上传完成')
 await expect(panel.getByRole('status',{name:'上传进度',exact:true})).toContainText('上传完成')
 await panel.getByRole('button',{name:'Batch',exact:true}).click();await panel.getByRole('button',{name:'empty',exact:true}).click();await expect(panel.getByRole('button',{name:'leaf',exact:true})).toBeVisible()
 await expect(panel.getByRole('table', {name:'文件列表'}).getByLabel('选择文件夹', {exact:true})).toBeAttached()
 await panel.getByRole('table', {name:'文件列表'}).evaluate(table=>{
  const root={name:'OnlyEmpty',isFile:false,isDirectory:true,createReader:()=>({readEntries:(done:(entries:unknown[])=>void)=>done([])})}
  const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{items:[{webkitGetAsEntry:()=>root}]}});table.dispatchEvent(event)
 })
 await expect(panel.getByRole('button',{name:'OnlyEmpty',exact:true})).toBeVisible()
 await page.evaluate(()=>{Object.defineProperty(window,'showDirectoryPicker',{configurable:true,value:async()=>({name:'PickerEmpty',values:async function*(){yield {name:'NestedEmpty',kind:'directory',values:async function*(){}}}})})})
 await panel.getByRole('button', {name:'上传文件夹',exact:true}).click()
 await expect(panel.getByRole('button',{name:'PickerEmpty',exact:true})).toBeVisible()
 await panel.getByRole('button',{name:'PickerEmpty',exact:true}).click()
 await expect(panel.getByRole('button',{name:'NestedEmpty',exact:true})).toBeVisible()

})

test('an active multipart upload survives switching to service status and back', async ({ page }) => {
  await page.goto('/sign-in')
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD)
  const folder = `Destination-switch-${Date.now()}`
  await createAndOpenFolder(page, folder)

  let releasePart!: () => void
  const gate = new Promise<void>(resolve => { releasePart = resolve })
  const secondPart = page.waitForRequest(request => request.method() === 'PUT' && new URL(request.url()).searchParams.get('partNumber') === '2')
  await page.route('**/*partNumber=2*', async route => {
    await gate
    await route.continue()
  })

  const explorer = page.getByRole('region', { name: '共享目录' })
  const progress = explorer.getByRole('progressbar', { name: '文件上传进度' })
  const indicator = page.locator('.upload-indicator summary')
  try {
    await explorer.getByLabel('上传文件', { exact: true }).setInputFiles({
      name: 'switch.txt', mimeType: 'text/plain', buffer: Buffer.alloc(9 * 1024 * 1024, 65),
    })
    await secondPart
    await expect(progress).toHaveAttribute('value', String(8 * 1024 * 1024))
    await openAccountPage(page, '服务状态')
    await expect(page.getByTestId('health-status')).toHaveText('正常')
    await expect(progress).toBeHidden()
    await expect(indicator).toHaveText('其他目录上传 1')
    await indicator.click()
    await expect(page.locator('.upload-indicator')).toHaveAttribute('open', '')
    await page.keyboard.press('Escape')
    await expect(page.locator('.upload-indicator')).not.toHaveAttribute('open')
    await expect(indicator).toBeFocused()
    await indicator.click()
    await page.getByRole('heading', { name: '服务状态' }).click()
    await expect(page.locator('.upload-indicator')).not.toHaveAttribute('open')
    await page.goBack()
    await expect(progress).toBeVisible()
    await expect(progress).toHaveAttribute('value', String(8 * 1024 * 1024))
    await expect(indicator).toHaveCount(0)
  } finally {
    releasePart()
  }
  await expect(explorer.getByRole('status', { name: '上传进度', exact: true })).toContainText('上传完成')
  await expect(explorer.getByRole('button', { name: 'switch.txt', exact: true })).toBeVisible()
})
