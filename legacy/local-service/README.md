# Joker's Music · 薛之谦私人音乐播放器

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-blue.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)  ![Made by Wang Nan](https://img.shields.io/badge/Made%20by-Wang%20Nan-brightgreen)

基于 Flask + 原生 HTML/CSS/JS 的私人音乐播放器，音频文件存放在本地电脑，通过 cloudflared 内网穿透实现外网访问。

> **本项目为个人前端学习练习，非盈利，不提供音视频资源下载。歌曲、歌词版权归原著作权人所有。**

## 功能特性

- 🔐 **密码登录鉴权**：后端校验，未登录无法访问任何接口
- 🎵 **本地 MP3 播放**：自动扫描 `music/` 目录，读取 ID3 标签（标题/专辑/歌手）
- 📝 **LRC 歌词同步**：自动匹配同名 `.lrc` 文件，播放时逐行高亮滚动
- 🔍 **歌曲搜索**：按歌名/专辑/歌手实时过滤
- 📋 **播放歌单**：创建多个歌单，数据保存在浏览器 localStorage
- 🔀 **播放模式**：顺序播放 / 随机播放 / 单曲循环
- 🎚️ **进度条 & 音量**：支持拖拽，支持触摸操作
- 💡 **悬浮提示**：鼠标悬停组件显示功能说明
- 📱 **响应式布局**：适配电脑、平板、手机
- 🔄 **刷新歌库**：新增 MP3 后点击按钮即可扫描，无需重启服务

## 文件结构

```
local-service/
├── JokerMusic.py
├── requirements.txt
├── .env
├── .gitignore
├── README.md
├── LICENSE
├── music/
├── lyrics/
└── static/
    ├── index.html
    ├── login.html
    ├── manifest.json
    ├── sw.js
    ├── css/
    │   └── style.css
    ├── js/
    │   └── app.js
    └── img/
        ├── icon-192.png
        └── icon-512.png
```

## 快速开始

### 1. 安装依赖

```
pip install -r requirements.txt
```

### 2. 配置环境变量

生成随机密钥：

```
python -c "import secrets; print(secrets.token_hex(32))"
```

填写 `.env`：

```env
SITE_PASSWORD=你的访问密码
FLASK_SECRET_KEY=随机密钥
```

### 3. 导入音乐文件

- 将 MP3 文件放入 `music/` 目录
- 将同名 LRC 歌词文件放入 `lyrics/` 目录
- 歌词文件缺失不影响播放，歌词区域显示提示

> MP3 的 ID3 标签建议填写完整（标题、艺术家、专辑），播放器会自动读取。标签缺失时回退使用文件名。

### 4. 启动服务

```
waitress-serve --host=0.0.0.0 --port=8080 JokerMusic:app
```

> 访问 `http://localhost:8080` 即可。
> 若配置了内网穿透及域名，则可外网访问。

## 技术说明

- **音频流**：Flask 实现支持 HTTP Range 的流式响应，浏览器可边下边播、拖拽进度条
- **歌词解析**：前端 JS 解析标准 LRC 格式 `[mm:ss.xx]`，二分查找定位当前行
- **歌单存储**：localStorage 仅保存歌曲文件名数组，换浏览器/设备歌单不互通
- **歌曲排序**：后端按中文拼音排序，前端搜索结果保持拼音序

## 注意事项

1. **不要将 `music/`、`lyrics/` 提交到公开仓库，尊重版权**
2. `.env` 包含密码和密钥，不要随意暴露

## 免责声明

本项目仅用于个人学习和技术研究，不用于任何商业用途。项目中涉及的音乐作品、歌词等内容的著作权归原权利人所有。使用者应确保其对本地存储的音乐文件拥有合法的使用权，不得通过本项目向公众传播受版权保护的内容。如有侵权，请联系删除。

## License

This work is licensed under the **[CC BY-NC-SA 4.0 License](https://creativecommons.org/licenses/by-nc-sa/4.0/)**.

You are free to use, share, and adapt the code for **non-commercial purposes**, provided that:

* You must give **appropriate credit**, provide **a link to this License**, and indicate if modifications were made. You may give credit in any reasonable way, but you must not do so in any way that suggests that the licensor endorses you or your use.
* You **distribute any modifications under the same license**.


© 2026 Wang Nan. All rights reserved.
