package net.wangnan.jokermusic;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;

import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.google.common.util.concurrent.ListenableFuture;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

@UnstableApi
public final class MainActivity extends ComponentActivity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<Runnable> pending = new ArrayList<>();
    private WebView webView;
    private ListenableFuture<MediaController> controllerFuture;
    private MediaController controller;
    private JavaScriptReplyProxy reply;
    private int documentGeneration;
    private boolean visible;
    private boolean oldPageWarning;
    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            publishState();
            if (visible) handler.postDelayed(this, 1000);
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(12, 12, 22));
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            new AlertDialog.Builder(this).setMessage("请先更新 Android System WebView 或 Chrome，再打开 Joker Music。")
                    .setPositiveButton("关闭", (dialog, which) -> finish()).setCancelable(false).show();
            return;
        }
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
        WebViewCompat.addWebMessageListener(webView, "JokerNative",
                Collections.singleton(BuildConfig.SITE_ORIGIN), (view, message, origin, mainFrame, proxy) -> {
                    if (!mainFrame || !PlaybackPolicy.isTrusted(origin.toString())
                            || !PlaybackPolicy.isTrusted(view.getUrl())) return;
                    String data = message.getData();
                    if (data == null || data.length() > 1024 * 1024) return;
                    int generation = documentGeneration;
                    Runnable action = () -> {
                        if (generation == documentGeneration) handleMessage(data, proxy);
                    };
                    if (controller != null) action.run();
                    else if (pending.size() < 16) pending.add(action);
                });
        }
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return !PlaybackPolicy.isTrusted(request.getUrl().toString());
                String url = request.getUrl().toString();
                if (PlaybackPolicy.isTrusted(url)) return false;
                if ("https".equals(request.getUrl().getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); }
                    catch (android.content.ActivityNotFoundException ignored) { }
                }
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                documentGeneration++;
                reply = null;
                pending.clear();
                if (!PlaybackPolicy.isTrusted(url)) { view.stopLoading(); return; }
                String path = Uri.parse(url).getPath();
                if ("/logout".equals(path) || "/login".equals(path)) stopPlayback();
            }
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                if (!PlaybackPolicy.isTrusted(url) || !"/".equals(Uri.parse(url).getPath())) return;
                view.evaluateJavascript("Boolean(window.JokerPlayback && window.JokerPlayback.NativeAudio)", value -> {
                    if (!"true".equals(value) && !oldPageWarning && !isFinishing()) {
                        oldPageWarning = true;
                        new AlertDialog.Builder(MainActivity.this)
                                .setMessage("网站未加载原生播放适配代码，等待开发者更新。")
                                .setPositiveButton("知道了", null).show();
                    }
                });
            }
        });
        controllerFuture = new MediaController.Builder(this,
                new SessionToken(this, new ComponentName(this, PlaybackService.class))).buildAsync();
        controllerFuture.addListener(() -> {
            try {
                controller = controllerFuture.get();
                controller.addListener(new Player.Listener() {
                    @Override public void onEvents(Player player, Player.Events events) { publishState(); }
                });
                if (webView != null && webView.getUrl() != null) {
                    String path = Uri.parse(webView.getUrl()).getPath();
                    if ("/login".equals(path) || "/logout".equals(path)) stopPlayback();
                }
                for (Runnable action : new ArrayList<>(pending)) action.run();
                pending.clear();
            } catch (Exception error) {
                Toast.makeText(this, "播放器连接失败，请刷新重试", Toast.LENGTH_LONG).show();
            }
        }, command -> handler.post(command));
        webView.loadUrl(BuildConfig.SITE_ORIGIN + "/");
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { goBack(); }
        });
    }

    private void handleMessage(String data, JavaScriptReplyProxy proxy) {
        long id = -1;
        try {
            JSONObject request = new JSONObject(data);
            id = request.getLong("id");
            reply = proxy;
            switch (request.getString("command")) {
                case "hello": break;
                case "queue": setQueue(request); break;
                case "play":
                    if (controller.getPlaybackState() == Player.STATE_ENDED) controller.seekTo(0);
                    if (controller.getPlaybackState() == Player.STATE_IDLE) controller.prepare();
                    controller.play(); break;
                case "pause": controller.pause(); break;
                case "stop": stopPlayback(); break;
                case "next": skip(false); break;
                case "previous": skip(true); break;
                case "seek": controller.seekTo(PlaybackPolicy.position(request.getDouble("position"))); break;
                case "mode": applyMode(PlaybackPolicy.mode(request.getString("mode"))); break;
                case "volume":
                    double volume = request.getDouble("volume");
                    if (Double.isNaN(volume) || Double.isInfinite(volume) || volume < 0 || volume > 1)
                        throw new IllegalArgumentException("音量无效");
                    controller.setVolume((float) volume); break;
                default: throw new IllegalArgumentException("未知的播放命令");
            }
            sendToPage(proxy, new JSONObject().put("type", "ack").put("id", id));
            publishState();
        } catch (Exception error) {
            try { sendToPage(proxy, new JSONObject().put("type", "error").put("id", id)
                    .put("message", "无法播放：" + error.getMessage())); }
            catch (Exception ignored) { }
        }
    }

    private void setQueue(JSONObject request) throws JSONException {
        JSONArray songs = request.getJSONArray("songs");
        int index = request.getInt("index");
        if (songs.length() == 0 || songs.length() > 2000 || index < 0 || index >= songs.length())
            throw new IllegalArgumentException("播放队列无效或超过 2000 首");
        String mode = PlaybackPolicy.mode(request.getString("mode"));
        String playlistId = request.optString("playlistId", "all");
        if (playlistId.length() > 256) throw new IllegalArgumentException("歌单无效");
        long position = PlaybackPolicy.position(request.optDouble("position", 0));
        List<MediaItem> items = new ArrayList<>();
        for (int i = 0; i < songs.length(); i++) {
            JSONObject song = songs.getJSONObject(i);
            String filename = song.getString("filename");
            String url = PlaybackPolicy.streamUrl(filename);
            Bundle extras = new Bundle();
            extras.putString("playlistId", playlistId);
            items.add(new MediaItem.Builder().setMediaId(filename).setUri(url)
                    .setMimeType("audio/mpeg")
                    .setMediaMetadata(new MediaMetadata.Builder().setTitle(song.optString("title", filename))
                            .setArtist(song.optString("artist", ""))
                            .setAlbumTitle(song.optString("album", ""))
                            .setExtras(extras).build()).build());
        }
        // Validate the ENTIRE new queue before touching a currently playing queue.
        controller.setMediaItems(items, index, position);
        applyMode(mode);
        controller.prepare();
        controller.setPlayWhenReady(request.optBoolean("play", true));
    }

    private void applyMode(String mode) {
        controller.setShuffleModeEnabled("shuffle".equals(mode));
        controller.setRepeatMode("repeat".equals(mode) ? Player.REPEAT_MODE_ONE
                : "shuffle".equals(mode) ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF);
    }

    private void skip(boolean previous) {
        int count = controller.getMediaItemCount();
        if (count == 0) return;
        if (previous && controller.getCurrentPosition() > 3000) controller.seekTo(0);
        else {
            int index = previous ? controller.getPreviousMediaItemIndex() : controller.getNextMediaItemIndex();
            controller.seekToDefaultPosition(index == C.INDEX_UNSET ? (previous ? count - 1 : 0) : index);
        }
        if (controller.getPlaybackState() == Player.STATE_IDLE) controller.prepare();
        controller.play();
    }

    private void stopPlayback() {
        if (controller != null) { controller.stop(); controller.clearMediaItems(); }
    }

    private void publishState() {
        if (reply == null || controller == null) return;
        try {
            JSONArray queue = new JSONArray();
            for (int i = 0; i < controller.getMediaItemCount(); i++) {
                MediaItem item = controller.getMediaItemAt(i);
                MediaMetadata meta = item.mediaMetadata;
                queue.put(new JSONObject().put("filename", item.mediaId).put("title", text(meta.title))
                        .put("artist", text(meta.artist)).put("album", text(meta.albumTitle)));
            }
            MediaItem current = controller.getCurrentMediaItem();
            String playlist = current != null && current.mediaMetadata.extras != null
                    ? current.mediaMetadata.extras.getString("playlistId", "all") : "all";
            int playbackState = controller.getPlaybackState();
            boolean playing = controller.getPlayWhenReady() && playbackState != Player.STATE_ENDED
                    && playbackState != Player.STATE_IDLE
                    && controller.getPlaybackSuppressionReason() == Player.PLAYBACK_SUPPRESSION_REASON_NONE;
            String mode = controller.getRepeatMode() == Player.REPEAT_MODE_ONE ? "repeat"
                    : controller.getShuffleModeEnabled() ? "shuffle" : "sequence";
            sendToPage(reply, new JSONObject().put("type", "state").put("protocol", 1)
                    .put("appVersion", BuildConfig.VERSION_NAME).put("queue", queue)
                    .put("index", queue.length() == 0 ? -1 : controller.getCurrentMediaItemIndex())
                    .put("playlistId", playlist).put("mode", mode).put("playing", playing)
                    .put("ended", playbackState == Player.STATE_ENDED)
                    .put("position", Math.max(0, controller.getCurrentPosition()) / 1000.0)
                    .put("duration", Math.max(0, controller.getDuration()) / 1000.0)
                    .put("volume", controller.getVolume()).put("error", playbackError()));
        } catch (JSONException | IllegalStateException ignored) { }
    }

    private void sendToPage(JavaScriptReplyProxy target, JSONObject message) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            target.postMessage(message.toString());
        }
    }

    private String playbackError() {
        PlaybackException error = controller.getPlayerError();
        if (error == null) return "";
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof HttpDataSource.InvalidResponseCodeException
                    && ((HttpDataSource.InvalidResponseCodeException) cause).responseCode == 401)
                return "登录已过期，请重新登录";
        }
        return "音频加载失败，检查网络连接（" + error.errorCode + "）";
    }

    private static String text(CharSequence value) { return value == null ? "" : value.toString(); }
    private void goBack() { if (webView != null && webView.canGoBack()) webView.goBack(); else moveTaskToBack(true); }
    @Override protected void onStart() { super.onStart(); visible = true; handler.post(ticker); }
    @Override protected void onStop() { visible = false; handler.removeCallbacks(ticker); super.onStop(); }
    @Override protected void onResume() { super.onResume(); if (webView != null) webView.onResume(); }
    @Override protected void onPause() { if (webView != null) webView.onPause(); super.onPause(); }
    @Override protected void onDestroy() {
        visible = false; handler.removeCallbacksAndMessages(null);
        documentGeneration++; pending.clear(); reply = null;
        if (controllerFuture != null) MediaController.releaseFuture(controllerFuture);
        if (webView != null) { webView.stopLoading(); webView.destroy(); webView = null; }
        super.onDestroy();
    }
}
