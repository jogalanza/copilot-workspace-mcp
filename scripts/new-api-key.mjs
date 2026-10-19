// Generate a random MCP_API_KEY and store it in .env (creating .env from .env.example if needed).
// Usage: npm run new-key             -> writes/rotates MCP_API_KEY in .env and prints it once
//        npm run new-key -- --print  -> only prints a new key; does not touch .env
import crypto from 'node:crypto';
import fs from 'node:fs';

const key = crypto.randomBytes(32).toString('base64url');

if (process.argv.includes('--print')) {
  console.log(key);
  process.exit(0);
}

let env = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8')
  : fs.existsSync('.env.example') ? fs.readFileSync('.env.example', 'utf8') : '';
env = /^MCP_API_KEY=.*$/m.test(env)
  ? env.replace(/^MCP_API_KEY=.*$/m, `MCP_API_KEY=${key}`)
  : `${env.replace(/\s*$/, '\n')}MCP_API_KEY=${key}\n`;
fs.writeFileSync('.env', env);

console.log('MCP_API_KEY written to .env. Restart the server, then update the key in Copilot Studio / M365 Copilot.');
console.log(`Key (shown once): ${key}`);