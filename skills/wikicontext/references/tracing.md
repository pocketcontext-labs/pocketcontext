# Optional request tracing

Ordinary commands need no ObserveContext installation or login. When the user requests performance tracing, install the separate [ObserveContext skill](https://github.com/pocketcontext/observecontext/tree/main/skills/observecontext). Resolve both installed skill directories to absolute paths. Authenticate independently to WikiContext and ObserveContext using ordinary users; never pass a source application token to ObserveContext.

Set `OBSERVECONTEXT_URL=https://observe.pocketcontext.com` and `OBSERVECONTEXT_USER_EMAIL` to your Workspace email, then run these logins sequentially (each uses loopback port 8765):

```sh
wikicontext login --google
observecontext login --google
observecontext capture \
  --url "$WIKICONTEXT_URL" --service wikicontext.client --upload \
  -- wikicontext sql 'SELECT id FROM pages LIMIT 5'
```

The wrapper requests authenticated server traces, retrieves them with the same source identity, and uploads correlated client/server timings as a private operation owned by the ObserveContext uploader. Only an operator-managed view-all role can see other users' operations. Source space membership does not make telemetry shared. The source server holds a bounded, expiring memory buffer and has no ObserveContext credentials. It emits no traces for ordinary unwrapped requests.

Add `--capture-sql` only when the user authorizes retaining SQL text. Without it, timings are recorded without SQL text. SQL literals can contain sensitive information; the wrapper records submitted SQL itself, independently of the server's SQL-capture setting. Results, credentials and request bodies are not captured. Existing traces cannot be retroactively populated with SQL.

`observecontext dashboard` opens a personal loopback dashboard on port 8766. Over SSH, forward 8765 for login and 8766 for the dashboard. Failed uploads remain in the private account-bound pending queue; use `observecontext flush` to retry after restoring connectivity. Capture adds retrieval/upload latency and measures completed requests, not the full agent session or prompt. Only supported HTTP routes on the explicitly selected origin are instrumented; protected file downloads, realtime streams, subprocesses and unrelated external services are excluded.

For ingestion, this measures WikiContext API requests, including original-file uploads, but not local PDF/audio processing or Gemini/Groq calls.
