/**
 * Background Service Worker（MV3）。
 * 职责：读取登录 Cookie、调用 B 站接口（WBI 签名）、编排 offscreen 下载与合并。
 */
importScripts('../lib/md5.js', '../lib/wbi.js');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 缓存登录态与 WBI 密钥，避免每次请求都重新获取
const cache = { cookie: null, wbi: null };

// 下载任务序号：取消时递增，作废仍在执行的 DOWNLOAD
let jobSeq = 0;
let activeJobId = 0;

// 视频/音频 CDN 域名，DNR 会给这些域名的请求补 Referer（否则 403）
const VIDEO_HOSTS = ['bilivideo.com', 'hdslb.com', 'bilivideo.cn', 'akamaized.net'];

// 带超时的 fetch，避免网络异常时无限卡住
function fetchWithTimeout(url, opts, ms) {
  const timeout = ms || 15000;
  return Promise.race([
    fetch(url, opts),
    new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('请求超时: ' + url)); }, timeout);
    }),
  ]);
}

/* ------------------------- Cookie 与 WBI ------------------------- */

async function getCookie() {
  if (cache.cookie) return cache.cookie;
  const names = ['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4', 'b_nut'];
  const parts = [];
  for (const name of names) {
    try {
      const c = await chrome.cookies.get({ url: 'https://www.bilibili.com/', name });
      if (c) parts.push(c.name + '=' + c.value);
    } catch (e) {
      // 忽略单个 cookie 获取失败
    }
  }
  cache.cookie = parts.join('; ');
  return cache.cookie;
}

async function getWbiKeys() {
  if (cache.wbi) return cache.wbi;
  const cookie = await getCookie();
  const res = await fetchWithTimeout('https://api.bilibili.com/x/web-interface/nav', {
    headers: {
      Cookie: cookie,
      Referer: 'https://www.bilibili.com/',
      'User-Agent': UA,
    },
  });
  const json = await res.json();
  if (json.code !== 0) {
    throw new Error('获取 WBI 密钥失败: ' + json.code + ' ' + (json.message || ''));
  }
  const img = json.data.wbi_img.img_url;
  const sub = json.data.wbi_img.sub_url;
  cache.wbi = {
    imgKey: img.slice(img.lastIndexOf('/') + 1, img.lastIndexOf('.')),
    subKey: sub.slice(sub.lastIndexOf('/') + 1, sub.lastIndexOf('.')),
  };
  return cache.wbi;
}

/* ------------------------- 接口调用 ------------------------- */

async function apiGet(url) {
  const cookie = await getCookie();
  const res = await fetchWithTimeout(url, {
    headers: {
      Cookie: cookie,
      Referer: 'https://www.bilibili.com/',
      'User-Agent': UA,
    },
  });
  const json = await res.json();
  if (json.code === -412) {
    throw new Error('触发 B 站风控（-412），请稍后重试或刷新视频页');
  }
  if (json.code !== 0) {
    throw new Error('接口错误 ' + json.code + ': ' + (json.message || ''));
  }
  // 普通接口用 data，番剧 pgc 接口用 result
  if (json.data != null) return json.data;
  if (json.result != null) return json.result;
  return json;
}

