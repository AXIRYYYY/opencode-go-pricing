@echo off
rem 设置窗口标题，方便分清这个窗口是干什么的
title 用量代理 usage-proxy (8787) - opencodego价格自动排序
rem 可选：只有「分模型明细 / Zen 校验」需要它。双击运行，不要关闭弹出的窗口
cd /d "%~dp0"

rem ---- 找 Python ----
set "PY="
where python >nul 2>nul
if not errorlevel 1 set "PY=python"
if not defined PY (
  where py >nul 2>nul
  if not errorlevel 1 set "PY=py"
)
if not defined PY (
  echo [失败] 没找到 Python。
  echo 请先去 python.org 装 Python 3，安装时勾选 Add python to PATH，装好后重跑本脚本。
  pause
  exit /b 1
)

rem ---- 已有 Key 文件就直接启动 ----
if exist "usage-proxy.keys.json" (
  echo [ok] 已有 usage-proxy.keys.json，直接启动。
  echo      想换 Key 就用记事本改这个文件，或删掉它重跑本脚本。
  goto :start
)

echo 第一次运行，先存几个 Key（只保存在本机 usage-proxy.keys.json，不上传、不提交）。
echo Go 卡现在可以直接连官方接口，代理里的 Go Key 只作备用。
echo.

rem ---- 尝试从本机 auth.json 自动读取 Go Key ----
set "GOKEY_AUTO="
for /f "delims=" %%K in ('powershell -NoProfile -Command "try { $base = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { \"$env:USERPROFILE\.local\share\" }; $k = (Get-Content (Join-Path $base 'opencode\auth.json') -Raw -ErrorAction Stop | ConvertFrom-Json).'opencode-go'.key; if ($k) { $k.Trim() } } catch { }"') do set "GOKEY_AUTO=%%K"

if defined GOKEY_AUTO (
  echo [ok] 已从本机 auth.json 自动找到 Go Key（备用，不填也能直连）。
  set "GOKEY=%GOKEY_AUTO%"
) else (
  echo 没找到本机 auth.json；Go Key 现在可以不填，直接回车跳过（仅作直连失败时的备用）。
  echo 一般在 %USERPROFILE%\.local\share\opencode\auth.json 里 opencode-go 那一项。
  set /p "GOKEY=请粘贴 Go Key（可留空，Go 卡默认直连）: "
)
set /p "SVCKEY=请粘贴服务账号 Key：oc_sk- 开头，Console 里创建，用于「分模型明细」，不用可直接回车跳过: "
set /p "DSKEY=请粘贴 DeepSeek Key（sk- 开头，不用可直接回车跳过）: "

powershell -NoProfile -Command "$d=@{}; if ($env:GOKEY.Trim() -ne '') { $d['OPENCODE_GO_KEY']=$env:GOKEY.Trim() }; if ($env:SVCKEY.Trim() -ne '') { $d['OPENCODE_SERVICE_KEY']=$env:SVCKEY.Trim() }; if ($env:DSKEY.Trim() -ne '') { $d['DEEPSEEK_API_KEY']=$env:DSKEY.Trim() }; $d | ConvertTo-Json | Out-File -Encoding utf8 'usage-proxy.keys.json'"
echo [ok] 已保存到 usage-proxy.keys.json。

:start

rem CORS: only allow the file:// opened usage.html (Origin: null) on this machine.
set "USAGE_PROXY_ALLOW_FILE=1"
echo.
echo 正在启动本地代理 http://127.0.0.1:8787（可选）—— 不要关这个窗口；只有「分模型明细 / Zen 校验」需要它。
echo.
%PY% usage-proxy.py
pause
