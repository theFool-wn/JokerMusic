package net.wangnan.jokermusic;

import android.app.PendingIntent;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Build;
import androidx.media3.session.DefaultMediaNotificationProvider;
import android.content.Intent;
import android.webkit.CookieManager;
import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.Player;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.CommandButton;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionResult;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.Arrays;
import java.util.List;
import java.io.IOException;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;

@UnstableApi
public final class PlaybackService extends MediaSessionService {
    public static final String NOTIFICATION_CHANNEL_ID = DefaultMediaNotificationProvider.DEFAULT_CHANNEL_ID;
    private ExoPlayer player;
    private MediaSession session;
    static final String SETTINGS = "playback_settings";
    private SharedPreferences settings;
    private static final SessionCommand CYCLE_MODE =
            new SessionCommand("net.wangnan.jokermusic.CYCLE_MODE", Bundle.EMPTY);
    private static final SessionCommand TOGGLE_MUTE =
            new SessionCommand("net.wangnan.jokermusic.TOGGLE_MUTE", Bundle.EMPTY);

    static String playbackMode(Player player) {
        if (player.getRepeatMode() == Player.REPEAT_MODE_ONE) return "repeat";
        return player.getShuffleModeEnabled() ? "shuffle" : "sequence";
    }

    static void applyMode(Player player, String mode) {
        player.setShuffleModeEnabled("shuffle".equals(mode));
        player.setRepeatMode("repeat".equals(mode) ? Player.REPEAT_MODE_ONE
                : "shuffle".equals(mode) ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF);
    }

    private List<CommandButton> notificationButtons() {
        int modeIcon = CommandButton.ICON_REPEAT_ALL;
        int modeLabel = R.string.mode_sequence;
        switch (playbackMode(player)) {
            case "shuffle":
                modeIcon = CommandButton.ICON_SHUFFLE_ON;
                modeLabel = R.string.mode_shuffle;
                break;
            case "repeat":
                modeIcon = CommandButton.ICON_REPEAT_ONE;
                modeLabel = R.string.mode_repeat;
                break;
        }
        boolean muted = player.getVolume() == 0f;
        return Arrays.asList(
                new CommandButton.Builder(modeIcon).setSessionCommand(CYCLE_MODE)
                        .setDisplayName(getString(modeLabel)).setSlots(CommandButton.SLOT_OVERFLOW).build(),
                new CommandButton.Builder(muted ? CommandButton.ICON_VOLUME_OFF : CommandButton.ICON_VOLUME_UP)
                        .setSessionCommand(TOGGLE_MUTE).setDisplayName(getString(muted
                                ? R.string.action_unmute : R.string.action_mute))
                        .setSlots(CommandButton.SLOT_OVERFLOW).build());
    }

    private final MediaSession.Callback controls = new MediaSession.Callback() {
        @Override public MediaSession.ConnectionResult onConnect(MediaSession session,
                MediaSession.ControllerInfo controller) {
            return new MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                    .setAvailableSessionCommands(MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS
                            .buildUpon().add(CYCLE_MODE).add(TOGGLE_MUTE).build()).build();
        }

        @Override public ListenableFuture<SessionResult> onCustomCommand(MediaSession session,
                MediaSession.ControllerInfo controller, SessionCommand command, Bundle args) {
            if (CYCLE_MODE.equals(command)) {
                String mode = playbackMode(player);
                applyMode(player, "sequence".equals(mode) ? "shuffle"
                        : "shuffle".equals(mode) ? "repeat" : "sequence");
            } else if (TOGGLE_MUTE.equals(command)) {
                float volume = player.getVolume();
                if (volume > 0f) {
                    settings.edit().putFloat("lastAudibleVolume", volume).apply();
                    player.setVolume(0f);
                } else {
                    player.setVolume(settings.getFloat("lastAudibleVolume", 0.7f));
                }
            } else {
                return MediaSession.Callback.super.onCustomCommand(session, controller, command, args);
            }
            return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(NOTIFICATION_CHANNEL_ID,
                    getString(R.string.playback_channel_name), NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(getString(R.string.playback_channel_description));
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            channel.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
        DefaultMediaNotificationProvider notifications = new DefaultMediaNotificationProvider.Builder(this)
                .setChannelId(NOTIFICATION_CHANNEL_ID)
                .setChannelName(R.string.playback_channel_name).build();
        notifications.setSmallIcon(R.drawable.ic_stat_music);
        setMediaNotificationProvider(notifications);
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
        settings = getSharedPreferences(SETTINGS, MODE_PRIVATE);
        player.setVolume(settings.getFloat("volume", 0.7f));
        applyMode(player, settings.getString("mode", "sequence"));
        PendingIntent openApp = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        ForwardingPlayer sessionPlayer = new ForwardingPlayer(player) {
			private void nextAndPlay() {
				if (player.getMediaItemCount() == 0) return;
				int nextIndex = player.getNextMediaItemIndex();
				if (nextIndex == C.INDEX_UNSET) {
					nextIndex = 0;
				}
				player.seekToDefaultPosition(nextIndex);
				if (player.getPlaybackState() == Player.STATE_IDLE) {
					player.prepare();
				}
				player.play();
			}
			@Override
			public void seekToNext() {
				nextAndPlay();
			}
			@Override
			public void seekToNextMediaItem() {
				nextAndPlay();
			}
		};
        session = new MediaSession.Builder(this, sessionPlayer)
                .setSessionActivity(openApp).setCallback(controls)
                .setMediaButtonPreferences(notificationButtons()).build();
        player.addListener(new Player.Listener() {
            private boolean muted = player.getVolume() == 0f;

            @Override public void onEvents(Player source, Player.Events events) {
                boolean modeChanged = events.contains(Player.EVENT_REPEAT_MODE_CHANGED)
                        || events.contains(Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED);
                boolean volumeChanged = events.contains(Player.EVENT_VOLUME_CHANGED);
                if (!modeChanged && !volumeChanged) return;
                SharedPreferences.Editor edit = settings.edit();
                if (modeChanged) edit.putString("mode", playbackMode(source));
                float volume = source.getVolume();
                if (volumeChanged) {
                    edit.putFloat("volume", volume);
                    if (volume > 0f) edit.putFloat("lastAudibleVolume", volume);
                }
                edit.apply();
                boolean nowMuted = volume == 0f;
                if (modeChanged || nowMuted != muted) {
                    muted = nowMuted;
                    session.setMediaButtonPreferences(notificationButtons());
                }
            }
        });
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
