/**
 * Offscreen Document：下载音视频分片 → ffmpeg.wasm 无损合并（-c copy）→ 触发下载。
 * 说明：service worker 内存受限且无 DOM，因此把耗时/吃内存的合并放到这里。
 * 这里直接用 @ffmpeg/core 单线程内核（主线程运行），避开 MV3 禁止 blob worker 的限制。
 */
(function () {
  'use strict';

  let core = null;
  let corePromise = null;
  let busy = false;
  let abortCtrl = null;
  let cancelled = false;

  function report(msg) {
    try {
      chrome.runtime
        .sendMessage({ type: 'PROGRESS', stage: msg.stage, pct: msg.pct, text: msg.text })
        .catch(function () {});
    } catch (e) {
      /* 忽略 */
    }
  }

  function throwIfCancelled() {
    if (cancelled) {
      const err = new Error('已取消');
      err.name = 'AbortError';
      throw err;
    }
  }

  // 加载 ffmpeg.wasm 核心（单线程，在主线程运行，不创建 worker）
  function loadCore() {
    if (core) return Promise.resolve(core);
    if (corePromise) return corePromise;
    corePromise = (async function () {
      const factory = self.createFFmpegCore || self.FFmpegCore;
      if (!factory) {
        throw new Error('找不到 createFFmpegCore：请先运行 download-vendor.bat 下载 vendor/ 依赖');
      }
      // 自己把 wasm 读成 ArrayBuffer 直接传入，绕开 Emscripten 的 wasm 自动定位逻辑
      // （否则它会回退去加载 manifest.json，被 Chrome 拒绝）
      const wasmURL = chrome.runtime.getURL('vendor/ffmpeg-core.wasm');
      const wasmResp = await fetch(wasmURL);
      if (!wasmResp.ok) throw new Error('读取 ffmpeg-core.wasm 失败: HTTP ' + wasmResp.status);
      const wasmBinary = await wasmResp.arrayBuffer();
      core = await factory({
        wasmBinary: wasmBinary,
        locateFile: function (path) {
          return chrome.runtime.getURL('vendor/' + path);
        },
      });
      return core;
    })();
    return corePromise;
  }

  async function downloadToMemory(url, label) {
    report({ stage: 'download', text: '下载' + label + '中…' });
    const signal = abortCtrl && abortCtrl.signal;
    const res = await fetch(url, { signal: signal });
    if (!res.ok) throw new Error('下载' + label + '失败: HTTP ' + res.status);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      throwIfCancelled();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) {
        report({
          stage: 'download',
          pct: Math.round((received / total) * 100),
          text: '下载' + label + ' ' + (received / 1048576).toFixed(1) + ' MB',
        });
      }
    }
    const buf = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.length;
    }
    return buf;
  }

  function sanitize(name) {
    return String(name || 'video').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120);
  }

  function resetJobState() {
    busy = false;
    cancelled = false;
    abortCtrl = null;
  }

  function requestCancel() {
    cancelled = true;
    if (abortCtrl) {
      try {
        abortCtrl.abort();
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  async function mux(req) {
    busy = true;
    cancelled = false;
    abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    try {
      report({ stage: 'load', text: '正在加载 ffmpeg（首次较慢）…' });
      const c = await loadCore();
      throwIfCancelled();

      const video = await downloadToMemory(req.videoUrl, '视频');
      throwIfCancelled();
      const audio = await downloadToMemory(req.audioUrl, '音频');
      throwIfCancelled();

      report({ stage: 'mux', text: '合并音视频中…' });
      c.FS.writeFile('video.m4s', video);
      c.FS.writeFile('audio.m4s', audio);
      // -c copy 为无损重封装，不重编码；exec 返回退出码，0 表示成功
      // 注意：wasm 执行中难以中断，卡住时由 background 关闭 offscreen 文档强制终止
      const ret = await c.exec('-y', '-i', 'video.m4s', '-i', 'audio.m4s', '-c', 'copy', 'output.mp4');
      throwIfCancelled();
      if (ret !== 0) throw new Error('ffmpeg 合并失败，退出码 ' + ret);

      report({ stage: 'save', text: '读取合并结果…' });
      const data = c.FS.readFile('output.mp4');

      report({ stage: 'save', text: '触发保存…' });
      const blob = new Blob([data], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = sanitize(req.title) + '.mp4';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);

      report({ stage: 'done', text: '完成' });
      try {
        chrome.runtime.sendMessage({ type: 'DONE' }).catch(function () {});
      } catch (e) {
        /* 忽略 */
      }
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      const isAbort =
        cancelled ||
        (e && (e.name === 'AbortError' || /abort|已取消/i.test(msg)));
      if (isAbort) {
        report({ stage: 'error', text: '已取消' });
        try {
          chrome.runtime.sendMessage({ type: 'CANCELLED' }).catch(function () {});
        } catch (e2) {
          /* 忽略 */
        }
      } else {
        report({ stage: 'error', text: msg });
        try {
          chrome.runtime
            .sendMessage({ type: 'ERROR', error: msg })
            .catch(function () {});
        } catch (e2) {
          /* 忽略 */
        }
      }
    } finally {
      resetJobState();
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type === 'MUX') {
      if (busy) {
        sendResponse({ ok: false, error: '已有下载任务进行中，请先取消' });
        return;
      }
      mux(msg);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'CANCEL') {
      requestCancel();
      sendResponse({ ok: true });
    }
  });
})();
