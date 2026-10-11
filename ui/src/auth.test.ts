import PocketBase, { BaseAuthStore, LocalAuthStore, type RecordAuthResponse } from "pocketbase";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const key = "wikicontext.reader.auth";
const record = { id: "user00000000001", collectionName: "users", collectionId: "_pb_users_auth_" };
const token = `synthetic.${btoa(JSON.stringify({ exp: 4102444800 }))}.signature`;
let api: typeof import("./api");
let close: ReturnType<typeof vi.fn>;
const servicePrototype = Object.getPrototypeOf(new PocketBase().collection("users"));
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function pendingOAuth() {
  const pending = deferred<RecordAuthResponse>();
  // Actual SDK clients and isolated stores; delay only the OAuth boundary.
  const oauth = vi.spyOn(servicePrototype, "authWithOAuth2").mockImplementation(function (this: { client: PocketBase }) {
    return pending.promise.then(result => {
      this.client.authStore.save(result.token, result.record);
      return result;
    });
  });
  return { ...pending, oauth };
}
beforeEach(async () => {
  vi.resetModules();
  localStorage.clear(); sessionStorage.clear();
  close = vi.fn();
  vi.spyOn(window, "open").mockReturnValue({ location: { href: "" }, close } as unknown as Window);
  api = await import("./api");
});
afterEach(() => {
  api.cancelGoogleLogin(); api.pb.authStore.clear();
  vi.useRealTimers(); vi.restoreAllMocks();
});
describe("Google sign-in completion fences", () => {
  it.each(["cancel", "timeout", "logout"])("cannot persist a delayed SDK result after %s", async action => {
    vi.useFakeTimers();
    const pending = pendingOAuth();
    const attempt = api.loginGoogle();
    const rejected = expect(attempt).rejects.toThrow(action === "timeout" ? /timed out/i : /cancel/i);
    if (action === "timeout") await vi.advanceTimersByTimeAsync(180000);
    else if (action === "logout") api.logout();
    else api.cancelGoogleLogin();
    await rejected;
    pending.resolve({ token, record });
    await pending.promise; await Promise.resolve();
    expect(api.pb.authStore.token).toBe("");
    expect(localStorage.getItem(key)).toBeNull();
    expect(close).toHaveBeenCalled();
  });
  it("does not replace an account that signed in while the popup was pending", async () => {
    const pending = pendingOAuth();
    const attempt = api.loginGoogle();
    const other = { ...record, id: "user00000000002" };
    api.pb.authStore.save("other-token", other);
    pending.resolve({ token, record });
    await expect(attempt).rejects.toThrow(/session changed/i);
    expect(api.pb.authStore.record?.id).toBe(other.id);
    expect(api.pb.authStore.token).toBe("other-token");
  });
  it("cancels before discovery completes without navigating the closed popup", async () => {
    const discovery = deferred<void>();
    const navigate = vi.fn();
    const location = { set href(_value: string) { navigate(); } };
    vi.mocked(window.open).mockReturnValue({ location, close } as unknown as Window);
    vi.spyOn(servicePrototype, "authWithOAuth2").mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as { urlCallback: (url: string) => void };
      await discovery.promise;
      options.urlCallback("https://accounts.google.com/o/oauth2/auth?state=synthetic");
      return { token, record };
    });
    const attempt = api.loginGoogle(); api.cancelGoogleLogin();
    await expect(attempt).rejects.toThrow(/cancel/i);
    discovery.resolve(); await discovery.promise; await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
    expect(api.pb.authStore.token).toBe("");
  });
  it.each([null, key])("cancels an anonymous pending popup on another tab’s logout (%s)", async storageKey => {
    const pending = pendingOAuth();
    const attempt = api.loginGoogle();
    const rejected = expect(attempt).rejects.toThrow(/cancel/i);
    window.dispatchEvent(new StorageEvent("storage", { key: storageKey, storageArea: localStorage }));
    await rejected;
    pending.resolve({ token, record });
    await pending.promise; await Promise.resolve();
    expect(api.pb.authStore.token).toBe("");
    expect(localStorage.getItem(key)).toBeNull();
  });
  it.each([
    "http://accounts.google.com/o/oauth2/auth",
    "https://accounts.google.com:444/o/oauth2/auth",
    "https://accounts.google.com.example.org/o/oauth2/auth",
    "https://name:password@accounts.google.com/o/oauth2/auth",
  ])("rejects an unexpected provider destination: %s", async url => {
    const navigate = vi.fn();
    const location = { set href(_value: string) { navigate(); } };
    vi.mocked(window.open).mockReturnValue({ location, close } as unknown as Window);
    vi.spyOn(servicePrototype, "authWithOAuth2").mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as { urlCallback: (url: string) => void };
      options.urlCallback(url);
      return { token, record };
    });
    await expect(api.loginGoogle()).rejects.toThrow(/unexpected Google authorization/i);
    expect(navigate).not.toHaveBeenCalled();
    expect(api.pb.authStore.token).toBe("");
    expect(close).toHaveBeenCalled();
  });
  it("reports blocked popups without starting provider discovery", async () => {
    vi.mocked(window.open).mockReturnValue(null);
    const pending = pendingOAuth();
    await expect(api.loginGoogle()).rejects.toThrow(/popup/i);
    expect(pending.oauth).not.toHaveBeenCalled();
  });
});
describe("SDK browser auth storage", () => {
  it("uses the named LocalAuthStore and discards legacy per-tab credentials", async () => {
    sessionStorage.setItem(key, JSON.stringify({ token, record }));
    vi.resetModules(); api = await import("./api");
    expect(api.pb.authStore).toBeInstanceOf(LocalAuthStore);
    expect(sessionStorage.getItem(key)).toBeNull();
    api.pb.authStore.save(token, record);
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ token, record });
  });
  it("keeps a usable memory session when local storage writes are blocked", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    vi.resetModules(); api = await import("./api");
    expect(api.pb.authStore).toBeInstanceOf(BaseAuthStore);
    expect(api.pb.authStore).not.toBeInstanceOf(LocalAuthStore);
    api.pb.authStore.save(token, record);
    expect(api.pb.authStore.isValid).toBe(true);
    api.logout(); expect(api.pb.authStore.token).toBe("");
  });
  it("clears the session on another tab's localStorage.clear event", () => {
    api.pb.authStore.save(token, record);
    const generation = api.sessionGeneration;
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
    expect(api.pb.authStore.token).toBe("");
    expect(api.sessionGeneration).toBeGreaterThan(generation);
  });
});

