import { expect, test } from "@playwright/test";
import {
  ADMINISTRATOR_USERNAME,
  ADMINISTRATOR_PASSWORD,
  signIn,
} from "./signin";

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
  const name = `Granted-${suffix}`;
  await panel.getByLabel("目录名称").fill(name);
  await panel.getByRole("button", { name: "创建目录" }).click();
  await panel.getByRole("button", { name, exact: true }).click();
  await panel.getByRole("button", { name: "管理当前权限" }).click();
  const permissions = page.getByRole("region", {name: "权限管理"});
  await permissions.getByLabel("主体 ID").fill(userId);
  await permissions.getByLabel("修改", {exact:true}).check();
  await permissions.getByRole("button", {name:"添加到草稿"}).click();
  await expect(permissions.getByRole("cell", {name:"11（待保存）"})).toBeVisible();
  await permissions.getByRole("button", { name: "保存全部授权" }).click();
  await expect(permissions.getByRole("status")).toHaveText("授权已保存");
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
