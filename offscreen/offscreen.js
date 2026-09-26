/**
 * Offscreen Document：下载音视频分片 → ffmpeg.wasm 无损合并（-c copy）→ 触发下载。
 * 取消任务时由 background 直接关闭本文档（可打断卡住的 fetch / wasm）。
 */
(function () {
  'use strict';

  let core = null;
  let corePromise = null;
  let busy = false;

  function report(msg) {
    try {
      chrome.runtime
        .sendMessage({ type: 'PROGRESS', stage: msg.stage, pct: msg.pct, text: msg.text })
        .catch(function () {});
    } catch (e) {
      /* 忽略 */
    }
  }

  function loadCore() {
    if (core) return Promise.resolve(core);
    if (corePromise) return corePromise;
    corePromise = (async function () {
      const factory = self.createFFmpegCore;
      if (!factory) {
        throw new Error('找不到 createFFmpegCore：请确认 vendor/ffmpeg-core.js 已随扩展打包');
      }
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
    const res = await fetch(url);
    if (!res.ok) throw new Error('下载' + label + '失败: HTTP ' + res.status);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
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

  async function mux(req) {
    busy = true;
    try {
      report({ stage: 'load', text: '正在加载 ffmpeg（首次较慢）…' });
      const c = await loadCore();

      const video = await downloadToMemory(req.videoUrl, '视频');
      const audio = await downloadToMemory(req.audioUrl, '音频');

      report({ stage: 'mux', text: '合并音视频中…' });
      c.FS.writeFile('video.m4s', video);
      c.FS.writeFile('audio.m4s', audio);
      const ret = await c.exec('-y', '-i', 'video.m4s', '-i', 'audio.m4s', '-c', 'copy', 'output.mp4');
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
      report({ stage: 'error', text: msg });
      try {
        chrome.runtime.sendMessage({ type: 'ERROR', error: msg }).catch(function () {});
      } catch (e2) {
        /* 忽略 */
      }
    } finally {
      busy = false;
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type !== 'MUX') return;
    if (busy) {
      sendResponse({ ok: false, error: '已有下载任务进行中，请先取消' });
      return;
    }
    mux(msg);
    sendResponse({ ok: true });
  });
})();
