# Reader chat removed in 0.22.0

Built-in reader chat and the ACP host integration were removed in 0.22.0.
Use an external agent with the PocketContext skill and authenticated CLI/API for
questions, ingestion and synthesis. HTTPS phone browsing and search remain available.

Existing machine-local chat files are left untouched, but the reader no longer
opens them. Chat history is not automatically ingested as knowledge.

For historical setup documentation, see the
[0.21.1 chat manual](https://github.com/pocketcontext-labs/pocketcontext/blob/v0.21.1/docs/chat.md).
