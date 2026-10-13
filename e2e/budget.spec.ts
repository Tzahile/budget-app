import { test, expect, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { householdDate } from "../shared/finance.ts";

const date = householdDate();
const euro = (cents: number) => new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(cents / 100);
const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page, context, request }) => {
  expect((await request.post("/__test/reset", { headers: { "X-Budget-Test-Reset": "synthetic-only" } })).status()).toBe(204);
  await context.addCookies([{ name: "budget_e2e_user", value: "tzahile", url: "http://127.0.0.1:4180" }]);
  // Real services are forbidden; even accidental CDN/provider requests fail the test.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    expect(url.hostname, "Browser must use only the synthetic loopback harness").toBe("127.0.0.1");
    await route.continue();
  });
  page.on("dialog", (dialog) => dialog.accept());
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start with your current cash" })).toBeVisible();
});

async function navigate(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Budget sections" }).getByRole("button", { name, exact: true }).click();
}

async function save(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function account(page: Page, name: string, balance: string) {
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Account name", { exact: true }).fill(name);
  await dialog.getByLabel("Current balance").fill(balance);
  await save(page);
}

async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

async function overview(page: Page, cash: number, spent: number, available = cash, committed = 0) {
  await navigate(page, "Overview");
  for (const [label, amount] of [["Cash now", cash], ["Spent this month", spent], ["Still committed", committed]] as const) {
    await expect(page.getByText(label, { exact: true }).last().locator("..")).toContainText(euro(amount));
  }
  await expect(page.locator("section").filter({ has: page.getByText("Available to spend", { exact: true }) }).first()).toContainText(euro(available));
  await noOverflow(page);
}

function activityRow(page: Page, description: string) {
  return page.getByText(description, { exact: true }).locator("..").locator("..").filter({ has: page.locator("button:not([disabled])") });
}

async function transaction(page: Page, description: string, amount: string, kind = "expense") {
  await page.getByRole("button", { name: "Add transaction", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Description", { exact: true }).fill(description);
  await dialog.getByRole("combobox", { name: "Type", exact: true }).selectOption(kind);
  await dialog.getByLabel("Amount").fill(amount);
  await dialog.getByLabel("Date", { exact: true }).fill(date);
  await noOverflow(page);
  await save(page);
}

test("transaction and refund create/edit/delete change cash and net spending exactly once", async ({ page }) => {
  await account(page, "Synthetic current", "1000.00");
  await overview(page, 100_000, 0);
  await transaction(page, "Synthetic groceries", "25.00");
  await overview(page, 97_500, 2_500);
  await navigate(page, "Activity");
  await activityRow(page, "Synthetic groceries").getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Amount").fill("40.00");
  await save(page);
  await overview(page, 96_000, 4_000);
  await transaction(page, "Synthetic refund", "10.00", "refund");
  await overview(page, 97_000, 3_000);
  await navigate(page, "Activity");
  await activityRow(page, "Synthetic refund").getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Amount").fill("15.00");
  await save(page);
  await overview(page, 97_500, 2_500);
  await navigate(page, "Activity");
  await activityRow(page, "Synthetic refund").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Synthetic refund", { exact: true })).toBeHidden();
  await overview(page, 96_000, 4_000);
  await navigate(page, "Activity");
  await activityRow(page, "Synthetic groceries").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Synthetic groceries", { exact: true })).toBeHidden();
  await overview(page, 100_000, 0);
});

test("owned transfers update both accounts while household cash and spending stay unchanged", async ({ page }) => {
  await account(page, "Synthetic source", "1000.00");
  await navigate(page, "Accounts");
  await account(page, "Synthetic destination", "200.00");
  await navigate(page, "Activity");
  await page.getByRole("button", { name: "Transfer between accounts", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Description", { exact: true }).fill("Synthetic owned transfer");
  await dialog.getByLabel("Amount").fill("100.00");
  await dialog.getByLabel("From account").selectOption({ label: "Synthetic source" });
  await dialog.getByLabel("To account").selectOption({ label: "Synthetic destination" });
  await save(page);
  await overview(page, 120_000, 0);
  await navigate(page, "Accounts");
  await expect(page.getByRole("heading", { name: "Synthetic source" }).locator("../..")).toContainText(euro(90_000));
  await expect(page.getByRole("heading", { name: "Synthetic destination" }).locator("../..")).toContainText(euro(30_000));
  await noOverflow(page);
  await navigate(page, "Activity");
  await activityRow(page, "Synthetic owned transfer").getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Amount").fill("150.00");
  await save(page);
  await overview(page, 120_000, 0);
  await navigate(page, "Accounts");
  await expect(page.getByRole("heading", { name: "Synthetic source" }).locator("../..")).toContainText(euro(85_000));
  await expect(page.getByRole("heading", { name: "Synthetic destination" }).locator("../..")).toContainText(euro(35_000));
  await navigate(page, "Activity");
  await activityRow(page, "Synthetic owned transfer").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Synthetic owned transfer", { exact: true })).toBeHidden();
  await overview(page, 120_000, 0);
  await navigate(page, "Accounts");
  await expect(page.getByRole("heading", { name: "Synthetic source" }).locator("../..")).toContainText(euro(100_000));
  await expect(page.getByRole("heading", { name: "Synthetic destination" }).locator("../..")).toContainText(euro(20_000));
});

test("planned expense completion/correction/undo preserves cash and unpaid commitment semantics", async ({ page }) => {
  await account(page, "Synthetic current", "1000.00");
  await navigate(page, "Planned");
  await page.getByRole("button", { name: "Add planned item" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Description", { exact: true }).fill("Synthetic planned bill");
  await dialog.getByLabel("Amount").fill("100.00");
  await dialog.getByLabel("Next due date").fill(date);
  await dialog.getByRole("combobox", { name: "Repeats", exact: true }).selectOption("once");
  await save(page);
  await overview(page, 100_000, 0, 90_000, 10_000);
  await navigate(page, "Planned");
  await page.getByRole("button", { name: "Mark paid" }).click();
  await expect(page.getByRole("button", { name: "Correct", exact: true })).toBeVisible();
  await overview(page, 90_000, 10_000, 90_000);
  await navigate(page, "Planned");
  await page.getByRole("button", { name: "Correct", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Correct amount").fill("80.00");
  await save(page);
  await overview(page, 92_000, 8_000, 92_000);
  await navigate(page, "Planned");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mark paid" })).toBeVisible();
  await noOverflow(page);
  await overview(page, 100_000, 0, 90_000, 10_000);
});

test("reserve funding and current-month goal protect available funds without changing cash", async ({ page }) => {
  await account(page, "Synthetic current", "1000.00");
  await navigate(page, "Reserves");
  await page.getByRole("button", { name: "Add reserve", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reserve name").fill("Synthetic emergency goal");
  await dialog.getByLabel("Already funded").fill("100.00");
  await save(page);
  await overview(page, 100_000, 0, 90_000);
  await navigate(page, "Reserves");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Set a target and deadline").check();
  await page.getByRole("dialog").getByLabel("Target amount").fill("300.00");
  await page.getByRole("dialog").getByLabel("Target date").fill(date);
  await save(page);
  await overview(page, 100_000, 0, 70_000);
  await navigate(page, "Reserves");
  await expect(page.getByText(/33% funded/)).toBeVisible();
  await noOverflow(page);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Synthetic emergency goal", { exact: true })).toBeHidden();
  await overview(page, 100_000, 0, 100_000);
});

test("CSV and XLSX imports share dedupe and reject an invalid preview without changing balances", async ({ page }) => {
  await account(page, "Synthetic current", "1000.00");
  await navigate(page, "Activity");
  const importer = page.locator("section").filter({ has: page.getByRole("heading", { name: "Import bank CSV or XLSX" }) });
  const csv = `Date,Amount,Description,ID\n${date},-12.50,Synthetic imported expense,synthetic-import-1\n`;
  await importer.getByLabel("CSV or XLSX file").setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await importer.getByLabel("Bank transaction ID (optional)").selectOption("ID");
  await importer.getByLabel("Decimal separator").selectOption(".");
  await importer.getByRole("button", { name: "Preview rows" }).click();
  await expect(importer.getByText("1 valid of 1 rows")).toBeVisible();
  await noOverflow(page);
  await importer.getByRole("button", { name: "Import 1 rows" }).click();
  await expect(importer.getByRole("status")).toHaveText("Imported 1; 0 duplicates; 0 ambiguous.");
  await overview(page, 98_750, 1_250);
  await navigate(page, "Activity");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Synthetic movements");
  sheet.addRow(["Date", "Amount", "Description", "ID"]);
  sheet.addRow([date, -12.5, "Synthetic imported expense", "synthetic-import-1"]);
  await importer.getByLabel("CSV or XLSX file").setInputFiles({ name: "synthetic.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await workbook.xlsx.writeBuffer()) });
  await importer.getByLabel("Bank transaction ID (optional)").selectOption("ID");
  await importer.getByLabel("Decimal separator").selectOption(".");
  await importer.getByRole("button", { name: "Preview rows" }).click();
  await expect(importer.getByText("1 valid of 1 rows")).toBeVisible();
  await importer.getByRole("button", { name: "Import 1 rows" }).click();
  await expect(importer.getByRole("status")).toHaveText("Imported 0; 1 duplicates; 0 ambiguous.");
  await overview(page, 98_750, 1_250);
  await navigate(page, "Activity");
  await importer.getByLabel("CSV or XLSX file").setInputFiles({ name: "synthetic-invalid.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Amount,Description\ninvalid,-1.00,Synthetic rejected row\n") });
  await importer.getByLabel("Decimal separator").selectOption(".");
  await importer.getByRole("button", { name: "Preview rows" }).click();
  await expect(importer.getByText("0 valid of 1 rows")).toBeVisible();
  await expect(importer.getByRole("button", { name: "Import 0 rows" })).toBeDisabled();
  await overview(page, 98_750, 1_250);
});

test("unauthenticated and unauthorized browser sessions cannot read finances or mutate", async ({ page, context }) => {
  await context.clearCookies();
  await page.reload();
  await expect(page.getByRole("link", { name: "Log in with Val Town" })).toBeVisible();
  expect((await page.request.get("/api/data")).status()).toBe(401);
  await context.addCookies([{ name: "budget_e2e_user", value: "synthetic-stranger", url: "http://127.0.0.1:4180" }]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Account not authorized" })).toBeVisible();
  expect((await page.request.get("/api/data")).status()).toBe(403);
  expect((await page.request.post("/api/accounts", { data: { name: "Synthetic forbidden", type: "cash", balanceCents: 1 }, headers: { Origin: "http://127.0.0.1:4180", "X-BudgetApp-Request": "1" } })).status()).toBe(403);
  await noOverflow(page);
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page), "Unexpected browser runtime errors").toEqual([]);
});
