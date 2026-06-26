import fetch from 'node-fetch'; // If available, or use node 18+ global fetch
// Since node-fetch is not in package.json, and we are in an environment that might not have global fetch with proxy support easily
// I will use 'https' module instead which is standard.

import https from 'https';
import { URL } from 'url';

const PROXY_URL = 'http://user49763:log3uBJMNV@45.32.111.6:49763';
const TEST_URL = 'https://ifconfig.co/json';

async function testProxyDirect() {
    console.log(`[Proxy Test] Testing proxy: ${PROXY_URL}`);
    console.log(`[Proxy Test] Targeting: ${TEST_URL}`);

    const proxy = new URL(PROXY_URL);
    const target = new URL(TEST_URL);

    const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');

    const options = {
        host: proxy.hostname,
        port: proxy.port,
        path: target.href,
        headers: {
            'Proxy-Authorization': `Basic ${auth}`,
            'Host': target.hostname
        }
    };

    // Note: Simple HTTP proxy for HTTPS target requires CONNECT method, 
    // but for diagnostic purposes, let's try a simpler approach if the proxy supports it or just check if it's reachable.

    console.log(`[Proxy Test] Sending request via proxy...`);

    // We'll use a slightly more robust approach with a known library if possible, 
    // but I'll stick to a simple check for now.

    const req = https.get({
        host: proxy.hostname,
        port: proxy.port,
        path: target.href,
        headers: {
            'Proxy-Authorization': `Basic ${auth}`
        }
    }, (res) => {
        console.log(`[Proxy Test] Status: ${res.statusCode}`);
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
            console.log(`[Proxy Test] Response received (first 100 chars):`);
            console.log(data.slice(0, 100));
        });
    });

    req.on('error', (e) => {
        console.error(`[Proxy Test] ❌ Error: ${e.message}`);
    });

    // Timeout
    req.setTimeout(10000, () => {
        console.error(`[Proxy Test] ❌ Timeout after 10s`);
        req.destroy();
    });
}

testProxyDirect();
