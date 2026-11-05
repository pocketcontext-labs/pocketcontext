import { useEffect, useState, type FormEvent } from "react";
import Brand from "./Brand";
import { api, localIdentity, type AuthMode } from "./api";

export type EmailLoginLink = { otpId: string; password: string };
/** Only the fragment carries credentials; reading it never redeems a link. */
export function readEmailLoginLink(): EmailLoginLink | null {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  if (path !== "login") return null;
  const params = new URLSearchParams(query);
  const otpId = params.get("otpId") || "";
  const password = params.get("otp") || "";
  if (
    params.getAll("otpId").length !== 1 ||
    params.getAll("otp").length !== 1 ||
    !/^[a-zA-Z0-9]{1,255}$/.test(otpId) ||
    !/^[0-9]{4,71}$/.test(password)
  ) {
    return { otpId: "", password: "" };
  }
  return { otpId, password };
}

export default function Login({
  emailLink,
  onEmailComplete,
}: {
  emailLink?: EmailLoginLink;
  onEmailComplete?: () => void;
}) {
  const [mode, setMode] = useState<AuthMode | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [link, setLink] = useState(emailLink);
  useEffect(() => {
    let active = true;
    setError("");
    api
      .loginMode()
      .then((value) => {
        if (active) setMode(value);
      })
      .catch(() => {
        if (active)
          setError("Unable to load sign-in options. Please try again.");
      });
    return () => {
      active = false;
    };
  }, [retry]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to sign in. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const password = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(async () => {
      await api.loginPassword(String(form.get("password")));
      onEmailComplete?.();
    });
  };
  const email = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(async () => {
      await api.requestEmailLogin(String(form.get("email")));
      setSent(true);
    });
  };
  const confirm = () =>
    void run(async () => {
      if (!link?.otpId || !link.password)
        throw new Error(
          "This login link is incomplete. Request a new one below.",
        );
      try {
        await api.loginEmail(link.otpId, link.password);
      } catch {
        throw new Error(
          "This login link is invalid or expired. Request a new one below.",
        );
      }
      setLink(undefined);
      onEmailComplete?.();
    });
  return (
    <main className="login-shell">
      <section className="login-card">
        <Brand />
        <h1>
          Your knowledge.
          <br />
          Connected.
        </h1>
        <p>
          Your notes and sources, gathered into pages you can follow back to the
          original evidence.
        </p>
        {mode === null && !error && (
          <p role="status">Loading sign-in options…</p>
        )}
        {mode === null && error && (
          <button
            className="primary-button"
            onClick={() => setRetry((value) => value + 1)}
          >
            Try again
          </button>
        )}
        {mode === "password" && (
          <>
            <form className="login-form" onSubmit={password}>
              <input
                type="hidden"
                name="username"
                autoComplete="username"
                value={localIdentity}
              />
              <label>
                Password
                <input
                  required
                  autoFocus
                  name="password"
                  type="password"
                  autoComplete="current-password"
                />
              </label>
              <button className="primary-button" disabled={busy}>
                Sign in
              </button>
            </form>
            <p className="login-hint">
              Use the password you chose with <code>pocketcontext init</code>,
              or run <code>pocketcontext open</code> to sign in with a
              single-use link.
            </p>
          </>
        )}
        {mode === "email" && (
          <>
            {link ? (
              <div className="login-form">
                <h2>Log in with email</h2>
                {link.otpId ? (
                  <>
                    <p>Confirm to open your knowledge base in this browser.</p>
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={confirm}
                    >
                      Log in
                    </button>
                  </>
                ) : (
                  <p role="status">
                    This login link is incomplete. Request a new one.
                  </p>
                )}
                <button
                  disabled={busy}
                  onClick={() => {
                    setLink(undefined);
                    setError("");
                  }}
                >
                  Request a new link
                </button>
              </div>
            ) : (
              <form className="login-form" onSubmit={email}>
                <h2>Log in with email</h2>
                <label>
                  Email
                  <input
                    required
                    autoFocus
                    name="email"
                    type="email"
                    autoComplete="email"
                    maxLength={255}
                  />
                </label>
                <button className="primary-button" disabled={busy}>
                  Send login link
                </button>
              </form>
            )}
            {sent && (
              <p role="status">
                If this email matches this knowledge base, a login link is on
                its way. Check your inbox and spam folder.
              </p>
            )}
            {!link && (
              <p className="login-hint">
                Use the email address registered for this knowledge base. No
                password needed.
              </p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="login-error">
            {error}
          </p>
        )}
        <div className="login-footer">
          <span className="live-dot" /> Living pages. Traceable sources.
        </div>
      </section>
    </main>
  );
}
