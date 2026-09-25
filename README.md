# nerds-opencode-web

A standalone web frontend for an **installed, unmodified OpenCode CLI**. The runtime package contains a static UI build and a small Node server. It does not package OpenCode core or an OpenCode executable.

The server exposes the UI at `/dev/opencode/` by default and starts the installed `opencode serve` command as a supervised child process. The TUI is independent. Once a prompt is accepted, the OpenCode backend continues working when the browser tab or laptop closes, provided the VM and this service stay running. A backend restart can interrupt active work.

## Requirements

- Node.js 22 or later for the service.
- An `opencode` executable installed on the VM and available on `PATH`.
- Bun 1.3.x and an OpenCode source checkout **only to build the UI**. Neither is required to serve an existing build.

## Build and run

```sh
cd nerds-opencode-web
OPENCODE_SOURCE=../opencode OPENCODE_WEB_BASE=/dev/opencode/ npm run build
npm link
nerds-opencode-web serve
```

The build command checks out the source revision into a temporary directory, applies [`patches/web-base-path.patch`](patches/web-base-path.patch), builds `packages/app`, and copies only the resulting static files into `dist/`. It also copies upstream's PWA icons into the UI build. Your OpenCode checkout is not edited.

The service listens on `127.0.0.1:3000` by default. Place it behind an HTTPS reverse proxy and route `/dev/opencode/` to that listener without stripping the prefix. Open `https://your-host/dev/opencode/` to use or install the PWA. HTTPS or localhost is required for browser installation.

For a VM, adapt [`deploy/nerds-opencode-web.service`](deploy/nerds-opencode-web.service) to your installation paths and service account. That is the only service unit required; it supervises the installed CLI child. Set any OpenCode environment variables in the unit or an environment file.

```sh
node src/serve.mjs serve --host 127.0.0.1 --port 3000 --opencode /path/to/opencode
```

The service starts a private backend on a free loopback port. You can instead connect to an existing backend with `--backend-url http://127.0.0.1:4096`; in that mode, you must keep it running separately.

Set `OPENCODE_SERVER_PASSWORD` (and optionally `OPENCODE_SERVER_USERNAME`) in the service environment to pass OpenCode's HTTP authentication settings to the backend child. Protect the public HTTPS endpoint as appropriate for a cloud VM.

## Updates

The child process always runs the currently installed `opencode` executable. Restart this service after updating OpenCode to pick up the new executable. Rebuild the UI from a corresponding OpenCode source revision when upstream changes its API. A version mismatch is reported at startup; compatibility across arbitrary future versions is not guaranteed.

The `/dev/opencode/manifest.json` response sets its PWA identity, launch URL, and scope to the prefix. The UI and API are both kept inside that prefix. Browser data is still tied to the site's origin, so changing the public hostname can create a separate local browser state.
