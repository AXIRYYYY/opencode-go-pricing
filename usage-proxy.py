#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地 CORS 代理：给 usage.html 提供用量数据（仅监听 127.0.0.1）。

为什么需要它（2026-10-18 更新）：
  Go 用量接口现已返回 CORS 头，浏览器可以直连，代理不再是必需项；
  DeepSeek 接口本来就支持 CORS。
  本代理保留为可选备用通道，主要服务两个附加功能：
    · /api/go/records  官方导出接口只允许 opencode.ai 自己跨域，浏览器读不到；
    · /api/zen/models  Zen 模型清单接口没有可用的 CORS 头。

可用路由：
  /api/go/usage    → https://opencode.ai/inference/go/v1/usage    （Go 用量，需要 Go Key；直连不可用时作备用）
  /api/go/records  → https://opencode.ai/console/api/v1/usage/export（逐请求明细，需要服务账号 Key oc_sk_...）
  /api/ds/balance  → https://api.deepseek.com/user/balance      （DeepSeek 余额，可直连）
  /api/zen/models  → https://opencode.ai/zen/v1/models（Zen 免费模型清单，免 Key；上游无 CORS 头故经本代理）

用法（Windows PowerShell）：
  $env:OPENCODE_GO_KEY = "你的 Go key（auth.json 里 opencode-go 项）"
  $env:OPENCODE_SERVICE_KEY = "oc_sk-开头（Console 里建服务账号 Key）"
  $env:DEEPSEEK_API_KEY = "sk-开头"
  python usage-proxy.py

  然后在 usage.html 的「本地代理（可选）」一栏填 http://127.0.0.1:8787
  （只有要用「分模型明细」或 Zen 实时校验时才需要）。

跨源放行（默认只放行本仓库的 GitHub Pages 站点和本机 localhost）：
  $env:USAGE_PROXY_ALLOW_ORIGIN = "https://axiryyyy.github.io,https://别的域名"
  $env:USAGE_PROXY_ALLOW_FILE = "1"   # 允许 file:// 打开的页面（双击打开 usage.html 时需要）

也可以把 Key 写进同目录的 usage-proxy.keys.json（已加入 .gitignore，
切勿提交）：
  {"OPENCODE_GO_KEY": "...", "OPENCODE_SERVICE_KEY": "oc_sk...",
   "DEEPSEEK_API_KEY": "sk-..."}

环境变量优先于 keys 文件。代理只做转发，不记录任何 Key。

说明：/api/go/records 走官方 Usage API（GET /console/api/v1/usage/export），
只收服务账号 Key（oc_sk），查询参数 scope/range 等原样透传（默认
scope=organization&range=7d）；返回体可能是 CSV 或 JSON，由页面自行解析。
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("USAGE_PROXY_HOST", "127.0.0.1")
PORT = int(os.environ.get("USAGE_PROXY_PORT", "8787"))
TIMEOUT = 15
RECORDS_TIMEOUT = 120
RETRY_ONCE = True

UPSTREAM = {
    "/api/go/usage": ("https://opencode.ai/inference/go/v1/usage", "OPENCODE_GO_KEY"),
    "/api/go/records": ("https://opencode.ai/console/api/v1/usage/export", "OPENCODE_SERVICE_KEY"),
    "/api/ds/balance": ("https://api.deepseek.com/user/balance", "DEEPSEEK_API_KEY"),
    # Zen 模型清单（2026-10-07 加）：上游免 Key，但 Access-Control-Allow-Origin 为空，
    # 浏览器直连必被 CORS 拦，所以走本代理给 zen.html 用。
    # 第二个字段是空串 = 该路由不需要任何 Key（见 do_GET 里的免鉴权分支）。
    "/api/zen/models": ("https://opencode.ai/zen/v1/models", ""),
}
DEFAULT_RECORDS_QUERY = {"scope": "organization", "range": "7d"}

# 允许跨源访问的来源白名单（逗号分隔，可用环境变量 USAGE_PROXY_ALLOW_ORIGIN 覆盖）。
# 默认只放行本仓库的 GitHub Pages 站点；本机 http(s)://localhost、127.0.0.1 也自动放行。
# 这样即使代理在运行，其它网站也无法在浏览器里读取你的用量/账单数据。
ALLOW_ORIGINS = {
    o.strip().rstrip("/")
    for o in os.environ.get(
        "USAGE_PROXY_ALLOW_ORIGIN", "https://axiryyyy.github.io"
    ).split(",")
    if o.strip()
}
# 用 file:// 直接双击打开 usage.html 时，浏览器会发送 Origin: null。
# 该值可被沙箱 iframe 伪造，所以默认不放行；start-proxy.bat 会设
# USAGE_PROXY_ALLOW_FILE=1 显式开启（仅本机自用场景）。
ALLOW_NULL_ORIGIN = os.environ.get("USAGE_PROXY_ALLOW_FILE", "") == "1"


