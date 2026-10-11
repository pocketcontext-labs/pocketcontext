import { expect, test, type Page } from "@playwright/test";

async function passwordLogin(page: Page) {
  await page.goto("/#/page/observatory");
  await page.getByText("Sign in with a password", { exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("agent@example.com");
  await page.getByLabel("Password", { exact: true }).fill("SyntheticUserPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toBeVisible();
}

test("clearing storage in another tab clears private content and preserves the login destination", async ({ page, context }) => {
  await passwordLogin(page);
  const peer = await context.newPage();
  await peer.goto("/#/page/telescope");
  await expect(peer.getByRole("heading", { name: "Telescope", exact: true })).toBeVisible();
  await peer.evaluate(() => localStorage.clear());
  await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/#\/page\/observatory$/);
  await passwordLogin(page);
});

test("blocked browser storage permits a memory-only password session until reload", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() { throw new DOMException("Synthetic blocked storage", "SecurityError"); },
    });
  });
  await passwordLogin(page);
  await page.reload();
  await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Observatory", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/#\/page\/observatory$/);
});

test("blocked Google popups show retry guidance without losing the destination", async ({ page }) => {
  await page.addInitScript(() => { window.open = () => null; });
  await page.goto("/#/page/observatory");
  await page.getByRole("button", { name: /Continue with Google/ }).click();
  await expect(page.getByRole("alert")).toContainText("Allow the sign-in popup");
  await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeEnabled();
  await expect(page).toHaveURL(/#\/page\/observatory$/);
});

test("Google opens immediately and keyboard cancellation closes the popup on mobile", async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  // Hold provider discovery: the popup must already exist, with no external navigation.
  await page.route("**/api/collections/users/auth-methods*", () => {});
  await page.goto("/#/page/observatory");
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("button", { name: /Continue with Google/ }).click();
  const popup = await popupPromise;
  expect(popup.url()).toBe("about:blank");
  const cancel = page.getByRole("button", { name: "Cancel Google sign-in" });
  await expect(cancel).toBeVisible();
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("cancelled");
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("Google timeout closes its popup and allows retry", async ({ page, context }) => {
  await page.clock.install();
  await page.route("**/api/collections/users/auth-methods*", () => {});
  await page.goto("/#/page/observatory");
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("button", { name: /Continue with Google/ }).click();
  const popup = await popupPromise;
  await expect(page.getByRole("button", { name: "Cancel Google sign-in" })).toBeVisible();
  await page.clock.fastForward(180_001);
  await expect(page.getByRole("alert")).toContainText("timed out");
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeEnabled();
  const retryPromise = context.waitForEvent("page");
  await page.getByRole("button", { name: /Continue with Google/ }).click();
  const retry = await retryPromise;
  await page.getByRole("button", { name: "Cancel Google sign-in" }).click();
  await expect.poll(() => retry.isClosed()).toBe(true);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
