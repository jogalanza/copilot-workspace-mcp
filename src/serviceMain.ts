// Development entry for the service installer: `npm run service -- install --exe <path>`.
// The standalone executable exposes the same commands as `<exe> service <command>`.
import { runServiceCommand } from './service.js';

await runServiceCommand(process.argv.slice(2));