/** 通过 bvid 拿视频基本信息（标题、cid 等） */
async function getVideoInfo(bvid) {
  const data = await apiGet('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid);
  return {
    bvid: bvid,
    title: data.title,
    cid: data.cid,
    pic: data.pic,
    owner: data.owner && data.owner.name,
  };
}

/** 收集正片 + section（花絮等）里的全部剧集 */
function collectEpisodes(season) {
  const list = [];
  (season.episodes || []).forEach(function (ep) { list.push(ep); });
  (season.section || []).forEach(function (sec) {
    (sec.episodes || []).forEach(function (ep) { list.push(ep); });
  });
  return list;
}

/**
 * 通过 ep_id / season_id 解析番剧当前集，得到与普通视频相同的 bvid/cid。
 * 之后仍走 wbi/playurl + DASH 合并，无需单独一套下载链路。
 */
async function getBangumiInfo(epId, seasonId) {
  if (!epId && !seasonId) {
    throw new Error('缺少番剧 ep_id 或 season_id');
  }
  const qs = epId ? 'ep_id=' + epId : 'season_id=' + seasonId;
  const season = await apiGet('https://api.bilibili.com/pgc/view/web/season?' + qs);
  const episodes = collectEpisodes(season);
  if (!episodes.length) {
    throw new Error('未找到剧集列表');
  }

  let ep = null;
  if (epId) {
    ep = episodes.find(function (e) { return String(e.id) === String(epId); });
  }
  if (!ep) {
    const lastEp =
      season.user_status &&
      season.user_status.progress &&
      season.user_status.progress.last_ep_id;
    if (lastEp) {
      ep = episodes.find(function (e) { return String(e.id) === String(lastEp); });
    }
  }
  if (!ep) ep = episodes[0];

  if (!ep.bvid || !ep.cid) {
    throw new Error('剧集缺少 bvid/cid，无法取流');
  }

  const epLabel = [ep.title, ep.long_title].filter(Boolean).join(' ').trim();
  const seasonTitle = season.title || season.season_title || '';
  const title = seasonTitle + (epLabel ? ' - ' + epLabel : '');

  return {
    bvid: ep.bvid,
    cid: ep.cid,
    epId: ep.id,
    title: title,
    pic: ep.cover || season.cover,
    owner: (season.up_info && season.up_info.uname) || seasonTitle,
  };
}

/** 统一解析：普通视频用 bvid，番剧用 epId/seasonId */
async function resolveMedia(msg) {
  if (msg.epId || msg.seasonId) {
    return getBangumiInfo(msg.epId, msg.seasonId);
  }
  if (msg.bvid) {
    return getVideoInfo(msg.bvid);
  }
  throw new Error('缺少视频或番剧标识');
}

/** 拿播放流（DASH）。qn 为目标清晰度，fnval=4048 一次性返回全部可用轨 */
async function getPlayUrl(bvid, cid, qn) {
  const wbi = await getWbiKeys();
  const params = { bvid: bvid, cid: String(cid), qn: String(qn), fnval: '4048', fnver: '0', fourk: '1' };
  const query = encWbi(params, wbi.imgKey, wbi.subKey);
  return apiGet('https://api.bilibili.com/x/player/wbi/playurl?' + query);
}

/* ------------------------- 清晰度 / 轨道选择 ------------------------- */

/** 用 support_formats 生成清晰度列表（带"大会员/4K"等角标） */
function buildQualities(data) {
  const accept = new Set((data.accept_quality || []).map(String));
  const formats = (data.support_formats || []).filter(function (f) {
    return accept.has(String(f.quality));
  });
  const list = formats.map(function (f) {
    return {
      qn: f.quality,
      desc: (f.new_description || f.quality) + (f.superscript ? ' [' + f.superscript + ']' : ''),
    };
  });
  list.sort(function (a, b) { return b.qn - a.qn; });
  return list;
}

/** 根据实际返回的清晰度选视频轨 */
function pickVideo(dash, data) {
  const videos = (dash && dash.video) || [];
  return videos.find(function (v) { return v.id === data.quality; }) || videos[0];
}

/** 优先选 AAC 音轨（mp4 兼容性最好），否则取最高码率 */
function pickAudio(audios) {
  if (!audios || !audios.length) return null;
  const aac = audios.filter(function (a) {
    return (a.codecs || '').toLowerCase().indexOf('mp4a') !== -1;
  });
  const list = aac.length ? aac : audios;
  return list.slice().sort(function (a, b) {
    return (b.bandwidth || b.id) - (a.bandwidth || a.id);
  })[0];
}

/* ------------------------- offscreen 编排 ------------------------- */

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['WORKERS', 'BLOBS'],
    justification: '用 ffmpeg.wasm 合并音视频并触发下载',
  });
}

/** 强制结束卡住的合并任务：关闭 offscreen 文档以终止 fetch / ffmpeg.wasm 并清掉 busy 锁 */
async function forceCancelJob() {
  activeJobId = 0;
  jobSeq += 1; // 作废任何仍在跑的 DOWNLOAD
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch (e) {
    console.warn('[取消] 关闭 offscreen 失败', e);
  }
  try {
    await chrome.action.setBadgeText({ text: '' });
  } catch (e) {
    /* 忽略 */
  }
}

/** 通知所有相关 UI（页内面板 + popup）任务已取消 */
async function broadcastCancelled() {
  try {
    chrome.runtime.sendMessage({ type: 'CANCELLED' }).catch(function () {});
  } catch (e) {
    /* 忽略 */
  }
  try {
    const tabs = await chrome.tabs.query({ url: ['*://*.bilibili.com/*', '*://www.bilibili.com/*'] });
    await Promise.all(
      tabs.map(function (tab) {
        return chrome.tabs.sendMessage(tab.id, { type: 'CANCELLED' }).catch(function () {});
      })
    );
  } catch (e) {
    /* 忽略 */
  }
}

// 向 offscreen 发送消息并等待其回应；offscreen 页面可能尚未加载完成，带重试
async function sendToOffscreen(msg, retries) {
  const max = retries || 15;
  for (let i = 0; i < max; i++) {
    try {
      const resp = await chrome.runtime.sendMessage(msg);
      return resp; // 有响应说明 offscreen 已收到
    } catch (e) {
      // 还没有监听者（offscreen 未就绪），稍等重试
      await new Promise(function (r) { setTimeout(r, 300); });
    }
  }
  return null;
}

/* ------------------------- DNR：给 CDN 请求补 Referer ------------------------- */

