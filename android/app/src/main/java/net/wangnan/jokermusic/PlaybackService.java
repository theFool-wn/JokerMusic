package net.wangnan.jokermusic;

import android.app.PendingIntent;
import android.content.Intent;
import android.webkit.CookieManager;
import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import java.io.IOException;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;

@UnstableApi
public final class PlaybackService extends MediaSessionService {
    private ExoPlayer player;
    private MediaSession session;

    @Override public void onCreate() {
        super.onCreate();
        // Initialize on the main thread; get fresh cookies for EVERY audio request.
        CookieManager cookies = CookieManager.getInstance();
        OkHttpClient client = new OkHttpClient.Builder()
                .followRedirects(false).followSslRedirects(false)
                .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
                .addInterceptor(chain -> {
                    Request request = chain.request();
                    if (!PlaybackPolicy.isTrusted(request.url().toString())
                            || !request.url().encodedPath().startsWith("/api/stream/"))
                        throw new IOException("Untrusted audio origin");
                    String cookie = cookies.getCookie(BuildConfig.SITE_ORIGIN);
                    Request.Builder builder = request.newBuilder().removeHeader("Cookie");
                    if (cookie != null) builder.header("Cookie", cookie);
                    return chain.proceed(builder.build());
                }).build();
        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(new OkHttpDataSource.Factory(client)))
                .build();
        player.setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true);
        player.setHandleAudioBecomingNoisy(true);
        player.setWakeMode(C.WAKE_MODE_NETWORK);
        player.setVolume(0.7f);
        PendingIntent openApp = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        session = new MediaSession.Builder(this, player).setSessionActivity(openApp).build();
        // The complete queue and foreground playback outlive the WebView/Activity.
        addSession(session);
    }

    @Nullable @Override public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        if (!isPlaybackOngoing()) { player.stop(); stopSelf(); }
    }

    @Override public void onDestroy() {
        if (session != null) session.release();
        if (player != null) player.release();
        super.onDestroy();
    }
}