describe("password and competing attempts", () => {
  it("persists password login without opening a popup", async () => {
    vi.spyOn(servicePrototype, "authWithPassword").mockResolvedValue({ token, record });
    await api.loginPassword("reader@example.test", "synthetic-password");
    expect(window.open).not.toHaveBeenCalled();
    expect(api.pb.authStore.token).toBe(token);
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ token, record });
  });
  it("fences a password result after logout", async () => {
    const pending = deferred<RecordAuthResponse>();
    vi.spyOn(servicePrototype, "authWithPassword").mockReturnValue(pending.promise);
    const attempt = api.loginPassword("reader@example.test", "synthetic-password");
    const rejected = expect(attempt).rejects.toThrow(/cancel/i);
    api.logout(); await rejected;
    pending.resolve({ token, record }); await pending.promise; await Promise.resolve();
    expect(api.pb.authStore.token).toBe("");
  });
  it("keeps newer password identity after a superseded popup completes", async () => {
    const pending = pendingOAuth();
    const first = api.loginGoogle();
    const rejected = expect(first).rejects.toThrow(/cancel/i);
    const other = { ...record, id: "user00000000002" };
    vi.spyOn(servicePrototype, "authWithPassword").mockResolvedValue({ token, record: other });
    await api.loginPassword("other@example.test", "synthetic-password"); await rejected;
    pending.resolve({ token, record }); await pending.promise; await Promise.resolve();
    expect(api.pb.authStore.record?.id).toBe(other.id);
  });
  it("opens Google synchronously and persists successful login", async () => {
    const pending = pendingOAuth();
    const attempt = api.loginGoogle();
    expect(window.open).toHaveBeenCalledOnce();
    pending.resolve({ token, record }); await attempt;
    expect(api.pb.authStore.token).toBe(token);
    expect(close).toHaveBeenCalled();
  });
  it("closes popup when discovery fails", async () => {
    vi.spyOn(servicePrototype, "authWithOAuth2").mockRejectedValue(new Error("Provider unavailable"));
    await expect(api.loginGoogle()).rejects.toThrow("Provider unavailable");
    expect(close).toHaveBeenCalled();
    expect(api.pb.authStore.token).toBe("");
  });
});
