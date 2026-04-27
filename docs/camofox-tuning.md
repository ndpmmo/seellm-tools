# Camofox Server Configuration Tuning

This document provides recommended environment variable configurations for optimal Camofox browser performance when running SeeLLM Tools worker scripts.

## Recommended Environment Variables

### Performance Tuning

```bash
# Browser idle timeout (ms) - auto-close idle tabs to free resources
# Recommended: 300000 (5 minutes) for worker scripts
BROWSER_IDLE_TIMEOUT_MS=300000

# Max concurrent tabs per user/session
# Recommended: 3-5 for parallel worker execution
MAX_CONCURRENT_PER_USER=5

# Session timeout (ms)
# Recommended: 1800000 (30 minutes) for long-running worker flows
SESSION_TIMEOUT_MS=1800000

# Max tabs per session
# Recommended: 10 to prevent memory bloat
MAX_TABS_PER_SESSION=10
```

### Anti-Detection & Stealth

```bash
# Enable humanization (mouse movements, typing delays)
HUMANIZE=true

# Randomize fonts and canvas fingerprinting
RANDOM_FONTS=true
CANVAS=random

# OS fingerprinting (macos, windows, linux)
OS=macos

# Screen resolution (affects fingerprinting)
SCREEN_WIDTH=1440
SCREEN_HEIGHT=900
```

### Resource Management

```bash
# Headless mode (set to false for better stealth on some sites)
HEADLESS=false

# Persistent tabs (set to false for worker scripts that clean up)
PERSISTENT=false

# Memory limit per tab (MB) - prevents runaway memory usage
MEMORY_LIMIT_PER_TAB_MB=512
```

### Network & Proxy

```bash
# Proxy timeout (ms)
PROXY_TIMEOUT_MS=30000

# Navigation timeout (ms)
NAVIGATION_TIMEOUT_MS=15000

# Page load timeout (ms)
PAGE_LOAD_TIMEOUT_MS=30000
```

### Logging & Debugging

```bash
# Enable structured logging
STRUCTURED_LOGGING=true

# Log level (error, warn, info, debug)
LOG_LEVEL=info

# Enable screenshot on error
SCREENSHOT_ON_ERROR=true
```

## Docker Deployment

For Docker deployments, add these to your `docker-compose.yml`:

```yaml
services:
  camofox:
    image: jo-inc/camofox-browser:latest
    environment:
      - BROWSER_IDLE_TIMEOUT_MS=300000
      - MAX_CONCURRENT_PER_USER=5
      - SESSION_TIMEOUT_MS=1800000
      - MAX_TABS_PER_SESSION=10
      - HUMANIZE=true
      - RANDOM_FONTS=true
      - CANVAS=random
      - OS=macos
      - HEADLESS=false
      - PERSISTENT=false
      - LOG_LEVEL=info
    ports:
      - "9377:9377"
```

## Local Development

For local development, create a `.env` file in the camofox-browser directory:

```bash
BROWSER_IDLE_TIMEOUT_MS=300000
MAX_CONCURRENT_PER_USER=5
SESSION_TIMEOUT_MS=1800000
MAX_TABS_PER_SESSION=10
HUMANIZE=true
RANDOM_FONTS=true
CANVAS=random
OS=macos
HEADLESS=false
PERSISTENT=false
LOG_LEVEL=debug
```

## Performance Impact

| Variable | Default | Recommended | Impact |
|----------|---------|-------------|--------|
| BROWSER_IDLE_TIMEOUT_MS | 600000 | 300000 | Faster cleanup, lower memory |
| MAX_CONCURRENT_PER_USER | 3 | 5 | Higher throughput, more CPU |
| SESSION_TIMEOUT_MS | 3600000 | 1800000 | Faster cleanup, lower memory |
| MAX_TABS_PER_SESSION | 20 | 10 | Lower memory usage |
| HEADLESS | true | false | Better stealth, slightly slower |
| HUMANIZE | false | true | Better anti-detection |
| RANDOM_FONTS | false | true | Better fingerprint randomization |

## Live Testing Commands

Test Camofox server configuration with worker scripts:

```bash
# Test auto-connect-worker
node scripts/auto-connect-worker.js --task <task_id>

# Test auto-register-worker
node scripts/auto-register-worker.js --email <email>

# Test auto-login-worker
node scripts/auto-login-worker.js --task <task_id>
```

Monitor Camofox server logs for performance metrics:

```bash
# View real-time logs
tail -f camofox.log

# Check for timeout errors
grep -i timeout camofox.log

# Check for memory issues
grep -i memory camofox.log
```

## Troubleshooting

### High Memory Usage

- Reduce `MAX_CONCURRENT_PER_USER` to 3
- Reduce `MAX_TABS_PER_SESSION` to 5
- Enable `HEADLESS=true` (less memory, less stealth)

### Frequent Timeouts

- Increase `NAVIGATION_TIMEOUT_MS` to 30000
- Increase `PAGE_LOAD_TIMEOUT_MS` to 60000
- Check proxy latency with `PROXY_TIMEOUT_MS`

### Detection Issues

- Ensure `HUMANIZE=true`
- Set `HEADLESS=false`
- Enable `RANDOM_FONTS=true` and `CANVAS=random`
- Rotate `OS` setting periodically

## References

- Camofox Browser: https://github.com/jo-inc/camofox-browser
- SeeLLM Tools: https://github.com/ndpmmo/seellm-tools
