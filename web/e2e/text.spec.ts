import {expect,test} from '@playwright/test'
import {ADMINISTRATOR_USERNAME,ADMINISTRATOR_PASSWORD,signIn} from './signin'
import { createAndOpenFolder } from './explorer'
test('two independent sessions retain edits and refuse stale text saves',async({page,browser})=>{
 await page.goto('/sign-in');await signIn(page,ADMINISTRATOR_USERNAME,ADMINISTRATOR_PASSWORD)
 const panel=page.getByRole('region',{name:'共享目录'}),dir=`Text-${Date.now()}`
 await createAndOpenFolder(page, dir)
 await panel.getByLabel('上传文件',{exact:true}).setInputFiles({name:'edit.txt',mimeType:'text/plain',buffer:Buffer.from('original')})
 await expect(panel.getByRole('status',{name:'上传进度'})).toContainText('上传完成')
 const context=await browser.newContext();const other=await context.newPage()
 try{
 await other.goto('/sign-in');await signIn(other,ADMINISTRATOR_USERNAME,ADMINISTRATOR_PASSWORD)
 await other.getByRole('button',{name:dir,exact:true}).click()
 for(const p of [page,other]){await p.getByRole('button',{name:'edit.txt',exact:true}).click();await p.getByRole('button',{name:'编辑文本',exact:true}).click();await expect(p.getByLabel('文本内容')).toHaveValue('original')}
 await page.getByLabel('文本内容').fill('first save 中文');await page.getByRole('button',{name:'保存文本'}).click();await expect(page.getByRole('status').filter({hasText:'已保存为新版本'})).toBeVisible()
 await other.getByLabel('文本内容').fill('second edit');await other.getByRole('button',{name:'保存文本'}).click();await expect(other.getByText('文件已被他人修改，请先复制您的修改，重新加载后合并。')).toBeVisible();await expect(other.getByLabel('文本内容')).toHaveValue('second edit')
 other.once('dialog', dialog => dialog.dismiss())
 await other.keyboard.press('Escape')
 await expect(other.getByLabel('文本内容')).toHaveValue('second edit')
 other.once('dialog', dialog => dialog.accept())
 await other.getByRole('button',{name:'重新加载',exact:true}).click();await expect(other.getByLabel('文本内容')).toHaveValue('first save 中文')
 await other.keyboard.press('Escape')
 await expect(other.getByLabel('文本内容')).toHaveCount(0)
 await expect(other.getByRole('region', { name: '文件预览' })).toBeVisible()
 }finally{await context.close()}
})
