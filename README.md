# B站视频下载助手（Chrome 扩展骨架）

一个 Manifest V3 的 Chrome 扩展，用于下载 B 站视频。登录后（大会员）可下载 4K / 8K / HDR / 杜比视界等高清画质，并自动把分离的音视频**无损合并成 MP4**。

> ⚠️ 仅供个人学习研究使用。下载行为可能违反 B 站用户协议，请勿用于商业用途或传播。**大会员付费番剧/影视等 DRM 加密内容无法通过本方式下载**（接口返回的是加密流）。

## 功能

- 自动读取浏览器登录态（`SESSDATA` 等 Cookie），无需手动复制 Cookie
- 完整走通 B 站官方接口：`view` → `wbi/playurl`（含 WBI 签名）
- 支持选择清晰度（含"大会员/4K/HDR"等角标），默认选最高
- 音视频分离下载 → ffmpeg.wasm 无损合并（`-c copy`，不重编码）→ 触发保存
- 页内悬浮按钮面板 + 扩展弹窗两种入口

## 目录结构

```
bilibili-downloader/
├─ manifest.json                 # MV3 配置（权限、CSP、内容脚本）
├─ background/
│  └─ service_worker.js          # Cookie、WBI 签名、接口调用、DNR、编排
├─ content/
│  ├─ content.js                 # 注入悬浮下载面板
│  └─ content.css
├─ offscreen/
│  ├─ offscreen.html             # 加载本地 ffmpeg-core.js
│  └─ offscreen.js               # 下载 + 合并 + 保存（直连 ffmpeg 内核）
├─ popup/
│  ├─ popup.html                 # 备用界面
│  ├─ popup.css
│  └─ popup.js
├─ lib/
│  ├─ md5.js                     # WBI 签名用的 MD5
│  └─ wbi.js                     # WBI 签名（mixin key 打乱表 + encWbi）
├─ vendor/                       # ffmpeg.wasm 内核（需先运行下载脚本）
│  ├─ ffmpeg-core.js
│  └─ ffmpeg-core.wasm
├─ download-vendor.ps1           # 下载 vendor/ 依赖的脚本
└─ download-vendor.bat           # 双击运行上面的脚本
```

## 安装

1. 打开 Chrome（需 **116+**），地址栏输入 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本目录 `bilibili-downloader/`（若缺 `vendor/ffmpeg-core.*`，先运行 `download-vendor.bat`）
4. 打开任意 B 站视频页（`bilibili.com/video/BV...`）或番剧页，右下角会出现「⏬ 下载」按钮；也可以点击工具栏扩展图标使用弹窗

## 兼容性说明

| 环境 | 说明 |
|------|------|
| Chrome / Edge / 国产 Chromium 内核 116+ | 可用（依赖 Offscreen Document、DNR、WASM） |
| Firefox / Safari | 不可用（非 Chromium MV3 扩展模型） |
| 内存较小的机器 | 4K/长视频可能合并失败或卡死（音视频整段进内存） |
| 企业策略禁用 `wasm-unsafe-eval` | ffmpeg 无法加载 |
| DRM 付费内容 | 无法下载（接口返回加密流） |

## 使用

1. 进入视频页，点击「⏬ 下载」
2. 选择清晰度（默认最高，需要登录才能看到高清档）
3. 点「开始下载」，等待音视频下载 + 合并，浏览器会弹出保存 MP4

## 技术要点

- **DASH**：B 站音视频是分离的 `.m4s`，必须合并。本扩展用 `-c copy` 无损重封装，速度很快。
- **WBI 签名**：`x/player/wbi/playurl` 需要 `w_rid`/`wts`，算法在 `lib/wbi.js`（从 `nav` 接口取 img_key/sub_key）。
- **Cookie 鉴权**：`chrome.cookies` 直接取登录态，大会员高清（qn≥116）依赖 `SESSDATA`。
- **清晰度 qn 对照**：80=1080P，112=1080P+，116=1080P60，120=4K，125=HDR，126=杜比视界，127=8K。`fnval=4048` 一次性返回全部轨。
- **Referer**：`.m4s` 直链要求 `Referer: https://www.bilibili.com/`，否则 403。本扩展用 `declarativeNetRequest` 动态规则给 CDN 请求补 Referer。
- **ffmpeg 内核直连**：MV3 禁止扩展页面加载远程脚本、也禁止 `worker-src blob:`。因此不依赖 `@ffmpeg/ffmpeg` 封装（它会创建 blob worker），而是直接用 `@ffmpeg/core` 单线程内核在主线程运行，CSP 只需最简形式。

## 已知限制

- **DRM 内容无法下载**：付费番剧/电影/纪录片（视频云加密）返回加密流。
- **内存**：ffmpeg.wasm 与整段下载会把音视频读进内存，4K 长视频可能吃几百 MB 内存（骨架先保证跑通，后续可改成分片/流式）。
- **ffmpeg 首次加载慢**：wasm 内核约 30MB 已本地打包在 `vendor/`，首次启动合并时仍需加载并编译，会稍慢（之后浏览器有缓存）。
- **风控**：短时间大量请求会触发 `-412`，稍等再试即可。

## 常见问题排查

| 现象 | 原因 / 处理 |
|------|------------|
| 清晰度列表里没有 4K/8K | 未登录，或该视频本身没有此清晰度；确认已在 `bilibili.com` 登录 |
| 合并时报错找不到 createFFmpegCore | `vendor/` 缺少 `ffmpeg-core.js` / `.wasm`，运行 `download-vendor.bat` 后重载扩展 |
| 下载视频/音频失败 HTTP 403 | Referer 没生效。确认 `declarativeNetRequest` 规则已注册（重启扩展）；若仍失败，可改为在 content script 内 `fetch`（页面上下文会自动带 Referer） |
| 接口错误 -412 | 触发风控，稍等重试或刷新视频页 |
| 接口错误 -10403 / 大会员相关 | 接口认为未登录或无权限，检查 Cookie 是否包含 `SESSDATA` |
| 合并报错 | 极少数编码轨 `-c copy` 不兼容，可把音频轨改为 AAC（已默认优先选 AAC） |

## 后续可优化方向

1. 分片并发下载 + 断点续传（大文件更稳）
2. 多 P / 合集批量下载
3. 弹幕与封面下载
4. 收紧 CSP（当前为兼容 wasm 保留了 `wasm-unsafe-eval`）
5. 进度持久化、下载队列
