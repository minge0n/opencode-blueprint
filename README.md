# @mingeon/opencode-blueprint

Structured plan-driven development for [OpenCode](https://opencode.ai). Three specialized agents, 26 custom tools, granular JSON task data, compaction-safe state tracking.

No markdown plans. No freeform documents. Every task, requirement, decision, and finding is an individual JSON file managed via tool calls.

## Installation

```bash
npm install @mingeon/opencode-blueprint
npx @mingeon/opencode-blueprint init
```

This does two things:
1. Copies agent (`.md`) and command (`.md`) files into your project's `.opencode/` directory
2. Registers the plugin in `opencode.json`

The 26 `plan_*` tools are loaded automatically via the plugin — no files needed in `.opencode/tools/`.

## Agents

| Agent | Persona | Role |
|-------|---------|------|
| **Plan** (Mira Chen) | Principal architect | Creates structured plans via interview-mode. Intent classification before planning. `edit: deny` — writes only via `plan_*` tools. |
| **Implement** (Daniel Kessler) | Staff engineer, orchestrator | Reads task specs, delegates parallel tasks to `@general` subagents. Certainty protocol before implementation. |
| **Verify** (Gene Hartley) | 23-year veteran auditor | Cross-references tasks against code. Delegates per-task checks to `@explore` subagents. Saves findings individually. |

Switch agents with **Tab**. Start implementation with `/start-work <phase>`.

## Commands

| Command | Description |
|---------|-------------|
| `/start-work <phase>` | Activate work mode, begin implementing a phase |
| `/fix-plan` | Process verification findings that target the plan |

## Data Structure

All data lives in `.plans/` and `.reports/` as granular JSON:

```
.plans/
├── metadata.json                    # project meta + session state
├── overview.json                    # goals, stack, constraints
├── decisions/D-001.json             # individual design decisions
└── phases/{phase}/
    ├── metadata.json                # phase status, tracks, dependencies
    └── tasks/{TASK-ID}/
        ├── metadata.json            # task status, files, dependsOn
        ├── req-001.json             # acceptance criterion
        └── test-001.json            # test specification

.reports/
├── metadata.json                    # finding counts
└── findings/{V-ID}/
    ├── metadata.json                # severity, status, fixTarget
    ├── expected.json                # what the plan says
    ├── actual.json                  # what the code does
    ├── impact.json                  # what breaks
    └── resolution.json              # disposition + reason
```

## Tools (26)

**Project**: `plan_status`, `plan_overview_get`, `plan_overview_save`, `plan_meta_save`, `plan_init`

**Decisions**: `plan_decision_list`, `plan_decision_get`, `plan_decision_save`

**Phases**: `plan_phase_list`, `plan_phase_get`, `plan_phase_save`

**Tasks**: `plan_task_list`, `plan_task_get`, `plan_task_save`, `plan_task_set`, `plan_task_done`, `plan_task_next`

**Requirements/Tests**: `plan_req_save`, `plan_req_done`, `plan_test_save`

**Findings**: `plan_finding_list`, `plan_finding_get`, `plan_finding_save`, `plan_finding_resolve`

**Session**: `plan_note`, `plan_work_start`

## Plugin Hooks

- **Compaction** — injects plan state (phase, task, constraints, notes) into continuation prompt
- **File protection** — blocks direct edits to `.plans/` (agents use `plan_*` tools instead)
- **Push reminders** — appends task context after write/edit/bash tool executions
- **Continuation enforcer** — auto-pushes when session goes idle with incomplete tasks

## Parallel Execution

Tasks declare dependencies via `dependsOn`. `plan_task_next` computes all tasks with met dependencies. When multiple tasks are ready, the implement agent delegates each to a separate `@general` subagent for parallel execution.

## Finding Disposition

Each verification finding gets resolved as:
- **accepted** — finding is valid, fix applied (with action description)
- **rejected** — finding dismissed (with reason)

Resolution includes `resolvedBy` (plan/implement/user), timestamp, and action taken.

## Workflow

```
1. Tab → Plan agent → describe your project
2. Plan agent interviews you, creates structured plan data
3. /start-work <phase> → switches to Implement agent
4. Implement agent reads tasks, delegates parallel work to subagents
5. Tab → Verify agent → audits completed tasks against plan
6. /fix-plan → Plan agent processes verification findings
7. Repeat until done
```

## License

MIT
