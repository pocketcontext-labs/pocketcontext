import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const queryURL = "**/api/context/query";

async function login(page: Page) {
  await page.goto("/#/page/observatory");
  await page.getByText("Sign in with a password", { exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("agent@example.com");
  await page.getByLabel("Password", { exact: true }).fill("SyntheticUserPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
  await expect(page.locator(".connection")).toContainText("Live · updates automatically");
  await expect(page.locator("#reader")).toHaveAttribute("aria-busy", "false");
}

async function control(request: APIRequestContext, action: string) {
  const response = await request.post(process.env.WIKICONTEXT_TEST_CONTROL + action);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function navigate(page: Page, hash: string) {
  await page.evaluate(value => { location.hash = value; }, hash);
}

// Fetch before pausing delivery so revocation tests exercise an authorized but
// stale response, rather than a request the server already knows to reject.
async function holdQuery(page: Page, matches: (sql: string) => boolean) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let claimed = false;
  let held = false;
  let fulfilled = false;
  await page.route(queryURL, async route => {
    if (!claimed && matches(route.request().postDataJSON().sql as string)) {
      claimed = true;
      const response = await route.fetch();
      held = true;
      await gate;
      await route.fulfill({ response });
      fulfilled = true;
    } else await route.continue();
  });
  return {
    wait: () => expect.poll(() => held).toBe(true),
    release,
    finished: () => expect.poll(() => fulfilled).toBe(true),
  };
}

const pageBody = (sql: string) => sql.includes("r.body") && sql.includes("AND p.slug=");
const publicationContent = (sql: string) => sql.includes("json_each(pub.manifest)") || sql.includes("FROM citations c");

test("reader performance: pending navigation retains content and warm revisits reuse publication data", async ({ page }) => {
  await login(page);
  const sql: string[] = [];
  let subscriptions = 0;
  page.on("request", request => {
    if (request.url().endsWith("/api/context/query")) sql.push(request.postDataJSON().sql);
    if (request.url().endsWith("/api/realtime") && request.method() === "POST") subscriptions++;
  });
  const held = await holdQuery(page, value => pageBody(value) && value.includes("p.slug='telescope'"));
  try {
    await page.getByRole("link", { name: "the telescope", exact: true }).click();
    await held.wait();
    await expect(page.locator("#reader")).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Telescope", exact: true })).toHaveCount(0);
    held.release();
    await held.finished();
    await expect(page.getByRole("heading", { name: "Telescope", exact: true })).toBeVisible();
    await expect(page.locator("#reader")).toHaveAttribute("aria-busy", "false");
    expect(sql.filter(pageBody)).toHaveLength(1);
    expect(sql.filter(value => value.includes("manifest_type"))).toHaveLength(0);
    expect(sql.filter(publicationContent)).toHaveLength(4);

    sql.length = 0;
    for (const [slug, title] of [["observatory", "Observatory"], ["telescope", "Telescope"], ["observatory", "Observatory"]]) {
      await navigate(page, `#/page/${slug}`);
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await expect(page.locator("#reader")).toHaveAttribute("aria-busy", "false");
    }
    expect(sql.filter(publicationContent)).toHaveLength(0);
    expect(subscriptions).toBe(0);

    // An unchanged focus check still reauthorizes access but needs no manifest,
    // page body, citation, or relationship reads.
    const checked = page.waitForResponse(response => response.url().endsWith("/api/context/query") &&
      /FROM publications WHERE space=.*LIMIT 1 OFFSET 0/.test(response.request().postDataJSON().sql));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await checked;
    await expect(page.locator("#reader")).toHaveAttribute("aria-busy", "false");
    expect(sql.some(value => value.includes("FROM spaces s JOIN space_members"))).toBe(true);
    expect(sql.filter(publicationContent)).toHaveLength(0);
    expect(subscriptions).toBe(0);
  } finally {
    held.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("reader performance: transient refresh failures keep the page and retry recovers", async ({ page }) => {
  await login(page);
  const content = await page.locator(".markdown").textContent();
  await page.route(queryURL, route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ message: "Synthetic temporary read failure" }),
  }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Synthetic temporary read failure");
  await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
  await expect(page.locator(".markdown")).toHaveText(content!);
  await expect(page.locator("#reader")).toHaveAttribute("aria-busy", "false");
  await page.unrouteAll({ behavior: "wait" });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
});

test("reader performance: publication refresh swaps complete content and history remains pinned", async ({ page, request }) => {
  await login(page);
  const previousBody = await page.locator(".markdown").textContent();
  const previousPublication = await page.getByLabel("Publication", { exact: true }).locator("option").nth(1).getAttribute("value");
  const held = await holdQuery(page, value => pageBody(value) && value.includes("p.slug='observatory'"));
  try {
    const published = await control(request, "/publish");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await held.wait();
    await expect(page.locator("#reader")).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
    await expect(page.locator(".markdown")).toHaveText(previousBody!);
    await expect(page.getByText(`Published edition ${published.edition}.`, { exact: false })).toHaveCount(0);
    held.release();
    await held.finished();
    await expect(page.getByText(`Published edition ${published.edition}.`, { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Citation 1", exact: true })).toBeVisible();
    await page.getByLabel("Publication", { exact: true }).selectOption(previousPublication!);
    await expect(page.locator(".markdown")).toHaveText(previousBody!);
    await control(request, "/publish");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("#reader")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".markdown")).toHaveText(previousBody!);
    await expect(page.getByLabel("Publication", { exact: true })).toHaveValue(previousPublication!);
  } finally {
    held.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

for (const trigger of ["navigation", "publication refresh"] as const) {
test(`reader performance: same-user revocation evicts warm content and fences a delayed ${trigger} response`, async ({ page, request }) => {
  await login(page);
  const slug = trigger === "navigation" ? "telescope" : "observatory";
  const held = await holdQuery(page, value => pageBody(value) && value.includes(`p.slug='${slug}'`));
  try {
    if (trigger === "navigation") await navigate(page, "#/page/telescope");
    else {
      await control(request, "/publish");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    }
    await held.wait();
    await control(request, "/revoke-company");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("alert")).toContainText("This space is unavailable");
    await expect(page.getByRole("heading", { name: /^(Observatory|Telescope)$/ })).toHaveCount(0);
    held.release();
    await held.finished();
    await expect(page.getByRole("heading", { name: /^(Observatory|Telescope)$/ })).toHaveCount(0);
    await navigate(page, "#/page/observatory");
    await expect(page.getByRole("alert")).toContainText("This space is unavailable");
    await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toHaveCount(0);
    await control(request, "/restore-company");
    const freshBody = page.waitForRequest(request => request.url().endsWith("/api/context/query") && pageBody(request.postDataJSON().sql));
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await freshBody;
    await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
  } finally {
    held.release();
    await page.unrouteAll({ behavior: "wait" });
    await control(request, "/restore-company");
  }
});
}

test("reader performance: logout fences delayed content before a different identity signs in", async ({ page, context, request }) => {
  await login(page);
  const held = await holdQuery(page, value => pageBody(value) && value.includes("p.slug='telescope'"));
  try {
    await navigate(page, "#/page/telescope");
    await held.wait();
    await page.getByRole("button", { name: /Sign out/ }).click();
    await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeVisible();
    const auth = await control(request, "/new-reader-revoked");
    const peer = await context.newPage();
    await peer.goto("/");
    await peer.evaluate(session => localStorage.setItem("wikicontext.reader.auth", JSON.stringify(session)), auth);
    await expect(page.getByRole("alert")).toContainText("This space is unavailable");
    held.release();
    await held.finished();
    await expect(page.getByRole("heading", { name: /^(Observatory|Telescope)$/ })).toHaveCount(0);
    await navigate(page, "#/page/observatory");
    await expect(page.getByRole("alert")).toContainText("This space is unavailable");
    await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toHaveCount(0);
  } finally {
    held.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
