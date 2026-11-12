# Privacy policy

Last updated: 2026-11-12.

## Which builds this covers

The published releases up to and including 3.2.2 send error and crash reports to Sentry without asking ([Published releases up to 3.2.2](#published-releases-up-to-322)). The choice described in the rest of this policy exists only in builds from the `signpath-preparation` branch and in releases made from it. In those builds reporting is off until you turn it on.

The version number does not tell the two apart. A build carries the package version of its commit, and the commit that adds the choice still has version 3.2.2. The reliable sign is the app itself: only a build with the choice asks on first launch and has an "Error and crash reporting" section in Settings.

## In short

- Aurora Electrons has no accounts, no analytics, no advertising and no usage tracking.
- Your saves, settings, Empire History and notebook notes stay on your computer. The app does not upload them. If you turn error reporting on, one exception applies: a native crash report includes a snapshot of the process's memory, which can hold parts of a save or notes (see [What a report contains](#what-a-report-contains)).
- The one thing that can leave your computer is an optional error report, sent to Sentry. In a build with the choice it is off by default, the app asks on first launch, and you can turn it off at any time in Settings.
- Apart from that, the application's own code sends nothing to other networked systems unless you specifically ask it to, by clicking a link (which opens in your web browser). See [Other network use](#other-network-use) for the limits of that statement.

## What stays on your computer

- **Aurora saves.** The app reads the save you open. The one exception is the Galaxy Map's Save positions button: after a confirmation, it writes the coordinates of the systems you moved (rounded to whole units) back to that save. Nothing else is written to a save.
- **App data.** Settings, the list of recent saves, Empire History, scenario records and economy notebook notes, history backups and the reporting choice live in the app's user-data folder. About, Data shows the paths and has an Open folder button. The app does not send any of it anywhere. See [Remove the app and its data](README.md#remove-the-app-and-its-data).

## Error reporting (optional, off by default)

### The choice

- On first launch the app shows a dialog, "Optional error and crash reporting", before any report can be sent. "Keep reporting off" leaves the app fully usable; "Enable reporting" turns it on. The dialog says what is sent and what it cannot remove, so the choice does not depend on opening this page. Its "Read privacy policy" button opens [this policy on GitHub](https://github.com/rubybrowncoat/Aurora-Electrons/blob/signpath-preparation/PRIVACY.md).
- Reporting exists only in the packaged production app. Development runs, the browser-only web mode and the ordinary smoke tests never report; Settings then says reporting is unavailable.
- Upgrading from an earlier release does not carry a choice over, because earlier releases had none: reporting starts off and the dialog appears.
- The choice is changed any time in Settings, section "Error and crash reporting". It is one choice for the whole app: every window follows it.
- It is kept in a file of its own, `reporting.json` in the user-data folder, apart from the settings. Exporting or importing preferences, resetting a view, or undoing a settings change does not change it.
- If the saved choice is missing, damaged or cannot be read, it counts as off.

### Who receives reports

Reports go to [Sentry](https://sentry.io) (Functional Software, Inc., doing business as Sentry), to the ingestion address in `src/main/sentry.js` (an `ingest.us.sentry.io` host). Sentry's own [privacy policy](https://sentry.io/privacy/) applies to what it does with them. This policy makes no promise about how long Sentry keeps a report, where it stores it or what it records about the connection, such as your network address; those depend on Sentry and on the settings of the project that receives the reports.

### What a report contains

With reporting on:

- **Error reports** for an unhandled error in the app's main process or in a window: the error type and message; a stack trace with, for each frame, the function name, line and column numbers, the file base name only, and a flag (`in_app`) that says whether the frame is the app's own code; how the error was caught (a short mechanism type, and whether it counts as handled); an event id, time and level; the platform label the Sentry SDK sets; the app version (`aurora-electrons@<version>`), the environment, and the runtime name and version; and two tags the SDK adds, `event.process` and `event.environment`, which say which process and environment produced the event. The envelope also names the Sentry SDK and its version, the time it was sent and the project address (DSN).
- **Native crash reports** when a process crashes: an event with whichever of the fields above the crash supplies, among them the platform label `native` and the process and environment tags, and a minidump of that process. A minidump is a snapshot of the process's memory, so it can contain file paths, parts of the save or notes that were open, and anything else in memory at the time. The screening described below does not apply to the contents of a dump. Aurora Electrons makes no promise that a crash report holds no personal or save data.

Before a report's event leaves the app, it is reduced to the fields named above: the filter in `src/main/sentry.js` copies only those and drops everything else on the event. For a native crash report this covers the event, not the minidump. In the text fields (the message, error type and value, function names, mechanism type, and the app, runtime and tag strings), a detected SQL statement (from its first keyword to the end of the text) becomes `[SQL redacted]`, web addresses become `[URL redacted]`, absolute file paths (to the end of their line) become `[path redacted]`, and each text field is cut to 1,000 characters. Stack-trace file names are reduced to their base name, and local variable values, source lines and surrounding code are left out. No user, request, device, breadcrumb or extra data is sent, and the only attachment ever sent is a native crash dump. Session replay, analytics, performance profiling, session tracking and screenshots are not used. This screening reduces what is sent; it cannot guarantee that an error message never quotes something private.

### Where reports wait

The app keeps no queue of error reports on disk and does not retry: a report that cannot be sent is dropped. A native crash is different: Electron writes the dump into a reporting folder the app creates under its user-data folder. The app records that folder's path and a random ownership id in `reporting.json`, with a matching marker inside the folder. Before native startup or deletion it validates the record, path, ancestors, marker and existing report subfolders. With consent still on, the next start lets the SDK recover dumps from that validated folder without deleting them first. With consent off, it deletes dumps only there and does not initialise the SDK. An invalid or replaced folder leaves reporting off without adopting another folder.

The default Electron crash-dump folder is never read, uploaded, moved or deleted by this preparation. Pre-fix dumps there remain on disk, including after an upgrade; they are not recovered by later opt-in. Future opted-in crashes use the app-created folder instead.

### Turning it off

- **New sends stop at once.** Switching off closes the gate that every report passes through before the app finishes saving the choice. It does not flush anything first, and it cancels a request in progress where it can. Bytes that were already transmitted cannot be recalled, and a cancelled request may still have reached Sentry.
- **Nothing old is uploaded after a saved opt-out.** Reports and crash dumps still on disk are not sent after you switch off: not when the connection returns, not after a restart with reporting off, and not if you switch reporting on again later. The app deletes only diagnostic files it can identify as its own: a leftover report-queue index and the report files it lists, the crash-context file, and dumps in its validated app-created reporting folder. It does this when you switch off and at every start with reporting off. It never sweeps the default Electron crash-dump folder or touches your saves, settings, history or notebook notes. If ownership validation or deletion fails, reporting stays off and the app says so; unclaimed bytes remain untouched.
- **Crash collection ends on restart.** Electron's crash reporter, once started, cannot be stopped inside a running process. If the app crashes after you switch off and before you restart, a dump may still be written in the app-created folder. It is not sent in that session and is deleted at the next start with reporting off, if the folder still validates.
- **Turning it on again needs a restart.** After switching off, a request to enable reporting in the same session is refused: "Reporting cannot be enabled again in this process. Restart while reporting is off, then enable it in Settings." No pending enable is stored, so a restart alone never turns reporting on.
- **If the choice cannot be saved.** When storage refuses the write, the current session stays off and the app says: "Reporting is off for this session, but the choice was not saved. A previously saved opt-in may enable reporting after restart. Try disabling again before restarting." The app cannot promise a durable opt-out when it cannot write the file.
- **If native startup fails.** The app closes the send gate, tries to abort requests and save reporting off, keeps the folder's ownership record, and cleans only the validated folder. It says: "Reporting is off because native startup failed. Restart, then enable reporting in Settings." It cannot retry native startup in that process. The next launch stays off only if saving off succeeded; otherwise the unsaved-choice warning above applies.

The repository has checks for this behaviour (`scripts/check-reporting.js` and `bun run reporting:smoke`). They run against a local collector, never against Sentry, and they are the project's own tests, not an independent audit.

## Published releases up to 3.2.2

Releases up to and including 3.2.2 sent error reports and native crash reports to the same Sentry project without asking. They used the Sentry SDK's default settings, which collect more than this policy describes (for example breadcrumbs of recent events and device details), and reports that could not be sent waited on disk and went out later. A published download cannot gain the choice afterwards, so it keeps this behaviour. The first start of a build with the choice leaves that backlog unsent and deletes the identified legacy queue and crash-context files before any later opt-in. Dumps in the default Electron crash-dump folder are abandoned in place, not read, sent or deleted.

## Other network use

The application's own code has no update check and no analytics. Searching its source (`src/`), at the date above, for network calls (`fetch`, `XMLHttpRequest`, `net.request`, `net.fetch`, `WebSocket`, `sendBeacon`, `autoUpdater`, `EventSource` and the Node `http` and `https` modules) finds only the report transport described above and a handler that serves the app's own pages from local files. A link opens in your default web browser only when you click it, where that site's policy applies. Aurora Electrons runs on Electron and Chromium, which are upstream software; this project has not audited what they do on the network, and this policy makes no promise about it. Downloading a release is a request to GitHub, under [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

## Questions and changes

Open an [issue](https://github.com/rubybrowncoat/Aurora-Electrons/issues) with any question about this policy. Changes are tracked in the repository history of this file.
