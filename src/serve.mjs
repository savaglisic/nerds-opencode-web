#!/usr/bin/env node

import { spawn } from "node:child_process"
import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { createServer as createHttpServer, request as httpRequest } from "node:http"
import { connect, createServer as createNetServer } from "node:net"
import { basename, extname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const project = resolve(fileURLToPath(new URL("..", import.meta.url)))
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

const args = process.argv.slice(2)
if (args[0] === "serve") args.shift()
if (args.includes("--help") || args.includes("-h")) {
  console.log(`nerds-opencode-web serve [options]

  --host HOST          Listener address (default: 127.0.0.1)
  --port PORT          Listener port (default: 3000)
  --opencode PATH      Installed CLI executable (default: opencode)
  --ui-dir PATH        Built UI directory (default: ./dist)
  --backend-url URL    Connect to an existing OpenCode server instead of launching one`)
  process.exit(0)
}

const option = (name, fallback) => {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  if (!args[index + 1]) throw new Error(`Missing value for ${name}`)
  return args[index + 1]
}
const known = new Set(["--host", "--port", "--opencode", "--ui-dir", "--backend-url"])
if (args.some((arg, index) => arg.startsWith("-") && !known.has(arg)) || args.some((arg, index) => known.has(args[index - 1]) === false && !arg.startsWith("-")))
  throw new Error("Unknown argument. Run nerds-opencode-web serve --help")

const uiDir = resolve(option("--ui-dir", join(project, "dist")))
const build = JSON.parse(await readFile(join(uiDir, "build.json"), "utf8"))
const base = build.base
if (typeof base !== "string" || !base.startsWith("/") || !base.endsWith("/"))
  throw new Error("Invalid base in UI build metadata")
const host = option("--host", "127.0.0.1")
const port = Number(option("--port", "3000"))
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid --port")
const binary = option("--opencode", "opencode")
const attached = option("--backend-url", undefined)
let backend = attached ? new URL(attached) : undefined
if (backend && (backend.protocol !== "http:" || backend.pathname !== "/"))
  throw new Error("--backend-url must be an HTTP origin, such as http://127.0.0.1:4096")
let child
let stopping = false

const freePort = () =>
  new Promise((done, fail) => {
    const listener = createNetServer()
    listener.once("error", fail)
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address()
      listener.close(() => done(address.port))
    })
  })

async function startBackend() {
  if (stopping || attached) return
  const backendPort = await freePort()
  const target = new URL(`http://127.0.0.1:${backendPort}`)
  const next = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(backendPort)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  })
  child = next
  next.stdout.pipe(process.stdout)
  next.stderr.pipe(process.stderr)
  next.once("error", (error) => console.error(`OpenCode failed to start: ${error.message}`))
  next.once("exit", (code, signal) => {
    if (child !== next) return
    child = undefined
    backend = undefined
    if (stopping) return
    console.error(`OpenCode exited (${signal ?? code}); restarting`)
    setTimeout(() => void startBackend().catch(console.error), 1000)
  })
  for (let attempt = 0; attempt < 100 && !stopping && child === next; attempt++) {
    const response = await fetch(new URL("/global/health", target), {
      signal: AbortSignal.timeout(1000),
      headers: process.env.OPENCODE_SERVER_PASSWORD
        ? {
            authorization: `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
          }
        : undefined,
    }).catch(() => undefined)
    if (response?.ok) {
      backend = target
      const health = await response.json().catch(() => undefined)
      if (health?.version && health.version !== build.uiVersion)
        console.warn(`UI ${build.uiVersion} / installed OpenCode ${health.version}: verify API compatibility`)
      console.log(`OpenCode backend ready at ${target}`)
      return
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  if (child === next && !stopping) next.kill()
}

function proxyPath(pathname, search) {
  if (!pathname.startsWith(`${base}__api/`)) return
  return pathname.slice((base + "__api").length) + search
}

function proxy(req, res, path) {
  if (!backend) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "retry-after": "1" })
    res.end("OpenCode backend is starting")
    return
  }
  const upstream = httpRequest(new URL(path, backend), {
    method: req.method,
    headers: { ...req.headers, host: backend.host },
  }, (response) => {
    const headers = { ...response.headers }
    if (headers.location?.startsWith(backend.origin))
      headers.location = base + "__api" + headers.location.slice(backend.origin.length)
    res.writeHead(response.statusCode ?? 502, headers)
    response.pipe(res)
  })
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502)
    res.end("OpenCode backend unavailable")
  })
  req.pipe(upstream)
}

async function serveFile(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end()
    return
  }
  const relative = decodeURIComponent(pathname.slice(base.length))
  if (relative.split("/").includes("..")) {
    res.writeHead(403).end()
    return
  }
  const file = resolve(uiDir, relative || "index.html")
  if (file !== uiDir && !file.startsWith(uiDir + sep)) {
    res.writeHead(403).end()
    return
  }
  const info = await stat(file).catch(() => undefined)
  const fallback =
    !info?.isFile() &&
    (req.headers.accept?.includes("text/html") || (req.method === "HEAD" && !extname(relative)))
      ? join(uiDir, "index.html")
      : undefined
  const chosen = info?.isFile() ? file : fallback
  if (!chosen) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, {
    "content-type": types[extname(chosen)] ?? "application/octet-stream",
    "cache-control": basename(chosen) === "index.html" ? "no-cache" : "public, max-age=3600",
  })
  if (req.method === "HEAD") {
    res.end()
    return
  }
  createReadStream(chosen).pipe(res)
}

const server = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (url.pathname === base.slice(0, -1)) {
    res.writeHead(308, { location: base }).end()
    return
  }
  if (!url.pathname.startsWith(base)) {
    res.writeHead(404).end()
    return
  }
  const path = proxyPath(url.pathname, url.search)
  if (path) {
    proxy(req, res, path)
    return
  }
  if (url.pathname === `${base}manifest.json`) {
    const manifest = {
      name: "OpenCode",
      short_name: "OpenCode",
      id: base,
      start_url: base,
      scope: base,
      display: "standalone",
      theme_color: "#080808",
      background_color: "#080808",
      icons: [192, 512].map((size) => ({
        src: `${base}web-app-manifest-${size}x${size}.png`,
        sizes: `${size}x${size}`,
        type: "image/png",
        purpose: "any maskable",
      })),
    }
    res.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "no-cache" })
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(manifest))
    return
  }
  void serveFile(req, res, url.pathname).catch((error) => {
    console.error(error)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const path = proxyPath(url.pathname, url.search)
  if (!path || !backend) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n")
    return
  }
  const upstream = connect(Number(backend.port), backend.hostname, () => {
    const headers = req.rawHeaders.flatMap((value, index, all) =>
      index % 2 === 0 && value.toLowerCase() !== "host" ? [`${value}: ${all[index + 1]}`] : [],
    )
    upstream.write(`${req.method} ${path} HTTP/1.1\r\nHost: ${backend.host}\r\n${headers.join("\r\n")}\r\n\r\n`)
    if (head.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on("error", () => socket.destroy())
  socket.on("error", () => upstream.destroy())
})

server.listen(port, host, () => console.log(`nerds-opencode-web listening at http://${host}:${server.address().port}${base}`))
if (!attached) void startBackend().catch(console.error)

function stop() {
  stopping = true
  server.close()
  child?.kill("SIGTERM")
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
