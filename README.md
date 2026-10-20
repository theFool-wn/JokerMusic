# Joker's Music · 薛之谦私人音乐播放器 (Cloudflare Worker 版)

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.html)  ![Made by Wang Nan](https://img.shields.io/badge/Made%20by-Wang%20Nan-brightgreen)  ![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)  ![Python](https://img.shields.io/badge/Python-3.x-blue)

基于 **Cloudflare Python Worker** 的私人音乐播放器, 音频文件存放在 **R2 对象存储**, 歌库缓存使用 **KV**, 静态资源通过 **Workers Assets** 分发。无需自有服务器, 全程运行在 Cloudflare 边缘网络。

> **本项目为个人前端学习练习, 非盈利, 不提供音视频资源下载。歌曲、歌词版权归原著作权人所有。**

## 功能特性

- 🔐 **JWT 密码登录鉴权**：HMAC-SHA256 签名 Cookie, 无状态验证, 未登录无法访问任何接口
- 🎵 **R2 MP3 播放**：自动扫描 R2 `music/` 前缀, 读取 ID3 标签 (标题/专辑/歌手/时长)
- 📝 **LRC 歌词同步**：自动匹配 R2 `lyrics/` 前缀下同名 `.lrc` 文件, 播放时逐行高亮滚动
- 🔍 **歌曲搜索**：按歌名/专辑/歌手实时过滤
- 📋 **播放歌单**：创建多个歌单, 数据保存在浏览器 localStorage
- 🔀 **播放模式**：顺序播放 / 随机播放 / 单曲循环
- 🎚️ **进度条 & 音量**：支持拖拽, 支持触摸操作
- 💡 **悬浮提示**：鼠标悬停组件显示功能说明
- 📱 **响应式布局**：适配电脑、平板、手机
- 🔄 **刷新歌库**：新增 MP3 后点击按钮即可重新扫描, 无需重新部署
- ⚡ **稀疏 ID3 读取**：按标签头自动扩展读取元信息, 不完整下载, 节省流量与内存


## 架构概览

```
用户浏览器
    │
    ▼
Cloudflare 边缘节点 (Python Worker / Pyodide WASM)
    │
    ├── Workers Assets ─ 静态文件 (HTML/CSS/JS/图片)
    ├── KV ───────────── 歌库缓存 (cache:song_list, 24h TTL)
    ├── R2 ───────────── 音乐文件 (music/*.mp3) + 歌词 (lyrics/*.lrc)
    └── Web Crypto API ─ JWT 签名/验证 (HMAC-SHA256)
```

## 文件结构

```
JokerMusic/
├── JokerMusic_Worker.py      # Worker 主程序 (Python, Pyodide 运行时)
├── wrangler.toml             # Cloudflare Worker 配置
├── pyproject.toml
├── README.md
├── LICENSE
├── static/
│   ├── index.html
│   ├── login.html
│   ├── manifest.json
│   ├── sw.js
│   ├── css/
│   │   └── style.css
│   ├── js/
│   │   └── app.js
│   └── img/
│       ├── icon-192.png
│       └── icon-512.png
└── legacy/                   # 历史版本
```

**R2 中的文件结构** (不在仓库中, 需单独上传)：

```
joker-music-library 
├── music/              # 所有 MP3 文件
│   ├── 陪你去流浪.mp3
│   ├── 跃.mp3
│   └── ...
└── lyrics/             # 同名 LRC 歌词文件
    ├── 陪你去流浪.lrc
    ├── 跃.lrc
    └── ...
```

## 配置说明

### wrangler.toml [vars] 非敏感变量

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `MUSIC_PREFIX` | `"music/"` | R2 中音乐文件的路径前缀 |
| `LYRIC_PREFIX` | `"lyrics/"` | R2 中歌词文件的路径前缀 |
| `CACHE_KEY` | `"cache:song_list"` | KV 中歌库缓存的键名 |
| `ID3_PER_RELOAD` | `1` | 每次 reload 最多读取音乐文件数量 |
| `TOKEN_TTL_DAYS` | `30` | JWT 登录有效期 (天), 默认 30 天免登录 |
| `COOKIE_NAME` | `"session_token"` | 登录 Cookie 的名称 |
| `ID3_HEADER_SIZE` | `65536` | 读取 ID3 时下载的文件头部大小 (字节), 默认 64KB, 可自动扩展 |

> 修改这些变量后重新部署即可生效, 无需改代码。

### Dashboard Secrets 敏感变量

| 变量名 | 必填 | 说明 |
|---|---|---|
| `SITE_PASSWORD` | ✅ | 登录密码 |
| `JWT_SECRET` | ❌ | JWT 签名密钥 |

## 技术说明

### Python Worker 运行时

- 基于 **Pyodide** (CPython 编译为 WebAssembly), 在 Cloudflare Workers 的 V8 隔离环境中运行
- 标准库 (`os`、`json`、`re`、`time`、`base64`、`urllib` 等) 可直接使用
- 第三方纯 Python 包 (`mutagen`、`pypinyin`) 通过 `micropip` 在首次请求时安装, 声明在 `wrangler.toml` 的 `[pyodide] packages` 中
- **不可用**的包：依赖 C 扩展的包 (如 `numpy`、`pandas`)、网络请求库 (`requests`、`flask`)、文件系统操作库

### JWT 无状态鉴权

- 使用 Cloudflare Worker 内置 **Web Crypto API** (HMAC-SHA256) 进行签名和验证
- Token 格式为标准三段式：`header.payload.signature`
- `payload` 包含 `exp` (过期时间) 和 `iat` (签发时间)
- Cookie 设置 `HttpOnly` (防 XSS 读取)、`SameSite=Lax` (防 CSRF)、`Secure` (仅 HTTPS 传输)
- **不使用 KV 存储 Session**, 完全无状态, 避免 KV 读写额度消耗

### 稀疏 ID3 读取 (_PartialMP3File)

- MP3 的 ID3v2 标签位于文件开头, MPEG 帧头也在开头附近
- 通过 R2 **Range 请求**只下载前 `ID3_HEADER_SIZE` (默认 512KB) 字节
- 自定义 `_PartialMP3File` 稀疏文件对象：只存开头真实数据, 其余位置返回零字节, 同时向 mutagen 报告完整文件大小
- mutagen 以为在读完整文件, 实际只读取了开头元信息
- 网络传输减少约 90%, 内存占用大幅降低

### Workers Assets 静态资源

- `static/` 目录下的所有文件通过 Workers Assets 自动分发
- 代码中通过 `env.ASSETS.fetch(request)` 获取静态文件
- 支持缓存、压缩、CDN 边缘分发

## API 接口

| 路径 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/` | GET | 需要登录 | 播放器主页 |
| `/login` | GET | 无 | 登录页 |
| `/login` | POST | 无 | 提交密码登录 |
| `/logout` | GET | 无 | 登出并清除 Cookie |
| `/api/songs` | GET | 需要登录 | 获取歌库列表 (含 ID3 信息) |
| `/api/reload` | POST | 需要登录 | 强制刷新歌库缓存 |
| `/api/lyric/<filename>` | GET | 需要登录 | 获取指定歌曲的 LRC 歌词 |
| `/api/stream/<filename>` | GET | 需要登录 | 音频流式播放 (支持 Range) |
| `/static/*` | GET | 无 | 静态资源 |
| `/sw.js` | GET | 无 | Service Worker |
| `/manifest.json` | GET | 无 | PWA 清单 |
| `/robots.txt` | GET | 无 | 禁止搜索引擎索引 |

## 注意事项

1. **不要将音乐文件和歌词文件提交到公开仓库**, 尊重版权
2. **`SITE_PASSWORD` 和 `JWT_SECRET` 必须在 Dashboard 设置为 Secret**, 不要写在 `wrangler.toml` 或代码中
3. **KV 命名空间 ID 必须替换为真实 ID**, 否则部署失败。或在 Dashboard 图形化绑定

## 从 Flask 版迁移的主要变化

| 项目 | Flask 版 (旧)  | Cloudflare Worker 版 (新)  |
|---|---|---|
| 运行环境 | 本地服务器 + cloudflared 内网穿透 | Cloudflare 边缘网络, 无需自有服务器 |
| 音乐存储 | 本地 `music/` 目录 | R2 对象存储 `music/` 前缀 |
| 歌词存储 | 本地 `lyrics/` 目录 | R2 对象存储 `lyrics/` 前缀 |
| 歌库缓存 | 内存缓存 (10 分钟) | KV 键值存储 (永久) |
| 登录鉴权 | Flask Session + 文件存储 | JWT HMAC-SHA256 + Cookie (无状态) |
| 静态文件 | Flask `send_from_directory` | Workers Assets |
| ID3 读取 | 完整下载 MP3 到内存 | Range 请求只下载前 64KB + 稀疏文件对象 |
| 音频流 | Flask 手动分块 Range 响应 | R2 ReadableStream 直接流式转发 |
| 部署方式 | 本地启动 + 内网穿透 | Cloudflare Worker 自动部署 |

## 免责声明

本项目仅用于个人学习和技术研究, 不用于任何商业用途。项目中涉及的音乐作品、歌词等内容的著作权归原权利人所有。使用者应确保其对存储的音乐文件拥有合法的使用权, 不得通过本项目向公众传播受版权保护的内容。如有侵权, 请联系删除。

## License

This project is licensed under the **[GNU Affero General Public License v3.0 (AGPL-3.0)](https://www.gnu.org/licenses/agpl-3.0.html)**.

You are free to **use, modify, and distribute** this project, including for commercial purposes, provided that:

* You **retain the copyright and license notices**.
* You **distribute modified versions under the same license**.
* You **make the corresponding source code available** as required by the AGPL-3.0, including when modified software is used to provide a network service.

See the [LICENSE](/LICENSE) file for details.

Copyright (c) 2025-2026 Wang Nan
