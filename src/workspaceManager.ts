
export class WorkspaceManager {
  private workspace:string = process.cwd();
  setWorkspace(path:string){ this.workspace = path; }
  getWorkspace(){ return this.workspace; }
}
export const workspaceManager = new WorkspaceManager();
