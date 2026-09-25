import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import test from "node:test"

test("serves a scoped PWA and proxies API requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nerds-opencode-test-"))
  const backend = createServer((request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ path: request.url }))
  })
  backend.listen(0, "127.0.0.1")
  await once(backend, "listening")
  await mkdir(join(directory, "assets"))
  await writeFile(join(directory, "build.json"), JSON.stringify({ base: "/dev/opencode/", uiVersion: "test" }))
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Test UI</title>")
  await writeFile(join(directory, "assets/app.js"), "export default 1")
  const child = spawn(process.execPath, ["src/serve.mjs", "serve", "--port", "0", "--ui-dir", directory, "--backend-url", `http://127.0.0.1:${backend.address().port}`], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
  })
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = ""
      child.once("error", reject)
      child.stdout.on("data", (chunk) => {
        output += chunk
        const match = /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
        if (match) resolve(match[1])
      })
      child.once("exit", () => reject(new Error("Service exited before listening")))
    })
    const page = await fetch(`${origin}/dev/opencode/session/example`, { headers: { accept: "text/html" } })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Test UI/)
    assert.equal((await fetch(`${origin}/dev/opencode/session/example`, { method: "HEAD" })).status, 200)
    const asset = await fetch(`${origin}/dev/opencode/assets/app.js`)
    assert.equal(await asset.text(), "export default 1")
    const manifest = await fetch(`${origin}/dev/opencode/manifest.json`).then((response) => response.json())
    assert.equal(manifest.id, "/dev/opencode/")
    assert.equal(manifest.start_url, "/dev/opencode/")
    assert.equal(manifest.scope, "/dev/opencode/")
    const api = await fetch(`${origin}/dev/opencode/__api/api/health?check=1`).then((response) => response.json())
    assert.equal(api.path, "/api/health?check=1")
    assert.equal((await fetch(`${origin}/api/health`)).status, 404)
    assert.equal((await fetch(`${origin}/dev/opencode/assets/missing.js`)).status, 404)
  } finally {
    child.kill()
    backend.closeAllConnections()
    backend.close()
    await rm(directory, { recursive: true, force: true })
  }
})
