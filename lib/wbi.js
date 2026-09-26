/**
 * B 站 WBI 签名工具。
 * 在 service worker 中通过 importScripts 引入（依赖先加载的 md5.js）。
 * 暴露全局：mixinKeyEncTab、getMixinKey、encWbi。
 */

// 固定的 64 位打乱表（公开且稳定）
var mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

function getMixinKey(orig) {
  return mixinKeyEncTab
    .map(function (n) { return orig[n]; })
    .join('')
    .slice(0, 32);
}

/**
 * 对请求参数做 WBI 签名。
 * @param {Object} params 原始参数（不含 wts / w_rid）
 * @param {string} imgKey 来自 nav 接口 wbi_img.img_url 的文件名主体
 * @param {string} subKey 来自 nav 接口 wbi_img.sub_url 的文件名主体
 * @returns {string} 可直接拼到 URL 后的 query 字符串（含 wts 与 w_rid）
 */
function encWbi(params, imgKey, subKey) {
  var mixinKey = getMixinKey(imgKey + subKey);
  var wts = Math.round(Date.now() / 1000);

  var allParams = {};
  Object.keys(params).forEach(function (k) { allParams[k] = params[k]; });
  allParams.wts = wts;

  var query = Object.keys(allParams)
    .filter(function (k) { return k !== 'w_rid'; })
    .sort()
    .map(function (k) {
      var value = String(allParams[k]).replace(/[!'()*]/g, '');
      return encodeURIComponent(k) + '=' + encodeURIComponent(value);
    })
    .join('&');

  var wRid = md5(query + mixinKey);
  return query + '&w_rid=' + wRid;
}
