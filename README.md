# Aurora Electrons

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/rubybrowncoat/Aurora-Electrons)

Aurora Electrons is a free desktop companion for the 4X game [Aurora (C#)](https://aurora4x.com/) by Steve Walmsley. It opens a game save (the SQLite database `AuroraDB.db`), watches it for changes and shows its information in new ways: plans, forecasts and summaries drawn from the save, covering production, warnings, minerals, colonies, logistics, finances, empire history, intelligence, the galaxy map and the tech tree. It is an unofficial companion: the game belongs to its author, and no permission or endorsement from him is claimed. The app is by Matsor Browncoat ([rubybrowncoat](https://github.com/rubybrowncoat)) and licensed under the MIT License ([LICENSE](LICENSE)).

## Download and run

Windows downloads are portable executables on the [releases page](https://github.com/rubybrowncoat/Aurora-Electrons/releases). Pick the release for your Aurora version:

| Your Aurora saves | Release |
| --- | --- |
| Aurora 3.x (the 3.0, 3.1 and 3.2 shapes) | The [latest release](https://github.com/rubybrowncoat/Aurora-Electrons/releases/latest): `aurora-electrons-<version>.exe` (3.2.2, published 2026-11-10, when this was written) |
| Aurora 2.7.x | [2.7.11](https://github.com/rubybrowncoat/Aurora-Electrons/releases/tag/v2.7.11), the last release of the 2.7 line |
| Before Aurora 2.7 | [0.11.0](https://github.com/rubybrowncoat/Aurora-Electrons/releases/tag/v0.11.0), the last release that read them |

There is no installer. Save the executable, put it next to the `AuroraDB.db` it should open (in Aurora's folder, or a copy of it), and start it. At start it opens the `AuroraDB.db` beside it; another save can be chosen from inside the app, and recent saves are remembered. The portable executable unpacks itself to a temporary folder each time it starts.

Releases are **not code-signed yet**, so Windows may warn about the download. GitHub shows a SHA-256 digest next to each asset to compare with the file you downloaded. See [Code signing policy](#code-signing-policy).

**What the app does to your save.** Aurora Electrons reads your save. The one exception is the Galaxy Map's **Save positions** button: after a confirmation it writes the positions of the systems you moved, rounded to whole units, into the save's survey rows for the empire you are viewing. Use it with the game closed, or load the save again in the game afterwards, and keep a copy of the save. Nothing else is written to a save, and the app never moves or copies one.

## Privacy

Aurora Electrons has no accounts, no analytics and no usage tracking. Your saves, settings, Empire History and notebook notes stay on your computer. Optional error and crash reporting to Sentry is the one way information can leave it. The published releases up to 3.2.2 send those reports without asking. Builds from the `signpath-preparation` branch, and releases made from it, keep reporting off until you choose: the app asks on first launch, and Settings changes the choice at any time. Apart from that, the application's own code sends nothing to other networked systems unless you ask it to, for example by clicking a link. [PRIVACY.md](PRIVACY.md) has the details: what a report contains, how turning it off works, and why a native crash dump can hold parts of a save.

## Code signing policy

The releases from 2.7.10 to 3.2.2 are unsigned. Signing through the SignPath Foundation is being prepared but has not been applied for, accepted or used; nothing here claims otherwise. The policy that will apply, the covered files, the team roles and how a signed release is made are in [SIGNING.md](SIGNING.md). How release builds are made is in [RELEASING.md](RELEASING.md).

## Remove the app and its data

There is no installer, so there is nothing to uninstall in Windows. Removing the app and removing the data it keeps are separate steps.

1. **Remove the app.** Close it and delete the `aurora-electrons-<version>.exe` you downloaded. Your Aurora saves are not touched, and removing the app never requires changing them.
2. **Optionally remove the data it keeps.** The app keeps its own data in one user-data folder, apart from your saves: settings, the list of recent saves, Empire History, scenario records, economy notebook notes, history backups, the error-reporting choice and any reporting leftovers. In the app, **About**, **Data** lists the paths of the save shown, the settings file and the Empire History folder, and its **Open folder** button opens the folder that holds the settings file; take the location from there, not from this page. To remove the data, close the app and delete that folder. This cannot be undone: it deletes your Empire History and notes, so export an Empire History backup first if you want one. Never delete the save listed under *Save shown*: it is your Aurora save, and removing the app's data does not involve it. Builds from before the settings folder was fixed may also have left a `config.json` in a folder named `electron-store-nodejs` (on Windows, `%APPDATA%\electron-store-nodejs\Config`). About does not list it, and later builds copy it into the user-data folder once without deleting the original. Other applications can share that folder, so look inside before deleting anything.

## Third-party notices

[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists the libraries, fonts, icons and runtime the app ships with and the notices that go with them. Packages built from the preparation branch onward carry the same file at `resources/THIRD_PARTY_NOTICES.md`; the published releases up to 3.2.2 predate it. In the app, About, Credits shows the font, icon and colour-reference credits and their notice texts. The project's MIT licence covers the project's own code only.

## Local reference material and the sample save

`references/aurcalcs` and `references/queries` hold community material by skoormit (the `Aur_Calcs260.xlsx` workbook, 171 SQL scripts and a survey text file), kept as local development references with the author's permission. The repository tracks only the authored README in each folder. The other 173 files are local, git-ignored files, and this change removes them from the current and later tree. It does not rewrite history, so earlier commits still contain them. They are not part of any release, and no licence is assigned to them here: the project's MIT licence is not a grant over them.

A checkout that still tracks these files loses them from its working tree when it merges or checks out a commit that stops tracking them. Each checkout and each worktree needs its own pass; this repository's change was prepared in one checkout and has not been merged into any other. In every such checkout:

1. **Before the merge or checkout, create the backup folder.** Make a new folder `<backup>` outside the repository, for this checkout only, and check that it is empty. Never reuse an earlier backup folder.
2. **Take a fresh inventory** of `references/aurcalcs` and `references/queries` with a SHA-256 for every file, stored in `<backup>` beside the payload folder of the next step, for example `Get-ChildItem references\aurcalcs, references\queries -Recurse -File | Get-FileHash -Algorithm SHA256 | Select-Object Hash, Path | Export-Csv <backup>\inventory.csv -NoTypeInformation`. An older inventory does not count: files change.
3. **Back up without overwriting.** Copy both folders into a separate subfolder, `<backup>\payload`, keeping their `references\...` layout, for example `robocopy references\queries <backup>\payload\references\queries /E` (and the same for `aurcalcs`). Put nothing else in `payload`. Check that each copy's hash matches the inventory.
4. **Merge or check out.**
5. **Restore only what is missing.** For example, `robocopy <backup>\payload\references\queries references\queries /E /XC /XN /XO` (and the same for `aurcalcs`) copies files that are absent and skips every file that exists. The backup also holds the old tracked `README.md` of each folder. The merge replaces it with the authored README, so never copy the old one back over it.
6. **Verify.** Hash the restored files against the inventory. Compare any file that exists in both places: if the bytes differ, keep both under different names and never overwrite either.

`fixtures/AuroraDB.zip` is a separate thing: a sample save generated by Aurora, kept tracked for development and tests. It has its own provenance, is not part of any release package, and no licence is stated for it here.

## Build from source

Requires Node 22.12 or newer (`.nvmrc` pins 24, so `nvm use 24` works) and [Bun](https://bun.com) as the package manager (`packageManager` pins Bun 1.4.2; other package managers are rejected). The scripts run on Node. For a clean build, start from a fresh clone, run `bun install --frozen-lockfile`, then `bun run build`.

``` bash
# install exactly the locked dependencies
bun install --frozen-lockfile

# serve app with hot reload
bun run dev

# build the production app; on Windows this writes build/aurora-electrons-<version>.exe
bun run build

# serve the renderer in a browser for testing, without Electron
bun run web

# lint all JS/Vue component files in `src/`
bun run lint

# check the error-reporting lifecycle against a local collector, never Sentry's servers
bun run reporting:smoke
```

Start `reporting:smoke` with `bun run`, not by calling `node` on the script: it expects the environment Bun's launcher provides.

Draft release builds are made on GitHub-hosted Windows runners from the same locked install, with Node 24 and Bun 1.4.2; see [RELEASING.md](RELEASING.md). A build on your machine with other versions is not that configuration.

The app reads `AuroraDB.db` from the project root in development. A sample save lives in `fixtures/AuroraDB.zip` (`unzip fixtures/AuroraDB.zip`): a United Earth Federation campaign of this line, saved in 2102.

The terraforming planner compares a blueprint's final colony cost over the whole orbit with leaving the body as it is. Partial plans use that same worst-point cost, including the atmosphere's seasonal dampening and tidal locking. When the bounded search finds no lower cost or equal-cost dangerous-gas removal, no blueprint is shown and the body ranks as it is.

Displayed plans have water-conserving endpoints under the held-position, completed-operation model. At the refreshed current climate, neither condensation nor evaporation may move more than a fixed numerical allowance of 1e-8 atm: liquid water uses the pressure-dependent humidity target, ice retains at most that allowance of vapour, and hot water must have enough vapour to stop evaporation but may retain an excess because condensation is disabled above 369 K. This allowance covers solver residue, not future orbital evolution or exact equilibrium. Frozen gases supply no active pressure, warming or cooling; stored frozen gas still counts for breathing. Trials with retained surface water but no supported phase, inconsistent ice albedo, unsolved surface evaporation, or an all-frozen atmosphere are rejected rather than rebalanced. If no supported trial improves the cost or removes dangerous gas at equal cost, no plan is shown; this does not rule out better atmospheres outside the bounded search. Wet and drained partial alternatives use the same whole-orbit cost, with less work breaking ties.

The shared saved-snapshot orbital census is `loadOrbitalCensus(database, { GameID, RaceID })` in `utilities/orbital-census.js`. It returns per-colony finite population bounds and separate positive-population and million-person predicates; an unknown count is not zero. Only reachable rows and their shared-cell constraints affect a colony, and infeasible relationship alternatives do not erase supported ones. A missing categorical input is named only when its supported alternatives change that colony's population bounds, not merely because its row is reachable or another constraint tightens the result. Coupled unknown quantities can leave a conservative upper bound and an undecided gate. `bun scripts/check-orbital-census.js` checks SQLite tables built from `.github/exports/` headers against an independent completion oracle and semantic mutants, plus loader/interval-order smoke checks on the four played saves (`--no-mutations` runs the head cases only). Consumer migrations remain separate from this shared primitive.

The build reads Aurora 3.x saves (the 3.0, 3.1 and 3.2 shapes) and refuses a pre-3.0 shape: a save with none of the seven columns Aurora 3.0 added, or without an `FCT_Game` table, is not read, and the app says so in place of the pages. A save from before Aurora 2.7 needs Aurora Electrons 0.11.0, the last release that read them. The Aurora 2.7.x line continues on the `release/2.7` branch (cut at `v2.7.11-cut`, fixes only) and reads Aurora 2.7.x saves; its last release is [2.7.11](https://github.com/rubybrowncoat/Aurora-Electrons/releases/tag/v2.7.11). This branch (`3.2`) is the Aurora 3.2 line, released as 3.2.N. `bun scripts/rule-versions-table.js` prints the registered version labels area by area, with the verification, repair and stored-column work behind them and the findings still unverified on the line.

# Contributions

Pull Requests and Issues are welcome.

The autogenerated wiki at https://deepwiki.com/rubybrowncoat/Aurora-Electrons helps to study and unpack the features and architecture of the project.
