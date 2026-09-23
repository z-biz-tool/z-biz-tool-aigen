#!/usr/bin/env python3
"""可编程 mock 上游（doc/优化方案/06 §2 的"mock LLM 服务"夹具）。

只服务 127.0.0.1，永远不碰真实 provider：
- 所有测试用假 key（sk-TEST-*），严禁调用真实付费端点（06 §6 R8）
- 能按需返回 SSE 流、429 重试、异步视频任务、损坏响应、慢响应，用于量化验收目标

用法：
    python3 tools/mock_provider.py --port 8899
    # Base URL 填 http://127.0.0.1:8899/v1（validate_config 允许 http 回环，专为本地联调开口）
"""

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# 1x1 PNG
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000a49444154789c6360000002000100ffff03000006000557034c0000000049454e44ae426082"
)

state = {
    "first_token_ms": 120,   # 模拟上游首字节时延
    "chunk_gap_ms": 60,
    "chunks": ["你好", "，世界", "。"],
    "flaky_hits": {},        # prompt -> 已经 429 过的次数
    "video_hits": {},        # task_id -> 查询次数
    "requests": [],
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ---- 基础设施 ----
    def log_message(self, *args):  # 静音默认日志，改用自己的记录
        pass

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _note(self, line):
        stamp = time.strftime("%H:%M:%S") + f".{int(time.time() * 1000) % 1000:03d}"
        state["requests"].append(line)
        print(f"[mock {stamp}] {line}", flush=True)

    # ---- 路由 ----
    def do_GET(self):
        path = urlparse(self.path).path
        if path.endswith("/models"):
            self._note("GET models")
            return self._json(
                200,
                {"data": [{"id": "gpt-4o"}, {"id": "gpt-4o-mini"}, {"id": "dall-e-3"}]},
            )
        if path.endswith(".png"):
            self._note(f"GET {path} (结果留存)")
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(PNG)))
            self.end_headers()
            return self.wfile.write(PNG)
        if "/video/generations/" in path:
            task = path.rsplit("/", 1)[-1]
            hits = state["video_hits"].get(task, 0) + 1
            state["video_hits"][task] = hits
            self._note(f"GET video task {task} #{hits}")
            if hits < 3:
                return self._json(200, {"status": "processing"})
            return self._json(
                200, {"status": "succeeded", "data": {"url": f"{self._base()}/final.mp4"}}
            )
        self._json(404, {"error": {"message": "not found"}})

    def _base(self):
        return f"http://{self.headers.get('Host', '127.0.0.1')}"

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            req = json.loads(raw or b"{}")
        except Exception:
            req = {}
        auth = self.headers.get("Authorization", "")
        prompt = str(req.get("prompt", ""))
        # 只记录 key 的前后缀，证明"密钥确实被带到上游"，但不把明文留在日志里
        key_shape = f"{auth[:10]}…{auth[-4:]}" if len(auth) > 16 else auth
        self._note(
            f"POST {path} stream={req.get('stream')} n={req.get('n')} auth={key_shape!r}"
            + (f" prompt={prompt[:24]!r}" if prompt else "")
        )

        if "images" in path:
            n = int(req.get("n") or 1)
            data = [
                {"url": f"{self._base()}/img-{i}.png"} if i % 2 == 0 else {"b64_json": "aGVsbG8="}
                for i in range(n)
            ]
            return self._json(200, {"data": data})

        if "video" in path:
            return self._json(200, {"task_id": f"task-{int(time.time())}"})

        if "chat/completions" not in path:
            return self._json(404, {"error": {"message": "unknown path"}})

        # 按需制造各类失败，用来验证错误分级与重试
        if "boom500" in prompt:
            return self._json(500, {"error": {"message": "boom"}})
        if "policy" in prompt:
            return self._json(400, {"error": {"code": "content_policy_violation"}})
        if "badkey" in prompt:
            return self._json(401, {"error": {"message": f"invalid key {auth}"}})
        if "flaky" in prompt and state["flaky_hits"].get(prompt, 0) < 1:
            state["flaky_hits"][prompt] = 1
            return self._json(429, {"error": {"message": "slow down"}})
        if "garbage" in prompt:
            return self._json(200, {"unexpected": True})

        if req.get("stream"):
            return self._sse(prompt)
        time.sleep(state["first_token_ms"] / 1000)
        return self._json(
            200,
            {
                "choices": [{"message": {"role": "assistant", "content": "".join(state["chunks"])}}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 22},
            },
        )

    def _sse(self, prompt):
        """标准 OpenAI 风格 SSE：首块延迟 = first_token_ms，之后每块间隔 chunk_gap_ms"""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def emit(obj):
            chunk = f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode()
            self.wfile.write(b"%X\r\n" % len(chunk))
            self.wfile.write(chunk + b"\r\n")
            self.wfile.flush()

        time.sleep(state["first_token_ms"] / 1000)
        emit({"choices": [{"delta": {"role": "assistant"}, "index": 0}]})
        for piece in state["chunks"]:
            emit({"choices": [{"delta": {"content": piece}, "index": 0}]})
            time.sleep(state["chunk_gap_ms"] / 1000)
        emit({"choices": [], "usage": {"prompt_tokens": 11, "completion_tokens": 22}})
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()
        self._note("SSE 完成")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8899)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"mock provider on http://127.0.0.1:{args.port}/v1", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
