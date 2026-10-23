---
extends: feature, bug-fix, investigation
when: Any work on an item of the Aurora Electrons backlog (an AE-*, FU-*, PLAN-INT-* or CP-* id), which is every change under src/ and every research task of the plan.
---

# Backlog ledger

Every item of the plan is tracked in the ledger: the page `docs/plans/backlog/progress.html`, its data file `progress.data.js`, and the CLI `node docs/plans/backlog/ledger.mjs`. `docs/WORKFLOW.md` § Tracking work in the ledger is the protocol. This playbook adds the ledger steps to the bundled Feature, Bug fix and Investigation playbooks. A feature of the plan runs Feature, a `FU-*` defect runs Bug fix, and a research or validation item runs Investigation.

This repository has no CI and the owner lands commits on the working branch. Open a PR only when the owner asks for one. Otherwise the **Opening a PR** step ends at the commit.

## Changes

- **Before** "`how` over the affected subsystem." pick the item. Run `node docs/plans/backlog/ledger.mjs next` and take the first ready item unless the owner named one. Run `ledger.mjs show <id>`, read its spec section, its Refresh block and the evidence files of its prerequisites and complete siblings, then log `in-progress` as `impl:<name>` with what you will deliver.
- **Before** "Reproduce it yourself on the matching surface" pick the item the same way. A defect that no `FU-*` item covers gets one first: `ledger.mjs add FU-<n> --phase 10 --title "<page>: <symptom>" --by impl:<name>`. Then log it `in-progress`.
- **Before** "Route through the **how** skill." log the research item `in-progress`. Its deliverable is the evidence file `docs/plans/backlog/evidence/<id>.md`, with the contract and the open questions the next item needs.
- **After** "Verify on the matching surface." write the evidence file, then log `in-review` with the evidence path, the check commands with their counts and the smoke result. When you stop short, log `blocked` with the blocker or `needs-decision` with the question and its options, and move to the next ready item.
- **After** "Verify on the same surface." do the same: evidence file, then `in-review`, or `blocked` or `needs-decision`.
- **After** "Apply the **unslop** skill to the reply." write the answer into the evidence file and log `in-review` with its path. The owner or a reviewer logs `complete`.
- **After** "Run **Opening a PR**." end the commit summary with the item ID in parentheses. When the closing review has approved, log `complete` under the reviewer's name (`review:<name>`) with the commit hash as the ref. The CLI refuses `complete` from `impl:<name>`. Run `node docs/plans/backlog/ledger.mjs check` before you reply.

## Lanes and review (FU-50, owner decisions of 2026-10-22)

- Builder lanes get the lane brief `docs/plans/backlog/LANE-BRIEF.md` as their mandatory brief. Rules learnt in a lane go into that file, not into a session-local copy.
- Open a lane only on files no lane in review owns, and order the queue by file ownership. When a hold cannot be avoided, the independent part may land as its own commit, and the item stays `in-progress` until the held part lands as a second commit.
- Review loop:
  - Spawn one `reviewer-interim` per change and wake that same agent with `write agent://<id>` for every recheck.
  - When the interim round leaves no still-present P0-P2 and the landing run has passed, spawn one fresh `reviewer` for the closing round.
  - If a closing round requests changes, the fixes go back to the interim reviewer, then a second fresh closing round runs.
  - Interim rechecks are not capped. A third fresh closing round needs the owner's approval: ask, with the still-open findings.
  - Keep each iteration short. The proof rules below keep it so.
- Proof:
  - A round runs only the head checks plus the faults and rewrites the round touched, focused.
  - The full suites (and every dependent check whose faults anchor on a changed file) run once, as the landing run, before the closing round.
  - Reviewers verify with their own probes and do not rerun whole suites.
  - Every heavy run counts against the machine-wide slot limit, reviewers' runs included.
- Full-run supervision (FU-53):
  - After the lead grants a heavy slot, start the suite with `CHECK_JOBS=1 bun scripts/run-check.js start --label=<ID>-<suite> <suite> [args]`. Record its label, supervisor pid and `.check-runs/<label>/status.json` path. Use `run-check.js status <label>` to read the result or `run-check.js wait <label>` to await completion.
  - The detached supervisor survives the starter's turn. A run still occupies its heavy slot until its supervisor exits. Report active runs before ending a turn; never treat the end of a turn as cancellation. Direct background jobs do not have this contract.
  - Resume a runner-based suite with the same command and arguments plus `--resume`. It refuses changed source, input saves or variant lists. Labels separate supervisor output, not suite progress records, so never run identical suite arguments concurrently.
  - Read the failed step and browser scene before another run. Fix the cause instead of retrying. Keep fix rounds focused; a full adopting-suite rerun is unnecessary when only the runner's own regressions changed.
  - Shared baseline work belongs in bounded `prepare`, not in a first variant. Every child has a watchdog or `runChild`/`startChild` limit, and the variant deadline covers its sequential child bounds plus its own work. The separate `between` bound covers every close, including after failed preparation. The runner's full contract is in `docs/plans/backlog/evidence/FU-53.md`.
- Research items: the closing review judges the contract, the open questions and reproducible figures. Unsettled parsing cases become open questions for the implementing item.
- Record each review round with `node docs/plans/backlog/ledger.mjs log <id> <status> <by> [note] [ref] --payload <agent>`.
  - The note is led by the payload's verdict, served model and finding ids, and the round is appended to the evidence file's `### Closing review record`.
  - `complete` is refused for a payload that did not approve, or that was served outside OpenAI.
  - One log line per round.
