import { openManagementPage } from './explorer'
import { test, expect } from "@playwright/test";
import {
  signIn,
  ADMINISTRATOR_USERNAME,
  ADMINISTRATOR_PASSWORD,
} from "./signin";
test("Registration is approved with an Organization before sign-in", async ({
  page,
  browser,
}) => {
  const username = `registration-${Date.now()}`;
  await page.goto("/register");
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("姓名", { exact: true }).fill("新员工");
  await page.getByLabel("所属组织说明").fill("Engineering");
  await page.getByLabel("密码", { exact: true }).fill("employee-secret");
  await page.getByRole("button", { name: "提交注册" }).click();
  await expect(page.getByRole("status")).toContainText("等待管理员审批");
  await page.goto("/sign-in");
  await signIn(page, username, "employee-secret");
  await expect(page.getByRole("alert")).toContainText("等待管理员审批");
  const admin = await browser.newPage();
  await admin.goto("/sign-in");
  await signIn(admin, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD);
  await openManagementPage(admin, '注册审批')
  const row = admin.getByRole("listitem").filter({ hasText: username });
  await expect(row).toContainText("Engineering");
  await row.getByLabel("分配组织").selectOption("1");
  await row.getByRole("button", { name: "激活" }).click();
  await expect(row).toHaveCount(0);
  await signIn(page, username, "employee-secret");
  await expect(page.getByTestId("current-user")).toHaveText("新员工");
  await admin.close();
});
