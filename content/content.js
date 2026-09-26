/**
 * 内容脚本：在 B 站视频/番剧页注入悬浮"下载"按钮与清晰度选择面板。
 * 支持 /video/BV... 与 /bangumi/play/ep...|/ss...
 */
(function () {
  'use strict';

  /** 从当前 URL（及页面内嵌数据）解析下载标识 */
  function parsePage() {
    const path = location.pathname;
    const bv = path.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (bv) return { bvid: bv[1] };

    const ep = path.match(/\/bangumi\/play\/ep(\d+)/);
    if (ep) return { epId: ep[1] };

    const ss = path.match(/\/bangumi\/play\/ss(\d+)/);
    if (ss) {
      // ss 页尽量再从 __NEXT_DATA__ / 当前选集链接抠出具体 ep
      const fromPage = guessEpIdFromPage();
      if (fromPage) return { epId: fromPage, seasonId: ss[1] };
      return { seasonId: ss[1] };
    }
    return null;
  }

  function guessEpIdFromPage() {
    try {
      const next = document.getElementById('__NEXT_DATA__');
      if (next && next.textContent) {
        const m = next.textContent.match(/"ep_id"\s*:\s*(\d+)/);
        if (m) return m[1];
      }
    } catch (e) { /* ignore */ }
    const active = document.querySelector(
      '.episode-item--active a[href*="/ep"], .ep-item.active a[href*="/ep"], a[href*="/bangumi/play/ep"].router-link-active'
    );
    if (active) {
      const m = (active.getAttribute('href') || '').match(/\/ep(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  function pageKey(p) {
    if (!p) return '';
    return p.bvid || ('ep:' + (p.epId || '') + '|ss:' + (p.seasonId || ''));
  }

  let page = parsePage();
  if (!page) return;

  /* ---------- 悬浮按钮 ---------- */
  const btn = document.createElement('div');
  btn.id = 'bili-dl-btn';
  btn.textContent = '⏬ 下载';
  btn.style.display = 'none'; // 等 storage 读完再决定是否显示，避免闪一下
  document.documentElement.appendChild(btn);

  /* ---------- 面板 ---------- */
  const panel = document.createElement('div');
  panel.id = 'bili-dl-panel';
  panel.style.display = 'none';
  panel.innerHTML =
    '<div class="bili-dl-title">加载中…</div>' +
    '<select class="bili-dl-quality"></select>' +
    '<div class="bili-dl-actions">' +
    '<button class="bili-dl-go" type="button">开始下载</button>' +
    '<button class="bili-dl-cancel" type="button" style="display:none">取消</button>' +
    '</div>' +
    '<div class="bili-dl-progress"></div>';
  document.documentElement.appendChild(panel);

  const titleEl = panel.querySelector('.bili-dl-title');
  const selEl = panel.querySelector('.bili-dl-quality');
  const goEl = panel.querySelector('.bili-dl-go');
  const cancelEl = panel.querySelector('.bili-dl-cancel');
  const progEl = panel.querySelector('.bili-dl-progress');

  let info = null;
  let downloading = false;
  let floatVisible = true;

  function applyFloatVisibility(show) {
    floatVisible = !!show;
    btn.style.display = floatVisible ? '' : 'none';
    if (!floatVisible) {
      panel.style.display = 'none';
    }
  }

  chrome.storage.local.get({ showFloatBtn: true }, function (data) {
    applyFloatVisibility(data.showFloatBtn !== false);
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes.showFloatBtn) {
      applyFloatVisibility(changes.showFloatBtn.newValue !== false);
    }
  });

  function setDownloading(on) {
    downloading = on;
    goEl.disabled = on;
    cancelEl.style.display = on ? 'block' : 'none';
    selEl.disabled = on;
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

  /** 番剧切集时 URL 会变但页面不整页刷新，需要重置状态 */
  function syncPageIfChanged() {
    const next = parsePage();
    if (!next) return false;
    if (pageKey(next) !== pageKey(page)) {
      page = next;
      info = null;
      progEl.textContent = '';
      titleEl.textContent = '加载中…';
      selEl.innerHTML = '';
      return true;
    }
    return false;
  }

  btn.addEventListener('click', async function () {
    syncPageIfChanged();
    const willShow = panel.style.display === 'none';
    panel.style.display = willShow ? 'block' : 'none';
    if (willShow && !info && !downloading) {
      await loadInfo();
    }
  });

  async function loadInfo() {
    titleEl.textContent = '加载中…';
    try {
      const res = await send(Object.assign({ type: 'GET_INFO' }, page));
      if (!res || !res.ok) throw new Error((res && res.error) || '获取失败');
      info = res.data;
      renderInfo();
    } catch (e) {
      titleEl.textContent = '错误：' + e.message;
    }
  }

  function renderInfo() {
    titleEl.textContent = (info.title || '') + (info.owner ? ' — ' + info.owner : '');
    selEl.innerHTML = '';
    info.qualities.forEach(function (q) {
      const o = document.createElement('option');
      o.value = String(q.qn);
      o.textContent = q.desc;
      selEl.appendChild(o);
    });
    if (info.qualities.length) {
      selEl.value = String(info.qualities[0].qn); // 默认最高清晰度
    }
  }

  goEl.addEventListener('click', async function () {
    if (!info || downloading) return;
    setDownloading(true);
    const qn = Number(selEl.value);
    progEl.textContent = '正在准备…';
    try {
      const res = await send({
        type: 'DOWNLOAD',
        bvid: info.bvid,
        cid: info.cid,
        epId: info.epId || page.epId,
        qn: qn,
        title: info.title,
      });
      if (!res || !res.ok) throw new Error((res && res.error) || '启动失败');
      progEl.textContent = '任务已提交，正在启动合并模块…';
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
      /* 忽略，下面统一解锁 */
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

  // 监听 SPA 切集（history 变化）
  let lastHref = location.href;
  setInterval(function () {
    if (location.href === lastHref) return;
    lastHref = location.href;
    if (syncPageIfChanged() && panel.style.display !== 'none' && !downloading) {
      loadInfo();
    }
  }, 800);
})();
