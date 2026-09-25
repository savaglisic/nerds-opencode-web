#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const project = resolve(fileURLToPath(new URL("..", import.meta.url)))
const source = resolve(process.env.OPENCODE_SOURCE ?? join(project, "../opencode"))
const base = process.env.OPENCODE_WEB_BASE ?? "/dev/opencode/"
if (!base.startsWith("/") || !base.endsWith("/") || base.includes("..") || base.includes("?"))
  throw new Error("OPENCODE_WEB_BASE must be an absolute path ending in /, such as /dev/opencode/")

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" })
if (revision.status !== 0) throw new Error(`Cannot read OpenCode source at ${source}`)
const directory = await mkdtemp(join(tmpdir(), "nerds-opencode-web-"))
try {
  run("git", ["clone", "--quiet", "--shared", source, directory])
  run("git", ["checkout", "--quiet", revision.stdout.trim()], { cwd: directory })
  run("git", ["apply", join(project, "patches/web-base-path.patch")], { cwd: directory })

  // The upstream app refers to these public assets, but keeps their source in packages/ui.
  await cp(join(directory, "packages/ui/src/assets/favicon"), join(directory, "packages/app/public"), {
    recursive: true,
  })
  run("bun", ["install", "--frozen-lockfile"], { cwd: directory })
  run("bun", ["typecheck"], { cwd: join(directory, "packages/app") })
  run("bun", ["run", "--cwd", "packages/app", "build"], {
    cwd: directory,
    env: { ...process.env, OPENCODE_WEB_BASE: base },
  })

  await rm(join(project, "dist"), { recursive: true, force: true })
  await mkdir(join(project, "dist"), { recursive: true })
  await cp(join(directory, "packages/app/dist"), join(project, "dist"), { recursive: true })
  const packageInfo = JSON.parse(await readFile(join(directory, "packages/app/package.json"), "utf8"))
  await writeFile(
    join(project, "dist/build.json"),
    JSON.stringify({ base, opencodeSource: revision.stdout.trim(), uiVersion: packageInfo.version }) + "\n",
  )
  console.log(`Built nerds-opencode-web ${packageInfo.version} for ${base}`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
