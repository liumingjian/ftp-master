import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
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
  // Fixture only: this ticket precedes the Registration API. Clone the local
  // Administrator's password hash into an ordinary, active User.
  const container =
    process.env.E2E_POSTGRES_CONTAINER ?? "ftp-ticket10-postgres-1";
  const userId = execFileSync(
    "docker",
    [
      "exec",
      container,
      "psql",
      "-U",
      "ftpmaster",
      "-d",
      "ftpmaster",
      "-Atc",
      `INSERT INTO users(username,display_name,password_hash,is_administrator,status,created_at) SELECT '${username}','Reader',password_hash,false,'active',created_at FROM users WHERE is_administrator LIMIT 1 RETURNING id`,
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")[0];
  await page.goto("/sign-in");
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD);
  const panel = page.getByRole("region", { name: "共享目录" });
  const name = `Granted-${suffix}`;
  await panel.getByLabel("目录名称").fill(name);
  await panel.getByRole("button", { name: "创建目录" }).click();
  await panel.getByRole("button", { name, exact: true }).click();
  await panel.getByLabel("主体 ID").fill(userId);
  await panel.getByRole("button", { name: "保存授权" }).click();
  await expect(panel.getByRole("status")).toHaveText("授权已保存");
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
