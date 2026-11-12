# SignPath Foundation application: Aurora Electrons

Prepared 2026-11-11, revised 2026-11-12. **Not submitted by this preparation.** This preparation entered nothing from this file into any form and sent nothing to SignPath or the SignPath Foundation; no acceptance is claimed. It maps each field of the live application form (<https://signpath.org/apply>, fields and options read on 2026-11-11 without entering or submitting anything) to the project's value, and lists what only the maintainer can supply. The Foundation's conditions are at <https://signpath.org/terms>.

## Form fields

| Form field | Value | Status |
| --- | --- | --- |
| Project Name* | Aurora Electrons | Ready. The form wants a web search for the name to identify the project; the maintainer checks that before submitting. |
| Repository URL* | https://github.com/rubybrowncoat/Aurora-Electrons | Ready |
| Homepage URL* | https://github.com/rubybrowncoat/Aurora-Electrons | Ready. The form accepts the repository page. |
| Download URL | https://github.com/rubybrowncoat/Aurora-Electrons/releases | Maintainer decision: the form says this page must mention the SignPath Foundation (question 4). |
| Privacy Policy URL | https://github.com/rubybrowncoat/Aurora-Electrons/blob/signpath-preparation/PRIVACY.md | This is the address the app's privacy button opens in builds from the preparation branch. The form asks for a policy when the software collects user data; those builds do so only if the user opts in, and the published releases up to 3.2.2 do not have that choice (see [Existing releases and preparation builds](#existing-releases-and-preparation-builds)). If the maintainer later moves the policy to `master`, the app's button needs the same change. |
| Wikipedia URL (optional) | none | Leave empty. |
| Tagline* | A desktop companion for the game Aurora (C#) that turns a save into plans, forecasts and dashboards. | Ready |
| Category* | Gaming | Ready. Options: Accessibility, AI Tools, Audio, Developer Tools, Educational, Gaming, Graphics, Productivity, Science, Other. |
| Description* | See below. | Ready |
| Reputation* | See below. | Ready; refresh the counters on the day of submission. |
| Maintainer Type | Individual maintainer(s) | Proposed from the public identity: one maintainer, no organization. Options: Independent community project, Non-profit foundation or research/educational institution, For-profit company or corporate-backed project, Individual maintainer(s), Other. |
| Build System* | GitHub Actions | Ready. Options: GitHub Actions, GitLab CI/CD. |
| First Name*, Last Name* | | Maintainer input: the name of the SignPath user account. The public alias is Matsor Browncoat (GitHub `rubybrowncoat`); no legal name is assumed. |
| Email* | | Maintainer input: the address for the SignPath account and its notifications. |
| Company Name | | Maintainer input, if applicable. |
| Primary Discovery Channel* | | Maintainer input: how the maintainer actually first found the Foundation. Options: Organic search, AI / LLM tools, Developer platforms (e.g. GitHub), Community platforms, Social media, Events, Referral, Direct contact, Other. |
| Exact source (optional) | | Maintainer input. |
| Code of Conduct and certificate-revocation consent* | | Unsubmitted. The maintainer reads the Code of Conduct and ticks the box personally. |
| Consent to store and process personal data* | | Unsubmitted. The maintainer's own decision. |
| Consent to receive other communications (optional) | | Not preselected. The maintainer's own choice. |
| reCAPTCHA | | The maintainer completes it. |

### Description

Aurora Electrons is a free, open-source (MIT) desktop companion for the 4X game Aurora (C#). It opens a game's SQLite save, watches it for changes and presents production, colony, logistics, finance, intelligence, galaxy-map and technology information as dashboards, plans and forecasts. It reads saves, and writes only when the user confirms moving systems on the galaxy map (Save positions). It is distributed as portable Windows executables. The published releases were uploaded to GitHub releases by the maintainer; the checked downloads, from 2.7.10 to 3.2.2, are unsigned. The repository also holds a GitHub Actions workflow, on the `signpath-preparation` branch, that builds the same portable executable on GitHub-hosted Windows runners from the public source.

### Reputation

Public facts, read on 2026-11-11 (counters at 23:22 UTC). They are a snapshot of counters that change.

- A public repository created 2020-04-17, MIT licence, maintained by one person (GitHub `rubybrowncoat`, who posts as Matsor Browncoat on the official Aurora forum). Last push 2026-11-10; 12 stars and 2 forks at that refresh, and 3 open issues when read earlier the same day.
- 57 GitHub releases, from v0.0.1-apr (2020-04-17) to v3.2.2 (2026-11-10). The latest are v3.2.2 (2026-11-10), v3.2.1 (2026-11-08), v3.2.0 (2026-11-07), v2.7.11 (2026-10-31), v2.7.10 (2026-10-30) and v0.11.0 (2026-10-12). There were no releases between v0.8.10 (2021-03-20) and v0.9.0 (2025-09-07).
- GitHub's counters show 4,803 downloads across the assets of all 57 releases, 144 of them for the three 3.2.x assets (38, 70 and 36). These count downloads, not unique people or installations.
- The official Aurora forum topic [Aurora Electrons - Looking Inwards (v3.2.2)](https://aurora4x.com/t/1177), created 2026-10-08 by Matsor Browncoat: 28 posts, 1,401 views and 52 likes, with player questions and suggestions and the maintainer's update posts. These are access-time counts, not unique viewers or an endorsement.
- No press coverage and no Wikipedia article is claimed.

## Existing releases and preparation builds

The published downloads and the builds proposed for signing differ. The table separates them.

| | Published releases (up to 3.2.2) | Preparation builds (`signpath-preparation` branch, not released) |
| --- | --- | --- |
| Made by | Uploaded to GitHub releases by the maintainer. The repository had no GitHub Actions workflow before this preparation. | GitHub-hosted Windows runners, from a frozen lockfile, as a draft release (see [RELEASING.md](RELEASING.md)) |
| Signed | No for the downloads checked, 2.7.10 to 3.2.2. | No project-signed artifact was produced by this preparation. The signing path is prepared; this preparation made no signing request. |
| Error reporting | Sent to Sentry by default, with no choice | Off until the user opts in; asked on first launch, changeable in Settings |
| Notices in the package | The project's `LICENSE` and a notices file were not added to the package; Electron's own notice files came with the runtime | `LICENSE` and `THIRD_PARTY_NOTICES.md` under `resources/`, plus Electron's, Chromium's and NSIS's notice files |

The package version number does not separate them: a build from the branch still reports 3.2.2 until the version is raised, so [PRIVACY.md](PRIVACY.md) names the first-launch dialog and the Settings section as the sign.

## Proposed signed artifacts

| Artifact | Signing | Notes |
| --- | --- | --- |
| `Aurora Electrons.exe` | First stage: [`.github/signpath/inner-app.xml`](.github/signpath/inner-app.xml) | Electron's runtime executable carrying the application. For source package version `M.m.p`: product name `Aurora Electrons`, ProductVersion `M.m.p.0` and FileVersion `M.m.p`. |
| `aurora-electrons-<version>.exe` | Second stage: [`.github/signpath/portable.xml`](.github/signpath/portable.xml) | The portable launcher generated around the signed first file. For source package version `M.m.p`: product name `Aurora Electrons`, ProductVersion `M.m.p` and FileVersion `M.m.p`. |
| Electron and Chromium files, `app.asar`, the native `sqlite3` binding | Never signed under this subscription | Upstream files and data. They keep their bytes and any upstream signature. |

Whether the provider accepts either executable as the project's own is open (question 2). The expected certificate subject is configured when the provider decides it; the builder's current `publisherName` is not that subject.

## Build, signing, privacy and provenance

- **Build.** GitHub Actions on GitHub-hosted Windows runners, from a frozen lockfile, with an unsigned draft release as the secret-free path and the signing path adding SignPath's manual-approval handoff. Source: [`portable.yml`](https://github.com/rubybrowncoat/Aurora-Electrons/blob/signpath-preparation/.github/workflows/portable.yml) on the preparation branch; procedures in [RELEASING.md](RELEASING.md).
- **Signing policy.** Roles, covered files, provider configuration and the fail-closed process are in [SIGNING.md](SIGNING.md). The signing token would live only in a protected GitHub environment that needs a second approver, and the policy states plainly that this preparation produced no project-signed artifact and that no SignPath claim is in effect.
- **Privacy.** [PRIVACY.md](PRIVACY.md): no accounts, no analytics; optional error and crash reporting to Sentry, off by default in builds from the preparation branch and asked on first launch. A native crash dump can contain memory, including parts of a save; the policy says so and promises nothing about its contents.
- **Own source.** The application source, the build scripts and the workflow are in the repository under the MIT licence; third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The community workbook and SQL scripts under `references/` (by skoormit, shared with the author's permission and with no licence assigned) were tracked before this preparation; they are now local, git-ignored files, absent from the current tree and never packaged, and earlier commits still contain them. The sample save is separate (question 1).
- **Foundation conditions at a glance.**

| Condition | Aurora Electrons |
| --- | --- |
| No malware or unwanted programs | None known; self-assessed |
| OSI licence, no dual licensing | MIT; see question 1 for the sample save and the reference files' history |
| No proprietary component | See questions 1 to 3 |
| Actively maintained | Releases on 2026-10-08, 10-09, 10-12, 10-30, 10-31, 11-07, 11-08 and 11-10; last push 2026-11-10 |
| Released in the form to sign | Yes: the published downloads are portable Windows executables; the checked downloads, from 2.7.10 to 3.2.2, are unsigned |
| Documented on the download page | [README.md](README.md) describes the app and its download |
| User data and privacy policy | [PRIVACY.md](PRIVACY.md); see question 5 |
| Uninstallation | [README.md](README.md#remove-the-app-and-its-data): delete the portable executable; removing the app's data is a separate optional step |
| Code signing policy | [SIGNING.md](SIGNING.md) and the "Code signing policy" section of the README, without the Foundation attribution until acceptance |

### Evidence to attach

| Evidence | Where to find it |
| --- | --- |
| Workflow source | [`portable.yml`](https://github.com/rubybrowncoat/Aurora-Electrons/blob/signpath-preparation/.github/workflows/portable.yml) and the [artifact configurations](https://github.com/rubybrowncoat/Aurora-Electrons/tree/signpath-preparation/.github/signpath) on the preparation branch |
| Hosted builds: the unsigned build and its draft release, a manual dispatch, a refused re-run of an older run, a production request refused for missing configuration | A scenario is evidenced by its corresponding run in the [Actions history](https://github.com/rubybrowncoat/Aurora-Electrons/actions) only if that run demonstrates it. This page links none, because a run is evidence for the commit it built, and a commit that adds the link is a different commit. A scenario in the left column counts as shown only where a run in that history shows it. Before the application is submitted, the evidence is the run for the exact commit submitted: its run URL, source SHA and attempt, and the size and SHA-256 of its executable from the draft's `build.json` and `SHA256SUMS.txt`. A draft release is visible only to people with write access to the repository, so the public evidence of a build is its run. |
| Package inspection and launch check results | Before the application is submitted, attach the inspection and launch results actually recorded for the exact commit submitted. Do not claim results for stages that a run did not reach or complete. |
| SignPath account, organization, project, certificate | This preparation created and verified none, and made no signing request. It did not look up whether an account already exists. |

## Questions for the SignPath Foundation

1. **Sample game save and earlier commits.** `fixtures/AuroraDB.zip` is a game save generated by Aurora, tracked for development and tests. It is excluded from every release package, and no licence is stated for it. The conditions require an OSI licence for all components and no proprietary component. Does a tracked sample game save in the repository matter if it is never part of a signed artifact, or must it leave the repository? The same question applies to the community reference files, which earlier commits still contain although the current tree does not.
2. **Which executables may be signed.** The app's executable is Electron's upstream runtime executable with this project's application and product metadata, and the portable launcher is generated by electron-builder, with the NSIS toolset, around it. Electron is upstream software that this project does not fork. May this project sign `Aurora Electrons.exe`, the launcher, both or neither, given that all upstream libraries stay unsigned and are only included? Which of them does the Foundation consider the project's own binary?
3. **Microsoft DirectX files and system libraries.** Electron's Windows distribution contains `d3dcompiler_47.dll`, `dxcompiler.dll` and `dxil.dll`. Microsoft lists them for redistribution, unmodified, with Classic Windows applications under the Windows SDK licence, which is not an OSI licence; the project has not established which SDK package supplied these exact copies, and the notice files for the Dawn-built `dxcompiler.dll` are unresolved ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), section 3). System libraries are allowed, and the Foundation points to section 1 of the GPL v3 for the definition. Does it treat these files as system libraries, or as acceptable unsigned upstream binaries inside a signed package, and what would it need to see?
4. **When the attribution goes live.** The Download URL field asks for a page that already mentions the Foundation. The attribution text is prepared ([SIGNING.md](SIGNING.md#activation-notice-not-in-effect)) but is not published, because this preparation has not activated signing. May the field carry the releases page now, with the attribution published on acceptance, or should it stay empty until then?
5. **Privacy presentation without an installer.** The conditions ask software that sends user data to systems the user did not specify to describe this in a privacy policy, show it during installation and offer an option to disable it. Aurora Electrons is a portable executable with no installer. In builds from the preparation branch the application sends no error or crash reports until the user opts in, and its first-launch dialog is that choice: it says what is sent, links the policy, and works without opening it. The published 3.2.2 downloads send reports without asking and cannot be changed; a signed release would come from a build with the choice. A native crash report can contain memory contents, and the policy says so. Is this presentation acceptable?
6. **Team of one.** The maintainer holds the author, reviewer and approver roles. Is a one-person team acceptable? The workflow requires a GitHub environment that prevents self-review, so a run also needs a second trusted GitHub reviewer, whom this application does not name.

## What only the maintainer can do

1. Search the web for "Aurora Electrons" and confirm the project is identifiable.
2. Decide the Download URL timing (question 4).
3. Supply the account name, email, company if any and the real discovery channel.
4. Turn on multi-factor authentication for GitHub (and for the SignPath account), and name a second trusted person as a reviewer of the GitHub environment `production-signing`.
5. Decide when to merge the preparation branch into `master` (a manual dispatch of the workflow needs it there; the privacy URL above does not) and when to publish a release built from it. Until then the published downloads differ from what the privacy policy describes for the preparation builds. This preparation does not merge or release.
6. Read the Code of Conduct and the SignPath privacy policy, tick the required consents, complete the reCAPTCHA and submit.
7. After acceptance, set up the SignPath organization, project, policy, artifact configurations, GitHub environment (with the token as an environment secret only) and repository variables as in [RELEASING.md](RELEASING.md#setting-up-production-signing-maintainer-outside-the-repository), publish the attribution, and run the first reviewed signing.
