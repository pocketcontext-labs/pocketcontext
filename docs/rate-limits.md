# Hosted knowledge rate limits

Hosted mode previously enabled PocketBase 0.41.1's default fixed-window rules:
`*:auth` 2 requests per 3 seconds; `*:create` 20 per 5 seconds;
`/api/batch` 3 per second; and `/api/` 300 per 10 seconds. The first matching
rule wins. General counters are keyed by rule/audience and real IP; collection
counters additionally distinguish collection, route pattern and action.
There was no authenticated allowance. All MCP internal requests use one synthetic
IP, so separate MCP connections shared these IP counters.

An atomic batch also checks each inner collection operation. Successive staging
batches could exhaust a collection's allowance, roll back a batch, and retain the
already consumed rate tokens. An outer HTTP 400 could contain the inner 429.
The default windows do not explain a single 495-second cooldown; repeated attempts,
workload shape and deployed settings must be examined separately.

## Current hosted policy

Authenticated `users` API requests use a process-local token bucket keyed by the
stable account ID: **1,200 operation units of burst capacity, replenished at 100
units per second**. All clients of this single-owner account intentionally share
that budget; token refresh, source IP, OAuth client ID and `run_key` do not reset it.
Ordinary requests cost one unit. A batch reserves the configured maximum batch
size (20 in this application) before executing, even when partially filled. This
conservative reservation covers JSON and multipart batches without reparsing large
request bodies. A rejected reservation consumes nothing and executes no writes.
Inner record operations do not charge the default limits again. Successful and
failed admitted requests both cost their reservation because both consume work.

Hosted startup changes only the all-audience `*:create`, `/api/batch` and `/api/`
rules to guest-only in memory. Their values, authentication rules, explicit
authenticated custom rules and unrelated rules remain intact. Guests retain the
original limits. Invalid tokens remain rejected by the existing authentication
hook and do not receive an authenticated allowance. Native HTTPS and local serving
do not acquire the hosted knowledge bucket. Authentication and knowledge hooks,
validation, batch transaction boundaries and publish behavior are unchanged.

Existing resume logic skips saved identities, revisions, citations and links.
There is no free retry or per-run bucket: changing an arbitrary run key cannot
increase capacity. The large bounded burst permits an ordinary 40-source,
30-page migration, while sustained workloads replenish continuously. Accepted
batch failures still consume their reservation; a later resume needs only the
outstanding writes, and throttled reservations consume no additional units.

## Authentication and retry information

Public password/redeem and OAuth mutation attempts retain their separate IP token
buckets: burst 10, refill one per 6 seconds. The public limiter table is bounded at
4,096 IPs; full-table rejection advertises a conservative 600-second cleanup delay.
Hosted email request and OTP redemption retain separate endpoint-wide buckets with
the same burst/refill. The existing account email-send cooldown (one per minute)
continues returning the non-disclosing successful response. Pending OAuth consent
codes remain capped at 200 and expire after two minutes.

Rate-limit responses carry `Retry-After`, `RateLimit-Limit`,
`RateLimit-Remaining`, and `RateLimit-Reset`. Reset is a relative number of seconds
until the budget is full; retry is the minimum whole-second delay for the rejected
reservation. For PocketBase fixed windows, which do not expose their clock, the
full matching window is a conservative retry/reset estimate. Pending OAuth and
limiter-table capacity replies likewise advertise conservative expiration delays.
The public email retry delay is six seconds (its refill interval).

HTTP bodies include `data.rate_limit` with `limit`, `retry_after_seconds`,
`capacity`, `remaining`, and `reset_after_seconds`. OAuth responses retain their
protocol `error` and `error_description`. Hosted nested batch errors retain their
outer 400 and inner 429, with metadata on both and headers on the outer response.
The client preserves these details for MCP tool errors rather than relying on
headers from the internal transport to reach the remote caller.

Each throttle records its named limit, route template or fixed authentication
endpoint, remaining allowance and retry delay. Account/IP keys are hashed; tokens,
credentials, payloads, run keys and source contents are never logged. Counters are
process-local and reset on server restart. Separate instances have separate budgets.
