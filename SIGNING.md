# Code signing policy

Aurora Electrons does not sign its releases today. This page states the policy under which signing is prepared, so that it is clear what would be signed, by whom, and how, before any certificate exists.

## Status

Checked on 2026-11-11; this page was last revised on 2026-11-12.

| Item | Status |
| --- | --- |
| Published downloads | Unsigned. The v3.2.2 download (`aurora-electrons-3.2.2.exe`, SHA-256 `2453ded88ff56edcedc371d3f4e9e2cc589f40af5ebab2b78589dde2b5aa6cf4`, the digest GitHub shows for the asset) reads as `NotSigned` in `Get-AuthenticodeSignature` on a byte-identical local copy. So do the 3.2.1, 3.2.0, 2.7.11 and 2.7.10 downloads, each checked the same way against its published digest. Windows may warn about an unsigned download. |
| Repository preparation | The release workflow, the two SignPath artifact configurations and the signature verifier are on the `signpath-preparation` branch of this repository (see [RELEASING.md](RELEASING.md)); that branch is not merged into the default branch. |
| SignPath Foundation application | Prepared in [SIGNPATH_APPLICATION.md](SIGNPATH_APPLICATION.md). Not submitted, not accepted. |
| Provider account and certificate | This preparation created or verified no SignPath account or certificate and made no signing request. It did not look up whether an account or certificate already exists. No project-signed artifact was produced by this preparation. |
| Team prerequisites | Multi-factor authentication and an independent second approver are not confirmed (see [Team roles](#team-roles)). |

Nothing on this page is a claim that SignPath, the SignPath Foundation or any certificate is in use.

## What would be signed

Only two Windows executables, both produced by this project's own build from its own source and build scripts, each selected by exact name in a SignPath artifact configuration (never by `*.exe`, `*.dll` or `*.node`):

| File | Signed | Why |
| --- | --- | --- |
| `Aurora Electrons.exe`, the inner application executable (Electron's runtime executable carrying the Aurora Electrons application and product metadata) | First stage ([`.github/signpath/inner-app.xml`](.github/signpath/inner-app.xml)) | Built by this project's workflow. Whether the provider accepts this executable as the project's own binary is open ([question 2](SIGNPATH_APPLICATION.md#questions-for-the-signpath-foundation)). |
| `aurora-electrons-<version>.exe`, the portable wrapper that electron-builder generates around the signed inner executable | Second stage ([`.github/signpath/portable.xml`](.github/signpath/portable.xml)) | The launcher users download. Same open question. |
| Electron and Chromium libraries and data files (`ffmpeg.dll`, `vk_swiftshader.dll`, `vulkan-1.dll`, `d3dcompiler_47.dll`, `dxcompiler.dll`, `dxil.dll`, `*.pak`, ...), `app.asar`, the native `sqlite3` binding, notices | Never | Upstream files and data. They are never signed under this project's subscription and keep the bytes they shipped with, including any upstream signature. The pipeline is built to check this. Whether the three Microsoft DirectX files count as system libraries is a separate open question ([question 3](SIGNPATH_APPLICATION.md#questions-for-the-signpath-foundation); [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), section 3). |

Both configurations enforce the product name `Aurora Electrons` and one product version, the package version, for each build.

Which of the two files the provider accepts, and the certificate subject, are the provider's decisions. The builder setting `publisherName: nerdship` is the project's current value; it is not a statement about any future certificate, and the expected subject is configured separately (`SIGNPATH_EXPECTED_SUBJECT`).

## Team roles

The Foundation asks projects to name three roles. Aurora Electrons has one maintainer today, who holds all three:

| Role | Responsibility | Member |
| --- | --- | --- |
| Authors | Change the source without an additional review | [rubybrowncoat](https://github.com/rubybrowncoat) (Matsor Browncoat) |
| Reviewers | Review every change proposed by someone who is not a committer (pull requests) | [rubybrowncoat](https://github.com/rubybrowncoat) |
| Approvers | Approve each signing request in SignPath | [rubybrowncoat](https://github.com/rubybrowncoat) |

Members who are added are listed here and in the matching GitHub and SignPath permission groups before they act in a role. Whether a one-person team meets the Foundation's expectations is one of the questions in the application.

**Second approver on GitHub.** A signing run also needs approval from the GitHub environment `production-signing` (see below), whose required reviewers must be independent of the person who starts the run, with self-review prevented. While the maintainer is the only person who starts runs, that needs a second trusted person as an environment reviewer. None is named yet, and this repository cannot create or verify one.

**Multi-factor authentication.** Every member must use it on both GitHub and SignPath. This repository cannot verify it; the maintainer enables and confirms it before the application is submitted.

## Provider configuration

Production signing is configured outside the repository. This preparation did not create or change that configuration; the maintainer must verify its current state before activation.

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret of the GitHub environment `production-signing` only | `SIGNPATH_API_TOKEN` | Token of the SignPath submitter user. It must not exist as a repository or organization secret of the same name. |
| Repository variables (public values, read before the environment is entered) | `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG` | SignPath organization, project and signing policy |
| | `SIGNPATH_INNER_CONFIG_SLUG`, `SIGNPATH_PORTABLE_CONFIG_SLUG` | The two artifact configurations above, as registered in SignPath |
| | `SIGNPATH_EXPECTED_SUBJECT` | Certificate subject the returned signatures must carry |
| | `SIGNPATH_MANUAL_APPROVAL` (`true`) | Declares that the policy requires manual approval |
| | `SIGNPATH_REVIEWED_SHA`, `SIGNPATH_REVIEWED_REF`, `SIGNPATH_REVIEWED_VERSION` | The release revision, ref and version the maintainer reviewed and allows to be signed |
| | `SIGNPATH_ENVIRONMENT` (`production-signing`) | Name of the GitHub environment |
| GitHub environment | `production-signing` | Must already exist, with required reviewers independent of the person who starts the run, self-review prevented, and deployments limited to protected branches; the source ref must be protected too. The workflow never creates it, weakens it or changes it. |

The action is `signpath/github-action-submit-signing-request`, pinned to v3 at commit `f6d04783b4569d051e0c80105fe66e82819d0092`.

### Why the token lives only in the environment

GitHub's workflow `permissions` has no environments entry, and listing an environment's secret names needs the Environments read permission, which the workflow's own token cannot hold ([permission matrix](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps#repository-permissions-for-environments), [workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)). The workflow therefore does not try to read secret names, and no personal access token or app credential is added to make it possible. Reading an environment's configuration and deployment restrictions needs only Actions read ([matrix](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps#repository-permissions-for-actions)), which the preparation job requests for itself.

Two checks follow from that:

1. **Public preparation, before any environment job.** The preparation job uses no SignPath secret. For a production run it checks the public identifiers and expected subject, the reviewed SHA, ref and version against the checked-out revision, that the source ref is protected, and the environment's metadata: that it exists, has required reviewers, prevents self-review and limits deployments to protected branches. Anything missing, unreadable or insufficient fails the run before a job that references the environment can start. An unreadable environment (HTTP 403) stops the run and is a workflow permission problem to raise, not something to bypass with a broader credential. This check cannot show that the token exists.
2. **Approved job, first step.** Once GitHub has released the job through the environment's protection, its first step checks that the injected `SIGNPATH_API_TOKEN` is not empty. This happens before checkout, before any artifact upload and before any request to SignPath. An empty token stops the run; nothing unsigned is staged in its place. A non-empty value shows the token is available, not that SignPath will accept it; a rejection still stops the run.

What remains outside the repository's control: the workflow cannot tell where a secret is stored, so a repository- or organization-level secret named `SIGNPATH_API_TOKEN` would also pass the second check. Keep none. It observes the environment's protection only when it runs, and an administrator can change it later.

## How a signed release is made

1. The maintainer reviews the release commit, including the workflow, build scripts and CI configuration (a SignPath signature vouches for the build's origin from those), and sets the `SIGNPATH_REVIEWED_*` variables to its SHA, ref and version.
2. The `Windows portable draft` workflow is dispatched in `production` mode with `reviewed_sha`, `reviewed_ref` (the full `refs/heads/...` or `refs/tags/...` form) and `reviewed_version` equal to those variables and to the checked-out revision.
3. The preparation job runs the public check above and claims the draft destination.
4. GitHub holds the signing job until the environment's reviewers approve it. Its first step checks the token, as above.
5. **Inner executable.** The workflow builds the unpacked app (`bun run build --win --dir`) and uploads a minimal workflow artifact (`signpath-inner-<sha>-<run>-<attempt>`, kept 3 days) holding only `Aurora Electrons.exe`. SignPath receives it from GitHub, the approver approves the request, the action waits up to 1800 seconds and downloads the result only if the request is `Completed`. `scripts/verify-signature.ps1` then checks the Authenticode status and chain, the timestamp, the expected subject, product name and version, and the file's identity. Only then is that one file replaced.
6. **Portable wrapper.** electron-builder wraps the prepackaged directory (`--win portable --prepackaged build/win-unpacked --config builder.config.js`) without rebuilding it, so the signed inner file is not recompiled. The same steps run on a second artifact (`signpath-portable-<sha>-<run>-<attempt>`), and the wrapper is confirmed to hold the same verified signed inner executable.
7. The verified bytes are staged to the draft release as `aurora-electrons-<version>-signed.exe`, `aurora-electrons-<version>-signed.build.json` and `aurora-electrons-<version>-signed.SHA256SUMS.txt`. Each temporary artifact is deleted by its exact ID, only after its request has completed and its result has been retrieved and verified; a pending or failed request keeps its input.
8. The maintainer inspects the draft and publishes it by hand. A draft is not a public release.

The process fails closed. An unconfigured production run, a rejected or unapproved request, a timeout or a failed verification stops the run; nothing unsigned is ever labelled signed. A failed request is repeated by a new run, never by reusing a file from an unrelated one. A timeout can leave a request pending in SignPath, so its input artifact is kept until it is finished.

The unsigned route (a push to `signpath-preparation`, a version tag, or a manual run in `unsigned` mode) needs no secret and no environment, never calls SignPath, and stages files named `-unsigned`. It is never a fallback for a failed signing run.

## Checking a signed release

After a release is signed, check it in the file's Properties, Digital Signatures tab, or with `Get-AuthenticodeSignature .\aurora-electrons-<version>-signed.exe | Format-List`, and compare its SHA-256 with `aurora-electrons-<version>-signed.SHA256SUMS.txt` in the same release. Releases published before signing is active stay unsigned.

## Privacy

Aurora Electrons's [privacy policy](PRIVACY.md) applies. In builds from the preparation branch onward, error reporting is off until the user turns it on; the published releases up to 3.2.2 predate that choice. The application's own code sends nothing else to other networked systems unless the user asks it to; the policy states the limits of that.

## Activation notice (not in effect)

Publish this only after the SignPath Foundation has accepted the project and the first signed release is out. The application form asks for the download page to carry it, so the maintainer decides when to publish it ([question 4](SIGNPATH_APPLICATION.md#questions-for-the-signpath-foundation)).

> **Code signing policy.** Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org). Team roles are listed in [SIGNING.md](SIGNING.md), and the [privacy policy](PRIVACY.md) applies.

A signature from a SignPath Foundation certificate means SignPath verified that the signed file is an automated build from the source repository. It is not a security audit or an endorsement, and the Foundation accepts no liability for software signed this way. Concerns that a signed file breaks the Foundation's conditions can be reported to support@signpath.io with proof.
