import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/#/page/observatory");
  await page.getByText("Sign in with a password", { exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("agent@example.com");
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticUserPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Observatory", exact: true }),
  ).toBeVisible();
}

test("published reader: navigation, evidence, safe Markdown, live updates, history and session revocation", async ({
  page,
  context,
  request,
}) => {
  const remoteRequests: string[] = [];
  page.on("request", (event) => {
    if (event.url().includes("invalid.example"))
      remoteRequests.push(event.url());
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const control = async (action: string) => {
    const response = await request.post(
      process.env.WIKICONTEXT_TEST_CONTROL + action,
    );
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  await login(page);
  await expect(
    page.getByText("Published edition 1.", { exact: false }),
  ).toBeVisible();
  await expect(page.locator("table")).toContainText("Telescope");
  await expect(page.locator("script:not([src])")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as Window & { wikiInjected?: boolean }).wikiInjected,
    ),
  ).toBeUndefined();
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(remoteRequests).toEqual([]);

  await page.getByRole("button", { name: "Citation 1", exact: true }).click();
  await expect(
    page.getByText("Observatory source", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText(
      "The synthetic observatory opened in 2026. Its telescope studies stars.",
      { exact: false },
    ),
  ).toBeVisible();
  const passageURL = await page.getByRole("link", { name: "Open passage", exact: true }).getAttribute("href");
  const sourceURL = await page.getByRole("link", { name: "Open source", exact: true }).getAttribute("href");
  const originalLink = page.getByRole("link", { name: /Open original/ });
  await expect(originalLink).toBeVisible();
  const originalResponse = await request.get(
    (await originalLink.getAttribute("href"))!,
  );
  expect(originalResponse.ok()).toBeTruthy();
  expect(await originalResponse.text()).toBe(
    "The synthetic observatory opened in 2026. Its telescope studies stars.\n",
  );
  let releaseModalToken!: () => void;
  const modalTokenGate = new Promise<void>(resolve => { releaseModalToken = resolve; });
  await page.route("**/api/files/token", async route => {
    const response = await route.fetch();
    await modalTokenGate;
    await route.fulfill({ response });
  });
  const pendingModalToken = page.waitForRequest("**/api/files/token");
  const pendingPopup = context.waitForEvent("page");
  await originalLink.click();
  const stalePopup = await pendingPopup;
  await pendingModalToken;
  await page.goto("/#/page/telescope");
  await page.getByRole("button", { name: /Sign out/ }).click();
  releaseModalToken();
  await expect.poll(() => stalePopup.isClosed()).toBe(true);
  await page.unroute("**/api/files/token");
  await login(page);
  await page.getByRole("button", { name: "Citation 1", exact: true }).click();
  await expect(originalLink).toBeVisible();
  const downloadPromise = new Promise<import("@playwright/test").Download>(
    (resolve) => {
      page.once("download", resolve);
      context.once("page", (popup) => popup.once("download", resolve));
    },
  );
  await originalLink.click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  expect(await readFile((await download.path())!, "utf8")).toBe(
    "The synthetic observatory opened in 2026. Its telescope studies stars.\n",
  );
  await page.bringToFront();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Citation 1", exact: true }),
  ).toBeFocused();
  await page.goto("/" + passageURL);
  await expect(page.getByRole("heading", { name: "Passages", exact: true })).toBeVisible();
  await expect(page.locator("blockquote.passage")).toContainText("observatory opened in 2026");
  await page.reload();
  await expect(page.locator("blockquote.passage")).toContainText("observatory opened in 2026");
  await page.goto("/" + sourceURL);
  await expect(page.getByRole("button", { name: "Download original", exact: true })).toBeVisible();
  let releaseFileToken!: () => void;
  const fileTokenGate = new Promise<void>(resolve => { releaseFileToken = resolve; });
  await page.route("**/api/files/token", async route => {
    const response = await route.fetch();
    await fileTokenGate;
    await route.fulfill({ response });
  });
  const pendingToken = page.waitForRequest("**/api/files/token");
  await page.getByRole("button", { name: "Download original", exact: true }).click();
  await pendingToken;
  await page.goto("/#/page/observatory");
  const staleDownload = page.waitForEvent("download", { timeout: 500 }).then(() => true, () => false);
  releaseFileToken();
  expect(await staleDownload).toBe(false);
  await page.unroute("**/api/files/token");
  await page.goto("/" + sourceURL);
  await expect(page.getByRole("button", { name: "Download original", exact: true })).toBeVisible();
  await page.getByLabel("Collection", { exact: true }).selectOption("passages");
  await page.keyboard.press("Control+k");
  await expect(page.getByLabel("Search passages", { exact: true })).toBeFocused();
  await page.getByLabel("Search passages", { exact: true }).fill("does-not-exist");
  await expect(page.getByText("No matches.", { exact: true })).toBeVisible();
  await page.goto("/#/page/observatory");
  await expect(page.getByRole("button", { name: "Copy historical link", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "the telescope", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Telescope", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/^BACKLINKS/)).toBeVisible();
  await page
    .getByRole("link", { name: "Observatory", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("heading", { name: "Observatory", exact: true }),
  ).toBeVisible();

  const search = page.getByLabel("Search pages", { exact: true });
  await search.fill("telescope");
  const searchResults = page.getByRole("region", { name: "Search results" });
  await expect(
    searchResults.getByRole("heading", { name: "Search results" }),
  ).toBeVisible();
  await expect(searchResults.locator("li")).toHaveCount(20);
  await search.fill("");
  await page.locator("details.all-pages-navigation summary").click();
  await page
    .locator(".page-list")
    .getByRole("link", { name: "Observatory", exact: true })
    .click();
  // Wait for hash navigation to finish before asserting keyboard focus.
  await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
  await expect(search).toBeVisible();
  await search.focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe(
    "BODY",
  );

  await page.screenshot({
    path: "/tmp/wikicontext-reader-desktop.png",
    fullPage: true,
  });

  await control("/stage");
  await page.reload();
  await expect(
    page.getByText("Published edition 1.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Published edition 2.", { exact: false }),
  ).toHaveCount(0);
  await control("/publish");
  await expect(
    page.getByText("Published edition 2.", { exact: false }),
  ).toBeVisible();

  const history = page.getByLabel("Publication", { exact: true });
  await history.selectOption({ label: "Publication 1" });
  await expect(
    page.getByText("Published edition 1.", { exact: false }),
  ).toBeVisible();
  await control("/publish");
  await expect(
    history.locator("option", { hasText: "Publication 3" }),
  ).toHaveCount(1);
  await expect(
    page.getByText("Published edition 1.", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Published edition 1.", { exact: false }),
  ).toBeVisible();
  await history.selectOption("live");
  await expect(
    page.getByText("Published edition 3.", { exact: false }),
  ).toBeVisible();

  await context.setOffline(true);
  await control("/publish");
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("Published edition 4.", { exact: false }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Observatory", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();

  await page.screenshot({
    path: "/tmp/wikicontext-reader-mobile.png",
    fullPage: true,
  });

  await control("/disable");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("Sign in with a password", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Published edition 4.", { exact: false }),
  ).toHaveCount(0);
  await control("/enable");
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  // A cached token cannot display content before server session validation.
  await control("/disable");
  let releaseRefresh: () => void = () => {};
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route("**/api/collections/users/auth-refresh", async (route) => {
    await refreshGate;
    await route.continue();
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("Published edition 4.", { exact: false }),
  ).toHaveCount(0);
  releaseRefresh();
  await expect(
    page.getByText("Sign in with a password", { exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/collections/users/auth-refresh");
  await control("/enable");
  await login(page);
  await page.getByRole("button", { name: /Sign out/ }).click();
  await expect(
    page.getByText("Sign in with a password", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Sign in with a password", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Published edition 4.", { exact: false }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("ranked search: scoped pagination, safe excerpts, back navigation, conflicts and mobile", async ({
  page,
  request,
}) => {
  await login(page);
  await page.keyboard.press("Control+k");
  const search = page.getByLabel("Search pages", { exact: true });
  await expect(search).toBeFocused();
  await search.fill("starlight");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.locator("li")).toHaveCount(20);
  await expect(results.locator("img,script")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Pages" })).toBeVisible();
  await page.getByRole("button", { name: "Load more results" }).click();
  await expect(results.locator("li")).toHaveCount(25);
  await page
    .locator("#reader")
    .evaluate((node) => node.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: "/tmp/wikicontext-search-desktop.png",
    fullPage: true,
  });
  await expect(
    page.getByRole("button", { name: "Load more results" }),
  ).toHaveCount(0);
  const last = results.locator("h2 a").last();
  const selectedTitle = await last.textContent();
  await last.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const scroll = await page
    .locator("#reader")
    .evaluate((node) => node.scrollTop);
  await last.click();
  await expect(
    page.getByRole("heading", { name: selectedTitle!, exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(results.locator("li")).toHaveCount(25);
  await expect(
    results.getByRole("link", { name: selectedTitle!, exact: true }),
  ).toBeFocused();
  await expect
    .poll(async () =>
      page.locator("#reader").evaluate((node) => node.scrollTop),
    )
    .toBeCloseTo(scroll, -1);
  const published = await request.post(
    process.env.WIKICONTEXT_TEST_CONTROL + "/publish",
  );
  expect(published.ok()).toBeTruthy();
  await expect(results.locator("li")).toHaveCount(20);
  await page.reload();
  await expect(search).toHaveValue("starlight");
  await expect(results.locator("li")).toHaveCount(20);
  let conflicted = false;
  await page.route("**/api/context/search", async (route) => {
    if (route.request().postDataJSON().offset > 0 && !conflicted) {
      conflicted = true;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ message: "Search changed" }),
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Load more results" }).click();
  await expect(results.locator("li")).toHaveCount(0);
  await page.getByRole("button", { name: "Restart search" }).click();
  await expect(results.locator("li")).toHaveCount(20);
  await page.unroute("**/api/context/search");
  await page.route("**/api/context/search", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "Search temporarily unavailable" }),
    }),
  );
  await search.fill("missingword");
  await expect(results.getByRole("alert")).toBeVisible();
  await expect(results.locator("li")).toHaveCount(0);
  await page.unroute("**/api/context/search");
  await page.getByRole("button", { name: "Retry search" }).click();
  await expect(results).toContainText("No published pages match");
  await search.fill("editiontoken1");
  await expect(results).toContainText("No published pages match");
  await page
    .getByLabel("Publication", { exact: true })
    .selectOption({ label: "Publication 1" });
  await expect(results.locator("li")).toHaveCount(1);
  await expect(results).toContainText("Published edition 1");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Tab");
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await search.fill("starlight");
  await search.press("Enter");
  await expect(results.locator("li")).toHaveCount(20);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "/tmp/wikicontext-search-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Load more results" }).click();
  await expect(results.locator("li")).toHaveCount(25);
});


test("persistent SDK sessions share login, account changes and logout without reviving old tab credentials", async ({ page, context, request }) => {
  await login(page);
  const peer = await context.newPage();
  await peer.goto("/#/page/telescope");
  await expect(peer.getByRole("heading", { name: "Telescope", exact: true })).toBeVisible();
  await peer.reload();
  await expect(peer.getByRole("heading", { name: "Telescope", exact: true })).toBeVisible();
  const original = await page.evaluate(() => localStorage.getItem("wikicontext.reader.auth"));
  await page.evaluate(value => sessionStorage.setItem("wikicontext.reader.auth", value!), original);
  await page.getByRole("button", { name: "Citation 1", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open passage", exact: true })).toBeVisible();
  const response = await request.post(process.env.WIKICONTEXT_TEST_CONTROL + "/other-session");
  expect(response.ok()).toBeTruthy();
  const second = await response.json();
  await peer.evaluate(session => localStorage.setItem("wikicontext.reader.auth", JSON.stringify(session)), second);
  await expect(page.getByRole("link", { name: "Open passage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
  await peer.reload();
  await expect(peer.getByRole("heading", { name: "Telescope", exact: true })).toBeVisible();
  await peer.getByRole("button", { name: /Sign out/ }).click();
  await expect(page.getByRole("button", { name: /Google/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /Google/ })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("wikicontext.reader.auth"))).toBeNull();
  await login(page);
  await expect(peer.getByRole("heading", { name: "Telescope", exact: true })).toBeVisible();
});


test("an idle reader clears cached content when its token expires", async ({ page }) => {
  await login(page);
  await page.clock.setSystemTime(new Date(Date.now() + 8 * 86400000));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: /Google/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("wikicontext.reader.auth"))).toBeNull();
});


test("home-only publications update live root while history and explicit links remain stable", async ({ page, context, request }) => {
  await login(page);
  await page.goto("/#/");
  await expect(page.getByRole("heading", { name: "Welcome to our shared context.", exact: true })).toBeVisible();
  const explicit = await context.newPage();
  await explicit.goto("/#/page/observatory");
  await expect(explicit.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
  const setResponse = await request.post(process.env.WIKICONTEXT_TEST_CONTROL + "/home-telescope");
  expect(setResponse.ok(), await setResponse.text()).toBeTruthy();
  const selected = await setResponse.json();
  await expect(page.getByRole("heading", { name: "Telescope", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator(".page-list .home-badge")).toHaveText("Home");
  await expect(page.locator(".page-list a.selected")).toContainText("Telescope");
  await expect(explicit.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
  await expect(explicit.getByLabel("Publication", { exact: true }).locator(`option[value="${selected.id}"]`)).toHaveCount(1);
  await explicit.reload();
  await expect(explicit.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
  const directory = await context.newPage();
  await directory.goto(`/#/welcome?publication=${selected.id}`);
  await expect(directory.getByRole("heading", { name: "Welcome to our shared context.", exact: true })).toBeVisible();
  await expect(directory.getByLabel("Publication", { exact: true })).toHaveValue(selected.id);
  await directory.getByLabel("Publication", { exact: true }).selectOption("live");
  await expect(directory).toHaveURL(/#\/welcome$/);
  await expect(directory.getByRole("heading", { name: "Welcome to our shared context.", exact: true })).toBeVisible();
  await directory.close();
  const history = page.getByLabel("Publication", { exact: true });
  await history.selectOption(selected.id);
  await expect(page).toHaveURL(new RegExp(`#/\\?publication=${selected.id}$`));
  const clearResponse = await request.post(process.env.WIKICONTEXT_TEST_CONTROL + "/home-clear");
  expect(clearResponse.ok(), await clearResponse.text()).toBeTruthy();
  const cleared = await clearResponse.json();
  await expect(history.locator(`option[value="${cleared.id}"]`)).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Telescope", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Telescope", exact: true })).toBeVisible();
  await history.selectOption({ label: "Publication 1" });
  await expect(page.getByRole("heading", { name: "Welcome to our shared context.", exact: true })).toBeVisible();
  await history.selectOption("live");
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole("heading", { name: "Welcome to our shared context.", exact: true })).toBeVisible();
  await expect(page.locator(".home-badge")).toHaveCount(0);
});


test("welcome directory includes published pages, onboarding, filters, history and live additions", async ({ page, context, request }) => {
  await login(page);
  await page.goto("/#/welcome");
  await expect(page.getByRole("heading", { name: "Welcome to our shared context.", exact: true })).toBeVisible();
  const screenshots = process.env.WIKICONTEXT_TEST_SCREENSHOTS || "/tmp";
  await page.screenshot({ path: `${screenshots}/welcome-desktop-dark.png`, fullPage: true });
  await page.getByRole("button", { name: "Switch to light theme", exact: true }).click();
  await page.screenshot({ path: `${screenshots}/welcome-desktop-light.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/welcome-mobile-light.png`, fullPage: true });
  await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
  await page.screenshot({ path: `${screenshots}/welcome-mobile-dark.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  const onboarding = page.getByRole("region", { name: "New to the workspace?", exact: true });
  await expect(onboarding.getByRole("link", { name: /Open onboarding/ })).toBeVisible();
  await expect(onboarding.locator("a")).toHaveCount(1);
  const index = page.getByRole("region", { name: "The complete page index", exact: true });
  const entries = index.locator('a[href*="/page/"]');
  await expect(entries).toHaveCount(28);
  const slugs = await entries.evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).hash.split("?")[0]));
  expect(new Set(slugs).size).toBe(28);
  const filter = page.getByRole("searchbox", { name: "Search published pages", exact: true });
  await expect(page.getByRole("searchbox")).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Topics", exact: true })).toBeVisible();
  const allPages = page.locator("details.all-pages-navigation");
  await expect(allPages).not.toHaveAttribute("open", "");
  await allPages.locator("summary").click();
  await expect(allPages.getByRole("navigation", { name: "Pages", exact: true }).getByRole("link")).toHaveCount(28);
  await allPages.locator("summary").click();
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
  // A body-only term proves Welcome uses the same full-text search as the sidebar.
  await filter.fill("research");
  await filter.press("Enter");
  const searchResults = page.getByRole("region", { name: "Search results" });
  await expect(searchResults.locator("li")).toHaveCount(20);
  await expect(page.getByLabel("Search pages", { exact: true })).toHaveValue("research");
  await page.getByRole("button", { name: "Load more results" }).click();
  await expect(searchResults.locator("li")).toHaveCount(25);
  await page.goto("/#/welcome");
  await filter.fill("no-such-page");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(searchResults).toContainText("No published pages match");
  await page.goto("/#/page/observatory");
  await page.getByRole("navigation", { name: "Topics", exact: true }).getByRole("link", { name: /Getting started/ }).click();
  await expect(page).toHaveURL(/#\/welcome\?topic=/);
  await expect(entries).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "The complete page index", exact: true })).toBeInViewport();
  await expect(entries).toContainText("Colleague onboarding");
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page).toHaveURL(/#\/welcome\?topic=all$/);
  await expect(page.getByRole("navigation", { name: "Topics", exact: true }).locator('[aria-current="page"]')).toHaveCount(0);
  await page.getByRole("button", { name: "A–Z", exact: true }).click();
  await expect(entries).toHaveCount(28);
  const titles = await entries.allTextContents();
  expect(titles[0]).toContain("Colleague onboarding");
  expect(titles.at(-1)).toContain("Telescope");
  await filter.focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await filter.press("Escape");
  await filter.blur();
  await page.keyboard.press("/");
  await expect(filter).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  const history = page.getByLabel("Publication", { exact: true });
  await history.selectOption({ label: "Publication 1" });
  await expect(page).toHaveURL(/#\/welcome\?publication=/);
  const historicURL = page.url();
  const live = await context.newPage();
  await live.goto("/#/welcome");
  const liveEntries = live.getByRole("region", { name: "The complete page index", exact: true }).locator('a[href*="/page/"]');
  await expect(liveEntries).toHaveCount(28);
  const liveFilter = live.getByRole("searchbox", { name: "Search published pages", exact: true });
  await liveFilter.fill("starlight");
  await live.getByRole("button", { name: "A–Z", exact: true }).click();
  await expect(liveEntries).toHaveCount(28);
  const published = await request.post(process.env.WIKICONTEXT_TEST_CONTROL + "/publish-new-page");
  expect(published.ok(), await published.text()).toBeTruthy();
  const added = await published.json();
  await expect(live.getByLabel("Publication", { exact: true }).locator(`option[value="${added.id}"]`)).toHaveCount(1);
  await expect(liveFilter).toHaveValue("starlight");
  await expect(liveEntries).toHaveCount(29);
  await expect(live.getByRole("button", { name: "A–Z", exact: true })).toHaveAttribute("aria-pressed", "true");
  await liveFilter.fill("");
  await expect(liveEntries).toHaveCount(29);
  await live.close();
  await expect(history.locator(`option[value="${added.id}"]`)).toHaveCount(1);
  await expect(entries).toHaveCount(28);
  await expect(index.getByRole("link", { name: /Zenith guide/ })).toHaveCount(0);
  await page.reload();
  await expect(entries).toHaveCount(28);
  await history.selectOption("live");
  await expect(entries).toHaveCount(29);
  await expect(index.getByRole("link", { name: /Zenith guide/ })).toBeVisible();
  await index.getByRole("link", { name: /Zenith guide/ }).click();
  await expect(page.getByRole("heading", { name: "Zenith guide", exact: true })).toBeVisible();
  await page.goto(historicURL);
  await expect(entries).toHaveCount(28);
  const historicalGuide = onboarding.getByRole("link", { name: /Open onboarding/ });
  expect(await historicalGuide.getAttribute("href")).toContain("publication=");
  await historicalGuide.click();
  await expect(page.getByRole("heading", { name: "Colleague onboarding", exact: true })).toBeVisible();
  await expect(history).not.toHaveValue("live");
});


test("protected image previews support evidence links, enlargement, retry and session cleanup", async ({ page, context, request }) => {
  const seeded = await request.post(process.env.WIKICONTEXT_TEST_CONTROL + "/images");
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  const records = await seeded.json();
  const sourcePath = `/#/sources/${records.image}`;
  // Login preserves an image evidence permalink.
  await page.goto(sourcePath);
  await page.getByText("Sign in with a password", { exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("agent@example.com");
  await page.getByLabel("Password", { exact: true }).fill("SyntheticUserPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const preview = page.getByRole("img", { name: "Original source: Synthetic image source", exact: true });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1200);
  const evidence = page.locator(".evidence-browser");
  const collectionHeading = evidence.getByRole("heading", { name: "Sources", exact: true });
  const recordHeading = evidence.getByRole("heading", { name: "Synthetic image source", exact: true });
  const headingBounds = await collectionHeading.boundingBox();
  const recordBounds = await recordHeading.boundingBox();
  expect(Math.abs(headingBounds!.x - recordBounds!.x)).toBeLessThan(2);
  expect((await preview.boundingBox())!.width).toBeGreaterThan(600);
  const actions = evidence.getByRole("group", { name: "Record actions", exact: true });
  await expect(actions.getByRole("button", { name: "Copy record link", exact: true })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Download original", exact: true })).toBeVisible();
  await expect(evidence.getByRole("link", { name: "View source passages", exact: true })).toBeVisible();
  const selectedEvidence = page.locator('.page-list a[aria-current="page"]');
  await expect(selectedEvidence).toContainText("Synthetic image source");
  await expect(selectedEvidence).not.toContainText(records.image);
  await evidence.locator("summary").click();
  await expect(evidence.locator(".evidence-details")).toContainText(records.image);
  await evidence.locator("summary").click();
  await page.locator("#reader").evaluate(node => node.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: "/tmp/wikicontext-image-desktop.png", fullPage: true });
  const originalURL = (await preview.getAttribute("src"))!;
  expect(new URL(originalURL).searchParams.get("download")).not.toBe("1");
  expect(new URL(originalURL).searchParams.has("token")).toBeTruthy();
  const anonymous = await request.get(originalURL.replace(/([?&])token=[^&]+/, "$1"));
  expect(anonymous.ok()).toBeFalsy();
  await expect(page).toHaveURL(new RegExp(`#\/sources/${records.image}$`));
  await page.reload();
  await expect(preview).toBeVisible();
  const enlarge = page.getByRole("button", { name: "Enlarge image", exact: true });
  await enlarge.focus();
  await page.keyboard.press("Enter");
  const enlarged = page.getByRole("dialog", { name: "Enlarged source image", exact: true });
  await expect(enlarged).toBeVisible();
  await expect(enlarged.getByRole("img")).toBeVisible();
  await enlarged.getByRole("button", { name: "Show actual size", exact: true }).click();
  expect(await enlarged.getByRole("img").evaluate(node => node.getBoundingClientRect().width)).toBe(1200);
  await expect(enlarged.getByRole("button", { name: "Fit image to width", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(enlarged).toHaveCount(0);
  await expect(enlarge).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await enlarge.click();
  await expect(enlarged).toBeVisible();
  expect(await enlarged.evaluate(node => node.getBoundingClientRect().width <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: "/tmp/wikicontext-image-mobile.png", fullPage: true });
  await enlarged.getByRole("button", { name: "Close enlarged image", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/#/passages/${records.passage}`);
  await expect(preview).toBeVisible();
  await expect(page.locator("blockquote.passage")).toContainText("synthetic blue image");
  await page.goto("/#/page/image-evidence");
  await page.getByRole("button", { name: "Citation 1", exact: true }).click();
  await expect(preview).toBeVisible();
  await enlarge.click();
  await expect(enlarged).toBeVisible();
  await page.keyboard.press("Tab");
  expect(await enlarged.evaluate(node => node.contains(document.activeElement))).toBeTruthy();
  await page.keyboard.press("Escape");
  await expect(enlarged).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open passage", exact: true })).toBeVisible();
  await expect(enlarge).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Closed enlargement controls must not enter the citation focus trap when
  // the original-download token request failed independently of preview retry.
  await page.route("**/api/files/token", route => route.fulfill({ status: 503,
    contentType: "application/json", body: JSON.stringify({ message: "Synthetic token failure" }) }));
  await page.getByRole("button", { name: "Citation 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry image preview", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Open original/ })).toHaveCount(0);
  await page.unroute("**/api/files/token");
  await page.getByRole("button", { name: "Retry image preview", exact: true }).click();
  await expect(preview).toBeVisible();
  const closeEvidence = page.getByRole("button", { name: "Close evidence", exact: true });
  await closeEvidence.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(enlarge).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeEvidence).toBeFocused();
  await page.keyboard.press("Escape");
  await page.goto(`/#/sources/${records.unsupported}`);
  await expect(page.getByText("Preview is unavailable for this image format. Download the original to view it.", { exact: true })).toBeVisible();
  await expect(page.locator("img")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download original", exact: true })).toBeVisible();
  await page.goto(`/#/sources/${records.broken}`);
  await expect(page.getByText("Unable to load image preview.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry image preview", exact: true })).toBeVisible();
  let tokenRequests = 0;
  page.on("request", event => { if (event.url().endsWith("/api/files/token")) tokenRequests++; });
  const imageFiles = `**/api/files/sources/${records.image}/**`;
  await page.route(imageFiles, route => route.fulfill({ status: 403, body: "Synthetic expired file token" }));
  await page.goto(sourcePath);
  // Hash navigation can leave the previous broken source visible briefly.
  // Wait for this source before accepting its error and removing the mock.
  await expect(recordHeading).toBeVisible();
  await expect(page.getByText("Unable to load image preview.", { exact: true })).toBeVisible();
  const beforeRetry = tokenRequests;
  await page.unroute(imageFiles);
  await page.getByRole("button", { name: "Retry image preview", exact: true }).click();
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1200);
  expect(tokenRequests).toBeGreaterThan(beforeRetry);
  // A late preview token cannot recreate an image after navigation and logout.
  await page.goto("/#/page/telescope");
  let releaseToken!: () => void;
  const gate = new Promise<void>(resolve => { releaseToken = resolve; });
  await page.route("**/api/files/token", async route => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  const pendingToken = page.waitForRequest("**/api/files/token");
  await page.goto(sourcePath);
  await pendingToken;
  await page.goto("/#/page/telescope");
  await page.getByRole("button", { name: /Sign out/ }).click();
  releaseToken();
  await expect(page.getByText("Sign in with a password", { exact: true })).toBeVisible();
  await expect(preview).toHaveCount(0);
  await page.unroute("**/api/files/token");
  await login(page);
  await page.goto(sourcePath);
  await expect(preview).toBeVisible();
  const peer = await context.newPage();
  await peer.goto("/#/page/telescope");
  await peer.getByRole("button", { name: /Sign out/ }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByText("Sign in with a password", { exact: true })).toBeVisible();
});


test("large transcript opens under the production Context request limit", async ({ page, request }) => {
  const seeded = await request.post(process.env.WIKICONTEXT_TEST_CONTROL + "/transcript");
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  await login(page);
  const throttled: string[] = [];
  let queries = 0;
  page.on("response", response => { if (response.status() === 429) throttled.push(response.url()); });
  page.on("request", request => { if (request.url().endsWith("/api/context/query")) queries++; });
  await page.goto("/#/page/large-transcript");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Large transcript", exact: true })).toBeVisible();
  await expect(page.locator(".source-row")).toHaveCount(738);
  await page.getByRole("button", { name: "Citation 738", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open passage", exact: true })).toBeVisible();
  expect(throttled).toEqual([]);
  expect(queries).toBeLessThan(60);
});

test("property evidence, catalog filters, pagination, historical links and mobile cards", async ({ page, request }) => {
  const seeded = await request.post(process.env.WIKICONTEXT_TEST_CONTROL + "/catalog");
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  const publication = await seeded.json() as { id: string };
  await page.goto(`/#/catalog/resource?publication=${publication.id}`);
  await page.getByText("Sign in with a password", { exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("agent@example.com");
  await page.getByLabel("Password", { exact: true }).fill("SyntheticUserPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Resources", exact: true })).toBeVisible();
  await expect(page.locator(".catalog-page").getByRole("status")).toHaveText("51 pages · 1–50");
  if (process.env.WIKICONTEXT_TEST_SCREENSHOTS) await page.screenshot({ path: `${process.env.WIKICONTEXT_TEST_SCREENSHOTS}/wiki-properties-desktop.png` });
  await page.getByRole("link", { name: "Next", exact: true }).click();
  await expect(page.locator(".catalog-table").getByRole("link", { name: "Catalog bucket 50" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".catalog-page").getByRole("status")).toHaveText("51 pages · 51–51");
  await page.getByLabel("Missing owner", { exact: true }).check();
  await expect(page.locator(".catalog-page").getByRole("status")).toHaveText("1 page · 1–1");
  await page.getByLabel("Provider", { exact: true }).selectOption("Fixture cloud");
  await page.getByLabel("Deployment", { exact: true }).selectOption({ label: "Synthetic cluster" });
  await page.getByLabel("Lifecycle", { exact: true }).selectOption("active");
  await page.getByLabel("Search catalog", { exact: true }).fill("synthetic-bucket-0");
  await expect(page).toHaveURL(/publication=.*missingOwner=true/);
  await page.locator(".catalog-table").getByRole("link", { name: "Catalog bucket 00" }).click();
  const panel = page.getByRole("region", { name: "Page properties" });
  await expect(panel).toBeVisible();
  const evidence = panel.getByRole("button", { name: "Evidence for Provider observed at: citation 1" });
  await evidence.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("Observatory source");
  await page.keyboard.press("Escape");
  await expect(evidence).toBeFocused();
  await panel.getByText(/All properties/).click();
  await expect(panel.getByText("Not returned", { exact: true })).toBeVisible();
  if (process.env.WIKICONTEXT_TEST_SCREENSHOTS) await page.screenshot({ path: `${process.env.WIKICONTEXT_TEST_SCREENSHOTS}/wiki-properties-detail.png` });
  await panel.getByRole("link", { name: "Synthetic cluster" }).click();
  await expect(page).toHaveURL(new RegExp(`publication=${publication.id}`));
  await expect(page.getByRole("heading", { name: "Synthetic cluster", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/catalog/resource?publication=${publication.id}&missingOwner=true`);
  await expect(page.locator(".catalog-cards")).toBeVisible();
  await expect(page.locator(".catalog-table")).toBeHidden();
  await page.locator(".catalog-cards").getByText("Record properties").click();
  await expect(page.locator(".catalog-cards").getByText("2026-10-08")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  if (process.env.WIKICONTEXT_TEST_SCREENSHOTS) await page.screenshot({ path: `${process.env.WIKICONTEXT_TEST_SCREENSHOTS}/wiki-properties-mobile.png` });
  await page.locator(".catalog-cards").getByRole("link", { name: "Catalog bucket 00" }).click();
  await expect(panel).toBeVisible();
  await page.goto("/#/catalog/resource?publication=" + publication.id);
  await page.getByLabel("Publication", { exact: true }).selectOption({ label: "Publication 1" });
  await expect(page.locator(".catalog-page").getByRole("status")).toHaveText("0 pages");
  await expect(page.getByRole("heading", { name: "Resources", exact: true })).toBeVisible();
});

test("people and group membership, responsibilities and publication history", async ({ page, request }) => {
  const seeded = await request.post(process.env.WIKICONTEXT_TEST_CONTROL + "/directory");
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  const publication = await seeded.json() as { id: string };
  await login(page);
  await page.goto(`/#/catalog/person?publication=${publication.id}`);
  await expect(page.getByRole("heading", { name: "People", exact: true })).toBeVisible();
  await page.getByLabel("Group", { exact: true }).selectOption({ label: "Core" });
  await expect(page.locator(".catalog-page").getByRole("status")).toHaveText("2 pages · 1–2");
  await page.reload();
  await expect(page.getByLabel("Group", { exact: true })).not.toHaveValue("");
  await page.locator(".catalog-table").getByRole("link", { name: "Ben", exact: true }).click();
  const panel = page.getByRole("region", { name: "Page properties" });
  await expect(panel.getByRole("heading", { name: "Responsibilities through groups" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Directory service", exact: true })).toHaveCount(2);
  await panel.getByRole("link", { name: "Core", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`publication=${publication.id}`));
  await expect(panel.getByRole("link", { name: "Ben", exact: true })).toBeVisible();
  const updated = await request.post(process.env.WIKICONTEXT_TEST_CONTROL + "/directory-update");
  expect(updated.ok(), await updated.text()).toBeTruthy();
  const later = await updated.json() as { id: string };
  await page.reload();
  await expect(panel.getByRole("link", { name: "Ben", exact: true })).toBeVisible();
  await page.goto(`/#/page/directory-ben?publication=${later.id}`);
  await expect(panel.getByRole("link", { name: "Directory service", exact: true })).toHaveCount(0);
  await page.goto(`/#/catalog/group?publication=${publication.id}`);
  await page.getByLabel("Member", { exact: true }).selectOption({ label: "Ben" });
  await expect(page.locator(".catalog-page").getByRole("status")).toHaveText("1 page · 1–1");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".catalog-cards")).toBeVisible();
  await page.locator(".catalog-cards").getByText("Record properties").click();
  await expect(page.locator(".catalog-cards").getByRole("link", { name: "Ben", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test("repository files group copies, filter, preserve history and expose stale checks on mobile", async ({ page, request }) => {
  const seeded = await request.post(process.env.WIKICONTEXT_TEST_CONTROL + "/repository-files");
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  const publication = await seeded.json() as { id: string };
  await login(page);
  const catalog = page.getByRole("region", { name: "Repository files catalog" });
  await page.goto(`/#/catalog/repository_document?publication=${publication.id}`);
  await expect(page.getByRole("heading", { name: "Repository files", exact: true })).toBeVisible();
  await expect(catalog.getByRole("link", { name: "README copy one", exact: true })).toBeVisible();
  await expect(catalog.getByRole("link", { name: "README copy two", exact: true })).toBeVisible();
  await expect(page.locator(".repository-destinations strong").first()).toHaveText("current");
  await page.getByLabel("Repository", { exact: true }).selectOption("example/one");
  await page.reload();
  await expect(page.getByLabel("Repository", { exact: true })).toHaveValue("example/one");
  await expect(catalog.getByRole("link", { name: "README copy two", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Sync evidence", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`page/readme-sync\\?publication=${publication.id}`));
  const updated = await request.post(process.env.WIKICONTEXT_TEST_CONTROL + "/repository-files-update");
  expect(updated.ok(), await updated.text()).toBeTruthy();
  const later = await updated.json() as { id: string };
  await page.goto(`/#/catalog/repository_document?publication=${later.id}&syncStatus=behind`);
  await expect(page.locator(".repository-destinations strong")).toHaveText("behind");
  await expect(page.getByText("Source revision differs from the last synchronized revision.")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.goto(`/#/catalog/repository_document?publication=${publication.id}&repository=example%2Fone`);
  await expect(page.locator(".repository-destinations strong")).toHaveText("current");
});

test("prompts preserve exact originals, filter metadata, retain history and work on mobile", async ({ page, request, context }) => {
  const seeded = await request.post(process.env.WIKICONTEXT_TEST_CONTROL + "/prompts");
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  const fixture = await seeded.json();
  await login(page);
  await page.goto(`/#/catalog/prompt?publication=${fixture.publication.id}`);
  const catalog = page.getByRole("region", {name:"Prompts catalog"});
  await expect(catalog.getByRole("status")).toHaveText("2 prompts · 1–2");
  await page.getByLabel("Target agent", {exact:true}).selectOption("codex");
  await page.getByLabel("Required skill", {exact:true}).selectOption("wikicontext");
  await page.reload();
  await expect(page.getByLabel("Target agent", {exact:true})).toHaveValue("codex");
  await expect(page).toHaveURL(new RegExp(`publication=${fixture.publication.id}`));
  const exact = catalog.locator("article").filter({has:page.getByRole("link", {name:"Exact setup prompt",exact:true})});
  await exact.getByRole("button", {name:"Preview prompt"}).focus();
  await page.keyboard.press("Enter");
  await expect(exact.getByRole("button", {name:"Download prompt"})).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await exact.getByRole("button", {name:"Download prompt"}).click();
  const download = await downloadEvent;
  expect((await readFile((await download.path())!)).toString("utf8")).toBe(fixture.exact_text);
  const markdown = catalog.locator("article").filter({has:page.getByRole("link", {name:"Onboarding prompt",exact:true})});
  await markdown.getByRole("button", {name:"Preview prompt"}).click();
  await context.grantPermissions(["clipboard-read","clipboard-write"]);
  await markdown.getByRole("button", {name:"Copy prompt"}).click();
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(fixture.markdown_text);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByLabel("Search prompts", {exact:true}).fill("no such prompt");
  await expect(catalog.getByRole("status")).toHaveText("0 prompts");
  await expect(page.getByRole("button", {name:"Copy prompt"})).toHaveCount(0);
});
