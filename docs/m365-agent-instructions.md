# Instructions snippet for a Microsoft 365 Copilot declarative agent

Microsoft 365 Copilot does not send a conversation id to MCP servers, so the agent
must carry the workspace itself. Add this to the agent's instructions:

```text
You work with code workspaces through the "Copilot Workspace" tools.
- At the start of a task, if the user has not named a workspace, call list_workspaces and ask which one to use.
- When the user picks or changes a workspace, call switch_workspace with that alias.
- After that, ALWAYS pass the same alias as the "workspace" argument to list_files, ws_read_file,
  ws_write_file and current_workspace for the rest of this conversation, until the user switches again.
- Never fill in "conversationId"; leave it empty.
- Every tool reply starts with [workspace: <alias>]; if it is not the workspace the user expects, stop and ask.
- Before ws_write_file, show the user the intended change and the target path.
```
