#!/usr/bin/env python3
"""
curl_cffi_daemon.py — Persistent, Chrome-impersonating HTTP client daemon for seellm-tools.

Reads requests from stdin line-by-line (each request is a single-line JSON string).
Writes responses to stdout line-by-line (each response is a single-line JSON string).
This avoids the overhead of spawning a new python3 process for every request.
"""

import json
import sys
import traceback
from urllib.parse import urljoin

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    print(json.dumps({"error": "curl_cffi not installed: pip3 install curl_cffi"}), flush=True)
    sys.exit(1)


def process_request(session_map, req):
    """Process a single JSON request using curl_cffi."""
    req_id = req.get("req_id", "default")
    method = req.get("method", "GET").upper()
    url = req.get("url", "")
    headers = req.get("headers", {})
    body = req.get("body", None)
    proxy_url = req.get("proxy", None)
    timeout = req.get("timeout", 30)
    allow_redirects = req.get("allow_redirects", True)
    stop_at_localhost = req.get("stop_at_localhost", False)
    impersonate = req.get("impersonate", "chrome131")

    if not url:
        return {"req_id": req_id, "error": "url is required"}

    # Build proxies dict
    proxies = None
    if proxy_url:
        proxies = {"http": proxy_url, "https": proxy_url}

    # Keep separate session per impersonate/proxy key to reuse connections properly
    session_key = f"{impersonate}_{proxy_url}"
    if session_key not in session_map:
        session_map[session_key] = cffi_requests.Session(impersonate=impersonate)
    session = session_map[session_key]

    try:
        redirect_chain = []

        if stop_at_localhost:
            # Manual redirect following — stop when we hit localhost
            current_url = url
            current_method = method
            current_body = body

            for _ in range(15):
                kwargs = {
                    "headers": headers,
                    "timeout": timeout,
                    "allow_redirects": False,
                }
                if proxies:
                    kwargs["proxies"] = proxies

                if current_method in ("POST", "PUT", "PATCH") and current_body:
                    if isinstance(current_body, str):
                        kwargs["data"] = current_body.encode('utf-8')
                    else:
                        kwargs["json"] = current_body

                res = session.request(current_method, current_url, **kwargs)

                # Track redirect
                if res.status_code in (301, 302, 303, 307, 308):
                    loc = res.headers.get("location", "")
                    if not loc:
                        response = res
                        break
                    next_url = urljoin(current_url, loc)
                    redirect_chain.append(next_url)

                    # Check if next URL is localhost (oauth callback target)
                    if "localhost" in next_url or "127.0.0.1" in next_url:
                        # Return redirect info immediately instead of requesting it
                        return {
                            "req_id": req_id,
                            "status": res.status_code,
                            "headers": dict(res.headers),
                            "body": res.text,
                            "cookies": dict(session.cookies.get_dict()),
                            "url": res.url,
                            "redirect_chain": redirect_chain,
                        }

                    current_url = next_url
                    # Standard redirect behavior: convert POST to GET on 301/302/303
                    if res.status_code in (301, 302, 303):
                        current_method = "GET"
                        current_body = None
                else:
                    response = res
                    break
            else:
                return {"req_id": req_id, "error": "Too many redirects"}
        else:
            # Default curl_cffi redirect following
            kwargs = {
                "headers": headers,
                "timeout": timeout,
                "allow_redirects": allow_redirects,
            }
            if proxies:
                kwargs["proxies"] = proxies

            if method in ("POST", "PUT", "PATCH") and body:
                if isinstance(body, str):
                    kwargs["data"] = body.encode('utf-8')
                else:
                    kwargs["json"] = body

            response = session.request(method, url, **kwargs)

        # Output successful response JSON
        return {
            "req_id": req_id,
            "status": response.status_code,
            "headers": dict(response.headers),
            "body": response.text,
            "cookies": dict(session.cookies.get_dict()),
            "url": response.url,
            "redirect_chain": redirect_chain or [response.url],
        }

    except Exception as e:
        return {"req_id": req_id, "error": str(e), "traceback": traceback.format_exc()}


def main():
    session_map = {}
    
    # Send ready signal to Node.js
    print(json.dumps({"status": "ready"}), flush=True)

    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break  # EOF, Node process closed stdin

            line = line.strip()
            if not line:
                continue

            try:
                req = json.loads(line)
            except Exception as e:
                print(json.dumps({"error": f"Invalid JSON string: {e}"}), flush=True)
                continue

            # Process shutdown command
            if req.get("command") == "shutdown":
                break

            res = process_request(session_map, req)
            print(json.dumps(res), flush=True)

        except Exception as e:
            print(json.dumps({"error": f"Daemon loop error: {str(e)}"}), flush=True)


if __name__ == "__main__":
    main()
