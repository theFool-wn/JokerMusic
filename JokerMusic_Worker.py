# @             Project: JokerMusic -> JokerMusic_Worker.py
# @              Author: WangNan
# @       Creation Date: 2026/9/5 16:37
# @         Description: A Private Music Player about Joker Xue
# @ Version Information: Created by WangNan, 2026/9/5 - 2026/9/9
#                        Revised by WangNan, 2026/10/11, adapted for Cloudflare Python Worker
#                                                        added JWT cookie
#                        Revised by WangNan, 2026/10/15, fix deployment error
# =============================================================================================================


import os
import json
import re
import time
import base64
from urllib.parse import unquote, parse_qs

from js import URL, console, Request, Uint8Array, crypto
from workers import WorkerEntrypoint, Response


# =============================================================================================================
# 第三方包安装
# =============================================================================================================
_PACKAGES_READY = False

async def ensure_packages():
    """确认依赖可用"""
    global _PACKAGES_READY
    if _PACKAGES_READY:
        return
        
    try:
        import mutagen
        import pypinyin
    except ImportError:
        try:
            import micropip
            await micropip.install(["mutagen", "pypinyin"])
            console.log("[Joker's Music] mutagen/pypinyin installed via micropip")
        except Exception as e:
            console.log(f"[Joker's Music] package import failed: {e}")
    _PACKAGES_READY = True


# =============================================================================================================
# JWT 工具函数
# =============================================================================================================
# 使用 Cloudflare Worker 内置的 Web Crypto API (HMAC-SHA256) 签名和验证

def _b64url_encode(data: bytes) -> str:
    """bytes → base64url 字符串 (去掉填充 =)"""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    """base64url 字符串 → bytes (补回填充 =)"""
    padding = 4 - len(s) % 4
    if padding != 4:
        s += "=" * padding
    return base64.urlsafe_b64decode(s)


def _get_jwt_secret(env) -> str:
    """
    获取 JWT 签名密钥
    未配置 env.JWT_SECRET 时回退到 env.SITE_PASSWORD
    """
    secret = getattr(env, "JWT_SECRET", None)
    if not secret:
        secret = env.SITE_PASSWORD
    return secret


async def create_token(env) -> str:
    """签发 JWT Token"""
    header = {
        "alg": "HS256",
        "typ": "JWT",
    }
    header_b64 = _b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    
    now = int(time.time())
    payload = {
        "exp": now + int(env.TOKEN_TTL_DAYS) * 24 * 3600,    # 过期时间
        "iat": now,                                 # 签发时间
    }
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    
    signing_input = f"{header_b64}.{payload_b64}"
    
    # 导入 HMAC 密钥
    key = await crypto.subtle.importKey(
        "raw",
        Uint8Array.new(_get_jwt_secret(env).encode("utf-8")),
        {"name": "HMAC", "hash": "SHA-256"},
        False,
        ["sign"],
    )
    
    # 计算签名
    signature = await crypto.subtle.sign(
        "HMAC",
        key,
        Uint8Array.new(signing_input.encode("utf-8")),
    )
    sig_b64 = _b64url_encode(bytes(Uint8Array.new(signature)))

    return f"{header_b64}.{payload_b64}.{sig_b64}"


async def verify_token(env, token: str) -> bool:
    """验证标准 JWT Token 签名和过期时间"""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return False
        header_b64, payload_b64, sig_b64 = parts

        # 校验 header 中的算法
        header = json.loads(_b64url_decode(header_b64))
        if header.get("alg") != "HS256":
            return False

        signing_input = f"{header_b64}.{payload_b64}"

        # 导入 HMAC 密钥
        key = await crypto.subtle.importKey(
            "raw",
            Uint8Array.new(_get_jwt_secret(env).encode("utf-8")),
            {"name": "HMAC", "hash": "SHA-256"},
            False,
            ["verify"],
        )
        
        # 验证签名
        signature_bytes = _b64url_decode(sig_b64)
        valid = await crypto.subtle.verify(
            "HMAC",
            key,
            Uint8Array.new(signature_bytes),
            Uint8Array.new(signing_input.encode("utf-8")),
        )
        if not valid:
            return False

        # 检查过期时间
        payload = json.loads(_b64url_decode(payload_b64))
        if payload.get("exp", 0) < int(time.time()):
            return False

        return True
        
    except Exception as e:
        console.log(f"[Joker's Music] Token 验证失败: {e}")
        return False


def get_token_from_cookie(request, env) -> str:
    """从请求 Cookie 中提取 session_token"""
    cookie_header = request.headers.get("Cookie") or ""
    for cookie in cookie_header.split(";"):
        cookie = cookie.strip()
        if cookie.startswith(env.COOKIE_NAME + "="):
            return cookie[len(env.COOKIE_NAME) + 1 :]
    return ""


