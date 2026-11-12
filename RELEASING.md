# Releasing

How Windows release builds are made and staged. For the signing policy, roles and provider configuration see [SIGNING.md](SIGNING.md).

The workflow is [`.github/workflows/portable.yml`](https://github.com/rubybrowncoat/Aurora-Electrons/blob/signpath-preparation/.github/workflows/portable.yml) on the `signpath-preparation` branch. Its runs are in the repository's [Actions history](https://github.com/rubybrowncoat/Aurora-Electrons/actions); that history, not this page, records what a given run did.

## What the workflow does

The workflow, named `Windows portable draft`, builds the Windows portable executable on GitHub-hosted Windows runners and stages it on a **draft** GitHub release. It never publishes a release: publishing is a manual step in GitHub, and a draft is not a public release. Drafts are visible only to people with write access to the repository; the public record of a build is its Actions run.

- **Toolchain.** Node from `.nvmrc` (24), Bun from `packageManager` (1.4.2), `bun install --frozen-lockfile`, and electron-builder 26.15.3, so the build uses exactly the locked dependencies. The run stops if a version differs. Only downloaded dependencies are cached, keyed by the lockfile and toolchain; build output, packages and Bun's transpile cache are not. A build on a developer's machine with other Node or Bun versions is not this configuration.
- **Inputs.** Nothing private: no saves, no files from `references/`, no local settings. The package check launches the packaged app against a throwaway user-data folder and a database it creates itself.
- **Temporary folder.** Each build job sets `TEMP` and `TMP` to the canonical path of the runner's temporary folder (which the runner reports as a short-name alias such as `RUNNER~1`) before installing dependencies, so scratch trees are created at their real paths; the cleanup guard that refuses a tree reached through a link, a short name or a device prefix is unchanged.
- **Checks before staging.** `bun scripts/check-reporting.js`, `bun scripts/check-release.js` (the release-decision checks) and `bun run lint` run first. After packaging, `scripts/package-smoke.js` inspects the archive and native files, the notices, the executables' product name and exact ProductVersion and FileVersion, and the signature verifier's cases, then launches the packaged app and runs a real SQLite query. For source version `M.m.p`, the inner ProductVersion is `M.m.p.0` and the portable ProductVersion is `M.m.p`; both FileVersion strings are `M.m.p`, and the build number is pinned to zero. The notice inspection compares the root `LICENSE` and `THIRD_PARTY_NOTICES.md` packaged under `resources/` with the repository copies, looks for Electron's, Chromium's and NSIS's own notice files, and checks that every runtime package inside `app.asar` is named in section 7 of `THIRD_PARTY_NOTICES.md`.
- **Build stages.** `bun run build --win --dir` produces the unpacked app. electron-builder then wraps that directory as the portable executable (`--win portable --prepackaged build/win-unpacked --config builder.config.js --publish never`), without rebuilding it. The build entrypoint and both direct wrapper invocations disable builder publishing; only the reviewed draft helper stages assets. `builder.config.js` sets the portable target to `useZip`, which in the installed electron-builder takes the path that does not add its `elevate.exe` helper; the package inspection rejects that file, and its result is in the run. Signing, when active, slots in between the two stages ([SIGNING.md](SIGNING.md#how-a-signed-release-is-made)); the signed inner file is never recompiled.

The hosted workflow does not run `bun run reporting:smoke`. That check builds the production-mode app against a local collector and is started locally, with `bun run`: calling `node` on its script skips the environment Bun's launcher provides.

## Triggers

| Trigger | Result |
| --- | --- |
| Push to the `signpath-preparation` branch | Unsigned build; draft `latest-build`. This route has no signing secrets and no GitHub environment. |
| Manual dispatch (`workflow_dispatch`), mode `unsigned` | Unsigned build; draft `latest-build` |
| Manual dispatch, mode `production` with `reviewed_sha`, `reviewed_ref` and `reviewed_version` | Signed build; see [SIGNING.md](SIGNING.md). Fails during preparation if production signing is not fully configured. |
| Push of a version tag that equals `v<version in package.json>` | Unsigned build and draft release for that version |

GitHub lists a workflow for manual dispatch only after its file is on the repository's default branch. Until `portable.yml` has been merged into `master`, the branch push is the way to start it, and a `gh workflow run` dispatch is expected to be refused. Merging is a maintainer decision outside this workflow.

## Draft rules

One preparation job validates the mode, revision and version and claims the draft before anything is built.

- Manual and branch builds share the draft `latest-build`; a tag build uses the draft for its own version. Concurrency is per destination.
- A **published** release is never written to: the run fails.
- The draft carries a marker with the workflow, source SHA, run ID and attempt. It is rechecked before any clean-up or upload, so an older run, or a re-run of an old run, cannot write into a draft that a newer run owns. A draft or asset the workflow does not own is refused, not cleared.
- Only this workflow's named assets are replaced, and a draft never mixes the files of two runs.
- Each build stages three assets: `aurora-electrons-<version>-unsigned.exe` (or `-signed.exe`), `aurora-electrons-<version>-unsigned.build.json` and `aurora-electrons-<version>-unsigned.SHA256SUMS.txt`, carrying the source SHA, run, attempt, file sizes and SHA-256. An unsigned build is labelled unsigned and is not a release to distribute.

## Making an unsigned draft

1. Push to `signpath-preparation`, or (once the workflow is on `master`) run `gh workflow run portable.yml --ref <branch> -f mode=unsigned`.
2. Open the run and check that every step passed.
3. Open the draft release. Check the asset names, sizes and the SHA-256 in `SHA256SUMS.txt`; download one asset and hash it again.
4. Publish by hand only if the draft is meant to be a release.

A local, unsigned build comes from `bun run build`, which writes `build/aurora-electrons-<version>.exe`.

## Setting up production signing (maintainer, outside the repository)

This preparation did not create, change or verify the external setup below and made no signing request. It did not look up whether that setup already exists. The maintainer must verify the current setup and complete any missing steps before activation. The repository creates no account, environment, secret or variable.

1. Get the SignPath Foundation's acceptance ([SIGNPATH_APPLICATION.md](SIGNPATH_APPLICATION.md)).
2. Enable multi-factor authentication on GitHub and on SignPath for every team member.
3. In SignPath: create or receive the organization and project, connect GitHub as the trusted build system, create a signing policy that requires manual approval, and register `.github/signpath/inner-app.xml` and `.github/signpath/portable.xml` as artifact configurations. Create the API token for the submitter user.
4. In GitHub, add the repository variables listed in [SIGNING.md](SIGNING.md#provider-configuration). They are public values and must be repository variables, not environment variables, because the preparation job reads them before the environment is entered.
5. In GitHub, create the environment `production-signing` with required reviewers independent of the person who starts a run, self-review prevented, and deployments limited to protected branches, and protect the source ref. If the maintainer is the only person who starts runs, add a second trusted person as a reviewer; one person cannot satisfy this alone.
6. Add `SIGNPATH_API_TOKEN` as a secret of that environment only. No repository or organization secret of that name may exist: the workflow cannot see where a secret is stored.
7. Set `SIGNPATH_EXPECTED_SUBJECT` to the subject SignPath gives the certificate.

## Making a signed release

1. Review the exact commit, including the workflow, build scripts and CI configuration.
2. Set `SIGNPATH_REVIEWED_SHA`, `SIGNPATH_REVIEWED_REF` and `SIGNPATH_REVIEWED_VERSION` to it.
3. Dispatch the workflow in `production` mode with the same three values (`reviewed_ref` as the full `refs/heads/...` or `refs/tags/...` ref). They must match the checkout exactly.
4. The environment's reviewers approve the signing job in GitHub. Its first step stops the run if `SIGNPATH_API_TOKEN` is empty, before any upload or request to SignPath.
5. Approve the two signing requests in SignPath, the inner executable first and then the wrapper. Each wait is limited to 1800 seconds and the job to 110 minutes.
6. Check the run, then the draft assets (`-signed`), then publish by hand.

## When something fails

- **Missing or inconsistent public configuration, an unreadable or unprotected environment, or an unprotected source ref** fails during preparation, before any job that uses the GitHub environment and before any request to SignPath. Fix the configuration and dispatch again. An HTTP 403 when reading the environment is a permission problem to raise; do not add a personal access token or any broader credential to get around it.
- **An empty `SIGNPATH_API_TOKEN`** fails the first step of the approved job. Nothing is uploaded and nothing unsigned is staged in its place.
- **Approval rejected, not given in time, or a failed verification** fails the run and stages nothing signed. A timeout can leave a request pending in SignPath: finish or cancel it there. Dispatch again; a new run makes new artifacts and a new request. A file returned for another run is never reused.
- **Temporary artifacts.** The signing handoff uses two minimal workflow artifacts (`signpath-inner-...` and `signpath-portable-...`) kept 3 days. Each is deleted by its exact ID only after its request has completed and its result has been retrieved and verified, never earlier, because SignPath reads them from GitHub. A pending or failed request keeps its input until the retention ends. Ordinary draft assets cannot replace them: SignPath requires the build's own workflow artifact.
- **Re-running an old run** after a newer one owns the draft is refused by design.
