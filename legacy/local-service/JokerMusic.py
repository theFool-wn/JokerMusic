# @             Project: JokerMusic -> JokerMusic.py
# @              Author: WangNan
# @       Creation Date: 2026/9/5 16:37
# @         Description: A Private Music Player about Joker Xue
# @ Version Information: Created by WangNan, 2026/9/5 - 2026/9/9
# =============================================================================================================


import os
import re
import time
import mimetypes

from functools import wraps
from dotenv import load_dotenv
from mutagen.mp3 import MP3
from mutagen import MutagenError
from flask import Flask, request, session, redirect, url_for, send_from_directory
from flask import Response, jsonify, abort
from flask_session import Session
from urllib.parse import unquote


load_dotenv()

BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
MUSIC_DIR  = os.path.join(BASE_DIR, "music")
LYRIC_DIR  = os.path.join(BASE_DIR, "lyrics")
STATIC_DIR = os.path.join(BASE_DIR, "static")

# 确保目录存在
os.makedirs(MUSIC_DIR, exist_ok=True)
os.makedirs(LYRIC_DIR, exist_ok=True)


app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")

# Flask Session 配置
app.config["SECRET_KEY"] = os.getenv("FLASK_SECRET_KEY")
app.config["SESSION_TYPE"] = "filesystem"
app.config["SESSION_FILE_DIR"] = os.path.join(BASE_DIR, ".flask_session")
app.config["SESSION_PERMANENT"] = True
app.config["PERMANENT_SESSION_LIFETIME"] = 30 * 24 * 3600  # 30 天免登录
os.makedirs(app.config["SESSION_FILE_DIR"], exist_ok=True)
Session(app)


SITE_PASSWORD = os.getenv("SITE_PASSWORD", "")

# 音频流分块大小（128KB）
CHUNK_SIZE = 128 * 1024

# 歌库缓存
_song_cache = None
_cache_time = 0
CACHE_TTL   = 600  # 缓存 10 分钟自动过期

# session缓存
_last_session_cleanup = 0.0
SESSION_CLEANUP_INTERVAL = 3600   # 每小时最多清理一次
SESSION_FILE_MAX_AGE = 30 * 24 * 3600  # session 文件最大存活 30 天，和 cookie 有效期一致


def safe_filename(filename: str) -> str:
    """过滤文件名，防止路径遍历攻击。只允许安全字符。
    先做 URL 解码，处理前端 encodeURIComponent 产生的 %20 等编码。
    """
    # 去掉路径分隔符和父目录引用
    filename = os.path.basename(filename)
    # URL 解码，将 %20 等还原为空格等原始字符
    filename = unquote(filename)
    # 允许中文、字母、数字、空格、下划线、连字符、点、括号、&
    if not re.match(r'^[\w\u4e00-\u9fff\s\.\-\(\)&]+$', filename, re.UNICODE):
        abort(400, description="非法文件名")
    return filename