# =============================================================================================================
# 通用工具函数
# =============================================================================================================

def json_response(data, status=200):
    """统一 JSON 响应"""
    return Response(
        json.dumps(data, ensure_ascii=False),
        status=status,
        headers={"Content-Type": "application/json; charset=utf-8"},
    )


def redirect_response(location):
    """302 重定向"""
    return Response("", status=302, headers={"Location": location})


def make_session_cookie(token: str, env) -> str:
    """
    构造 Set-Cookie 头
    HttpOnly 防 JS 读取
    SameSite=Lax 防 CSRF
    Secure 只在 HTTPS 下发送
    """
    max_age = int(env.TOKEN_TTL_DAYS) * 24 * 3600
    return (
        f"{env.COOKIE_NAME}={token}; Path=/; Max-Age={max_age}; "
        f"HttpOnly; SameSite=Lax; Secure"
    )


def clear_session_cookie(env) -> str:
    """登出时清除 cookie"""
    return f"{env.COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure"


# =============================================================================================================
# 登录鉴权
# =============================================================================================================

async def is_logged_in(request, env) -> bool:
    """验证用户是否已登录, 从 Cookie 读 Token, 验证签名"""
    token = get_token_from_cookie(request, env)
    if not token:
        return False
    return await verify_token(env, token)


# =============================================================================================================
# 业务工具函数
# =============================================================================================================

def safe_filename(filename: str) -> str:
    """过滤文件名, 防止路径遍历攻击"""
    filename = os.path.basename(filename)
    filename = unquote(filename)
    if not re.match(r'^[\w\u4e00-\u9fff\s\.\-\(\)&]+$', filename, re.UNICODE):
        raise ValueError("非法文件名")
    return filename


async def render_login_page(env, error: str = ""):
    """
    登录页渲染
    从 Workers Assets 读取 login.html, 替换错误提示占位符
    """
    resp = await env.ASSETS.fetch("/login.html")
    html = await resp.text()

    error_html = f'<p class="login-error">{error}</p>' if error else ""
    html = html.replace("<!--ERROR_HTML-->", error_html)

    return Response(
        html,
        headers={"Content-Type": "text/html; charset=utf-8"},
    )


class _PartialMP3File:
    """
    稀疏文件对象：只包含 mp3 文件开头的真实数据，其余位置返回零字节
    用于节约流量与内存资源
    """
    def __init__(self, header_data: bytes, full_size: int):
        self._data = header_data          # 开头的真实数据
        self._data_len = len(header_data)
        self._size = full_size            # 报告给 mutagen 的完整文件大小
        self._pos = 0

    def read(self, n: int = -1) -> bytes:
        if n < 0:
            n = self._size - self._pos
        end = min(self._pos + n, self._size)
        length = end - self._pos
        if length <= 0:
            return b""

        if self._pos < self._data_len:
            # 读取范围有一部分在真实数据内
            real_end = min(end, self._data_len)
            chunk = bytearray(self._data[self._pos:real_end])
            # 超出真实数据的部分用零填充
            if real_end < end:
                chunk.extend(b"\x00" * (end - real_end))
            result = bytes(chunk)
        else:
            # 完全在真实数据之外，全返回零
            result = b"\x00" * length

        self._pos = end
        return result

    def seek(self, offset: int, whence: int = 0) -> int:
        if whence == 0:
            self._pos = offset
        elif whence == 1:
            self._pos += offset
        elif whence == 2:
            self._pos = self._size + offset
        self._pos = max(0, min(self._pos, self._size))
        return self._pos

    def tell(self) -> int:
        return self._pos
        
    def close(self):
        pass


async def read_id3_tag(env, key: str) -> dict:
    """
    从 R2 下载 MP3 到内存, 读取 ID3 标签
    只下载前 512KB (覆盖 ID3v2 + MPEG 帧头)，不完整下载
    用 _PartialMP3File 虚拟文件对象让 mutagen 以为在读完整文件
    """
    info = {"title": "", "artist": "", "album": "", "duration": 0}

    try:
        from mutagen.mp3 import MP3

        obj_head = await env.JokerMusicLibrary.head(key)
        if obj_head is None:
            return info
        file_size = obj_head.size

        if file_size <= 0:
            return info
            
        header_size = min(int(env.ID3_HEADER_SIZE), file_size)
        header_obj = await env.JokerMusicLibrary.get(
            key,
            {"range": {"start": 0, "end": header_size - 1}}
        )
        
        if header_obj is None:
            return info
        header_data = bytes(Uint8Array.new(await header_obj.arrayBuffer()))
        if not header_data:
            return info

        virtual_file = _PartialMP3File(header_data, file_size)
        audio = MP3(virtual_file)

        # TIT2=标题, TPE1=艺术家, TALB=专辑
        if "TIT2" in audio:
            info["title"] = str(audio["TIT2"].text[0]).strip()
        if "TPE1" in audio:
            info["artist"] = str(audio["TPE1"].text[0]).strip()
        if "TALB" in audio:
            info["album"] = str(audio["TALB"].text[0]).strip()
        if audio.info and audio.info.length:
            info["duration"] = round(audio.info.length, 2)

    except Exception as e:
        console.log(f"[Joker's Music] 读取ID3失败 ({key}): {e}")

    return info


