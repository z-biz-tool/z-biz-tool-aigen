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
CONCURRENCY_JOBS = 5


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
    import urllib.request

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.5)
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
        "TAURI_CONFIG": json.dumps({"build": {"devUrl": f"http://localhost:{port}"}}),
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
