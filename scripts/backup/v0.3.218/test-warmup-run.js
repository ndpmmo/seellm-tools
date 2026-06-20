import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, 'warmup.js');

function runWarmupFor(accountId) {
  return new Promise((resolve) => {
    console.log(`\n==================================================`);
    console.log(`🚀 STARTING TEST WARMUP FOR ACCOUNT: ${accountId}`);
    console.log(`==================================================\n`);
    
    const child = spawn('node', [scriptPath, '--accountId', accountId, '--questions', '1'], {
      env: { ...process.env, WARMUP_SCREENSHOTS: '1' },
      stdio: 'inherit'
    });

    child.on('close', (code) => {
      console.log(`\n[Test] Warmup process for ${accountId} exited with code ${code}`);
      resolve(code);
    });
  });
}

async function run() {
  // Test both ready accounts:
  // 1. acc_3f7ddd81 (jackchadmoore7872@hotmail.com)
  // 2. acc_15c0be87 (zyphor@gptmail.biz.id)
  
  const code1 = await runWarmupFor('acc_3f7ddd81');
  console.log(`First account completed. Code: ${code1}`);
  
  const code2 = await runWarmupFor('acc_15c0be87');
  console.log(`Second account completed. Code: ${code2}`);
}

run().catch(console.error);
