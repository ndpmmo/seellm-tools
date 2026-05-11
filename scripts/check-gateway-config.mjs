import { loadConfig } from '../server/db/config.js';
const cfg = loadConfig();
console.log('gatewayUrl:', cfg.gatewayUrl);
console.log('d1WorkerUrl:', cfg.d1WorkerUrl);
console.log('d1SyncSecret:', cfg.d1SyncSecret ? '***' + cfg.d1SyncSecret.slice(-4) : '(not set)');
console.log('workerAuthToken:', cfg.workerAuthToken ? '***' + cfg.workerAuthToken.slice(-4) : '(not set)');
