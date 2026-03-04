#!/usr/bin/env node
/**
 * @mingeon/opencode-blueprint init
 *
 * Copies agent and command markdown files into the user's project .opencode/ directory
 * and registers the plugin in opencode.json.
 *
 * Usage:
 *   npx @mingeon/opencode-blueprint init
 *   bunx @mingeon/opencode-blueprint init
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from "fs"
import { join, dirname, resolve } from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PKG_ROOT = resolve(__dirname, "..")
const PLUGIN_NAME = "@mingeon/opencode-blueprint"

const cwd = process.cwd()

function log(msg) { console.log(`  ${msg}`) }
function warn(msg) { console.warn(`  ⚠ ${msg}`) }
function ok(msg) { console.log(`  ✓ ${msg}`) }

function copyDir(srcDir, destDir, label) {
  if (!existsSync(srcDir)) {
    warn(`Source not found: ${srcDir}`)
    return 0
  }
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })

  const files = readdirSync(srcDir).filter(f => f.endsWith(".md"))
  let copied = 0
  for (const file of files) {
    const dest = join(destDir, file)
    if (existsSync(dest)) {
      warn(`${label}/${file} already exists — skipping (delete to overwrite)`)
      continue
    }
    copyFileSync(join(srcDir, file), dest)
    ok(`${label}/${file}`)
    copied++
  }
  return copied
}

function registerPlugin(configPath) {
  let config = {}
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"))
    } catch {
      warn(`Could not parse ${configPath} — creating fresh`)
      config = {}
    }
  }

  if (!Array.isArray(config.plugin)) config.plugin = []

  if (config.plugin.includes(PLUGIN_NAME)) {
    log(`Plugin already registered in opencode.json`)
    return false
  }

  config.plugin.push(PLUGIN_NAME)

  // Ensure $schema is present
  if (!config.$schema) config.$schema = "https://opencode.ai/config.json"

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
  ok(`Registered "${PLUGIN_NAME}" in opencode.json`)
  return true
}

function main() {
  const command = process.argv[2]

  if (command !== "init") {
    console.log(`
  @mingeon/opencode-blueprint

  Usage:
    npx @mingeon/opencode-blueprint init    Set up blueprint in current project

  This copies agent and command files to .opencode/ and registers
  the plugin in opencode.json.
`)
    process.exit(command === "--help" || command === "-h" ? 0 : 1)
  }

  console.log(`\n  @mingeon/opencode-blueprint — init\n`)

  // 1. Copy agents
  const agentsSrc = join(PKG_ROOT, ".opencode", "agents")
  const agentsDest = join(cwd, ".opencode", "agents")
  log("Copying agents...")
  const agentsCopied = copyDir(agentsSrc, agentsDest, "agents")

  // 2. Copy commands
  const cmdsSrc = join(PKG_ROOT, ".opencode", "commands")
  const cmdsDest = join(cwd, ".opencode", "commands")
  log("Copying commands...")
  const cmdsCopied = copyDir(cmdsSrc, cmdsDest, "commands")

  // 3. Register plugin in opencode.json
  log("Registering plugin...")
  const configPath = join(cwd, "opencode.json")
  registerPlugin(configPath)

  // Summary
  console.log(`
  Done! ${agentsCopied + cmdsCopied} files copied.

  Agents:  plan (Mira Chen), implement (Daniel Kessler), verify (Gene Hartley)
  Commands: /start-work, /fix-plan
  Tools:   26 plan_* tools (loaded via plugin)

  Next steps:
    1. Start opencode
    2. Tab → Plan agent → describe your project
    3. /start-work <phase> → implementation begins
`)
}

main()
