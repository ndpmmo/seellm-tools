#!/usr/bin/env python3
"""
curl_cffi_fetch.py — Chrome-impersonating HTTP client for seellm-tools.

Mirrors upstream lxf746/any-auto-register which uses:
  curl_cffi.requests.Session(impersonate="chrome131")

Usage (called from Node.js via spawn):
  python3 curl_cffi_fetch.py <json_request>

Input JSON (stdin or first arg):
  {
    "method": "GET"|"POST",
    "url": "https://...",
    "headers": { "key": "value" },
    "body": "string or null",
    "proxy": "http://...",
    "timeout": 30,
    "allow_redirects": true,
    "stop_at_localhost": true,   // stop redirect chain at localhost URLs
    "impersonate": "chrome131"
  }

Output JSON (stdout):
  {
    "status": 200,
    "headers": { "content-type": "..." },
    "body": "...",
    "cookies": { "name": "value" },
    "url": "https://final-url...",
    "redirect_chain": ["url1", "url2"]
  }

On error:
  { "error": "message" }
"""

import json
import sys


def main():
    try:
        from curl_cffi import requests as cffi_requests
    except ImportError:
        print(json.dumps({"error": "curl_cffi not installed: pip3 install curl_cffi"}))
        sys.exit(1)

    # Read request from stdin or first argument
    if len(sys.argv) > 1:
        raw = sys.argv[1]
    else:
        raw = sys.stdin.read()

    try:
        req = json.loads(raw)
    except Exception as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

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
        print(json.dumps({"error": "url is required"}))
        sys.exit(1)

    # Build proxies dict
    proxies = None
    if proxy_url:
        proxies = {"http": proxy_url, "https": proxy_url}

    try:
        session = cffi_requests.Session(impersonate=impersonate)

        redirect_chain = []

        if stop_at_localhost:
            # Manual redirect following — stop when we hit localhost
            current_url = url
            current_method = method
            current_body = body
            response = None

            for _ in range(15):
                kwargs = {
                    "headers": headers,
                    "timeout": timeout,
                    "allow_redirects": False,
                }
                if proxies:
                    kwargs["proxies"] = proxies
                if current_body is not None:
                    kwargs["data"] = current_body

                response = session.request(current_method, current_url, **kwargs)
                redirect_chain.append(current_url)

                location = response.headers.get("location", "")
                if not location:
                    break

                # Stop at localhost — this is the OAuth callback
                if "localhost" in location or "127.0.0.1" in location:
                    redirect_chain.append(location)
                    # Return the redirect response with location header
                    break

                if response.status_code not in (301, 302, 303, 307, 308):
                    break

                # Follow redirect — use GET for 301/302/303
                if response.status_code in (301, 302, 303):
                    current_method = "GET"
                    current_body = None

                # Resolve relative URLs
                if location.startswith("http"):
                    current_url = location
                else:
                    from urllib.parse import urljoin
                    current_url = urljoin(current_url, location)

        else:
            kwargs = {
                "headers": headers,
                "timeout": timeout,
                "allow_redirects": allow_redirects,
            }
            if proxies:
                kwargs["proxies"] = proxies
            if body is not None:
                kwargs["data"] = body

            response = session.request(method, url, **kwargs)

        if response is None:
            print(json.dumps({"error": "no response"}))
            sys.exit(1)

        # Extract cookies from session jar (accumulated across all redirects)
        cookies = {}
        for cookie in session.cookies.jar:
            cookies[cookie.name] = cookie.value

        # Extract headers (lowercase keys)
        resp_headers = {}
        for k, v in response.headers.items():
            resp_headers[k.lower()] = v

        # Build set-cookie list from cookies dict for compatibility with Node.js cookie jar
        set_cookie_list = [f"{name}={value}" for name, value in cookies.items()]
        if set_cookie_list:
            resp_headers["set-cookie"] = set_cookie_list

        result = {
            "status": response.status_code,
            "headers": resp_headers,
            "body": response.text,
            "cookies": cookies,
            "url": str(response.url),
            "redirect_chain": redirect_chain,
        }
        print(json.dumps(result, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
