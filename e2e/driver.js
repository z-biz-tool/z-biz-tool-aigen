// 原生壳 E2E 驱动（只在 `vite serve` 下被注入，dist 里不会有它；带 ?e2e=1 才跑）。
//
// 为什么需要它：WKWebView 没有可挂的 CDP，release 里 Tauri 注入的 CSP 也会挡掉外来脚本，
// 所以"首字节时延/并发下帧间隔"这类只能在 dev 真壳里量。06 §3 的「端到端」「性能」两格靠它落地。
// 结果通过 vite dev 中间件 POST 回磁盘（tools/e2e_native.py 读它并做门禁断言）。
(() => {
  // 只有 vite dev 中间件在 AIGEN_E2E=1 时才会把本文件发过来；否则 404，这里根本不会被执行
  const I = window.__TAURI_INTERNALS__;
  if (!I || !I.invoke) {
    console.warn("e2e: 没有 Tauri IPC，跳过");
    return;
  }

  const lines = [];
  const t0 = performance.now();
  const post = (final) =>
    fetch("/__e2e/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n"), final: !!final }),
    }).catch(() => {});

  // 边跑边回传：真壳里任何一步抛错，前面的数据都还在
  const log = (msg) => {
    lines.push(`E2E| ${msg}`);
    post(false);
  };
  const sleep = (n) => new Promise((r) => setTimeout(r, n));
  const listen = (event, fn) =>
    I.invoke("plugin:event|listen", {
      event,
      target: { kind: "Any" },
      handler: I.transformCallback((msg) => fn(msg && msg.payload !== undefined ? msg.payload : msg)),
    });

  const BASE = "http://127.0.0.1:8899/v1";
  const stateOf = (id, kind, over) =>
    Object.assign(
      {
        requestId: id,
        kind,
        status: "succeeded",
        model: null,
        partial: "",
        progress: null,
        resultRefs: [],
        preview: [],
        textResult: null,
        recordId: null,
        usage: null,
        error: null,
        createdAt: "",
        updatedAt: "",
      },
      over
    );

  async function boot() {
    const root = document.getElementById("root");
    log(`BOOT mounted=${!!root && root.children.length > 0} hidden=${document.hidden}`);
  }

  async function provider() {
    const view = await I.invoke("save_api_config", {
      providerId: null,
      name: "E2E",
      baseUrl: BASE,
      apiKey: "sk-TEST-e2e-1234567890",
      capabilities: ["text", "image", "video", "ppt"],
      models: ["gpt-4o-mini", "dall-e-3"],
    });
    const wire = JSON.stringify(view);
    const mine = view.providers.filter((p) => p.name === "E2E")[0];
    log(
      `PROVIDER id=${mine && mine.id} masked=${mine && mine.key_masked} keyOnWire=${wire.includes(
        "sk-TEST-e2e-1234567890"
      )}`
    );
    return mine.id;
  }

  async function streaming(pid) {
    const started = performance.now();
    let ttfb = null;
    const steps = [];
    let terminal = null;
    const ack = await I.invoke("submit_generation", {
      req: {
        kind: "text",
        prompt: "e2e 流式",
        providerId: pid,
        model: "gpt-4o-mini",
        params: { stream: true, temperature: 0.4, maxTokens: 128 },
      },
    });
    await listen(`aigen://state/${ack.requestId}`, (s) => {
      if (s.partial) {
        if (ttfb === null) ttfb = Math.round(performance.now() - started);
        if (steps[steps.length - 1] !== s.partial.length) steps.push(s.partial.length);
      }
      if (s.status !== "submitting" && s.status !== "streaming") terminal = s;
    });
    for (let i = 0; i < 100 && !terminal; i++) await sleep(30);
    log(
      `STREAM ttfbMs=${ttfb} growSteps=${JSON.stringify(steps)} text=${
        terminal && terminal.textResult
      } usage=${terminal && terminal.usage && terminal.usage.completion_tokens}`
    );
  }

  async function imageAndAsset(pid) {
    const ack = await I.invoke("submit_generation", {
      req: { kind: "image", prompt: "一只橘猫", providerId: pid, model: null, params: { count: 2, size: "1024x1024" } },
    });
    let done = null;
    await listen(`aigen://state/${ack.requestId}`, (s) => {
      if (["succeeded", "failed", "cancelled"].includes(s.status)) done = s;
    });
    for (let i = 0; i < 120 && !done; i++) await sleep(50);
    if (!done || done.status !== "succeeded") {
      log(`IMAGE status=${done && done.status} code=${done && done.error && done.error.code}`);
      return;
    }
    const dir = await I.invoke("data_dir_path");
    const abs = `${dir}/${done.resultRefs[0]}`;
    const url = I.convertFileSrc ? I.convertFileSrc(abs) : null;
    const rendered = await new Promise((resolve) => {
      if (!url) return resolve("no-convertFileSrc");
      const img = new Image();
      img.onload = () => resolve(`loaded ${img.naturalWidth}x${img.naturalHeight}`);
      img.onerror = () => resolve("blocked-or-error");
      img.src = url;
      setTimeout(() => resolve("timeout"), 4000);
    });
    log(`IMAGE refs=${JSON.stringify(done.resultRefs)} assetRender=${rendered}`);
    const hist = await I.invoke("list_history", { kind: null, keyword: null, page: 0, size: 50 });
    log(
      `HISTORY total=${hist.total} stored=${hist.stored} kinds=${hist.items
        .map((i) => i.kind)
        .join(",")} inlineBase64=${JSON.stringify(hist.items).includes("base64,") ? "YES(BUG)" : "no"}`
    );
  }

  async function concurrency() {
    const frames = [];
    let stop = false;
    const tick = (t) => {
      frames.push(t);
      if (!stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const acks = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        I.invoke("submit_generation", {
          req: { kind: "text", prompt: `并发 ${i}`, providerId: null, model: "gpt-4o-mini", params: {} },
        })
      )
    );
    const settled = new Set();
    await Promise.all(
      acks.map((a) =>
        listen(`aigen://state/${a.requestId}`, (s) => {
          if (["succeeded", "failed", "cancelled"].includes(s.status)) settled.add(a.requestId);
        })
      )
    );
    for (let i = 0; i < 200 && settled.size < acks.length; i++) await sleep(30);
    stop = true;
    let maxGap = 0;
    for (let i = 1; i < frames.length; i++) maxGap = Math.max(maxGap, frames[i] - frames[i - 1]);
    log(
      `CONCURRENCY jobs=${acks.length} settled=${settled.size} frames=${frames.length} maxFrameGapMs=${maxGap.toFixed(1)}`
    );
  }

  async function cancelWhilePolling(pid) {
    const ack = await I.invoke("submit_generation", {
      req: { kind: "video", prompt: "x", providerId: pid, model: null, params: { taskId: `slow-${Date.now()}` } },
    });
    let terminal = null;
    await listen(`aigen://state/${ack.requestId}`, (s) => {
      if (["succeeded", "failed", "cancelled"].includes(s.status)) terminal = s;
    });
    await sleep(500);
    const ok = await I.invoke("cancel_generation", { requestId: ack.requestId });
    const started = Date.now();
    for (let i = 0; i < 100 && !terminal; i++) await sleep(30);
    log(
      `CANCEL acknowledged=${ok} status=${terminal && terminal.status} code=${
        terminal && terminal.error && terminal.error.code
      } afterMs=${Date.now() - started}`
    );
  }

  (async () => {
    try {
      await sleep(500);
      await boot();
      const pid = await provider();
      await streaming(pid);
      await imageAndAsset(pid);
      await concurrency();
      await cancelWhilePolling(pid);
    } catch (e) {
      log(`ERROR ${(e && (e.stack || e.message)) || JSON.stringify(e)}`);
    }
    log(`DONE in ${Math.round(performance.now() - t0)}ms`);
    await post(true);
  })();
})();
