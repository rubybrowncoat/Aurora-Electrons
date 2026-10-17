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