async def scan_music_library(env) -> list:
    """
    扫描 R2 中 music/ 前缀下的全部 MP3, 读取 ID3 标签, 匹配同名 LRC 歌词
    返回歌曲列表, 按标题拼音排序
    """
    songs = []

    result = await env.JokerMusicLibrary.list({"prefix": env.MUSIC_PREFIX})
    objects = result.objects

    for obj in objects:
        key = obj.key
        fname = key[len(env.MUSIC_PREFIX):]

        if not fname.lower().endswith(".mp3"):
            continue

        tag = await read_id3_tag(env, key)

        base_name = fname[:-4] if fname.lower().endswith(".mp3") else fname
        title = tag["title"] if tag["title"] else base_name

        # 检查同名 LRC 歌词是否存在
        lrc_key = env.LYRIC_PREFIX + base_name + ".lrc"
        lrc_obj = await env.JokerMusicLibrary.head(lrc_key)
        has_lyric = lrc_obj is not None

        songs.append({
            "filename": fname,
            "title": title,
            "artist": tag["artist"],
            "album": tag["album"],
            "duration": tag["duration"],
            "has_lyric": has_lyric,
        })

    # 按标题拼音排序
    try:
        from pypinyin import lazy_pinyin
        songs.sort(key=lambda s: "".join(lazy_pinyin(s["title"])))
    except Exception:
        songs.sort(key=lambda s: s["title"])

    return songs


async def get_songs(env, force_refresh: bool = False) -> list:
    """获取歌库, 带 KV 缓存"""
    if not force_refresh:
        cached_str = await env.JokerMusicKV.get(env.CACHE_KEY)
        if cached_str:
            try:
                return json.loads(cached_str)
            except Exception:
                pass

    songs = await scan_music_library(env)

    await env.JokerMusicKV.put(
        env.CACHE_KEY,
        json.dumps(songs, ensure_ascii=False),
        expirationTtl=int(env.CACHE_TTL),
    )

    return songs


async def handle_login_post(request, env):
    """
    处理登录 POST
    验证密码后签发 JWT Token, 写入 Cookie
    """
    site_password = env.SITE_PASSWORD

    if not site_password:
        return await render_login_page(env, error="管理员未设置站点密码")

    try:
        form_data = await request.formData()
        password = form_data.get("password") or ""
    except Exception:
        body = await request.text()
        params = parse_qs(body)
        password = params.get("password", [""])[0]

    if password == site_password:
        token = await create_token(env)
        resp = redirect_response("/")
        resp.headers.set("Set-Cookie", make_session_cookie(token, env))
        return resp

    return await render_login_page(env, error="密码错误, 请重试")


async def handle_api_songs(request, env):
    """/api/songs - 返回歌库列表"""
    songs = await get_songs(env)
    return json_response({"count": len(songs), "songs": songs})


async def handle_api_reload(request, env):
    """/api/reload - 强制刷新歌库"""
    songs = await get_songs(env, force_refresh=True)
    return json_response({"count": len(songs), "songs": songs, "message": "歌库已刷新"})


async def handle_api_lyric(request, env, filename: str):
    """/api/lyric/<filename> - 返回歌词内容"""
    try:
        filename = safe_filename(filename)
    except ValueError:
        return json_response({"error": "非法文件名"}, 400)

    base = filename.rsplit(".", 1)[0] if "." in filename else filename
    lrc_key = env.LYRIC_PREFIX + base + ".lrc"

    obj = await env.JokerMusicLibrary.get(lrc_key)
    if obj is None:
        return json_response({"lyric": "", "has_lyric": False})

    try:
        data = await obj.arrayBuffer()
        raw = bytes(Uint8Array.new(data))

        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            content = raw.decode("gbk", errors="replace")

        return json_response({"lyric": content, "has_lyric": True})
    except Exception as e:
        return json_response({"lyric": "", "has_lyric": False, "error": str(e)}, 500)


