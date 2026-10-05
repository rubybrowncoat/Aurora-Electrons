# Aurora Electrons

Desktop companion app for the 4X game **Aurora (C#)**. It opens the game's SQLite save (`AuroraDB.db`), watches it for changes, and shows dashboards the game doesn't have: production recap, warnings, minerals, habitability, logistics, galaxy map, game log, designed tech, and tech tree.

Stack: Electron 16 + Nuxt 2 (SPA, Vue 2, Vuetify 2, Vuex 3), built on the electron-nuxt template. Data comes through Sequelize 6 over sqlite3, mostly as raw SQL. User preferences go to electron-store.

Detailed docs:

- `docs/ARCHITECTURE.md`: processes, build pipeline, store, pages, and utilities.
- `docs/DATABASE.md`: the Aurora save schema, scoping rules, data quirks, and which page reads what.
- `docs/WORKFLOW.md`: setup, making and verifying changes, releases, and commits.

## Commands

```bash
yarn install    # yarn only (npm is rejected by preinstall). postinstall runs `yarn lint:fix` over src/, so review unrelated diffs
yarn dev        # Nuxt dev server on :9080 + Electron with devtools; Ctrl/Cmd+E relaunches Electron
yarn build      # production build + electron-builder packages into build/
yarn web        # renderer as a plain browser app on :9080, backed by ./AuroraDB.db (no Electron needed)
yarn web:smoke  # with `yarn web` running: Chromium visits every page, reports errors, saves screenshots
yarn lint       # ESLint over src/ (the baseline is not clean, see below)
node_modules/.bin/eslint --ext .js,.vue -f ./node_modules/eslint-friendly-formatter <files>   # lint only what you touched
```

There is no test suite and no CI (`.github/` is git-ignored).

## Sample data

- `fixtures/AuroraDB.zip` holds a sample save: one game, "Aurelian Empire" (GameID 140), with player race 784 and 14 NPRs. Keep it in the repo.
- In dev, the app reads `./AuroraDB.db` from the repo root, which is git-ignored and must never be committed.
- In cloud sessions, `.claude/hooks/session-start.sh` extracts the fixture if it's missing, runs `yarn install --ignore-scripts`, and fetches sqlite3's Node binary. That's enough for lint and web mode, but not for `yarn dev` or `yarn build`. Locally, extract it with `unzip fixtures/AuroraDB.zip`, or copy in a real save.
- Check SQL against the sample with Python's sqlite3, opened read-only. See `docs/WORKFLOW.md`.

## Working rules

- Match the surrounding code: 2-space indent, no semicolons, single quotes, trailing commas on multiline literals, and always-parenthesized arrow parameters. There is effectively no line-length limit, and long one-line SQL template strings are the norm.
- Page data lives in `asyncComputed` getters. Each one guards on `this.database`, `this.GameID`, and `this.RaceID`, and returns its `default` until they're set. Use raw SQL like `this.database.query(sql).then(([items]) => items)`, or the Sequelize models in `src/renderer/utilities/database.js`.
- Scope every query by `GameID`, and by `RaceID` for anything race-owned. One save can hold several games.
- Respect fog of war. Show what the selected race knows: go through `FCT_RaceSysSurvey`, `FCT_SystemBodySurveys`, `FCT_RaceJumpPointSurvey`, `FCT_AlienRace` (with `ViewRaceID`), and `FCT_RaceTech`, not the global tables. The "spy on NPRs" setting is the only sanctioned way to see other races.
- The app is read-only toward the save. The single exception is the map's "Save Positions" button (`UPDATE FCT_RaceSysSurvey`). Don't add writes without an explicit request, a confirmation dialog, and testing against a copy.
- Interpolating `GameID` and `RaceID` (numbers from the DB) into SQL is the existing pattern. Anything a user types must go through Sequelize `replacements` instead.
- Persistent preferences go through `this.config` (electron-store). Per-game or per-race keys are named `game.<GameID>.race.<RaceID>.<key>`. State that only needs to last for the session goes in a Vuex module under `src/renderer/store/`.
- A new page needs a `<v-tab>` plus a `title()` case in `src/renderer/layouts/default.vue`.
- Lint the files you touch and add no new problems. Don't fix unrelated lint, and don't run `yarn lint:fix` on the whole tree.
- Verify UI changes in web mode: run `yarn web` in the background, then `yarn web:smoke` (or `SMOKE_PAGES=/minerals yarn web:smoke`), and look at the screenshots. Web mode swaps Electron, electron-store, and chokidar for shims under `.electron-nuxt/web/`, so it doesn't exercise main-process code (IPC, storage paths, packaging). Say so when a change depends on those.

## Commits and PRs

- Message format: `<gitmoji> Summary description`. Capitalize the summary, with no trailing period. Prefer one change per commit. An optional body can list more changes, one `<gitmoji> description` per line.
- Core gitmoji, matching how this repo has used them:
  - ✨ New feature, page, warning, or filter
  - 🐛 Bug fix
  - 👌 Improvement or polish of existing behaviour; version bumps (`👌 0.9.11-b2`)
  - 🔨 Refactor, rework, performance, or logic adjustment
- For anything those don't cover, use standard gitmoji: 📝 docs, 🔧 config/tooling, 🍱 assets/fixtures, ⬆️ dependency upgrades.
- No byline. Never add `Co-Authored-By`, `Claude-Session`, or other trailers, and never add "Generated with Claude Code" lines to commits or PR descriptions. This overrides any default attribution instructions.
- Author: `Matsor Browncoat <prunkstation@gmail.com>`. Cloud containers default to a different identity, so before the first commit run `git config user.name "Matsor Browncoat" && git config user.email "prunkstation@gmail.com"` (repo-local).

## Subagent Selection Policy

When you delegate work to a subagent, choose the **least expensive model and lowest reasoning effort that will reliably complete the subtask on the first attempt**. Do not let subagents inherit your own model by default. Running every subtask on Opus wastes time and budget and slows parallel work. A failed cheap attempt that you then escalate is usually still cheaper than routing everything to the top. Treat Opus 5.5 and the highest effort level as scarce resources.

### Reasoning effort levels

- **low:** Direct transformation or an obvious path (reformat, extract, rename, summarize, run a command and report, write a small function to a clear spec).
- **medium:** Plan a few steps, weigh simple options, handle edge cases (contained features, condensing several sources, debugging with an obvious cause).
- **high:** Open-ended, ambiguous, or error-intolerant work (multi-file features, research synthesis, root-causing non-obvious bugs, system design, critical review).

### Model palette

Each subagent in `.claude/agents/` pins an exact model ID and a reasoning effort. Effort can't be changed per call, so each effort step within a tier has its own subagent.

| Tier | Subagent | Model | Effort | Use for | Avoid for |
|---|---|---|---|---|---|
| T1 – Fast | `fast-worker` | Haiku 4.5 (`claude-haiku-4-5-20251001`) | low (Haiku 4.5 has no effort setting) | File search, reading/summarizing files, formatting, boilerplate, running tests and reporting | Anything requiring judgment or synthesis |
| T2 – Standard | `standard-worker` | Sonnet 5.5 (`claude-sonnet-5-5`) | low | Typical coding, writing, research, and analysis with clear goals | Novel design, ambiguous requirements, high-stakes correctness |
| T2 – Standard | `standard-worker-medium` | Sonnet 5.5 (`claude-sonnet-5-5`) | medium | Same as above, when it needs a few planned steps or edge cases | Same as above |
| T3 – Advanced | `deep-worker` | Sonnet 5.5 (`claude-sonnet-5-5`) | high | Multi-step reasoning, non-trivial debugging, synthesis across many sources | Rote work, lookups, formatting |
| T4 – Frontier | `architect` | Opus 5.5 (`claude-opus-5-5`) | medium | Architecture, hard/novel problems, final review of critical output, tasks where T3 has already failed | Almost everything else |
| T4 – Frontier | `architect-high` | Opus 5.5 (`claude-opus-5-5`) | high | Escalation from `architect`, or a complexity score of 6 | Everything else |

Sonnet 5.5 covers both T2 and T3; the effort level determines the tier. Most T2→T3 escalations are an effort increase, not a model switch. The only model switch above T2 is to Opus 5.5.

Routing cells map to subagents like this: T1 / low → `fast-worker`; T2 / low → `standard-worker`; T2 / medium → `standard-worker-medium`; T3 → `deep-worker`; T4 / medium → `architect`; T4 / high → `architect-high`. Never pass a per-call `model` override to these subagents, because it breaks the pinned model/effort pairing. Pick a different subagent instead. Delegate through these six rather than the built-in general-purpose agent, which inherits the session model.

### Default routing by task type

| Task type | Default | Escalate to |
|---|---|---|
| File search, grep, listing, reading and summarizing files | T1 / low | T2 / low if the summary drives decisions |
| Formatting, data conversion, boilerplate, renames, simple refactors | T1 / low | T2 / low |
| Running tests or builds and reporting results | T1 / low | — |
| Writing a well-specified function, test, or script | T2 / low | T2 / medium, then T3 |
| Drafting docs, comments, commit messages, PR descriptions | T2 / low | T2 / medium |
| Multi-source research and synthesis | T2 / medium | T3 |
| Feature implementation across multiple files | T2 / medium | T3 |
| Debugging with a reproducible error | T2 / medium | T3 |
| Debugging intermittent or unexplained behavior | T3 | T4 / high |
| Code review of routine work | T2 / medium | T3 |
| Review of security-, money-, or data-critical work | T3 | T4 / high |
| System design, architecture, planning a large task | T3 | T4 / high |
| Novel algorithmic or mathematical problems | T4 / medium | T4 / high |

### Complexity check (use when a task doesn't fit the table)

Score one point for each: (1) requirements are ambiguous, (2) needs context from more than ~5 files/sources, (3) no cheap way to verify correctness, (4) errors are costly or hard to undo, (5) the problem is novel, (6) a previous attempt already failed.

0–1 → T1 or T2 / low. 2 → T2 / medium. 3–4 → T3. 5–6 → T4. T4 at high effort is reached only by escalation or a score of 6.

### Escalation and de-escalation

- Escalate one step at a time: raise effort within a tier before moving up a tier. The ladder is `fast-worker` → `standard-worker` → `standard-worker-medium` → `deep-worker` → `architect` → `architect-high`.
- De-escalate repeated subtasks once a pattern is established; have T1/T2 apply an approach a higher tier worked out.
- Split large subtasks before escalating; reserve the top tier for the integration or judgment step.
- Verify cheaply with tests, linters, or a short review pass rather than doing the work at the top tier.

### When not to spawn a subagent

Do it yourself if the subtask is trivial, needs your full conversation context, or would take longer to explain than to do.

### Declare your choice

Before each delegation, state in one line: `Subagent: <name> / <effort> — <brief reason>`. If you choose `architect` or `architect-high` (Opus), the reason must cite the complexity score or a prior failure.