def _is_local_origin(origin):
    """判断是否为本机页面（任意端口的 localhost / 127.0.0.1）。"""
    try:
        parts = urllib.parse.urlsplit(origin)
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and parts.hostname in (
        "localhost",
        "127.0.0.1",
        "::1",
    )


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

    def _allowed_origin(self):
        """返回本次请求可以回显的 Origin；None 表示不下发任何 CORS 头。

        只放行白名单来源与本机来源，避免任意网站读到你的用量/账单数据。
        没有 Origin 头的请求（curl、同源）不需要 CORS 头，直接返回 None。
        """
        origin = (self.headers.get("Origin") or "").strip()
        if not origin:
            return None
        if origin == "null":
            # 见文件开头 ALLOW_NULL_ORIGIN 的说明
            return "null" if ALLOW_NULL_ORIGIN else None
        if origin in ALLOW_ORIGINS or _is_local_origin(origin):
            return origin
        return None

    def _cors(self):
        allow = self._allowed_origin()
        if allow is None:
            # 未放行的来源：不下发 CORS 头，浏览器会拦下响应，网页拿不到数据
            return
        self.send_header("Access-Control-Allow-Origin", allow)
        self.send_header("Vary", "Origin")
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
        path, _, query = self.path.partition("?")
        route = UPSTREAM.get(path)
        if route is None:
            self._send_json(200, {"ok": True, "routes": sorted(UPSTREAM)})
            return
        url, env_name = route
        if path == "/api/go/records":
            have = {}
            for p in query.split("&"):
                if "=" in p:
                    k, _, v = p.partition("=")
                    have[k.strip()] = v.strip()
            pairs = [p for p in query.split("&") if p]
            for k, v in DEFAULT_RECORDS_QUERY.items():
                if k not in have:
                    pairs.append("%s=%s" % (k, v))
            url = url + "?" + "&".join(pairs)
        # env_name 为空串 = 免鉴权路由（/api/zen/models），此时不需要 Key
        key = get_key(env_name) if env_name else ""
        if not key and env_name:
            self._send_json(503, {"error": "missing_key", "which": env_name})
            return
        accept = self.headers.get("Accept", "")
        if path == "/api/go/records":
            # 上游导出接口对 Accept 敏感：用 text/csv 以外的值会直接 400/403
            accept = "text/csv"
        elif not accept:
            accept = "application/json"
        timeout = RECORDS_TIMEOUT if path == "/api/go/records" else TIMEOUT
        # 免鉴权路由不带 Authorization：给免 Key 接口发一个空的 "Bearer " 头
        # 虽然目前上游也返回 200，但接口一旦收紧就会 401，不如直接不发
        upstream_headers = {
            "Accept": accept,
            "User-Agent": "opencode-go-pricing-usage/1.0",
        }
        if key:
            upstream_headers["Authorization"] = "Bearer " + key
        req = urllib.request.Request(url, headers=upstream_headers)
        attempts = 2 if (path == "/api/go/records" and RETRY_ONCE) else 1
        last_exc = None
        for _ in range(attempts):
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = resp.read()
                    self.send_response(resp.status)
                    self.send_header(
                        "Content-Type", resp.headers.get("Content-Type", "application/json")
                    )
                    self._cors()
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
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
                return
            except Exception as e:
                last_exc = e
                sys.stderr.write("[proxy] upstream error (retrying): %r\n" % (e,))
        sys.stderr.write("[proxy] upstream failed after retries: %r\n" % (last_exc,))
        self._send_json(502, {"error": "upstream_unreachable"})


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("usage-proxy listening on http://%s:%d (localhost only)" % (HOST, PORT))
    print("routes: %s" % (" ".join(sorted(UPSTREAM))))
    print(
        "allowed origins: %s%s"
        % (
            ", ".join(sorted(ALLOW_ORIGINS)) or "(none)",
            " + Origin:null (file://)" if ALLOW_NULL_ORIGIN else "",
        )
    )
    if not ALLOW_NULL_ORIGIN:
        print(
            "提示：如果用 file:// 直接打开 usage.html 报跨域错误，"
            "设 USAGE_PROXY_ALLOW_FILE=1 后重启代理，或改用在线页面。"
        )
    # name 为空串的是免鉴权路由（/api/zen/models），不能算进「缺少 Key」
    missing = [name for _, name in UPSTREAM.values() if name and not get_key(name)]
    if missing:
        print("提示：缺少 %s，代理会照常运行，但对应卡片查不到数。" % (", ".join(missing)))
        print("最简单的办法：关掉本窗口，双击 start-proxy.bat 按提示填 Key。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
