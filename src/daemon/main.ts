import { getPipePath, DEFAULT_IDLE_SHUTDOWN_MS, getStateDir } from '../shared/protocol.js';
import { createDaemon } from './daemon.js';

const pipePath = getPipePath();
const idleShutdownMs = DEFAULT_IDLE_SHUTDOWN_MS;
const stateDir = getStateDir();

const daemon = createDaemon({ pipePath, idleShutdownMs, stateDir });

daemon.on('stopped', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  void daemon.stop();
});

process.on('SIGINT', () => {
  void daemon.stop();
});

try {
  await daemon.start();
  console.log(`argusd listening on ${pipePath}`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('already in use')) {
    console.log('Another argusd is already running. Exiting cleanly.');
    process.exit(0);
  }
  console.error(`Failed to start argusd: ${msg}`);
  process.exit(1);
}
