# M365 Code Analyzer MCP v1.3

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
