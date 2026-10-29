package net.wangnan.jokermusic;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/** Validation shared by the bridge and authenticated audio transport. */
final class PlaybackPolicy {
    static boolean isTrusted(String value) {
        try {
            URI uri = URI.create(value), origin = URI.create(BuildConfig.SITE_ORIGIN);
            return "https".equalsIgnoreCase(uri.getScheme()) && uri.getUserInfo() == null
                    && origin.getHost().equalsIgnoreCase(uri.getHost())
                    && (uri.getPort() == -1 || uri.getPort() == 443);
        } catch (IllegalArgumentException | NullPointerException e) { return false; }
    }

    static String streamUrl(String filename) {
        if (filename == null || filename.isEmpty() || filename.length() > 1024
                || filename.contains("/") || filename.contains("\\")
                || filename.equals(".") || filename.equals("..")) {
            throw new IllegalArgumentException("歌曲文件名无效");
        }
        for (int i = 0; i < filename.length(); i++) {
            if (filename.charAt(i) < 32 || filename.charAt(i) == 127)
                throw new IllegalArgumentException("歌曲文件名无效");
        }
        try {
            return BuildConfig.SITE_ORIGIN + "/api/stream/"
                    + URLEncoder.encode(filename, StandardCharsets.UTF_8.name()).replace("+", "%20");
        } catch (java.io.UnsupportedEncodingException impossible) { throw new AssertionError(impossible); }
    }

    static String mode(String value) {
        if (!"sequence".equals(value) && !"shuffle".equals(value) && !"repeat".equals(value))
            throw new IllegalArgumentException("播放模式无效");
        return value;
    }

    static long position(double seconds) {
        if (Double.isNaN(seconds) || Double.isInfinite(seconds) || seconds < 0 || seconds > 7 * 24 * 3600)
            throw new IllegalArgumentException("播放位置无效");
        return (long) (seconds * 1000);
    }
}
