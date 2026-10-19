
import express from 'express';
import fg from 'fast-glob';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { workspaceManager } from './workspaceManager.js';

workspaceManager.setWorkspace(process.env.WORKSPACE_ROOT || process.cwd());

// Factory: an McpServer instance can only be connected to one transport,
// so the stateless HTTP endpoint creates a fresh server per request.
function createServer(){
 const server = new McpServer({name:'m365-code-analyzer',version:'1.2.0'});

 server.registerTool('switch_workspace',{
  description:'Switch active workspace',
  inputSchema:{path:z.string()}
 },async({path})=>{
  workspaceManager.setWorkspace(path);
  return {content:[{type:'text',text:`Workspace changed to ${path}`}]};
 });

 server.registerTool('current_workspace',{
  description:'Show current workspace',
  inputSchema:{}
 },async()=>({content:[{type:'text',text:workspaceManager.getWorkspace()}]}));

 server.registerTool('list_files',{
  description:'List files',
  inputSchema:{pattern:z.string().default('**/*')}
 },async({pattern})=>({content:[{type:'text',text:JSON.stringify(await fg(pattern,{cwd:workspaceManager.getWorkspace()}),null,2)}]}));

 server.registerTool('read_file',{
  description:'Read file',
  inputSchema:{filePath:z.string()}
 },async({filePath})=>({content:[{type:'text',text:await fs.readFile(workspaceManager.getWorkspace()+'/'+filePath,'utf8')}]}));

 server.registerTool('write_file',{
  description:'Write file',
  inputSchema:{filePath:z.string(),content:z.string()}
 },async({filePath,content})=>{
  await fs.writeFile(workspaceManager.getWorkspace()+'/'+filePath,content);
  return {content:[{type:'text',text:'updated'}]};
 });

 return server;
}

const app = express();
app.use(express.json());

// MCP Streamable HTTP endpoint (what M365 Copilot / Copilot Studio calls).
app.post('/mcp', async (req,res)=>{
 const server = createServer();
 const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
 res.on('close',()=>{ transport.close(); server.close(); });
 try {
  await server.connect(transport);
  await transport.handleRequest(req,res,req.body);
 } catch (err) {
  console.error('MCP request failed:',err);
  if(!res.headersSent){
   res.status(500).json({jsonrpc:'2.0',error:{code:-32603,message:'Internal server error'},id:null});
  }
 }
});

// Stateless mode: no SSE stream / session termination.
const methodNotAllowed = (_req:express.Request,res:express.Response)=>
 res.status(405).json({jsonrpc:'2.0',error:{code:-32000,message:'Method not allowed.'},id:null});
app.get('/mcp',methodNotAllowed);
app.delete('/mcp',methodNotAllowed);

app.get('/health',(_,res)=>res.json({status:'healthy',workspace:workspaceManager.getWorkspace()}));

app.get('/workspace',(_,res)=>res.json({workspace:workspaceManager.getWorkspace()}));

app.post('/workspace', (req,res)=>{
 const path=req.body.path;
 workspaceManager.setWorkspace(path);
 res.json({workspace:path});
});

app.get('/repository-summary',async(_,res)=>{
 const files=await fg(['**/*.ts','**/*.js','**/*.cs','**/*.java','**/*.py'],{cwd:workspaceManager.getWorkspace()});
 res.json({workspace:workspaceManager.getWorkspace(),fileCount:files.length});
});

const port=Number(process.env.PORT||8787);
app.listen(port,(err?:Error)=>{
 if(err){
  // Express 5 passes listen errors (e.g. EADDRINUSE) here.
  console.error(`Failed to listen on ${port}: ${err.message}`);
  process.exit(1);
 }
 // stderr, not stdout: stdout is reserved for the stdio MCP transport.
 console.error(`Listening on ${port} (MCP endpoint: http://localhost:${port}/mcp)`);
});

if(process.env.ENABLE_STDIO==='true'){
 await createServer().connect(new StdioServerTransport());
}
