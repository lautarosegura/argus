import path from 'node:path';
import { clean } from './commands/clean.js';
import { daemonStatus } from './commands/daemon-status.js';
import { init } from './commands/init.js';
import { list } from './commands/list.js';
import { logs } from './commands/logs.js';
import { open } from './commands/open.js';
import { sentinel } from './commands/sentinel.js';

const argv0 = path.basename(process.argv[1] ?? '');
const args = process.argv.slice(2);

const isWorkspaceCli = argv0 === 'workspace' || argv0 === 'workspace.exe';

if (isWorkspaceCli) {
  await sentinel(args);
  process.exit(0);
}

const command = args[0];

switch (command) {
  case 'daemon-status':
    await daemonStatus();
    break;

  case 'init':
    await init(args.slice(1));
    break;

  case 'list':
    await list();
    break;

  case 'logs':
    await logs(args.slice(1));
    break;

  case 'clean':
    await clean(args.slice(1));
    break;

  case 'open':
    await open(args.slice(1));
    break;

  default:
    console.error(`Unknown command: ${command ?? '(none)'}`);
    console.error(`Available commands: init, list, clean, logs, open, daemon-status`);
    process.exit(1);
}
