import { test, expect } from "@playwright/test";
import {
  signIn,
  ADMINISTRATOR_USERNAME,
  ADMINISTRATOR_PASSWORD,
} from "./signin";
test("Administrator queries audit events, opens details and exports CSV", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await signIn(page, ADMINISTRATOR_USERNAME, ADMINISTRATOR_PASSWORD);
  const panel = page.getByRole("region", { name: "审计记录" });
  await expect(panel).toBeVisible();
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  await panel
    .getByLabel("开始时间（UTC）")
    .fill(today.toISOString().slice(0, 10) + "T00:00");
  await panel
    .getByLabel("结束时间（UTC）")
    .fill(tomorrow.toISOString().slice(0, 10) + "T00:00");
  await panel.getByRole("button", { name: "查询审计", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("条记录");
  await panel.getByRole("button", { name: "查看详情" }).first().click();
  await expect(
    panel.getByRole("complementary", { name: "审计详情" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "仅此人员" }).click();
  await expect(panel.getByRole("status")).toContainText("条记录");
  await panel.getByRole("button", { name: "关闭详情" }).click();
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "导出 CSV" }).click();
  expect((await download).suggestedFilename()).toBe("audit.csv");
  await panel.getByLabel("结束时间（UTC）").fill("2027-11-22T00:00");
  await panel.getByRole("button", { name: "查询审计", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("180 天");
});