async def handle_api_stream(request, env, filename: str):
    """/api/stream/<filename> - 音频流式播放"""
    try:
        filename = safe_filename(filename)
    except ValueError:
        return Response("非法文件名", status=400)

    key = env.MUSIC_PREFIX + filename

    obj_head = await env.JokerMusicLibrary.head(key)
    if obj_head is None:
        return Response("音频文件不存在", status=404)

    file_size = obj_head.size
    mime_type = "audio/mpeg"

    # 解析 Range 请求头
    range_header = request.headers.get("Range") or ""
    range_header = range_header.strip()
    start = 0
    end = file_size - 1
    has_range = False

    if range_header.startswith("bytes="):
        has_range = True
        range_value = range_header[6:]
        if "-" in range_value:
            parts = range_value.split(",")[0].split("-", 1)
            start_str, end_str = parts[0], parts[1]
            if start_str:
                start = int(start_str)
            if end_str:
                end = int(end_str)
            if start >= file_size:
                return Response(status=416)
            end = min(end, file_size - 1)
            if start > end:
                return Response(status=416)

    content_length = end - start + 1

    if has_range:
        obj = await env.JokerMusicLibrary.get(key, {"range": {"start": start, "end": end}})
    else:
        obj = await env.JokerMusicLibrary.get(key)

    if obj is None:
        return Response("音频文件不存在", status=404)

    headers = {
        "Content-Type": mime_type,
        "Content-Length": str(content_length),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
    }

    if has_range:
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
        return Response(obj.body, status=206, headers=headers)
    else:
        return Response(obj.body, status=200, headers=headers)


def not_found_response(path: str):
    """
    404 页面
    API 请求返回 JSON, 页面请求返回友好的 404 HTML
    """
    if path.startswith("/api/"):
        return json_response({"error": "资源不存在"}, 404)

    html = """<!DOCTYPE html>
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
</html>"""
    return Response(html, status=404, headers={"Content-Type": "text/html; charset=utf-8"})


class Default(WorkerEntrypoint):
    """
    Cloudflare Python Worker 入口类

    路由表:
        公开 (无需登录) :
            GET  /login              → 登录页
            POST /login              → 登录提交 (验证密码 → 签发 JWT)
            GET  /logout             → 登出 (清除 Cookie)
            GET  /robots.txt         → 爬虫协议
            GET  /sw.js              → Service Worker
            GET  /manifest.json      → PWA 清单
            GET  /static/*           → 静态资源

        需登录 (JWT 验证) :
            GET  /                   → 主页
            GET  /api/songs          → 歌库列表
            POST /api/reload         → 刷新歌库
            GET  /api/lyric/<file>   → 歌词
            GET  /api/stream/<file>  → 音频流
    """
    
    async def fetch(self, request):
        env = self.env
        await ensure_packages()

        url    = URL.new(request.url)
        path   = url.pathname
        method = request.method

        # -------------------------------------------------------------------------
        # 公开路由
        # -------------------------------------------------------------------------

        if path == "/login":
            if method == "POST":
                return await handle_login_post(request, env)
            if await is_logged_in(request, env):
                return redirect_response("/")
            return await render_login_page(env)

        if path == "/logout":
            resp = redirect_response("/login")
            resp.headers.set("Set-Cookie", clear_session_cookie(env))
            return resp

        if path == "/robots.txt":
            return Response(
                "User-agent: *\nDisallow: /\n",
                headers={"Content-Type": "text/plain"},
            )

        if path == "/sw.js":
            return await env.ASSETS.fetch(request)

        if path == "/manifest.json":
            return await env.ASSETS.fetch(request)

        if path.startswith("/static/"):
            asset_path = path[len("/static"):]
            return await env.ASSETS.fetch(asset_path)

        # -------------------------------------------------------------------------
        # 以下路由需要登录验证
        # -------------------------------------------------------------------------
        logged_in = await is_logged_in(request, env)

        if path == "/":
            if not logged_in:
                return redirect_response("/login")
            return await env.ASSETS.fetch("/index.html")

        if path == "/api/songs":
            if not logged_in:
                return json_response({"error": "未登录"}, 401)
            return await handle_api_songs(request, env)

        if path == "/api/reload" and method == "POST":
            if not logged_in:
                return json_response({"error": "未登录"}, 401)
            return await handle_api_reload(request, env)

        if path.startswith("/api/lyric/"):
            if not logged_in:
                return json_response({"error": "未登录"}, 401)
            filename = path[len("/api/lyric/"):]
            return await handle_api_lyric(request, env, filename)

        if path.startswith("/api/stream/"):
            if not logged_in:
                return json_response({"error": "未登录"}, 401)
            filename = path[len("/api/stream/"):]
            return await handle_api_stream(request, env, filename)

        # -------------------------------------------------------------------------
        # 404
        # -------------------------------------------------------------------------
        asset_resp = await env.ASSETS.fetch(request)
        if asset_resp.status != 404:
            return asset_resp

        return not_found_response(path)
