---
description: "Begin plan-driven implementation. Usage: /start-work <phase>"
agent: implement
---

Target phase: **$1**

Call `plan_work_start("$1")` to activate work mode.

If "$1" is empty:
1. Call `plan_status` to check state
2. Call `plan_phase_list` to see available phases
3. Pick the next phase that isn't completed

After activation:
1. `plan_task_list("$1")` — see all tasks
2. `plan_task_set(id)` — pick first pending task
3. `plan_task_get(id)` — read its spec
4. Implement. Do not ask for confirmation.
