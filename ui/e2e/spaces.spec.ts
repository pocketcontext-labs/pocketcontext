import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
async function login(page: Page) {
  await page.goto("/#/page/observatory");
  await page.getByText("Sign in with a password", { exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("agent@example.com");
  await page.getByLabel("Password", { exact: true }).fill("SyntheticUserPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
}
async function control(request: APIRequestContext, action: string) {
  const response = await request.post(process.env.WIKICONTEXT_TEST_CONTROL + action);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

test("company remains default, personal space is explicit and its links survive reload", async ({ page, request }) => {
  await login(page);
  await expect(page.getByLabel("Space", { exact: true })).toHaveCount(0);
  const create = page.getByRole("button", { name: "Create personal space", exact: true });
  await create.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "This space has no published pages" })).toBeVisible();
  const selector = page.getByLabel("Space", { exact: true });
  const personal = await selector.inputValue();
  expect(personal).not.toBe("companyspace001");
  await page.reload();
  await expect(page.getByRole("heading", { name: "This space has no published pages" })).toBeVisible();
  await expect(selector).toHaveValue(personal);
  await selector.selectOption("companyspace001");
  await page.goto("/#/page/observatory");
  await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
  await expect(selector).toHaveValue("companyspace001");
  const records = await control(request, "/spaces");
  expect(records.own.space).toBe(personal);
  await page.goto(`/#/page/observatory?space=${personal}`);
  await expect(page.getByRole("heading", { name: "Personal notes", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Copy live link", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Personal notes", exact: true })).toBeVisible();
  await page.getByLabel("Search pages", { exact: true }).fill("private");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.getByRole("link", { name: /Personal notes/ })).toBeVisible();
  await expect(results).not.toContainText("Foreign");
  await results.getByRole("link", { name: /Personal notes/ }).click();
  await expect(page).toHaveURL(new RegExp(`space=${personal}`));
  await page.goto("/#/page/observatory");
  await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
});

test("evidence and publication links infer personal space and foreign links reveal no records", async ({ page, request }) => {
  const records = await control(request, "/spaces");
  await login(page);
  for (const [collection, id] of [["sources", records.own.source], ["passages", records.own.passage]]) {
    await page.goto(`/#/${collection}/${id}`);
    await expect(page.getByRole("heading", { name: "Personal source", exact: true })).toBeVisible();
    await expect(page.getByLabel("Space", { exact: true })).toHaveValue(records.own.space);
    await expect(page).toHaveURL(new RegExp(`space=${records.own.space}`));
    await page.reload();
    await expect(page.getByRole("heading", { name: "Personal source", exact: true })).toBeVisible();
  }
  await page.goto(`/#/page/observatory?publication=${records.own.publication}`);
  await expect(page.getByRole("heading", { name: "Personal notes", exact: true })).toBeVisible();
  await expect(page.getByLabel("Space", { exact: true })).toHaveValue(records.own.space);
  await page.getByLabel("Publication", { exact: true }).selectOption("live");
  await expect(page.getByRole("heading", { name: "Personal notes", exact: true })).toBeVisible();
  for (const path of [`sources/${records.foreign.source}`, `passages/${records.foreign.passage}`, `page/observatory?publication=${records.foreign.publication}`, `page/observatory?space=${records.foreign.space}`]) {
    await page.goto(`/#/${path}`);
    await expect(page.getByText(/Record unavailable\.|This publication is unavailable\.|This space is unavailable\./).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /Foreign|Personal notes/ })).toHaveCount(0);
  }
  await page.getByLabel("Space", { exact: true }).selectOption("companyspace001");
  await expect(page.getByLabel("Space", { exact: true })).toHaveValue("companyspace001");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByLabel("Space", { exact: true }).selectOption(records.own.space);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("space switch fences delayed content and company membership revocation clears the view", async ({ page, request }) => {
  const records = await control(request, "/spaces");
  await login(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  let fulfilled = false;
  await page.route("**/api/context/query", async route => {
    const sql = route.request().postDataJSON().sql as string;
    if (!held && sql.includes("FROM publications WHERE space='" + records.own.space + "'")) {
      held = true;
      const response = await route.fetch();
      await gate; await route.fulfill({ response }); fulfilled = true;
    } else await route.continue();
  });
  await page.getByLabel("Space", { exact: true }).selectOption(records.own.space);
  await expect.poll(() => held).toBe(true);
  await page.getByLabel("Space", { exact: true }).selectOption("companyspace001");
  release();
  await expect.poll(() => fulfilled).toBe(true);
  await expect(page.getByRole("heading", { name: "Welcome to our shared context.", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Personal notes", exact: true })).toHaveCount(0);
  await page.goto("/#/page/observatory");
  await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Personal notes", exact: true })).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
  try {
    await control(request, "/revoke-company");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("alert")).toContainText("This space is unavailable");
    await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toHaveCount(0);
    await page.getByLabel("Space", { exact: true }).selectOption(records.own.space);
    await page.goto(`/#/page/observatory?space=${records.own.space}`);
    await expect(page.getByRole("heading", { name: "Personal notes", exact: true })).toBeVisible();
  } finally { await control(request, "/restore-company"); }
});

async function freshReader(page: Page, request: APIRequestContext, revoked = false) {
  const auth = await control(request, revoked ? "/new-reader-revoked" : "/new-reader");
  await page.goto("/");
  await page.evaluate(auth => localStorage.setItem("wikicontext.reader.auth", JSON.stringify({ token: auth.token, record: auth.record })), auth);
  await page.goto("/#/page/observatory");
  await page.reload();
}

test("a reader with revoked company access can explicitly create their first personal space", async ({ page, request }) => {
  await freshReader(page, request, true);
  await expect(page.getByRole("alert")).toContainText("This space is unavailable");
  await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Create personal space", exact: true }).click();
  await expect(page.getByRole("heading", { name: "This space has no published pages" })).toBeVisible();
  await expect(page).toHaveURL(/space=[a-z0-9]{15}/);
});

test("malformed explicit space never falls back to company", async ({ page }) => {
  await login(page);
  for (const value of ["bad-space", ""]) {
    await page.goto(`/#/page/observatory?space=${value}`);
    await expect(page.getByRole("alert")).toContainText("This space is unavailable");
    await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toHaveCount(0);
  }
});

for (const action of ["navigation", "logout"] as const) {
  test(`late personal creation cannot redirect after ${action}`, async ({ page, request }) => {
    await freshReader(page, request);
    await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false, fulfilled = false;
    await page.route("**/api/wiki/spaces/personal", async route => {
      const response = await route.fetch(); held = true;
      await gate; await route.fulfill({ response }); fulfilled = true;
    });
    await page.getByRole("button", { name: "Create personal space", exact: true }).click();
    await expect.poll(() => held).toBe(true);
    if (action === "navigation") {
      // Hash navigation preserves the mounted reader and the in-flight request.
      await page.evaluate(() => { location.hash = "#/page/telescope"; });
      await expect(page.getByRole("heading", { name: "Telescope", exact: true })).toBeVisible();
    } else await page.getByRole("button", { name: /Sign out/ }).click();
    const destination = page.url();
    release(); await expect.poll(() => fulfilled).toBe(true);
    await page.unrouteAll({ behavior: "wait" });
    await expect(page).toHaveURL(destination);
    if (action === "navigation") await expect(page.getByRole("heading", { name: "Telescope", exact: true })).toBeVisible();
    else await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}
