/**
 * plan-tracker.ts — OpenCode Blueprint plugin.
 *
 * Single entry point for npm distribution. Exports:
 * - Plugin hooks (compaction, file protection, push reminders, continuation enforcer)
 * - All 26 plan_* tools via tool:{} record
 *
 * All plan data is stored as granular JSON files in .plans/ and .reports/.
 */
import { type Plugin, tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs"
import { join } from "path"

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const PLANS_DIR = ".plans"
const REPORTS_DIR = ".reports"

// ─────────────────────────────────────────────────────────────
// JSON / FS helpers
// ─────────────────────────────────────────────────────────────

function readJson<T>(filepath: string): T | null {
  if (!existsSync(filepath)) return null
  try { return JSON.parse(readFileSync(filepath, "utf-8")) as T }
  catch { return null }
}

function writeJson(filepath: string, data: unknown): void {
  const dir = filepath.substring(0, filepath.lastIndexOf("/"))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filepath, JSON.stringify(data, null, 2))
}

function listDirs(dirPath: string): string[] {
  if (!existsSync(dirPath)) return []
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

function listJsonFiles(dirPath: string): string[] {
  if (!existsSync(dirPath)) return []
  return readdirSync(dirPath)
    .filter((f: string) => f.endsWith(".json"))
    .sort()
}

function ensurePlansDir(dir: string): string | null {
  const p = join(dir, PLANS_DIR)
  if (!existsSync(p)) {
    return `ERROR: No .plans/ directory found. Run plan_init to bootstrap, or create .plans/ manually.`
  }
  return null
}

// ─────────────────────────────────────────────────────────────
// Schema types
// ─────────────────────────────────────────────────────────────

interface ProjectMetadata {
  name: string
  description: string
  version: string
  workMode: boolean
  currentPhase: string
  currentTask: string
  completedTasks: string[]
  notes: string[]
  lastUpdated: string
}

interface ProjectOverview {
  goals: string[]
  stack: string[]
  constraints: string[]
  outOfScope: string[]
}

interface PhaseMetadata {
  name: string
  description: string
  status: "planning" | "in_progress" | "completed" | "blocked"
  tracks: string[]
  dependsOn: string[]
}

interface TaskMetadata {
  id: string
  title: string
  description: string
  status: "pending" | "in_progress" | "completed" | "blocked"
  track: string
  phase: string
  files: string[]
  dependsOn: string[]
}

interface Requirement {
  id: string
  description: string
  done: boolean
}

interface TestSpec {
  id: string
  description: string
  done: boolean
}

interface Decision {
  id: string
  title: string
  rationale: string
  constraint: string
  status: "active" | "superseded"
}

interface FindingMetadata {
  id: string
  severity: "critical" | "major" | "minor" | "suggestion"
  title: string
  status: "open" | "accepted" | "rejected"
  fixTarget: "plan" | "code"
  location: string
  planRef: string
}

interface FindingResolution {
  disposition: "accepted" | "rejected"
  reason: string
  resolvedBy: "plan" | "implement" | "user"
  resolvedAt: string
  action: string
}

interface ReportsMetadata {
  totalFindings: number
  open: number
  accepted: number
  rejected: number
  lastUpdated: string
}

// ─────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────

const paths = {
  metadata: (dir: string) => join(dir, PLANS_DIR, "metadata.json"),
  overview: (dir: string) => join(dir, PLANS_DIR, "overview.json"),
  decisions: (dir: string) => join(dir, PLANS_DIR, "decisions"),
  decision: (dir: string, id: string) => join(dir, PLANS_DIR, "decisions", `${id}.json`),
  phases: (dir: string) => join(dir, PLANS_DIR, "phases"),
  phase: (dir: string, phase: string) => join(dir, PLANS_DIR, "phases", phase),
  phaseMeta: (dir: string, phase: string) => join(dir, PLANS_DIR, "phases", phase, "metadata.json"),
  tasks: (dir: string, phase: string) => join(dir, PLANS_DIR, "phases", phase, "tasks"),
  task: (dir: string, phase: string, taskId: string) => join(dir, PLANS_DIR, "phases", phase, "tasks", taskId),
  taskMeta: (dir: string, phase: string, taskId: string) => join(dir, PLANS_DIR, "phases", phase, "tasks", taskId, "metadata.json"),
  reportsMeta: (dir: string) => join(dir, REPORTS_DIR, "metadata.json"),
  findings: (dir: string) => join(dir, REPORTS_DIR, "findings"),
  finding: (dir: string, id: string) => join(dir, REPORTS_DIR, "findings", id),
  findingMeta: (dir: string, id: string) => join(dir, REPORTS_DIR, "findings", id, "metadata.json"),
}

// ─────────────────────────────────────────────────────────────
// State helpers
// ─────────────────────────────────────────────────────────────

const DEFAULT_METADATA: ProjectMetadata = {
  name: "",
  description: "",
  version: "0.1.0",
  workMode: false,
  currentPhase: "",
  currentTask: "",
  completedTasks: [],
  notes: [],
  lastUpdated: new Date().toISOString(),
}

function loadMeta(dir: string): ProjectMetadata {
  return readJson<ProjectMetadata>(paths.metadata(dir)) ?? { ...DEFAULT_METADATA }
}

function saveMeta(dir: string, meta: ProjectMetadata): void {
  meta.lastUpdated = new Date().toISOString()
  writeJson(paths.metadata(dir), meta)
}

function findTaskPhase(dir: string, taskId: string): string | null {
  const phasesDir = paths.phases(dir)
  for (const phase of listDirs(phasesDir)) {
    const tasksDir = paths.tasks(dir, phase)
    if (listDirs(tasksDir).includes(taskId)) return phase
  }
  return null
}


// ─────────────────────────────────────────────────────────────
// Continuation enforcer state
// ─────────────────────────────────────────────────────────────

interface ContinuationState {
  lastInjectedAt: number
  consecutiveFailures: number
  inFlight: boolean
}

const CONTINUATION_COOLDOWN_MS = 5_000
const MAX_CONSECUTIVE_FAILURES = 5
const FAILURE_RESET_WINDOW_MS = 5 * 60_000

const CONTINUATION_PROMPT = [
  "## Blueprint — Task Continuation",
  "",
  "Incomplete tasks remain. Continue working on the next pending task.",
  "",
  "- Call plan_task_list to see remaining tasks",
  "- Call plan_task_set to pick the next one",
  "- Call plan_task_get to read its spec",
  "- Proceed without asking for permission",
  "- Call plan_task_done when finished",
].join("\n")

// ─────────────────────────────────────────────────────────────
// Findings report helper
// ─────────────────────────────────────────────────────────────

function updateReportsMeta(dir: string): void {
  const findingIds = listDirs(paths.findings(dir))
  let open = 0, accepted = 0, rejected = 0
  for (const fid of findingIds) {
    const f = readJson<FindingMetadata>(paths.findingMeta(dir, fid))
    if (!f) continue
    if (f.status === "open") open++
    else if (f.status === "accepted") accepted++
    else if (f.status === "rejected") rejected++
  }
  const reportsMeta: ReportsMetadata = {
    totalFindings: findingIds.length,
    open,
    accepted,
    rejected,
    lastUpdated: new Date().toISOString(),
  }
  writeJson(paths.reportsMeta(dir), reportsMeta)
}

// ═══════════════════════════════════════════════════════════════
// PLUGIN
// ═══════════════════════════════════════════════════════════════

export const BlueprintPlugin: Plugin = async ({ directory, client }) => {
  const plansExist = existsSync(join(directory, PLANS_DIR))
  const sessionStates = new Map<string, ContinuationState>()

  function getSessionState(sessionID: string): ContinuationState {
    let state = sessionStates.get(sessionID)
    if (!state) {
      state = { lastInjectedAt: 0, consecutiveFailures: 0, inFlight: false }
      sessionStates.set(sessionID, state)
    }
    return state
  }

  if (plansExist) {
    await client.app.log({
      body: { service: "blueprint", level: "info", message: `Blueprint loaded. Plans: ${directory}/${PLANS_DIR}` },
    })
  }

  return {
    // ════════════════════════════════════════════════════════
    // COMPACTION — inject plan state for seamless resume
    // ════════════════════════════════════════════════════════

    "experimental.session.compacting": async (_input, output) => {
      if (!plansExist) return

      const meta = loadMeta(directory)
      if (!meta) return

      const decisionsDir = join(directory, PLANS_DIR, "decisions")
      const activeConstraints = listJsonFiles(decisionsDir)
        .map((f) => readJson<Decision>(join(decisionsDir, f)))
        .filter((d): d is Decision => d !== null && d.status === "active")
        .map((d) => `- ${d.id}: ${d.constraint}`)

      let taskSummary = ""
      if (meta.currentPhase) {
        const tasksDir = join(directory, PLANS_DIR, "phases", meta.currentPhase, "tasks")
        const taskDirs = listDirs(tasksDir)
        const pending = taskDirs.filter((tid) => {
          const tm = readJson<TaskMetadata>(join(tasksDir, tid, "metadata.json"))
          return tm && tm.status !== "completed"
        }).length
        taskSummary = `Phase "${meta.currentPhase}": ${taskDirs.length - pending}/${taskDirs.length} tasks done, ${pending} remaining`
      }

      const findingsDir = join(directory, ".reports", "findings")
      const openFindings = listDirs(findingsDir).filter((fid) => {
        const fm = readJson<FindingMetadata>(join(findingsDir, fid, "metadata.json"))
        return fm?.status === "open"
      }).length

      output.context.push(
        [
          "## Blueprint State (auto-injected on compaction)",
          "",
          `Project: ${meta.name}`,
          `Work mode: ${meta.workMode ? "ACTIVE" : "inactive"}`,
          `Phase: ${meta.currentPhase || "(none)"}`,
          `Active task: ${meta.currentTask || "(none)"}`,
          `Completed: ${meta.completedTasks.length} tasks total`,
          taskSummary ? `${taskSummary}` : "",
          openFindings > 0 ? `Open findings: ${openFindings}` : "",
          "",
          meta.notes.length
            ? `### Notes (last 5)\n${meta.notes.slice(-5).join("\n")}\n`
            : "",
          activeConstraints.length
            ? `### Active Constraints\n${activeConstraints.join("\n")}\n`
            : "",
          "### Post-Compaction Instructions",
          "1. Call plan_status to verify state",
          "2. Call plan_task_list to see remaining tasks",
          meta.currentTask
            ? `3. Resume task: ${meta.currentTask} — call plan_task_get("${meta.currentTask}")`
            : "3. Call plan_task_set to pick the next task",
          meta.workMode
            ? "4. WORK MODE ACTIVE — continue implementing."
            : "4. Work mode inactive — wait for /start-work.",
          "5. NEVER modify files in .plans/ directly — use plan_* tools.",
        ].filter(Boolean).join("\n"),
      )
    },

    // ════════════════════════════════════════════════════════
    // FILE PROTECTION — block direct .plans/ edits
    // ════════════════════════════════════════════════════════

    "tool.execute.before": async (input, output) => {
      if (!plansExist) return

      const writingTools = ["write", "edit", "patch"]
      if (!writingTools.includes(input.tool)) return

      const filePath: string =
        (output.args as Record<string, unknown>)?.filePath as string ??
        (output.args as Record<string, unknown>)?.path as string ??
        ""

      if (filePath.includes(`${PLANS_DIR}/`) || filePath.endsWith(PLANS_DIR)) {
        throw new Error(
          `BLOCKED by blueprint: .plans/ is managed via plan_* tools only.\n` +
          `Attempted to modify: ${filePath}\n` +
          `Use plan_task_save, plan_phase_save, etc. to modify plan data.`,
        )
      }
    },

    // ════════════════════════════════════════════════════════
    // PUSH REMINDERS — nudge agent after tool execution
    // ════════════════════════════════════════════════════════

    "tool.execute.after": async (input, output) => {
      try {
        const meta = loadMeta(directory)
        if (!meta?.workMode || !meta.currentTask) return

        const significantTools = ["write", "edit", "patch", "bash"]
        if (!significantTools.includes(input.tool)) return

        const reminder =
          `\n\n` +
          `─── blueprint ──────────────────────────────────────\n` +
          `  Task: ${meta.currentTask} | Phase: ${meta.currentPhase}\n` +
          `  → plan_task_done("${meta.currentTask}") when complete\n` +
          `────────────────────────────────────────────────────`

        const out = output as Record<string, unknown>
        if (typeof out.result === "string") out.result += reminder
        else if (typeof out.output === "string") out.output += reminder
      } catch { /* silent */ }
    },

    // ════════════════════════════════════════════════════════
    // SESSION EVENTS + CONTINUATION ENFORCER
    // ════════════════════════════════════════════════════════

    event: async ({ event }) => {
      if (!plansExist) return

      const props = event.properties as Record<string, unknown> | undefined
      const sessionID = (props?.sessionID as string) ?? ""

      if (event.type === "session.created") {
        const meta = loadMeta(directory)
        await client.app.log({
          body: {
            service: "blueprint",
            level: "info",
            message: meta?.workMode
              ? `Work mode ACTIVE. Phase: ${meta.currentPhase}, Task: ${meta.currentTask || "none"}`
              : `Blueprint ready. Call /start-work to begin.`,
          },
        })
      }

      if (event.type === "session.compacted") {
        await client.app.log({
          body: { service: "blueprint", level: "warn", message: "Compacted. State injected into continuation." },
        })
      }

      if (event.type === "session.idle" && sessionID) {
        const meta = loadMeta(directory)
        if (!meta?.workMode || !meta.currentTask) return

        const contState = getSessionState(sessionID)
        if (contState.inFlight) return

        if (
          contState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
          contState.lastInjectedAt &&
          Date.now() - contState.lastInjectedAt >= FAILURE_RESET_WINDOW_MS
        ) {
          contState.consecutiveFailures = 0
        }

        if (contState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return
        if (Date.now() - contState.lastInjectedAt < CONTINUATION_COOLDOWN_MS) return

        contState.inFlight = true

        try {
          const prompt = [
            CONTINUATION_PROMPT,
            "",
            `[Task: ${meta.currentTask} | Phase: ${meta.currentPhase} | Done: ${meta.completedTasks.length}]`,
          ].join("\n")

          const session = client.session as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
          if (typeof session.chat === "function") {
            await session.chat({ body: { sessionID, content: prompt } })
          }

          contState.inFlight = false
          contState.lastInjectedAt = Date.now()
          contState.consecutiveFailures = 0
        } catch {
          contState.inFlight = false
          contState.lastInjectedAt = Date.now()
          contState.consecutiveFailures += 1
        }
      }
    },


    // ════════════════════════════════════════════════════════
    // TOOLS — all 26 plan_* tools
    // ════════════════════════════════════════════════════════

    tool: {

      // ─── Project Level ──────────────────────────────────

      plan_status: tool({
        description:
          "Get current project state: work mode, active task, phase, progress. ALWAYS call at session start or after compaction.",
        args: {},
        async execute(_args, ctx) {
          const err = ensurePlansDir(ctx.directory)
          if (err) return err

          const meta = loadMeta(ctx.directory)
          const overview = readJson<ProjectOverview>(paths.overview(ctx.directory))

          let totalTasks = 0
          let completedTasks = 0
          const phaseList = listDirs(paths.phases(ctx.directory))
          const phaseStatuses: string[] = []

          for (const phase of phaseList) {
            const pMeta = readJson<PhaseMetadata>(paths.phaseMeta(ctx.directory, phase))
            const taskDirs = listDirs(paths.tasks(ctx.directory, phase))
            let phaseDone = 0
            for (const tid of taskDirs) {
              const tMeta = readJson<TaskMetadata>(paths.taskMeta(ctx.directory, phase, tid))
              totalTasks++
              if (tMeta?.status === "completed") { completedTasks++; phaseDone++ }
            }
            phaseStatuses.push(`  ${phase}: ${pMeta?.status ?? "unknown"} (${phaseDone}/${taskDirs.length} tasks)`)
          }

          const decisionCount = listJsonFiles(paths.decisions(ctx.directory)).length

          const findingDirs = listDirs(paths.findings(ctx.directory))
          const openFindings = findingDirs.filter((fid) => {
            const fm = readJson<FindingMetadata>(paths.findingMeta(ctx.directory, fid))
            return fm?.status === "open"
          }).length

          return [
            "# Project Status",
            "",
            `Project: ${meta.name || "(unnamed)"}`,
            `Work mode: ${meta.workMode ? "ACTIVE" : "inactive"}`,
            `Current phase: ${meta.currentPhase || "(none)"}`,
            `Current task: ${meta.currentTask || "(none)"}`,
            `Progress: ${completedTasks}/${totalTasks} tasks completed`,
            "",
            "## Phases",
            phaseStatuses.length ? phaseStatuses.join("\n") : "  (none)",
            "",
            `Decisions: ${decisionCount}`,
            `Open findings: ${openFindings}/${findingDirs.length}`,
            meta.notes.length ? `\nNotes: ${meta.notes.length} saved (last: ${meta.notes.at(-1)?.slice(0, 80)}...)` : "",
            "",
            overview?.goals?.length ? `Goals: ${overview.goals.join(", ")}` : "",
          ].filter(Boolean).join("\n")
        },
      }),

      plan_overview_get: tool({
        description: "Get project overview (goals, tech stack, constraints, out-of-scope).",
        args: {},
        async execute(_args, ctx) {
          const data = readJson<ProjectOverview>(paths.overview(ctx.directory))
          if (!data) return "No overview.json found. Use plan_overview_save to create one."
          return JSON.stringify(data, null, 2)
        },
      }),

      plan_overview_save: tool({
        description: "Save project overview. Provide goals, tech stack, constraints as JSON arrays.",
        args: {
          goals: tool.schema.string().describe('JSON array of goal strings, e.g. ["Build REST API", "Support OAuth2"]'),
          stack: tool.schema.string().describe('JSON array of tech stack items, e.g. ["TypeScript", "PostgreSQL"]'),
          constraints: tool.schema.string().optional().describe('JSON array of constraints'),
          out_of_scope: tool.schema.string().optional().describe('JSON array of out-of-scope items'),
        },
        async execute(args, ctx) {
          try {
            const data: ProjectOverview = {
              goals: JSON.parse(args.goals),
              stack: JSON.parse(args.stack),
              constraints: args.constraints ? JSON.parse(args.constraints) : [],
              outOfScope: args.out_of_scope ? JSON.parse(args.out_of_scope) : [],
            }
            writeJson(paths.overview(ctx.directory), data)
            return `Overview saved: ${data.goals.length} goals, ${data.stack.length} stack items, ${data.constraints.length} constraints`
          } catch {
            return "ERROR: Invalid JSON in one of the parameters."
          }
        },
      }),

      plan_meta_save: tool({
        description: "Save project metadata (name, description). Also used to initialize .plans/.",
        args: {
          name: tool.schema.string().describe("Project name"),
          description: tool.schema.string().describe("One-line project description"),
        },
        async execute(args, ctx) {
          const plansPath = join(ctx.directory, PLANS_DIR)
          if (!existsSync(plansPath)) mkdirSync(plansPath, { recursive: true })
          const meta = loadMeta(ctx.directory)
          meta.name = args.name
          meta.description = args.description
          saveMeta(ctx.directory, meta)
          return `Project initialized: "${args.name}" — ${args.description}`
        },
      }),

      plan_init: tool({
        description: "Initialize .plans/ directory structure. Creates metadata.json. Run this once to start a new project plan.",
        args: {
          name: tool.schema.string().describe("Project name"),
          description: tool.schema.string().describe("One-line description"),
        },
        async execute(args, ctx) {
          const plansPath = join(ctx.directory, PLANS_DIR)
          if (existsSync(paths.metadata(ctx.directory))) {
            return `Already initialized. metadata.json exists at ${paths.metadata(ctx.directory)}`
          }
          mkdirSync(plansPath, { recursive: true })
          mkdirSync(join(plansPath, "phases"), { recursive: true })
          mkdirSync(join(plansPath, "decisions"), { recursive: true })

          const meta: ProjectMetadata = {
            ...DEFAULT_METADATA,
            name: args.name,
            description: args.description,
          }
          saveMeta(ctx.directory, meta)

          return [
            `Initialized .plans/ for "${args.name}"`,
            "",
            "Created:",
            "  .plans/metadata.json",
            "  .plans/phases/",
            "  .plans/decisions/",
            "",
            "Next steps:",
            "1. plan_overview_save — set goals, stack, constraints",
            "2. plan_decision_save — record design decisions",
            "3. plan_phase_save — create phases",
            "4. plan_task_save — create tasks within phases",
            "5. plan_req_save — add requirements to tasks",
          ].join("\n")
        },
      }),

      // ─── Decisions ──────────────────────────────────────

      plan_decision_list: tool({
        description: "List all design decisions. Returns only IDs and titles — low context cost.",
        args: {},
        async execute(_args, ctx) {
          const dir = paths.decisions(ctx.directory)
          const files = listJsonFiles(dir)
          if (files.length === 0) return "No decisions found."
          const rows = files.map((f) => {
            const d = readJson<Decision>(join(dir, f))
            return d ? `  ${d.id.padEnd(8)} ${d.title.padEnd(50)} ${d.status}` : `  ${f} (unreadable)`
          })
          return ["# Design Decisions", "", "  ID       Title                                              Status", "  ────────────────────────────────────────────────────────────────", ...rows].join("\n")
        },
      }),

      plan_decision_get: tool({
        description: "Read a single design decision by ID. Returns full detail.",
        args: { id: tool.schema.string().describe('Decision ID (e.g. "D-001")') },
        async execute(args, ctx) {
          const data = readJson<Decision>(paths.decision(ctx.directory, args.id))
          if (!data) return `Decision not found: ${args.id}`
          return JSON.stringify(data, null, 2)
        },
      }),

      plan_decision_save: tool({
        description: "Save a design decision. Provide ID, title, rationale, and the constraint it imposes.",
        args: {
          id: tool.schema.string().describe('Decision ID (e.g. "D-001")'),
          title: tool.schema.string().describe("Short title"),
          rationale: tool.schema.string().describe("Why this decision was made"),
          constraint: tool.schema.string().describe("What this decision constrains/requires in code"),
          status: tool.schema.string().optional().describe('"active" or "superseded" (default: active)'),
        },
        async execute(args, ctx) {
          const data: Decision = {
            id: args.id,
            title: args.title,
            rationale: args.rationale,
            constraint: args.constraint,
            status: (args.status as Decision["status"]) || "active",
          }
          writeJson(paths.decision(ctx.directory, args.id), data)
          return `Decision saved: ${args.id} — ${args.title}`
        },
      }),


      // ─── Phases ─────────────────────────────────────────

      plan_phase_list: tool({
        description: "List all phases with status and task counts. Low context cost.",
        args: {},
        async execute(_args, ctx) {
          const phaseNames = listDirs(paths.phases(ctx.directory))
          if (phaseNames.length === 0) return "No phases found. Use plan_phase_save to create one."
          const rows = phaseNames.map((name) => {
            const pm = readJson<PhaseMetadata>(paths.phaseMeta(ctx.directory, name))
            const taskCount = listDirs(paths.tasks(ctx.directory, name)).length
            return `  ${name.padEnd(16)} ${(pm?.status ?? "?").padEnd(14)} ${String(taskCount).padEnd(6)} ${pm?.description ?? ""}`
          })
          return ["# Phases", "", "  Name             Status         Tasks  Description", "  ──────────────────────────────────────────────────────────────", ...rows].join("\n")
        },
      }),

      plan_phase_get: tool({
        description: "Read phase metadata (description, status, tracks, dependencies). Does NOT load tasks.",
        args: { phase: tool.schema.string().describe("Phase name") },
        async execute(args, ctx) {
          const data = readJson<PhaseMetadata>(paths.phaseMeta(ctx.directory, args.phase))
          if (!data) return `Phase not found: ${args.phase}`
          return JSON.stringify(data, null, 2)
        },
      }),

      plan_phase_save: tool({
        description: "Create or update a phase. Does not create tasks — use plan_task_save for that.",
        args: {
          name: tool.schema.string().describe('Phase name (e.g. "mvp", "phase1")'),
          description: tool.schema.string().describe("Phase description"),
          status: tool.schema.string().optional().describe('"planning" | "in_progress" | "completed" | "blocked" (default: planning)'),
          tracks: tool.schema.string().optional().describe('JSON array of track names, e.g. ["A", "B"]'),
          depends_on: tool.schema.string().optional().describe('JSON array of phase names this depends on'),
        },
        async execute(args, ctx) {
          const data: PhaseMetadata = {
            name: args.name,
            description: args.description,
            status: (args.status as PhaseMetadata["status"]) || "planning",
            tracks: args.tracks ? JSON.parse(args.tracks) : [],
            dependsOn: args.depends_on ? JSON.parse(args.depends_on) : [],
          }
          writeJson(paths.phaseMeta(ctx.directory, args.name), data)
          return `Phase saved: ${args.name} — ${args.description}`
        },
      }),

      // ─── Tasks ──────────────────────────────────────────

      plan_task_list: tool({
        description: "List tasks in a phase. Returns IDs, titles, and status only. Low context cost. Omit phase to list all.",
        args: {
          phase: tool.schema.string().optional().describe("Phase name. Omit to list all phases."),
        },
        async execute(args, ctx) {
          const phasesToScan = args.phase
            ? [args.phase]
            : listDirs(paths.phases(ctx.directory))

          if (phasesToScan.length === 0) return "No phases found."

          const rows: string[] = []
          for (const phase of phasesToScan) {
            const taskDirs = listDirs(paths.tasks(ctx.directory, phase))
            for (const tid of taskDirs) {
              const tm = readJson<TaskMetadata>(paths.taskMeta(ctx.directory, phase, tid))
              if (tm) {
                rows.push(`  ${tm.id.padEnd(14)} ${tm.status.padEnd(14)} ${tm.track.padEnd(6)} ${tm.title}`)
              } else {
                rows.push(`  ${tid.padEnd(14)} (metadata missing)`)
              }
            }
          }

          if (rows.length === 0) return `No tasks found${args.phase ? ` in phase "${args.phase}"` : ""}.`
          return ["# Tasks", "", "  ID             Status         Track  Title", "  ──────────────────────────────────────────────────────────────", ...rows].join("\n")
        },
      }),

      plan_task_get: tool({
        description: "Read a single task by ID. Returns metadata, all requirements, and test specs. Phase auto-detected if omitted.",
        args: {
          id: tool.schema.string().describe('Task ID (e.g. "MVP-A-01")'),
          phase: tool.schema.string().optional().describe("Phase name (auto-detected if omitted)"),
        },
        async execute(args, ctx) {
          const phase = args.phase ?? findTaskPhase(ctx.directory, args.id)
          if (!phase) return `Task not found: ${args.id} (searched all phases)`

          const taskDir = paths.task(ctx.directory, phase, args.id)
          const meta = readJson<TaskMetadata>(paths.taskMeta(ctx.directory, phase, args.id))
          if (!meta) return `Task metadata not found: ${args.id}`

          const files = listJsonFiles(taskDir).filter((f) => f !== "metadata.json")
          const reqs: Requirement[] = []
          const tests: TestSpec[] = []
          for (const f of files) {
            const data = readJson<Requirement | TestSpec>(join(taskDir, f))
            if (!data) continue
            if (f.startsWith("req-")) reqs.push(data as Requirement)
            else if (f.startsWith("test-")) tests.push(data as TestSpec)
          }

          return JSON.stringify({ metadata: meta, requirements: reqs, tests }, null, 2)
        },
      }),

      plan_task_save: tool({
        description: "Create or update a task. Saves only metadata. Use plan_req_save and plan_test_save for requirements and tests.",
        args: {
          id: tool.schema.string().describe('Task ID (e.g. "MVP-A-01")'),
          phase: tool.schema.string().describe("Phase this task belongs to"),
          title: tool.schema.string().describe("Task title"),
          description: tool.schema.string().describe("What to implement"),
          track: tool.schema.string().optional().describe('Track letter (e.g. "A", "B"). Default "A"'),
          files: tool.schema.string().optional().describe('JSON array of files to create/modify'),
          depends_on: tool.schema.string().optional().describe('JSON array of task IDs this depends on'),
          status: tool.schema.string().optional().describe('"pending" | "in_progress" | "completed" | "blocked"'),
        },
        async execute(args, ctx) {
          const data: TaskMetadata = {
            id: args.id,
            title: args.title,
            description: args.description,
            status: (args.status as TaskMetadata["status"]) || "pending",
            track: args.track || "A",
            phase: args.phase,
            files: args.files ? JSON.parse(args.files) : [],
            dependsOn: args.depends_on ? JSON.parse(args.depends_on) : [],
          }
          writeJson(paths.taskMeta(ctx.directory, args.phase, args.id), data)
          return `Task saved: ${args.id} — ${args.title} (phase: ${args.phase}, track: ${data.track})`
        },
      }),

      plan_task_set: tool({
        description: "Set the current active task and phase. Persists across compaction. Call before starting work on a task.",
        args: {
          id: tool.schema.string().describe('Task ID (e.g. "MVP-A-01")'),
          phase: tool.schema.string().optional().describe("Phase (auto-detected if omitted)"),
        },
        async execute(args, ctx) {
          const phase = args.phase ?? findTaskPhase(ctx.directory, args.id)
          if (!phase) return `Task not found: ${args.id}`

          const meta = loadMeta(ctx.directory)
          meta.currentTask = args.id
          meta.currentPhase = phase

          const tm = readJson<TaskMetadata>(paths.taskMeta(ctx.directory, phase, args.id))
          if (tm && tm.status === "pending") {
            tm.status = "in_progress"
            writeJson(paths.taskMeta(ctx.directory, phase, args.id), tm)
          }

          saveMeta(ctx.directory, meta)
          return `Active task: ${args.id} (phase: ${phase})\nCall plan_task_get("${args.id}") to read the full task spec.\nCall plan_task_done("${args.id}") when complete.`
        },
      }),

      plan_task_done: tool({
        description: "Mark a task as completed. Updates task status and session state. Call IMMEDIATELY after finishing.",
        args: {
          id: tool.schema.string().describe("Task ID that was completed"),
        },
        async execute(args, ctx) {
          const phase = findTaskPhase(ctx.directory, args.id)
          if (!phase) return `Task not found: ${args.id}`

          const tm = readJson<TaskMetadata>(paths.taskMeta(ctx.directory, phase, args.id))
          if (tm) {
            tm.status = "completed"
            writeJson(paths.taskMeta(ctx.directory, phase, args.id), tm)
          }

          const meta = loadMeta(ctx.directory)
          if (!meta.completedTasks.includes(args.id)) meta.completedTasks.push(args.id)
          meta.currentTask = ""
          saveMeta(ctx.directory, meta)

          const taskDirs = listDirs(paths.tasks(ctx.directory, phase))
          const remaining = taskDirs.filter((tid) => {
            const t = readJson<TaskMetadata>(paths.taskMeta(ctx.directory, phase, tid))
            return t && t.status !== "completed"
          }).length

          return [
            `Completed: ${args.id}`,
            `Phase "${phase}": ${remaining} tasks remaining`,
            `Total completed: ${meta.completedTasks.length}`,
            "",
            remaining > 0
              ? "NEXT: Call plan_task_next to see parallelizable tasks."
              : `Phase "${phase}" is DONE. Check plan_phase_list for the next phase.`,
          ].join("\n")
        },
      }),

      plan_task_next: tool({
        description:
          "Find all tasks ready to start NOW (dependencies met, status pending). If multiple returned, they can be worked on IN PARALLEL — delegate each to a @general subagent.",
        args: {
          phase: tool.schema.string().optional().describe("Phase to check. Omit to scan all phases."),
        },
        async execute(args, ctx) {
          const phasesToScan = args.phase
            ? [args.phase]
            : listDirs(paths.phases(ctx.directory))

          if (phasesToScan.length === 0) return "No phases found."

          const allTasks = new Map<string, TaskMetadata>()
          for (const phase of phasesToScan) {
            const taskDirs = listDirs(paths.tasks(ctx.directory, phase))
            for (const tid of taskDirs) {
              const tm = readJson<TaskMetadata>(paths.taskMeta(ctx.directory, phase, tid))
              if (tm) allTasks.set(tm.id, tm)
            }
          }

          const completedIds = new Set<string>()
          for (const [id, tm] of allTasks) {
            if (tm.status === "completed") completedIds.add(id)
          }

          const ready: TaskMetadata[] = []
          const blocked: Array<{ task: TaskMetadata; waitingOn: string[] }> = []

          for (const [, tm] of allTasks) {
            if (tm.status !== "pending") continue
            const unmetDeps = tm.dependsOn.filter((dep) => !completedIds.has(dep))
            if (unmetDeps.length === 0) {
              ready.push(tm)
            } else {
              blocked.push({ task: tm, waitingOn: unmetDeps })
            }
          }

          const inProgress: TaskMetadata[] = []
          for (const [, tm] of allTasks) {
            if (tm.status === "in_progress") inProgress.push(tm)
          }

          if (ready.length === 0 && inProgress.length === 0) {
            if (blocked.length > 0) {
              const blockedRows = blocked.slice(0, 5).map((b) =>
                `  ${b.task.id.padEnd(14)} waiting on: ${b.waitingOn.join(", ")}`,
              )
              return ["No tasks ready. Blocked tasks:", "", ...blockedRows].join("\n")
            }
            return "No pending tasks found. Phase may be complete."
          }

          const parallel = ready.length > 1
          const sections: string[] = []

          if (ready.length > 0) {
            sections.push(
              parallel
                ? `## ${ready.length} tasks ready — PARALLEL EXECUTION POSSIBLE`
                : `## 1 task ready`,
              "",
              ...ready.map((tm) =>
                `  ${tm.id.padEnd(14)} ${tm.track.padEnd(6)} ${tm.phase.padEnd(12)} ${tm.title}`,
              ),
            )

            if (parallel) {
              sections.push(
                "",
                "### Delegation Instructions",
                `Delegate each task to a @general subagent in parallel:`,
                "",
                ...ready.map((tm) =>
                  `  @general → plan_task_set("${tm.id}") → plan_task_get("${tm.id}") → implement → plan_task_done("${tm.id}")`,
                ),
              )
            }
          }

          if (inProgress.length > 0) {
            sections.push(
              "",
              `## ${inProgress.length} tasks in progress`,
              "",
              ...inProgress.map((tm) =>
                `  ${tm.id.padEnd(14)} ${tm.track.padEnd(6)} ${tm.phase.padEnd(12)} ${tm.title}`,
              ),
            )
          }

          if (blocked.length > 0) {
            sections.push(
              "",
              `## ${blocked.length} tasks blocked`,
              "",
              ...blocked.slice(0, 10).map((b) =>
                `  ${b.task.id.padEnd(14)} waiting on: ${b.waitingOn.join(", ")}`,
              ),
            )
          }

          return sections.join("\n")
        },
      }),


      // ─── Requirements & Tests ───────────────────────────

      plan_req_save: tool({
        description: "Save a requirement (acceptance criterion) within a task. Each requirement is a separate JSON file.",
        args: {
          task_id: tool.schema.string().describe('Task ID (e.g. "MVP-A-01")'),
          phase: tool.schema.string().describe("Phase name"),
          req_id: tool.schema.string().describe('Requirement ID (e.g. "req-001")'),
          description: tool.schema.string().describe("What must be true for this requirement to pass"),
          done: tool.schema.string().optional().describe('"true" or "false" (default: false)'),
        },
        async execute(args, ctx) {
          const data: Requirement = {
            id: args.req_id,
            description: args.description,
            done: args.done === "true",
          }
          const filepath = join(paths.task(ctx.directory, args.phase, args.task_id), `${args.req_id}.json`)
          writeJson(filepath, data)
          return `Requirement saved: ${args.task_id}/${args.req_id}`
        },
      }),

      plan_test_save: tool({
        description: "Save a test specification within a task. Each test is a separate JSON file.",
        args: {
          task_id: tool.schema.string().describe('Task ID (e.g. "MVP-A-01")'),
          phase: tool.schema.string().describe("Phase name"),
          test_id: tool.schema.string().describe('Test ID (e.g. "test-001")'),
          description: tool.schema.string().describe("What the test should verify"),
          done: tool.schema.string().optional().describe('"true" or "false" (default: false)'),
        },
        async execute(args, ctx) {
          const data: TestSpec = {
            id: args.test_id,
            description: args.description,
            done: args.done === "true",
          }
          const filepath = join(paths.task(ctx.directory, args.phase, args.task_id), `${args.test_id}.json`)
          writeJson(filepath, data)
          return `Test spec saved: ${args.task_id}/${args.test_id}`
        },
      }),

      plan_req_done: tool({
        description: "Mark a requirement as done within a task.",
        args: {
          task_id: tool.schema.string().describe("Task ID"),
          phase: tool.schema.string().describe("Phase name"),
          req_id: tool.schema.string().describe("Requirement ID"),
        },
        async execute(args, ctx) {
          const filepath = join(paths.task(ctx.directory, args.phase, args.task_id), `${args.req_id}.json`)
          const data = readJson<Requirement>(filepath)
          if (!data) return `Requirement not found: ${args.task_id}/${args.req_id}`
          data.done = true
          writeJson(filepath, data)
          return `Requirement done: ${args.task_id}/${args.req_id}`
        },
      }),

      // ─── Findings (Verify) ─────────────────────────────

      plan_finding_list: tool({
        description: "List all verify findings. Returns IDs, severity, status, fix target. Low context cost.",
        args: {
          status_filter: tool.schema.string().optional().describe('"open", "accepted", or "rejected". Omit for all.'),
          fix_target: tool.schema.string().optional().describe('"plan" or "code". Omit for all.'),
        },
        async execute(args, ctx) {
          const findingIds = listDirs(paths.findings(ctx.directory))
          if (findingIds.length === 0) return "No findings."

          const rows: string[] = []
          for (const fid of findingIds) {
            const fm = readJson<FindingMetadata>(paths.findingMeta(ctx.directory, fid))
            if (!fm) continue
            if (args.status_filter && fm.status !== args.status_filter) continue
            if (args.fix_target && fm.fixTarget !== args.fix_target) continue
            rows.push(`  ${fm.id.padEnd(14)} ${fm.severity.padEnd(12)} ${fm.status.padEnd(12)} ${fm.fixTarget.padEnd(6)} ${fm.title}`)
          }

          if (rows.length === 0) return "No findings match the filter."
          return ["# Findings", "", "  ID             Severity     Status       Target Title", "  ──────────────────────────────────────────────────────────────────", ...rows].join("\n")
        },
      }),

      plan_finding_get: tool({
        description: "Read a single verify finding by ID. Returns metadata, expected, actual, impact, and resolution.",
        args: { id: tool.schema.string().describe('Finding ID (e.g. "V-MVP-001")') },
        async execute(args, ctx) {
          const findingDir = paths.finding(ctx.directory, args.id)
          if (!existsSync(findingDir)) return `Finding not found: ${args.id}`

          const meta = readJson<FindingMetadata>(paths.findingMeta(ctx.directory, args.id))
          const expected = readJson<unknown>(join(findingDir, "expected.json"))
          const actual = readJson<unknown>(join(findingDir, "actual.json"))
          const impact = readJson<unknown>(join(findingDir, "impact.json"))
          const resolution = readJson<FindingResolution>(join(findingDir, "resolution.json"))

          return JSON.stringify({ metadata: meta, expected, actual, impact, resolution: resolution ?? null }, null, 2)
        },
      }),

      plan_finding_save: tool({
        description: "Save a verify finding. Creates finding folder with metadata, expected, actual, impact files.",
        args: {
          id: tool.schema.string().describe('Finding ID (e.g. "V-MVP-001")'),
          severity: tool.schema.string().describe('"critical" | "major" | "minor" | "suggestion"'),
          title: tool.schema.string().describe("Short finding title"),
          fix_target: tool.schema.string().describe('"plan" or "code"'),
          location: tool.schema.string().describe("File and line (e.g. src/api.ts:45)"),
          plan_ref: tool.schema.string().describe("Plan reference (e.g. MVP-A-01, req-002)"),
          expected: tool.schema.string().describe("What the plan/spec says should happen"),
          actual: tool.schema.string().describe("What the code actually does"),
          impact: tool.schema.string().describe("What breaks or what risk this creates"),
        },
        async execute(args, ctx) {
          const findingDir = paths.finding(ctx.directory, args.id)

          const meta: FindingMetadata = {
            id: args.id,
            severity: args.severity as FindingMetadata["severity"],
            title: args.title,
            status: "open",
            fixTarget: args.fix_target as FindingMetadata["fixTarget"],
            location: args.location,
            planRef: args.plan_ref,
          }

          writeJson(paths.findingMeta(ctx.directory, args.id), meta)
          writeJson(join(findingDir, "expected.json"), { planRef: args.plan_ref, description: args.expected })
          writeJson(join(findingDir, "actual.json"), { description: args.actual })
          writeJson(join(findingDir, "impact.json"), { description: args.impact })

          updateReportsMeta(ctx.directory)

          return `Finding saved: ${args.id} | ${args.severity} | target: ${args.fix_target} — ${args.title}`
        },
      }),

      plan_finding_resolve: tool({
        description:
          'Resolve a verify finding. "accepted" = valid, fixed. "rejected" = dismissed. Always provide a reason.',
        args: {
          id: tool.schema.string().describe("Finding ID"),
          disposition: tool.schema.string().describe('"accepted" or "rejected"'),
          reason: tool.schema.string().describe("Why this disposition was chosen"),
          action: tool.schema.string().optional().describe("What was changed (for accepted findings)"),
          resolved_by: tool.schema.string().optional().describe('"plan", "implement", or "user"'),
        },
        async execute(args, ctx) {
          const fm = readJson<FindingMetadata>(paths.findingMeta(ctx.directory, args.id))
          if (!fm) return `Finding not found: ${args.id}`

          const disposition = args.disposition as "accepted" | "rejected"
          if (disposition !== "accepted" && disposition !== "rejected") {
            return `Invalid disposition: "${args.disposition}". Must be "accepted" or "rejected".`
          }

          fm.status = disposition
          writeJson(paths.findingMeta(ctx.directory, args.id), fm)

          const resolution: FindingResolution = {
            disposition,
            reason: args.reason,
            resolvedBy: (args.resolved_by as FindingResolution["resolvedBy"]) || (fm.fixTarget === "plan" ? "plan" : "implement"),
            resolvedAt: new Date().toISOString(),
            action: args.action || "",
          }
          writeJson(join(paths.finding(ctx.directory, args.id), "resolution.json"), resolution)

          updateReportsMeta(ctx.directory)

          const reportsMeta = readJson<ReportsMetadata>(paths.reportsMeta(ctx.directory))

          return [
            `Finding ${args.id}: ${disposition.toUpperCase()}`,
            `Reason: ${args.reason}`,
            args.action ? `Action: ${args.action}` : "",
            `Resolved by: ${resolution.resolvedBy}`,
            "",
            `Remaining: ${reportsMeta?.open ?? "?"} open, ${reportsMeta?.accepted ?? "?"} accepted, ${reportsMeta?.rejected ?? "?"} rejected`,
          ].filter(Boolean).join("\n")
        },
      }),

      // ─── Session ────────────────────────────────────────

      plan_note: tool({
        description: "Save a note to persistent state. Survives compaction.",
        args: {
          text: tool.schema.string().describe("Note text"),
        },
        async execute(args, ctx) {
          const meta = loadMeta(ctx.directory)
          meta.notes.push(`[${new Date().toISOString()}] ${args.text}`)
          if (meta.notes.length > 50) meta.notes = meta.notes.slice(-50)
          saveMeta(ctx.directory, meta)
          return `Note saved (${meta.notes.length} total).`
        },
      }),

      plan_work_start: tool({
        description: "Activate work mode for a phase. Sets work mode ON and current phase. Returns a briefing.",
        args: {
          phase: tool.schema.string().describe("Phase to start working on"),
        },
        async execute(args, ctx) {
          const err = ensurePlansDir(ctx.directory)
          if (err) return err

          const phase = args.phase.toLowerCase()
          const pm = readJson<PhaseMetadata>(paths.phaseMeta(ctx.directory, phase))
          if (!pm) return `Phase not found: ${phase}. Use plan_phase_list to see available phases.`

          const meta = loadMeta(ctx.directory)
          meta.workMode = true
          meta.currentPhase = phase
          saveMeta(ctx.directory, meta)

          if (pm.status === "planning") {
            pm.status = "in_progress"
            writeJson(paths.phaseMeta(ctx.directory, phase), pm)
          }

          const taskDirs = listDirs(paths.tasks(ctx.directory, phase))
          const taskRows: string[] = []
          for (const tid of taskDirs) {
            const tm = readJson<TaskMetadata>(paths.taskMeta(ctx.directory, phase, tid))
            if (tm) taskRows.push(`  ${tm.id.padEnd(14)} ${tm.status.padEnd(14)} ${tm.title}`)
          }

          const decFiles = listJsonFiles(paths.decisions(ctx.directory))
          const activeDecisions = decFiles
            .map((f) => readJson<Decision>(join(paths.decisions(ctx.directory), f)))
            .filter((d): d is Decision => d !== null && d.status === "active")
            .map((d) => `  ${d.id}: ${d.constraint}`)

          return [
            "═══════════════════════════════════════════════════════════",
            " WORK MODE ACTIVATED",
            `  Phase: ${phase} — ${pm.description}`,
            `  Time: ${new Date().toISOString()}`,
            "═══════════════════════════════════════════════════════════",
            "",
            "## Tasks",
            taskRows.length ? taskRows.join("\n") : "  (no tasks — check plan_task_list)",
            "",
            activeDecisions.length ? `## Active Constraints (${activeDecisions.length})\n${activeDecisions.join("\n")}` : "",
            "",
            "## Workflow",
            "1. Call plan_task_list to see all tasks",
            "2. Call plan_task_set(id) to pick the first pending task",
            "3. Call plan_task_get(id) to read the full task spec",
            "4. Implement EXACTLY as specified",
            "5. Call plan_req_done for each requirement as you complete it",
            "6. Call plan_task_done(id) when all requirements pass",
            "7. Repeat until phase is done",
            "",
            "═══════════════════════════════════════════════════════════",
          ].filter(Boolean).join("\n")
        },
      }),

    }, // end tool: {}
  } // end return
} // end plugin function

export default BlueprintPlugin
