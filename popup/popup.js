/**
 * Popup：备用下载界面。打开扩展弹窗时读取当前标签页（视频或番剧），展示清晰度列表。
 */
(function () {
  'use strict';

  const statusEl = document.getElementById('status');
  const mainEl = document.getElementById('main');
  const titleEl = document.getElementById('title');
  const selEl = document.getElementById('quality');
  const goEl = document.getElementById('go');
  const cancelEl = document.getElementById('cancel');
  const progEl = document.getElementById('progress');
  const floatToggle = document.getElementById('floatToggle');

  let info = null;
  let downloading = false;

  // 悬浮窗开关：写入 storage，并立刻通知所有 B 站标签页（不依赖页面是否已刷新）
  chrome.storage.local.get({ showFloatBtn: true }, function (data) {
    floatToggle.checked = data.showFloatBtn !== false;
  });
  floatToggle.addEventListener('change', function () {
    const show = !!floatToggle.checked;
    chrome.storage.local.set({ showFloatBtn: show }, function () {
      chrome.runtime.sendMessage({ type: 'SET_FLOAT_VISIBLE', show: show }, function () {
        void chrome.runtime.lastError;
      });
    });
  });

  function setDownloading(on) {
    downloading = on;
    goEl.disabled = on;
    selEl.disabled = on;
    if (on) cancelEl.classList.remove('hidden');
    else cancelEl.classList.add('hidden');
  }

  function parseUrl(url) {
    const bv = url.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (bv) return { bvid: bv[1] };
    const ep = url.match(/\/bangumi\/play\/ep(\d+)/);
    if (ep) return { epId: ep[1] };
    const ss = url.match(/\/bangumi\/play\/ss(\d+)/);
    if (ss) return { seasonId: ss[1] };
    return null;
  }

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  async function init() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tabs[0] && tabs[0].url ? tabs[0].url : '';
      const page = parseUrl(url);
      if (!page) {
        statusEl.textContent = '请先打开一个 B 站视频或番剧页面';
        return;
      }
      statusEl.textContent = '加载中…';
      const res = await send(Object.assign({ type: 'GET_INFO' }, page));
      if (!res || !res.ok) throw new Error((res && res.error) || '获取失败');

      info = res.data;
      titleEl.textContent = (info.title || '') + (info.owner ? ' — ' + info.owner : '');
      selEl.innerHTML = '';
      info.qualities.forEach(function (q) {
        const o = document.createElement('option');
        o.value = String(q.qn);
        o.textContent = q.desc;
        selEl.appendChild(o);
      });
      if (info.qualities.length) selEl.value = String(info.qualities[0].qn);

      statusEl.classList.add('hidden');
      mainEl.classList.remove('hidden');
    } catch (e) {
      statusEl.textContent = '错误：' + e.message;
    }
  }

  goEl.addEventListener('click', async function () {
    if (!info || downloading) return;
    setDownloading(true);
    progEl.textContent = '正在准备…';
    try {
      const res = await send({
        type: 'DOWNLOAD',
        bvid: info.bvid,
        cid: info.cid,
        epId: info.epId,
        qn: Number(selEl.value),
        title: info.title,
      });
      if (!res || !res.ok) throw new Error((res && res.error) || '启动失败');
    } catch (e) {
      progEl.textContent = '错误：' + e.message;
      setDownloading(false);
    }
  });

  cancelEl.addEventListener('click', async function () {
    if (!downloading) return;
    cancelEl.disabled = true;
    progEl.textContent = '正在取消…';
    try {
      await send({ type: 'CANCEL' });
    } catch (e) {
      /* 忽略 */
    }
    progEl.textContent = '已取消，可以重新下载';
    setDownloading(false);
    cancelEl.disabled = false;
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === 'PROGRESS') {
      let text = msg.text || '';
      if (msg.pct != null && msg.stage !== 'done') text += ' (' + msg.pct + '%)';
      progEl.textContent = text;
    } else if (msg.type === 'DONE') {
      progEl.textContent = '✅ 已完成，文件已开始保存';
      setDownloading(false);
    } else if (msg.type === 'ERROR') {
      progEl.textContent = '❌ ' + (msg.error || '失败');
      setDownloading(false);
    } else if (msg.type === 'CANCELLED') {
      progEl.textContent = '已取消，可以重新下载';
      setDownloading(false);
    }
  });

  init();
})();
