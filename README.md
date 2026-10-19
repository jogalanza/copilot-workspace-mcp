# M365 Code Analyzer MCP v1.3

MCP server that lets Microsoft 365 Copilot and Copilot Studio (incl. Teams) list, read and
write files in named code workspaces. **Each chat keeps its own workspace**, and the choice
survives server restarts (SQLite state via the built-in `node:sqlite`).

## Quick start

```powershell
npm install
Copy-Item .env.example .env   # then set MCP_API_KEY, WORKSPACES, ALLOWED_ROOTS
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
| `read_file` | Read a text file (size-capped) |
| `write_file` | Atomic create/overwrite; blocked in `.git`, `node_modules` |

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

## Safety

- Paths are resolved inside the workspace (also through symlinks/junctions); `..` and absolute paths are rejected.
- Writes into `.git`, `node_modules` or the state DB are refused; writes are atomic and size-limited.
- Every tool call is recorded in the audit log (no file contents). Chat bindings expire after
  `BINDING_TTL_DAYS` (30) of inactivity; audit rows after 90 days.

## Configuration

See `.env.example`. State DB default: `%LOCALAPPDATA%\copilot-mcp\state.db`.