async function setupDNR() {
  const rules = VIDEO_HOSTS.map(function (host, i) {
    return {
      id: i + 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'referer', operation: 'set', value: 'https://www.bilibili.com/' },
          { header: 'origin', operation: 'set', value: 'https://www.bilibili.com' },
        ],
      },
      condition: {
        urlFilter: '||' + host,
        resourceTypes: ['xmlhttprequest', 'media', 'other'],
      },
    };
  });
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map(function (r) { return r.id; }),
    addRules: rules,
  });
}

/* ------------------------- 消息路由 ------------------------- */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    try {
      switch (msg.type) {
        case 'SET_FLOAT_VISIBLE': {
          const show = msg.show !== false;
          try {
            await chrome.storage.local.set({ showFloatBtn: show });
          } catch (e) {
            /* 忽略 */
          }
          try {
            const tabs = await chrome.tabs.query({
              url: ['*://*.bilibili.com/*', '*://www.bilibili.com/*'],
            });
            await Promise.all(
              tabs.map(function (tab) {
                return chrome.tabs
                  .sendMessage(tab.id, { type: 'SET_FLOAT_VISIBLE', show: show })
                  .catch(function () {});
              })
            );
          } catch (e) {
            /* 忽略 */
          }
          return { ok: true };
        }

        case 'GET_INFO': {
          const info = await resolveMedia(msg);
          // 用最高清晰度请求一次，拿到可用清晰度列表（accept_quality / support_formats）
          const data = await getPlayUrl(info.bvid, info.cid, 127);
          return {
            ok: true,
            data: {
              bvid: info.bvid,
              epId: info.epId || null,
              title: info.title,
              cid: info.cid,
              pic: info.pic,
              owner: info.owner,
              qualities: buildQualities(data),
            },
          };
        }

        case 'DOWNLOAD': {
          const jobId = ++jobSeq;
          activeJobId = jobId;
          // 允许只传 epId/seasonId（由 popup/content 直接下），或已解析好的 bvid+cid
          let bvid = msg.bvid;
          let cid = msg.cid;
          let title = msg.title;
          if ((!bvid || !cid) && (msg.epId || msg.seasonId)) {
            const info = await resolveMedia(msg);
            if (activeJobId !== jobId) return { ok: false, error: '已取消' };
            bvid = info.bvid;
            cid = info.cid;
            title = title || info.title;
          }
          const data = await getPlayUrl(bvid, cid, msg.qn);
          if (activeJobId !== jobId) return { ok: false, error: '已取消' };
          console.log('[下载] bvid=' + bvid + ' 请求qn=' + msg.qn + ' 实际qn=' + data.quality);
          const video = pickVideo(data.dash, data);
          const audio = pickAudio(data.dash && data.dash.audio);
          if (!video || !audio) {
            return {
              ok: false,
              error:
                '未找到可用的音视频流（可能是 DRM 加密番剧/影视，或该清晰度需要更高权限）',
            };
          }
          await ensureOffscreen();
          if (activeJobId !== jobId) return { ok: false, error: '已取消' };
          const videoUrl = video.baseUrl || video.base_url;
          const audioUrl = audio.baseUrl || audio.base_url;
          const sent = await sendToOffscreen({
            type: 'MUX',
            videoUrl: videoUrl,
            audioUrl: audioUrl,
            title: title || ('B站视频_' + bvid),
            actualQuality: data.quality,
          });
          if (activeJobId !== jobId) return { ok: false, error: '已取消' };
          if (!sent) {
            return { ok: false, error: '合并模块未就绪，请刷新视频页后重试' };
          }
          if (sent.ok === false) {
            return { ok: false, error: sent.error || '合并模块出错' };
          }
          return { ok: true, data: { actualQuality: data.quality } };
        }

        case 'CANCEL': {
          await forceCancelJob();
          await broadcastCancelled();
          return { ok: true };
        }

        // 这些消息是 offscreen/content 之间广播的，background 只做转发或不处理
        case 'MUX':
        case 'DONE':
        case 'CANCELLED':
          return { ok: true };

        case 'PROGRESS': {
          if (msg.stage === 'done' || msg.stage === 'error') {
            chrome.action.setBadgeText({ text: '' }).catch(function () {});
          } else if (msg.pct != null) {
            chrome.action.setBadgeBackgroundColor({ color: '#00a1d6' }).catch(function () {});
            chrome.action.setBadgeText({ text: String(msg.pct) }).catch(function () {});
          }
          return { ok: true };
        }

        case 'ERROR': {
          chrome.action.setBadgeText({ text: '' }).catch(function () {});
          return { ok: true };
        }

        default:
          return { ok: false, error: '未知消息类型: ' + msg.type };
      }
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  })().then(sendResponse);
  return true; // 异步响应
});

/* ------------------------- 启动 ------------------------- */

chrome.runtime.onInstalled.addListener(function () { setupDNR().catch(console.error); });
chrome.runtime.onStartup.addListener(function () { setupDNR().catch(console.error); });
setupDNR().catch(console.error);
