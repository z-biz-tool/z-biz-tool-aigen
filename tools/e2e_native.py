#!/usr/bin/env python3
"""原生壳 E2E 门禁：起真 App → 跑页内驱动 → 对指标做断言（06 §3「端到端」「性能」）。

用法：
    python3 tools/e2e_native.py            # 跑一次，任何一项不达标就退出码 1
    python3 tools/e2e_native.py --keep     # 结束后不杀进程（调试用）

为什么需要脚本而不是 CI 步骤：
- WKWebView 没有可挂的 CDP，release 里 Tauri 注入的 CSP 会挡掉任何外来脚本
  ⇒ 首字节时延、并发下帧间隔只能在 `tauri dev` 的真壳里量
- CI 上跑 GUI 需要 display（Linux 要 xvfb），所以这条先作为**本地/手动门禁**固化，
  CI 里仍由 quality.yml 跑单元/集成/契约/静态检查

隔离：App 的数据目录被指到 /tmp/aigen-e2e-state，不会污染 ~/.z-biz-tool-aigen。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORT = Path("/tmp/aigen-e2e-report.txt")
STATE = Path("/tmp/aigen-e2e-state")
DEVLOG = Path("/tmp/aigen-e2e-dev.log")
MOCK_PORT = 8899

# 阈值来自 06 §4：#5 首字节 ≤2s；#15 并发下无可感知卡顿（这里用最大帧间隔 ≤100ms 近似）
TTFB_MS = 2000
MAX_FRAME_GAP_MS = 100
CONCURRENCY_JOBS = 10


def parse_report(text: str) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for line in text.splitlines():
        m = re.match(r"^E2E\| (\w+) (.*)$", line.strip())
        if not m:
            continue
        tag, rest = m.group(1), m.group(2)
        fields: dict[str, str] = {}
        for kv in re.finditer(r"(\w+)=([^\s]+(?:\s+(?![\w]+=)[^\s]+)*)", rest):
            fields[kv.group(1)] = kv.group(2)
        out[tag] = fields
    return out


def _free_port() -> int:
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _vite_env(port: int) -> dict[str, str]:
    return {
        **os.environ,
        "AIGEN_E2E": "1",
        "AIGEN_E2E_REPORT": str(REPORT),
    }


def _wait_http(port: int, timeout: float) -> bool:
    """vite 默认只绑 localhost（常常是 ::1），所以 127.0.0.1 探不到，两个主机名都要试。"""
    import urllib.request

    # 本机可能挂着 HTTP(S)_PROXY，代理会把对 localhost 的探测变成超时或 502
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        for host in ("localhost", "[::1]", "127.0.0.1"):
            try:
                with opener.open(f"http://{host}:{port}/", timeout=2) as r:
                    body = r.read().decode("utf8", "ignore")
                    if r.status == 200 and "__e2e/driver.js" in body:
                        return True
            except Exception as e:  # noqa: BLE001
                last = e
        time.sleep(0.5)
    print(f"vite 探测失败：{last}", file=sys.stderr)
    return False


def kill_group(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        for _ in range(20):
            if proc.poll() is not None:
                return
            time.sleep(0.5)
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except ProcessLookupError:
        return


def port_in_use(port: int) -> bool:
    import socket

    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="跑完不杀进程")
    args = ap.parse_args()

    procs: list[subprocess.Popen] = []
    if REPORT.exists():
        REPORT.unlink()
    if STATE.exists():
        os.system(f"rm -rf {STATE}")  # 每次都是干净的隔离目录（/tmp 下，非用户数据）
    STATE.mkdir(parents=True, exist_ok=True)

    mock = None
    if port_in_use(MOCK_PORT):
        print(f"· 复用已在跑的 mock 上游 :{MOCK_PORT}")
    else:
        mock = subprocess.Popen(
            [sys.executable, str(ROOT / "tools/mock_provider.py"), "--port", str(MOCK_PORT)],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        procs.append(mock)
        time.sleep(1.2)
        if not port_in_use(MOCK_PORT):
            print("mock 上游起不来", file=sys.stderr)
            return 2

    devlog = open(DEVLOG, "w")
    # 并行会话共用这台机器：5173 常被别的项目占，所以自己挑一个空闲端口，
    # 用 TAURI_CONFIG 覆盖 devUrl，再直接 cargo run（等价于 tauri dev，但不依赖固定端口）
    port = _free_port()
    vite = subprocess.Popen(
        ["npx", "vite", "--port", str(port), "--strictPort"],
        cwd=ROOT, env=_vite_env(port), stdout=open("/tmp/aigen-e2e-vite.log", "w"),
        stderr=subprocess.STDOUT, start_new_session=True,
    )
    procs.append(vite)
    if not _wait_http(port, 40):
        print("vite 起不来，看 /tmp/aigen-e2e-vite.log", file=sys.stderr)
        return 2

    app_env = {
        **os.environ,
        "AIGEN_DATA_DIR": str(STATE),
        "TAURI_CONFIG": json.dumps({"build": {"devUrl": f"http://localhost:{port}/"}}),
    }
    app = subprocess.Popen(
        ["cargo", "run"],
        cwd=ROOT / "src-tauri", env=app_env, stdout=devlog, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    procs.append(app)

    print(f"· 真壳启动中（vite :{port}，首次编译可能要几分钟）…")
    deadline = time.time() + 480
    report_text = ""
    while time.time() < deadline:
        if app.poll() is not None and vite.poll() is not None:
            print(f"进程提前退出，看 {DEVLOG} 与 /tmp/aigen-e2e-vite.log", file=sys.stderr)
            return 2
        if REPORT.exists():
            report_text = REPORT.read_text()
            if "DONE in" in report_text:
                break
        time.sleep(1.0)
    else:
        print(f"等 E2E 报告超时；进度见 {DEVLOG} 与 {REPORT}", file=sys.stderr)
        if not args.keep:
            for pr in procs:
                kill_group(pr)
        return 3

    data = parse_report(report_text)
    checks: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append((name, bool(ok), detail))

    def flag(v) -> bool:
        return str(v).lower() == "true"

    boot = data.get("BOOT", {})
    check("前端在真壳里挂载", boot.get("mounted") == "true", str(boot))

    prov = data.get("PROVIDER", {})
    check("密钥不在 IPC 回传里", flag(prov.get("keyOnWire")) is False, str(prov))
    check("新建服务商拿到自己的 id", bool(prov.get("id")), str(prov))

    st = data.get("STREAM", {})
    ttfb = st.get("ttfbMs")
    check(
        f"首字节 ≤{TTFB_MS}ms（06 §4 #5）",
        ttfb is not None and str(ttfb).isdigit() and 0 < int(ttfb) <= TTFB_MS,
        f"ttfbMs={ttfb}",
    )
    check("流式逐段增长（不是一次性甩出）", (st.get("growSteps") or "[]").count(",") >= 1, str(st.get("growSteps")))
    check("流式终态文本正确", "你好，世界" in (st.get("text") or ""), str(st.get("text")))
    check("usage 回传并入任务态", st.get("usage") not in (None, "null"), f"usage={st.get('usage')}")

    img = data.get("IMAGE", {})
    check("图片结果落盘为文件引用（非内联 base64）", (img.get("refs") or "").startswith('["results/'), str(img.get("refs")))
    # 本用例把数据目录隔离到 /tmp，而 asset scope 只允许 $HOME/.z-biz-tool-aigen/results/**
    # ⇒ 越界必须读不到。正向证据来自此前在默认目录跑同一驱动：assetRender=loaded 1x1
    check(
        "asset 协议按 scope 拒绝越界路径",
        (img.get("assetRender") or "") == "blocked-or-error",
        f"assetRender={img.get('assetRender')}",
    )

    hist = data.get("HISTORY", {})
    check("历史里没有内联 base64（06 §4 #7）", hist.get("inlineBase64") == "no", str(hist))
    check("历史已落盘可读", hist.get("total") not in (None, "0"), f"total={hist.get('total')}")

    con = data.get("CONCURRENCY", {})
    check(
        f"{CONCURRENCY_JOBS} 个并发任务全部收敛（06 §4 #2/#15）",
        con.get("settled") == con.get("jobs") == str(CONCURRENCY_JOBS),
        f"jobs={con.get('jobs')} settled={con.get('settled')}",
    )
    gap_raw = (con.get("maxFrameGapMs") or "")
    try:
        gap_ms = float(gap_raw)
    except ValueError:
        gap_ms = 1e9
    check(
        f"并发下最大帧间隔 ≤{MAX_FRAME_GAP_MS}ms（06 §4 #15）",
        con.get("frames") not in (None, "0") and gap_ms <= MAX_FRAME_GAP_MS,
        f"frames={con.get('frames')} maxFrameGapMs={gap_raw}",
    )

    cancel = data.get("CANCEL", {})
    check(
        "轮询中的任务可取消",
        flag(cancel.get("acknowledged")) and cancel.get("status") == "cancelled",
        f"ack={cancel.get('acknowledged')} status={cancel.get('status')} afterMs={cancel.get('afterMs')}",
    )

    err = data.get("ERROR")
    check("驱动全程无异常", err is None, str(err))

    print("\nE2E 报告：")
    for line in report_text.splitlines():
        print("  " + line)
    print("\n门禁结果：")
    failed = 0
    for name, ok, detail in checks:
        print(f"  {'PASS' if ok else 'FAIL':4}  {name}" + (f"   [{detail}]" if detail and not ok else ""))
        failed += 0 if ok else 1
    print(f"\n{len(checks) - failed}/{len(checks)} 项通过；隔离数据目录 {STATE}")

    if not args.keep:
        for p in reversed(procs):
            kill_group(p)
    devlog.close()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
