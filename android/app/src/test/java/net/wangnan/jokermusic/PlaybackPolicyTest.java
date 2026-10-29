package net.wangnan.jokermusic;

import org.junit.Test;
import static org.junit.Assert.*;

public class PlaybackPolicyTest {
    @Test public void credentialsStayOnTheExactHttpsOrigin() {
        assertTrue(PlaybackPolicy.isTrusted(BuildConfig.SITE_ORIGIN + "/api/stream/song.mp3"));
        assertTrue(PlaybackPolicy.isTrusted(BuildConfig.SITE_ORIGIN + ":443/"));
        assertFalse(PlaybackPolicy.isTrusted("http://jokermusic.wangnan.net/"));
        assertFalse(PlaybackPolicy.isTrusted("https://jokermusic.wangnan.net.evil.example/"));
        assertFalse(PlaybackPolicy.isTrusted("https://jokermusic.wangnan.net@evil.example/"));
        assertFalse(PlaybackPolicy.isTrusted("https://evil@jokermusic.wangnan.net/"));
        assertFalse(PlaybackPolicy.isTrusted(BuildConfig.SITE_ORIGIN + ":8443/"));
        assertFalse(PlaybackPolicy.isTrusted("file:///etc/passwd"));
        assertFalse(PlaybackPolicy.isTrusted(null));
    }

    @Test public void filenamesAreEncodedAsOnePathSegment() {
        assertEquals(BuildConfig.SITE_ORIGIN + "/api/stream/%E6%BC%94%E5%91%98%20%231%3F.mp3",
                PlaybackPolicy.streamUrl("演员 #1?.mp3"));
        assertTrue(PlaybackPolicy.streamUrl("%2e%2e.mp3").endsWith("%252e%252e.mp3"));
        for (String invalid : new String[]{"", "..", ".", "../song.mp3", "folder/song.mp3", "a\\b.mp3", "bad\n.mp3"}) {
            assertThrows(IllegalArgumentException.class, () -> PlaybackPolicy.streamUrl(invalid));
        }
    }

    @Test public void seekBoundsAndModesAreValidated() {
        assertEquals(42500, PlaybackPolicy.position(42.5));
        for (double invalid : new double[]{-1, Double.NaN, Double.POSITIVE_INFINITY, 604801})
            assertThrows(IllegalArgumentException.class, () -> PlaybackPolicy.position(invalid));
        for (String mode : new String[]{"sequence", "shuffle", "repeat"}) assertEquals(mode, PlaybackPolicy.mode(mode));
        assertThrows(IllegalArgumentException.class, () -> PlaybackPolicy.mode("loop_forever"));
    }
}
