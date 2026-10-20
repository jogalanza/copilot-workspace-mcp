# Copilot Workspace MCP v1.3

MCP server that lets Microsoft 365 Copilot and Copilot Studio (incl. Teams) list, read and
write files in named code workspaces. **Each chat keeps its own workspace**, and the choice
survives server restarts (SQLite state via the built-in `node:sqlite`).

## Quick start

```powershell
npm install
Copy-Item .env.example .env   # then set WORKSPACES, ALLOWED_ROOTS
npm run new-key               # generates MCP_API_KEY in .env
npm run dev                   # http://localhost:8790/mcp
npm test                      # unit + end-to-end tests
```

Requires Node.js >= 22.13. Expose port 8790 with a dev tunnel and register
`https://<tunnel-host>/mcp` in the client (the `/mcp` suffix is required).

## Standalone executable (download, run, done)

A single-file app that sets everything up for you: no clone, no `npm install`, no build, no manual tunnel.

### Download and run

Get the archive for your system from the [latest release](https://github.com/jogalanza/copilot-workspace-mcp/releases/latest),
unpack it and run the executable inside. Each archive also contains a short `README.txt`; `SHA256SUMS.txt` is on the release page.

| System | Archive | Run |
|---|---|---|
| Windows (x64) | `copilot-workspace-mcp-v<version>-windows-x64.zip` | double-click `copilot-workspace-mcp.exe` (SmartScreen: *More info > Run anyway*, the app is not code-signed) |
| macOS (Apple silicon / Intel) | `...-macos-arm64.tar.gz` / `...-macos-x64.tar.gz` | `xattr -d com.apple.quarantine ./copilot-workspace-mcp && ./copilot-workspace-mcp` (if macOS still refuses: `codesign --sign - ./copilot-workspace-mcp`) |
| Linux (x64 / arm64) | `...-linux-x64.tar.gz` / `...-linux-arm64.tar.gz` | `./copilot-workspace-mcp` |

On first run it:

1. asks for the workspace folder to expose (default: current folder) and generates an API key, saved in
   `%APPDATA%\copilot-workspace-mcp\config.env` (Windows) or `~/.config/copilot-workspace-mcp/config.env`
2. downloads the `devtunnel` CLI into that folder if it is not on PATH, and signs you in if needed
3. creates a persistent tunnel (same public URL on every run), starts the server and hosts the tunnel
4. prints the public `https://.../mcp` URL and the API key (key shown on first run or with `--show-key`)

A local web UI (default http://localhost:8791, loopback only) opens automatically in its own app-style window using the
installed Edge/Chrome, or the default browser if there is none (`--no-ui` / `--no-open`). It shows colour-coded live logs with
level/source/text filters, pause, clear and download, tunnel status with a restart button, **Settings** for every variable in
`config.env` (saving validates and restarts the server in place), and a Stop button. Ctrl+C, closing the console or Stop shuts
down the tunnel first, then the server, cleanly. The browser tools (`browser_*`) are on by default; set `ENABLE_BROWSER=false` to disable them.

The tunnel allows anonymous clients by default (Copilot Studio / M365 Copilot cannot sign in to a dev tunnel; the API key still
protects `/mcp`). Set `TUNNEL_ALLOW_ANONYMOUS=false` to restrict it to your own Microsoft account.

The console shows only errors and important lines (add `--verbose` for all dev tunnel output). Other flags:
`--reconfigure`, `--new-key`, `--show-key`, `--no-tunnel`, `--no-ui`, `--no-open`, `--help`. Any variable from `.env.example` can be
set in `config.env`, in a `.env` in the folder you start it from, or in the environment (later wins).

### Build it yourself

Needs Node.js >= 24 and `npm install` once. The executable embeds the Node runtime of the machine (or target) it is built for.

| Goal | Command | Output in `release/` |
|---|---|---|
| This machine's OS/arch | `npm run build:standalone` | `copilot-workspace-mcp-<platform>-<arch>[.exe]` |
| Linux x64 + arm64 | `npm run build:standalone:linux` | `copilot-workspace-mcp-linux-x64`, `-linux-arm64` |
| macOS Intel + Apple silicon | `npm run build:standalone:mac` | `copilot-workspace-mcp-darwin-x64`, `-darwin-arm64` |
| Every target | `npm run build:standalone:all` | all of the above plus `win32-x64`, `win32-arm64` |
| Any mix | `node scripts/build-standalone.mjs win32-x64 linux-arm64` | |
| Download-ready archives | `npm run package` (all targets) or `npm run package:current` | `release/packages/*.zip`, `*.tar.gz`, `SHA256SUMS.txt` |

Set `OUT_DIR=some/folder` to write somewhere other than `release/`.

**Building on each OS.** Run `npm install` then `npm run build:standalone` on that machine. On macOS this also ad-hoc signs the binary
(`codesign`, built into macOS), so it can run immediately on Apple silicon.

**Cross-building from one machine.** Targets for another OS/arch download that platform's official Node runtime
(same version as yours, cached in `.cache/node/`) and inject the app into it, so you can produce Linux and macOS binaries from Windows.
Cross-built Linux and Windows binaries run as they are. Cross-built **macOS** binaries cannot be code-signed off a Mac, so on the Mac run
once `codesign --sign - ./copilot-workspace-mcp` (the release archives avoid this because CI builds them on macOS runners).

**Releases.** Pushing a tag such as `v1.3.0` runs `.github/workflows/release.yml`: it builds on Windows, Linux (x64 and arm64) and macOS
(Intel and Apple silicon) runners, packages the archives with `scripts/package-release.mjs`, and attaches them and `SHA256SUMS.txt` to a GitHub release.
The same workflow can be started by hand (*Actions > Release executables*) to get the archives as a build artifact without a release.

## Configure a Copilot Studio agent

Step-by-step guide: **[Set up a Copilot Studio agent with this MCP server](docs/copilot-studio-guide.html)**
([view it rendered](https://htmlpreview.github.io/?https://github.com/jogalanza/copilot-workspace-mcp/blob/main/docs/copilot-studio-guide.html),
since GitHub shows `.html` files as source; or download the repo file and open it in a browser).
It covers adding the MCP tool, the `api-key` header authentication, the per-chat workspace input, the optional browser and
command tools, and troubleshooting. The quick version: add an MCP tool with your public `https://.../mcp` URL, authentication
**API key**, type **Header**, name `api-key`, value = your key.

## How a chat's workspace is chosen

For every tool call the server resolves the workspace in this order:

1. `workspace` tool argument (alias) - used by **Microsoft 365 Copilot** declarative agents
2. the chat's saved binding, keyed by conversation id - **Copilot Studio / Teams**
   (`conversation-id` header, or `conversationId` argument set to `System.Conversation.Id`)
3. the default workspace (`DEFAULT_WORKSPACE`, or `switch_workspace` with `makeDefault`)

Every file tool reply starts with `[workspace: <alias>]`.

| Client | Setup |
|---|---|
| Copilot Studio / Teams | Import `docs/copilot-studio-connector.yaml`, add input `conversation-id` = `System.Conversation.Id`, API key header `api-key`. |
| M365 Copilot declarative agent | Add `docs/m365-agent-instructions.md` to the agent instructions; configure API key auth. |

## MCP tools

| Tool | Purpose |
|---|---|
| `list_workspaces` | Registered workspaces, default and this chat's current one |
| `switch_workspace` | Bind this chat to a workspace (`makeDefault` optional) |
| `current_workspace` | Which workspace this chat uses and why |
| `add_workspace` / `remove_workspace` | Register/unregister a folder (only under `ALLOWED_ROOTS`) |
| `list_files` | Glob within the workspace (skips `node_modules`, `.git`) |
| `ws_read_file` | Read a text file (size-capped) |
| `ws_write_file` | Atomic create/overwrite; blocked in `.git`, `node_modules` |

### Optional: headless browser and command runner

Both are **off by default** (see `.env.example`).

| Tool | Enabled by | Purpose |
|---|---|---|
| `browser_open`, `browser_screenshot`, `browser_text`, `browser_click`, `browser_type`, `browser_logs`, `browser_eval`, `browser_close` | `ENABLE_BROWSER=true` | Drive a headless Edge/Chrome (one tab per chat). Screenshots are returned as images **and** saved under `<workspace>/.screenshots/`. |
| `run_command`, `process_output`, `process_stop`, `list_processes` | `RUN_ALLOWED_COMMANDS` non-empty | Run allowlisted commands in a workspace root, optionally in the background (dev servers), with output capture. |

Typical flow: `run_command` `npm run dev` (background, `readyText`) -> `browser_open` the printed URL -> `browser_screenshot` -> `browser_logs` -> `process_stop`.

Safety: the browser only loads hosts in `BROWSER_ALLOWED_HOSTS` (default localhost; every sub-request and redirect is checked, `file:` is refused).
`run_command` only starts commands that begin with an allowlist entry, rejects quotes, pipes, `&`, `;`, `$`, `%` and redirects, runs without `MCP_API_KEY` in its environment,
and each chat can only see and stop its own processes. Do not allowlist interpreters such as `node` or `powershell`. These tools give anyone holding the API key a way to run
your project's scripts, so keep the key private and the allowlist small. Uses `playwright-core` against an installed browser; no browser download.

## HTTP endpoints

All except `/health` require the API key (`api-key` header, `Authorization: Bearer`, or `?api_key=`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness (no paths revealed) |
| POST | `/mcp` | MCP Streamable HTTP (stateless) |
| GET / POST | `/workspaces` | List / register `{"alias","path","makeDefault"?}` |
| DELETE | `/workspaces/:alias` | Unregister |
| GET / POST | `/workspace` | Get / set default `{"workspace":"<alias>"}` |
| GET | `/repository-summary?workspace=<alias>` | Source file count |
| GET | `/audit?limit=50` | Recent tool calls |

## API key (`MCP_API_KEY`)

Every request except `GET /health` must carry the key; without it the server returns `401`.
The server refuses to start when `MCP_API_KEY` is empty (unless `MCP_ALLOW_ANONYMOUS=true`).

1. **Generate** (writes/rotates the key in `.env`, prints it once):
   `npm run new-key` - or only print one: `npm run new-key -- --print`
2. **Restart** the server (`npm run dev`); `.env` is read at startup.
3. **Send it** in one of these ways (checked in this order):

   | Where | Example |
   |---|---|
   | `api-key` header (recommended) | `api-key: <key>` |
   | Bearer token | `Authorization: Bearer <key>` |
   | Query string (avoid: ends up in logs) | `https://<host>/mcp?api_key=<key>` |

4. **Configure the clients**
   - *Copilot Studio*: MCP wizard > Authentication **API key** > Type **Header** > name `api-key`
     (or use `docs/copilot-studio-connector.yaml`, which already declares it). Paste the key when creating the connection.
   - *M365 Copilot declarative agent*: API key auth registered in the Teams developer portal / Agents Toolkit;
     the key is stored by Microsoft, not in the app package.
   - *curl / scripts*: `curl -H "api-key: $env:MCP_API_KEY" http://localhost:8790/workspaces`

**Rotate**: `npm run new-key`, restart, then update the connection in each client. Never commit `.env`
(it is git-ignored) and never paste the key into chat prompts.

## Dependencies

Versions are pinned exactly in `package.json` (and `.npmrc` sets `save-exact=true`). Update deliberately:
`npm install <pkg>@<version>`, then `npm run typecheck && npm test`. Check with `npm run audit`.

Known advisory: `braces` <= 3.0.3 (via `fast-glob` -> `micromatch`), CVE-2026-93687 / GHSA-vfj7-8cjw-p6xm,
has no patched release. `list_files` mitigates it by capping glob patterns at 512 characters and
8 nesting levels; remove this note when a fixed `braces` ships.
## Safety

- Paths are resolved inside the workspace (also through symlinks/junctions); `..` and absolute paths are rejected.
- Writes into `.git`, `node_modules` or the state DB are refused; writes are atomic and size-limited.
- Every tool call is recorded in the audit log (no file contents). Chat bindings expire after
  `BINDING_TTL_DAYS` (30) of inactivity; audit rows after 90 days.

## Configuration

See `.env.example`. State DB default: `%LOCALAPPDATA%\copilot-mcp\state.db`.

## License

MIT, see [LICENSE](LICENSE).
