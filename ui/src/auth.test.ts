import PocketBase, { BaseAuthStore, LocalAuthStore, type RecordAuthResponse } from "pocketbase";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const key = "pocketcontext.reader.auth";
const record = { id: "user00000000001", collectionName: "users", collectionId: "_pb_users_auth_" };
const token = `synthetic.${btoa(JSON.stringify({ exp: 4102444800 }))}.signature`;
let api: typeof import("./api");
const servicePrototype = Object.getPrototypeOf(new PocketBase().collection("users"));
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function pendingPassword() {
  const pending = deferred<RecordAuthResponse>();
  // Actual SDK clients and isolated stores; delay only the password boundary.
  const password = vi.spyOn(servicePrototype, "authWithPassword").mockImplementation(function (this: { client: PocketBase }) {
    return pending.promise.then(result => {
      this.client.authStore.save(result.token, result.record);
      return result;
    });
  });
  return { ...pending, password };
}
beforeEach(async () => {
  vi.resetModules();
  localStorage.clear(); sessionStorage.clear();
  vi.spyOn(window, "open");
  api = await import("./api");
});
afterEach(() => {
  api.cancelLogin(); api.pb.authStore.clear();
  vi.restoreAllMocks();
});
describe("sign-in completion fences", () => {
  it.each(["cancel", "logout"])("cannot persist a delayed SDK result after %s", async action => {
    const pending = pendingPassword();
    const attempt = api.loginPassword("synthetic-password");
    const rejected = expect(attempt).rejects.toThrow(/cancel/i);
    if (action === "logout") api.logout();
    else api.cancelLogin();
    await rejected;
    pending.resolve({ token, record });
    await pending.promise; await Promise.resolve();
    expect(api.pb.authStore.token).toBe("");
    expect(localStorage.getItem(key)).toBeNull();
  });
  it("does not replace an account that signed in while the attempt was pending", async () => {
    const pending = pendingPassword();
    const attempt = api.loginPassword("synthetic-password");
    const other = { ...record, id: "user00000000002" };
    api.pb.authStore.save("other-token", other);
    pending.resolve({ token, record });
    await expect(attempt).rejects.toThrow(/session changed/i);
    expect(api.pb.authStore.record?.id).toBe(other.id);
    expect(api.pb.authStore.token).toBe("other-token");
  });
  it.each([null, key])("cancels an anonymous pending attempt on another tab’s logout (%s)", async storageKey => {
    const pending = pendingPassword();
    const attempt = api.loginPassword("synthetic-password");
    const rejected = expect(attempt).rejects.toThrow(/cancel/i);
    window.dispatchEvent(new StorageEvent("storage", { key: storageKey, storageArea: localStorage }));
    await rejected;
    pending.resolve({ token, record });
    await pending.promise; await Promise.resolve();
    expect(api.pb.authStore.token).toBe("");
    expect(localStorage.getItem(key)).toBeNull();
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
  it("persists password login under the fixed local identity without opening a popup", async () => {
    const password = vi.spyOn(servicePrototype, "authWithPassword").mockResolvedValue({ token, record });
    await api.loginPassword("synthetic-password");
    expect(password).toHaveBeenCalledWith(api.localIdentity, "synthetic-password");
    expect(window.open).not.toHaveBeenCalled();
    expect(api.pb.authStore.token).toBe(token);
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ token, record });
  });
  it("keeps the newer identity after a superseded attempt completes", async () => {
    const first = pendingPassword();
    const attempt = api.loginPassword("synthetic-password");
    const rejected = expect(attempt).rejects.toThrow(/cancel/i);
    const other = { ...record, id: "user00000000002" };
    first.password.mockResolvedValueOnce({ token, record: other });
    await api.loginPassword("synthetic-password"); await rejected;
    first.resolve({ token, record }); await first.promise; await Promise.resolve();
    expect(api.pb.authStore.record?.id).toBe(other.id);
  });
  it("reports a failed sign-in without storing a session", async () => {
    vi.spyOn(servicePrototype, "authWithPassword").mockRejectedValue(new Error("Failed to authenticate."));
    await expect(api.loginPassword("wrong")).rejects.toThrow("Failed to authenticate.");
    expect(api.pb.authStore.token).toBe("");
  });
});