def login_required(f):
    """登录鉴权装饰器：未登录一律重定向到登录页。"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get("is_logged_in"):
            # API 请求返回 401，页面请求重定向
            if request.path.startswith("/api/"):
                return jsonify({"error": "未登录"}), 401
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated_function


def read_id3_tag(filepath: str) -> dict:
    """
    读取 MP3 的 ID3 标签。任何字段缺失或读取失败都留空字符串，
    保证歌曲只要 MP3 文件存在就能播放。
    """
    info = {"title": "", "artist": "", "album": "", "duration": 0}

    try:
        audio = MP3(filepath)
        # TIT2=标题, TPE1=艺术家, TALB=专辑
        if "TIT2" in audio:
            info["title"] = str(audio["TIT2"].text[0]).strip()
        if "TPE1" in audio:
            info["artist"] = str(audio["TPE1"].text[0]).strip()
        if "TALB" in audio:
            info["album"] = str(audio["TALB"].text[0]).strip()
        if audio.info and audio.info.length:
            info["duration"] = round(audio.info.length, 2)
    except (MutagenError, Exception):
        # 损坏的 MP3 或无标签，全部留空，不影响播放
        pass

    return info


def scan_music_library() -> list:
    """
    扫描 music/ 目录下全部 MP3，读取 ID3 标签，匹配同名 LRC 歌词。
    返回歌曲列表，按标题拼音排序（后端用 locale，前端也可再排）。
    """
    songs = []

    if not os.path.isdir(MUSIC_DIR):
        return songs

    for fname in sorted(os.listdir(MUSIC_DIR)):
        if not fname.lower().endswith(".mp3"):
            continue

        full_path = os.path.join(MUSIC_DIR, fname)
        if not os.path.isfile(full_path):
            continue

        tag = read_id3_tag(full_path)

        # 标题缺失时回退为文件名（去掉 .mp3）
        base_name = os.path.splitext(fname)[0]
        title = tag["title"] if tag["title"] else base_name

        # 匹配同名 LRC 歌词
        lrc_filename = base_name + ".lrc"
        lrc_path = os.path.join(LYRIC_DIR, lrc_filename)
        has_lyric = os.path.isfile(lrc_path)

        songs.append({
            "filename": fname,
            "title": title,
            "artist": tag["artist"],
            "album": tag["album"],
            "duration": tag["duration"],
            "has_lyric": has_lyric,
        })

    # 按标题拼音排序（中文 locale）
    try:
        import locale
        locale.setlocale(locale.LC_COLLATE, "zh_CN.UTF-8")
        songs.sort(key=lambda s: locale.strxfrm(s["title"]))
    except Exception:
        # locale 不可用时回退普通排序
        songs.sort(key=lambda s: s["title"])

    return songs


def get_songs(force_refresh: bool = False) -> list:
    """获取歌库，带缓存。force_refresh=True 时强制重新扫描。"""
    global _song_cache, _cache_time

    now = time.time()
    if force_refresh or _song_cache is None or (now - _cache_time) > CACHE_TTL:
        _song_cache = scan_music_library()
        _cache_time = now
    return _song_cache


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        password = request.form.get("password", "")
        if SITE_PASSWORD and password == SITE_PASSWORD:
            session["is_logged_in"] = True
            return redirect(url_for("index"))
        return render_login_page(error="密码错误，请重试")

    # 已登录直接进主页
    if session.get("is_logged_in"):
        return redirect(url_for("index"))
    return render_login_page()

def render_login_page(error: str = "") -> str:
    """渲染简洁的登录页（读取 static/login.html，替换错误提示占位符）。"""
    error_html = f'<p class="login-error">{error}</p>' if error else ""
    login_path = os.path.join(STATIC_DIR, "login.html")
    with open(login_path, "r", encoding="utf-8") as f:
        html = f.read()
    return html.replace("<!--ERROR_HTML-->", error_html)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
@login_required
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/sw.js")
def service_worker():
    """Service Worker 必须在根路径提供，才能获得全站 scope（/），
    否则放在 /static/sw.js 的话 scope 仅限 /static/，无法拦截音频和 API 请求。"""
    return send_from_directory(STATIC_DIR, "sw.js")


@app.route("/manifest.json")
def web_manifest():
    return send_from_directory(STATIC_DIR, "manifest.json")


@app.route("/api/songs")
@login_required
def api_songs():
    songs = get_songs()
    return jsonify({"count": len(songs), "songs": songs})


@app.route("/api/reload", methods=["POST"])
@login_required
def api_reload():
    songs = get_songs(force_refresh=True)
    return jsonify({"count": len(songs), "songs": songs, "message": "歌库已刷新"})


@app.route("/api/lyric/<path:filename>")
@login_required
def api_lyric(filename):
    filename = safe_filename(filename)
    # 允许传 xxx.mp3 或 xxx.lrc，统一找 .lrc
    base = os.path.splitext(filename)[0]
    lrc_path = os.path.join(LYRIC_DIR, base + ".lrc")

    if not os.path.isfile(lrc_path):
        return jsonify({"lyric": "", "has_lyric": False})

    try:
        # 尝试 UTF-8，失败回退 GBK
        try:
            with open(lrc_path, "r", encoding="utf-8") as f:
                content = f.read()
        except UnicodeDecodeError:
            with open(lrc_path, "r", encoding="gbk", errors="replace") as f:
                content = f.read()
        return jsonify({"lyric": content, "has_lyric": True})
    except Exception as e:
        return jsonify({"lyric": "", "has_lyric": False, "error": str(e)}), 500


@app.route("/api/stream/<path:filename>")
@login_required
def api_stream(filename):
    filename = safe_filename(filename)
    file_path = os.path.join(MUSIC_DIR, filename)

    if not os.path.isfile(file_path):
        abort(404, description="音频文件不存在")

    file_size = os.path.getsize(file_path)
    mime_type = mimetypes.guess_type(file_path)[0] or "audio/mpeg"

    # 解析 Range 请求头
    range_header = request.headers.get("Range", "").strip()
    start = 0
    end = file_size - 1

    if range_header.startswith("bytes="):
        range_value = range_header[6:]  # 去掉 "bytes="
        # 只处理第一个范围（音频播放器标准用法）
        if "-" in range_value:
            parts = range_value.split(",")[0].split("-", 1)
            start_str, end_str = parts[0], parts[1]
            if start_str:
                start = int(start_str)
            if end_str:
                end = int(end_str)
            # 修正范围
            if start >= file_size:
                return Response(status=416)  # Range Not Satisfiable
            end = min(end, file_size - 1)
            if start > end:
                return Response(status=416)

    content_length = end - start + 1

    def generate():
        with open(file_path, "rb") as f:
            f.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk = f.read(min(CHUNK_SIZE, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Content-Type": mime_type,
        "Content-Length": str(content_length),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
    }

    if range_header:
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
        return Response(generate(), status=206, headers=headers)
    else:
        return Response(generate(), status=200, headers=headers)


@app.route("/robots.txt")
def robots_txt():
    return Response(
        "User-agent: *\nDisallow: /\n",
        mimetype="text/plain",
    )


# 过期 Session 自动清理
# Flask-Session filesystem 模式下，session 文件不会自动删除。
# 每次请求时检查，超过间隔则扫描 session 目录，删除过期文件。
@app.before_request
def cleanup_expired_sessions():
    global _last_session_cleanup
    now = time.time()
    if now - _last_session_cleanup < SESSION_CLEANUP_INTERVAL:
        return
    _last_session_cleanup = now

    session_dir = app.config.get("SESSION_FILE_DIR")
    if not session_dir or not os.path.isdir(session_dir):
        return

    try:
        for fname in os.listdir(session_dir):
            fpath = os.path.join(session_dir, fname)
            if not os.path.isfile(fpath):
                continue
            if now - os.path.getmtime(fpath) > SESSION_FILE_MAX_AGE:
                try:
                    os.remove(fpath)
                except OSError:
                    pass
    except Exception:
        # 清理失败不影响正常请求
        pass


@app.errorhandler(404)
def not_found(e):
    # API 请求继续返回 JSON
    if request.path.startswith("/api/"):
        return jsonify({"error": "资源不存在"}), 404
    # 页面请求返回友好的 404 页
    return """<!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;charset=utf-8;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMDAiPgogIDxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzZjNWNlNyIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI2EyOWJmZSIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPgogIDxjaXJjbGUgY3g9IjE2IiBjeT0iMTYiIHI9IjE1IiBmaWxsPSIjMGYwZjFhIiBzdHJva2U9InVybCgjZykiIHN0cm9rZS13aWR0aD0iMS41Ii8+CiAgPGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iOSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjNmM1Y2U3IiBzdHJva2Utd2lkdGg9IjAuOCIgb3BhY2l0eT0iMC40Ii8+CiAgPGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iNSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjNmM1Y2U3IiBzdHJva2Utd2lkdGg9IjAuNiIgb3BhY2l0eT0iMC4zIi8+CiAgPGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMiIgZmlsbD0idXJsKCNnKSIgb3BhY2l0eT0iMC4zIi8+CiAgPHBhdGggZmlsbD0idXJsKCNnKSIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoOC41LCA4LjUpIHNjYWxlKDAuNSkiIGQ9Ik0gMjEuNTYyNSAwLjE3MTg3NSBMIDEwLjQ1MzEyNSAzLjU3MDMxMyBDIDkuMTA1NDY5IDMuOTUzMTI1IDguMDE1NjI1IDUuMzU1NDY5IDguMDE1NjI1IDYuNzAzMTI1IEwgOC4wMTU2MjUgMTguMjYxNzE5IEMgOC4wMTU2MjUgMTguMjYxNzE5IDguMDE1NjI1IDE4LjQxNzk2OSA4LjAxNTYyNSAxOC40MjE4NzUgQyA4LjAxNTYyNSAxOC40MjE4NzUgNy4yMTA5MzggMTcuODc4OTA2IDUuNDE3OTY5IDE4LjEzMjgxMyBDIDIuNzg1MTU2IDE4LjUwNzgxMyAwLjY0ODQzOCAyMC41MjczNDQgMC42NDg0MzggMjIuNjQ4NDM4IEMgMC42NDg0MzggMjQuNzY5NTMxIDIuNzg1MTU2IDI2LjA2NjQwNiA1LjQxNzk2OSAyNS42OTE0MDYgQyA4LjA1NDY4OCAyNS4zMjAzMTMgOS45ODQzNzUgMjMuMzYzMjgxIDkuOTg0Mzc1IDIxLjI0MjE4OCBDIDkuOTg0Mzc1IDIxLjI0MjE4OCA5Ljk4NDM3NSAxMi4xNzU3ODEgOS45ODQzNzUgOC4yMzQzNzUgQyA5Ljk4NDM3NSA3LjI5Njg3NSAxMS4xMTMyODEgNi44OTA2MjUgMTEuMTEzMjgxIDYuODkwNjI1IEwgMjAuOTM3NSAzLjgxMjUgQyAyMC45Mzc1IDMuODEyNSAyMi4wMjM0MzggMy40NDkyMTkgMjIuMDIzNDM4IDQuNDUzMTI1IEMgMjIuMDIzNDM4IDguNDYwOTM4IDIyLjAyMzQzOCAxNS40ODQzNzUgMjIuMDIzNDM4IDE1LjQ4NDM3NSBDIDIyLjAyMzQzOCAxNS40ODQzNzUgMjIuMDIzNDM4IDE1LjQ4ODI4MSAyMi4wMjM0MzggMTUuNDkyMTg4IEMgMjIuMDIzNDM4IDE1LjQ5MjE4OCAyMS4wMjM0MzggMTQuOTE0MDYzIDE5LjIzMDQ2OSAxNS4xMzI4MTMgQyAxNi41OTc2NTYgMTUuNDUzMTI1IDE0LjQ2MDkzOCAxNy40Mjk2ODggMTQuNDYwOTM4IDE5LjU1MDc4MSBDIDE0LjQ2MDkzOCAyMS42NzE4NzUgMTYuNTk3NjU2IDIzLjAxMTcxOSAxOS4yMzA0NjkgMjIuNjkxNDA2IEMgMjEuODYzMjgxIDIyLjM3NSAyNCAyMC4zOTQ1MzEgMjQgMTguMjczNDM4IEwgMjQgMS45MTAxNTYgQyAyNCAwLjU2NjQwNiAyMi45MDYyNSAtMC4yMTQ4NDQgMjEuNTYyNSAwLjE3MTg3NSBaIi8+Cjwvc3ZnPg==">
        <title>404 - 页面不存在</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                height: 100vh; display: flex; flex-direction: column;
                align-items: center; justify-content: center; gap: 16px;
                background: #0c0c16; color: #ececf4;
                font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
            }
            .code { 
                font-size: 72px; font-weight: 800;
                background: linear-gradient(135deg, #b8aefc, #7c6cf0);
                -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            .msg { font-size: 16px; color: #a8a8c0; }
            a { 
                margin-top: 8px; padding: 10px 24px; border-radius: 10px;
                background: #7c6cf0; color: #fff; text-decoration: none;
                font-size: 14px; transition: background 0.2s; }
            a:hover { background: #6a5ae0; }
        </style>
    </head>
    <body>
        <div class="code">404</div>
        <div class="msg">页面不存在</div>
        <a href="/">返回主页</a>
    </body>
    </html>""", 404


@app.errorhandler(403)
def forbidden(e):
    return jsonify({"error": "禁止访问"}), 403


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)
    # app.run(host="127.0.0.1", port=8080, debug=False)
