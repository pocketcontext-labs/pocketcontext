import { StrictMode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import Login, { readEmailLoginLink } from "./Login";
import App from "./App";

beforeEach(() => {
  history.replaceState(null, "", "/");
  vi.spyOn(api, "loginMode").mockResolvedValue("email");
  vi.spyOn(api, "loginEmail").mockResolvedValue(undefined);
  vi.spyOn(api, "requestEmailLogin").mockResolvedValue(undefined);
  vi.spyOn(api, "loginPassword").mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

it("requests a link without revealing whether the email is registered", async () => {
  render(<Login />);
  fireEvent.change(await screen.findByLabelText("Email"), {
    target: { value: "owner@example.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send login link" }));
  await screen.findByText(/If this email matches this knowledge base/);
  expect(api.requestEmailLogin).toHaveBeenCalledWith("owner@example.test");
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(api.loginEmail).not.toHaveBeenCalled();
});

it("never redeems a link on mount, including React strict effects", async () => {
  history.replaceState(null, "", "/#/login?otpId=syntheticid1234&otp=12345678");
  const link = readEmailLoginLink()!;
  const done = vi.fn();
  render(
    <StrictMode>
      <Login emailLink={link} onEmailComplete={done} />
    </StrictMode>,
  );
  const confirm = await screen.findByRole("button", { name: "Log in" });
  expect(api.loginEmail).not.toHaveBeenCalled();
  expect(api.requestEmailLogin).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  expect(api.loginEmail).toHaveBeenCalledExactlyOnceWith(
    "syntheticid1234",
    "12345678",
  );
});

it("lets an expired link request another without exposing the token", async () => {
  vi.mocked(api.loginEmail).mockRejectedValue(new Error("server detail"));
  render(
    <Login emailLink={{ otpId: "syntheticid1234", password: "12345678" }} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Log in" }));
  await screen.findByText(
    "This login link is invalid or expired. Request a new one below.",
  );
  expect(document.body.textContent).not.toContain("12345678");
  fireEvent.click(screen.getByRole("button", { name: "Request a new link" }));
  expect(screen.getByLabelText("Email")).toBeInTheDocument();
});

it("preserves the existing local password flow", async () => {
  vi.mocked(api.loginMode).mockResolvedValue("password");
  render(<Login />);
  fireEvent.change(await screen.findByLabelText("Password"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() =>
    expect(api.loginPassword).toHaveBeenCalledWith("synthetic-password"),
  );
  expect(screen.queryByLabelText("Email")).toBeNull();
  expect(screen.getByText("pocketcontext init")).toBeInTheDocument();
});

it("fails closed when authentication configuration is unavailable", async () => {
  vi.mocked(api.loginMode).mockRejectedValue(new Error("offline"));
  render(<Login />);
  await screen.findByRole("alert");
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(screen.queryByLabelText("Email")).toBeNull();
  vi.mocked(api.loginMode).mockResolvedValue("email");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByLabelText("Email");
});

it.each([
  "#/login?otpId=id&otp=1234&otp=5678",
  "#/login?otpId=id",
  "#/login?otpId=id&otp=abc",
  "#/login",
])("rejects malformed login fragments: %s", (hash) => {
  history.replaceState(null, "", "/" + hash);
  expect(readEmailLoginLink()).toEqual({ otpId: "", password: "" });
});
it("does not interpret query-string credentials or knowledge navigation as login", () => {
  history.replaceState(null, "", "/?otpId=id&otp=1234#/page/login");
  expect(readEmailLoginLink()).toBeNull();
});

it("scrubs the email secret from browser history while retaining explicit confirmation", async () => {
  history.replaceState(null, "", "/#/login?otpId=syntheticid1234&otp=12345678");
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await screen.findByRole("button", { name: "Log in" });
  expect(location.hash).toBe("#/login");
  expect(location.href).not.toContain("12345678");
  expect(api.loginEmail).not.toHaveBeenCalled();
});

it("accepts a replacement email link in an already-open tab without redeeming it", async () => {
  history.replaceState(null, "", "/#/login?otpId=firstid12345678&otp=12345678");
  render(<App />);
  await screen.findByRole("button", { name: "Log in" });
  history.replaceState(null, "", "/#/login?otpId=secondid1234567&otp=87654321");
  fireEvent(window, new HashChangeEvent("hashchange"));
  await screen.findByRole("button", { name: "Log in" });
  expect(location.hash).toBe("#/login");
  expect(api.loginEmail).not.toHaveBeenCalled();
  // Leave the request pending so this test does not mount the private reader.
  vi.mocked(api.loginEmail).mockReturnValue(new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  expect(api.loginEmail).toHaveBeenCalledExactlyOnceWith(
    "secondid1234567",
    "87654321",
  );
});
