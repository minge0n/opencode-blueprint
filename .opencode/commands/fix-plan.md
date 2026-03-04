---
description: "Fix plan data based on verify findings. Usage: /fix-plan"
agent: plan
---

Fix plan data based on verification findings.

1. `plan_finding_list(fix_target: "plan")` — get all plan-targeted findings
2. For each finding:
   - `plan_finding_get(id)` — read full details
   - Determine what plan data needs to change
   - Update via `plan_task_save`, `plan_req_save`, `plan_decision_save`, etc.
   - `plan_finding_resolve(id, "accepted", reason, action)` — if you fixed the plan
   - `plan_finding_resolve(id, "rejected", reason)` — if the finding is invalid
3. Report summary of what was changed.

Skip findings where fix_target is "code" — those are for the implement agent.

Do not ask for confirmation. Start processing immediately.
