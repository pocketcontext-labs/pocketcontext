# Spaces release candidate

Prepared 11 October 2026. This procedure publishes a separately tagged candidate
for the private rehearsal. It does not promote production. Production cutover
requires the [recovery checkpoint and clone plan](predeployment-recovery.md).

## Workflow boundary

The existing `image.yml` validates every push but publishes only on `main`.
Its main publication promotes `latest`, creates a GitHub release, and can invoke
production delivery. `CONTEXT_DEPLOY_PAUSED=true` disables its deployment job;
it does not prevent `latest` promotion. Do not use a main merge as the candidate
publication mechanism.

`candidate.yml` publishes only from `release-candidates/**` branch pushes or a
manual dispatch on such a branch. A push is the initial bootstrap because GitHub
manual dispatch discovery may require a new workflow to exist on the default
branch first. Creating/pushing the candidate branch is therefore an explicit
publication action, not an ordinary validation push.

The workflow verifies the event's full commit SHA, runs the reusable application
suite on native AMD64 and ARM64, and additionally tests the unchanged copied uv
launcher against its published package commit. Each architecture then builds one
image, runs configuration, smoke and complete S3/Litestream recovery on those exact
bytes, and pushes that tested image as `candidate-SHA-ARCH`. The combined
`candidate-SHA` manifest uses the two validated pushed digest references from this
workflow run. It writes a digest receipt to the run summary and an artifact.
There is no production environment, SSH step, GitHub release, main promotion or
`latest` tag in this workflow.

Tags identify source revisions; they are not immutable content identifiers.
A rerun may rebuild different bytes when unpinned distribution packages change.
Record and use the returned registry manifest digest for the rehearsal. Do not
configure the clone with a mutable tag or substitute the local image ID for a
registry manifest digest. A failed run can leave an architecture-specific candidate
tag; it is not a completed candidate until both native gates and the combined
manifest job succeed.

## Package and candidate sequence

1. Prepare package commit **A** on an ordinary feature branch, excluding unrelated
   `brand-exploration/` and generated output. Include the reviewed application and
   client source/schema. Push that branch so uv can resolve A from GitHub. An
   ordinary feature push validates but cannot publish an image under `image.yml`.
2. Update only the portable launcher's Git source pin to A's full SHA. Test an
   unchanged executable copy from an unrelated directory through uv against the
   isolated server using `tests/skill.py --client ABSOLUTE_COPY --binary PINNED_SERVER`,
   with and without `--trace`. The normal `tests/launcher.py` substitutes a local
   package path and is not evidence of remote resolution. Preserve the original
   production launcher until the replacement package commit is available.
3. Commit **B** containing that launcher pin, the reviewed candidate workflow,
   reusable native gates and release documentation. Rehearsal tooling can follow
   in a separate commit without changing the runtime image. Push B on the ordinary
   feature branch. Its normal validation and candidate validation may run in
   parallel; candidate publication always waits for its full native gates. The
   client source at B must match A; changes require a new package commit and pin.
4. After candidate-publication authorization, push an explicit candidate ref that
   points to exactly B, without merging main. For example:

   ```sh
   git push origin FULL_B_SHA:refs/heads/release-candidates/wiki-spaces
   ```

   Substitute the verified full SHA. Do not force-update an existing candidate
   branch or infer that its latest remote tip still equals the reviewed revision.
   A future manual rerun must select that branch and supply the same full SHA in
   the workflow's `revision` input; mismatches and noncandidate branches fail.
5. Require successful reusable native tests, unchanged launcher verification,
   native container gates and candidate manifest publication. Download the digest
   receipt and confirm it contains exactly AMD64 and ARM64 for B. Record the
   workflow run URL, A, B, server pin and registry digest. Preserve the old image's
   exact digest separately. Use only the candidate digest in the reviewed clone
   configuration. Candidate publication does not authorize provisioning, copying
   production records, changing DNS/OAuth/storage, or production deployment.

## Current local evidence

Package commit A is `69082e24ed83d8df11a5d34a734f336283aa9bee` on
`feature/wiki-spaces-rehearsal`. Its source has been pushed and the unchanged
launcher pinned to A passed the isolated skill integration both normally and with
tracing. Initial package CI run
[38152851034](https://github.com/pocketcontext/wikicontext/actions/runs/38152851034)
passed both native ARM64 and AMD64 container jobs but both application jobs stopped at deployment
workflow validation: A intentionally excluded the in-flight workflow changes while
including their new assertions. B must include the matching workflow changes and
pass all native gates; B and its candidate digest remain to be recorded.

The reviewed application source was validated against server
`dc1dc6b0e88bbc46f36fa8441c8f6959bada4732`; the pre-spaces production source is
`7cf5d4548fd22a7cb250adbd4034f1060c9bd53e`. See the full
[spaces validation record](spaces-validation.md).

The local native ARM64 image `wikicontext:spaces-port-final-20261011`, image ID
`sha256:394f1d1244b93e34fda2e7473f5eb95e0ff0255afcedee8b4d7f5c8acf87c1ba`, passed
build, configuration, smoke and complete graceful/crash recovery. Recovery retained
private-space originals, search and memberships while denying a company peer
through SQL, REST and protected-file access. It is an uncommitted working-tree
build labelled `local-spaces-port-final`, not a remote release or registry digest.
Later workflow/rehearsal-only edits are outside that image's runtime contents.

Local logs are `/tmp/wikicontext-spaces-final-build.log`,
`/tmp/wikicontext-spaces-final-config.log`,
`/tmp/wikicontext-spaces-final-smoke.log`, and
`/tmp/wikicontext-spaces-final-recovery.log`. Synthetic containers, volumes and
networks were removed by the fixtures; the review image remains local.

Candidate workflow validation uses `tests/candidate_workflow.py` to execute branch
and revision guards and mocked native-image/manifest promotion offline. The normal
production workflow tests remain separate. Both workflows must pass actionlint.
These checks do not publish an image.

## Gates not established by local evidence

Record completion rather than assuming it from the plan:

- Exact B passes remote native AMD64/ARM64 application and container gates,
  including optional-personal-space recovery and published-launcher verification.
- A candidate manifest and immutable digest receipt exist for B. Registry write
  permission and first-run workflow execution have not been proven by local tests.
- The old production image/checkpoint, live-provider original retention and isolated
  restore comparison meet the predeployment recovery plan.
- The private rehearsal's configuration, maintenance-authentication/bootstrap,
  migration and rollback succeed using separate storage and approved resources.
- Actual Google browser sign-in is verified at the intended rehearsal hostname.

None of these gates can be replaced by an HTTP health response. Candidate success
is not production-cutover approval.
