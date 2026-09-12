#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地 CORS 代理：给 usage.html 提供用量数据（仅监听 127.0.0.1）。

为什么需要它：
  OpenCode Go 的用量接口不返回 CORS 头，浏览器页面无法直连；
  DeepSeek 接口支持 CORS，可直连，本代理同样可做备用通道。

用法（Windows PowerShell）：
  $env:OPENCODE_GO_KEY = "你的 Go key（auth.json 里 opencode-go 项）"
  $env:DEEPSEEK_API_KEY = "sk-开头"
  python usage-proxy.py

  然后在 usage.html 的「本地代理」一栏填 http://127.0.0.1:8787。

也可以把 Key 写进同目录的 usage-proxy.keys.json（已加入 .gitignore，
切勿提交）：
  {"OPENCODE_GO_KEY": "...", "DEEPSEEK_API_KEY": "sk-..."}

环境变量优先于 keys 文件。代理只做转发，不记录任何 Key。
"""

import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("USAGE_PROXY_HOST", "127.0.0.1")
PORT = int(os.environ.get("USAGE_PROXY_PORT", "8787"))
TIMEOUT = 15

UPSTREAM = {
    "/api/go/usage": ("https://opencode.ai/zen/go/v1/usage", "OPENCODE_GO_KEY"),
    "/api/ds/balance": ("https://api.deepseek.com/user/balance", "DEEPSEEK_API_KEY"),
}


def load_keys_file():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "usage-proxy.keys.json")
    try:
        # utf-8-sig：兼容 Windows PowerShell 写出的带 BOM 文件
        with open(path, encoding="utf-8-sig") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(v, str) and v.strip()}


FILE_KEYS = load_keys_file()


def get_key(env_name):
    value = os.environ.get(env_name, "").strip()
    if value:
        return value
    return FILE_KEYS.get(env_name, "").strip()


class Handler(BaseHTTPRequestHandler):
    server_version = "UsageProxy/1.0"

    def log_message(self, *args):
        # 只记方法和路径，不记任何凭证或查询串
        sys.stderr.write("[proxy] %s %s\n" % (self.command, self.path.split("?")[0]))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Max-Age", "600")
        # Chrome Private Network Access：公网 https 页面调 127.0.0.1 必须有这个头
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        route = UPSTREAM.get(path)
        if route is None:
            self._send_json(200, {"ok": True, "routes": sorted(UPSTREAM)})
            return
        url, env_name = route
        key = get_key(env_name)
        if not key:
            self._send_json(503, {"error": "missing_key", "which": env_name})
            return
        req = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "Authorization": "Bearer " + key,
                "User-Agent": "opencode-go-pricing-usage/1.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header(
                    "Content-Type", resp.headers.get("Content-Type", "application/json")
                )
                self._cors()
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            try:
                data = e.read() or b"{}"
            except Exception:
                data = b"{}"
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            sys.stderr.write("[proxy] upstream error: %r\n" % (e,))
            self._send_json(502, {"error": "upstream_unreachable"})


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("usage-proxy listening on http://%s:%d (localhost only)" % (HOST, PORT))
    print("routes: %s" % (" ".join(sorted(UPSTREAM))))
    missing = [name for _, name in UPSTREAM.values() if not get_key(name)]
    if missing:
        print("提示：缺少 %s，代理会照常运行，但对应卡片查不到数。" % (", ".join(missing)))
        print("最简单的办法：关掉本窗口，双击 start-proxy.bat 按提示填 Key。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
