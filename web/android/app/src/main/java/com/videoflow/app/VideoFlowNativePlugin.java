package com.videoflow.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import androidx.activity.result.ActivityResult;
import android.webkit.CookieManager;
import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.YoutubeDLResponse;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import kotlin.Unit;
import kotlin.jvm.functions.Function3;

/**
 * Runs yt-dlp + ffmpeg directly on the phone (via youtubedl-android), so the app works without any server.
 */
@CapacitorPlugin(name = "VideoFlowNative")
public class VideoFlowNativePlugin extends Plugin {

    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final java.util.concurrent.ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor();
    private volatile boolean ready = false;
    private volatile String initError = null;
    private volatile boolean updating = false;
    private static final long UPDATE_EVERY_MS = 12L * 3600_000L;

    private volatile String pendingShare = null;

    @Override
    public void load() {
        pendingShare = sharedText(getActivity() != null ? getActivity().getIntent() : null);
        pool.execute(() -> {
            try {
                YoutubeDL.getInstance().init(getContext());
                FFmpeg.getInstance().init(getContext());
            } catch (Throwable e) {
                initError = String.valueOf(e.getMessage());
                return;
            }
            try { writeCookies(); } catch (Throwable ignored) { }
            ready = true; // usable right away; the engine refresh below runs in the background
            android.content.SharedPreferences prefs = getContext().getSharedPreferences("videoflow", Context.MODE_PRIVATE);
            long last = prefs.getLong("lastEngineUpdate", 0);
            if (System.currentTimeMillis() - last > UPDATE_EVERY_MS) {
                updating = true;
                try {
                    YoutubeDL.getInstance().updateYoutubeDL(getContext(), YoutubeDL.UpdateChannel.STABLE.INSTANCE);
                    prefs.edit().putLong("lastEngineUpdate", System.currentTimeMillis()).apply();
                } catch (Throwable ignored) {
                    // offline or GitHub unreachable: keep the current engine, try again next launch
                } finally {
                    updating = false;
                }
            }
        });
    }

    // ---------- "Share → VideoFlow" from YouTube, TikTok, Instagram… ----------

    private static String sharedText(Intent intent) {
        if (intent == null) return null;
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            String t = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (t != null && !t.trim().isEmpty()) return t;
        }
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            return intent.getData().toString();
        }
        return null;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String t = sharedText(intent);
        if (t != null) {
            JSObject o = new JSObject();
            o.put("text", t);
            notifyListeners("shared", o, true);
        }
    }

    /** Text shared to the app when it was launched (returned once). */
    @PluginMethod
    public void getShared(PluginCall call) {
        JSObject o = new JSObject();
        o.put("text", pendingShare);
        pendingShare = null;
        call.resolve(o);
    }

    // ---------- Sign in (only for videos the site shows to signed-in users, e.g. age-restricted reels) ----------

    /** id, name, sign-in page, page whose cookies we read, session cookie, cookie domain */
    private static final String[][] SITES = {
            {"instagram", "Instagram", "https://www.instagram.com/accounts/login/", "https://www.instagram.com/", "sessionid", ".instagram.com"},
            {"facebook", "Facebook", "https://m.facebook.com/login/", "https://www.facebook.com/", "c_user", ".facebook.com"},
            {"x", "X / Twitter", "https://x.com/i/flow/login", "https://x.com/", "auth_token", ".x.com"},
    };

    private static String[] site(String id) {
        for (String[] s : SITES) if (s[0].equals(id)) return s;
        return null;
    }

    private File cookiesFile() { return new File(getContext().getFilesDir(), "cookies.txt"); }

    private static boolean hasSession(String all, String name) {
        if (all == null) return false;
        for (String part : all.split(";")) {
            String kv = part.trim();
            if (kv.startsWith(name + "=") && kv.length() > name.length() + 1 && !kv.endsWith("=\"\"")) return true;
        }
        return false;
    }

    private boolean signedIn(String[] s) {
        try { return hasSession(CookieManager.getInstance().getCookie(s[3]), s[4]); } catch (Throwable e) { return false; }
    }

    /** Writes the signed-in sites' cookies in the Netscape format yt-dlp reads (no file when nobody is signed in). */
    private synchronized void writeCookies() {
        StringBuilder b = new StringBuilder("# Netscape HTTP Cookie File\n");
        long exp = System.currentTimeMillis() / 1000 + 180L * 86400L;
        boolean any = false;
        for (String[] s : SITES) {
            String all;
            try { all = CookieManager.getInstance().getCookie(s[3]); } catch (Throwable e) { continue; }
            if (!hasSession(all, s[4])) continue;
            any = true;
            for (String part : all.split(";")) {
                String kv = part.trim();
                int eq = kv.indexOf('=');
                if (eq <= 0) continue;
                b.append(s[5]).append("\tTRUE\t/\tTRUE\t").append(exp).append('\t')
                        .append(kv.substring(0, eq)).append('\t').append(kv.substring(eq + 1)).append('\n');
            }
        }
        File f = cookiesFile();
        if (!any) { f.delete(); return; }
        try (OutputStream os = new java.io.FileOutputStream(f)) { os.write(b.toString().getBytes("UTF-8")); } catch (Throwable ignored) { }
    }

    private JSObject accountsJson() {
        JSObject r = new JSObject();
        for (String[] s : SITES) r.put(s[0], signedIn(s));
        return r;
    }

    @PluginMethod
    public void accounts(PluginCall call) {
        call.resolve(accountsJson());
    }

    @PluginMethod
    public void login(PluginCall call) {
        String[] s = site(call.getString("site", ""));
        if (s == null) { call.reject("Unknown site"); return; }
        Intent i = new Intent(getContext(), LoginActivity.class);
        i.putExtra(LoginActivity.EXTRA_URL, s[2]);
        i.putExtra(LoginActivity.EXTRA_HOME, s[3]);
        i.putExtra(LoginActivity.EXTRA_COOKIE, s[4]);
        i.putExtra(LoginActivity.EXTRA_TITLE, "Sign in to " + s[1]);
        startActivityForResult(call, i, "loginDone");
    }

    @ActivityCallback
    private void loginDone(PluginCall call, ActivityResult result) {
        if (call == null) return;
        writeCookies();
        JSObject r = accountsJson();
        String[] s = site(call.getString("site", ""));
        r.put("signedIn", s != null && signedIn(s));
        call.resolve(r);
    }

    @PluginMethod
    public void logout(PluginCall call) {
        String[] s = site(call.getString("site", ""));
        if (s == null) { call.reject("Unknown site"); return; }
        CookieManager cm = CookieManager.getInstance();
        String all = cm.getCookie(s[3]);
        if (all != null) {
            for (String part : all.split(";")) {
                String kv = part.trim();
                int eq = kv.indexOf('=');
                if (eq <= 0) continue;
                String name = kv.substring(0, eq);
                cm.setCookie(s[3], name + "=; Max-Age=0; Path=/; Domain=" + s[5]);
                cm.setCookie(s[3], name + "=; Max-Age=0; Path=/");
            }
        }
        cm.flush();
        writeCookies();
        call.resolve(accountsJson());
    }

    /** Path of the bundled QuickJS interpreter (YouTube needs a JavaScript runtime to unlock video links). */
    private String jsRuntime() {
        File qjs = new File(getContext().getApplicationInfo().nativeLibraryDir, "libqjs.so");
        return qjs.exists() ? qjs.getAbsolutePath() : null;
    }

    /**
     * Options shared by every yt-dlp call.
     * mode "fast": YouTube's android_vr client, which needs no JavaScript solving (seconds instead of minutes on a phone).
     * mode "full": YouTube's web/tv clients + QuickJS to solve YouTube's challenge (slow, but works when fast doesn't).
     * mode "alt":  another set of clients, used as a last resort after an HTTP 403.
     */
    private void addCommon(YoutubeDLRequest req, String mode) {
        req.addOption("--cache-dir", new File(getContext().getCacheDir(), "yt-dlp").getAbsolutePath());
        req.addOption("--socket-timeout", "15");
        req.addOption("--no-playlist");
        if (cookiesFile().exists()) req.addOption("--cookies", cookiesFile().getAbsolutePath());
        if ("fast".equals(mode)) {
            // visionos = yt-dlp's current no-JavaScript client; android_vr = backup (older engines skip unknown names).
            req.addOption("--extractor-args", "youtube:player_client=visionos,android_vr");
            return;
        }
        String qjs = jsRuntime();
        if (qjs != null) req.addOption("--js-runtimes", "quickjs:" + qjs);
        req.addOption("--remote-components", "ejs:github");
        if ("alt".equals(mode)) req.addOption("--extractor-args", "youtube:player_client=tv,web_embedded,mweb");
        else req.addOption("--extractor-args", "youtube:player_client=android_vr,tv,web_safari");
    }

    /** Don't start yt-dlp while the engine update is replacing its files (max ~40 s). */
    private void waitUpdate() {
        for (int i = 0; i < 400 && updating; i++) {
            try { Thread.sleep(100); } catch (InterruptedException ignored) { }
        }
    }

    /** Waits (in a worker thread) until the engine has unpacked itself on first launch. */
    private boolean waitReady(PluginCall call) {
        for (int i = 0; i < 1200 && !ready && initError == null; i++) {
            try { Thread.sleep(100); } catch (InterruptedException ignored) { }
        }
        if (!ready) {
            call.reject("The download engine could not start: " + (initError != null ? initError : "timeout"), "ENGINE_INIT");
            return false;
        }
        return true;
    }

    @PluginMethod
    public void status(PluginCall call) {
        pool.execute(() -> {
            if (!waitReady(call)) return;
            JSObject r = new JSObject();
            r.put("ready", true);
            r.put("jsRuntime", jsRuntime() != null);
            r.put("updating", updating);
            try { r.put("version", YoutubeDL.getInstance().versionName(getContext())); } catch (Throwable e) { r.put("version", ""); }
            call.resolve(r);
        });
    }

    @PluginMethod
    public void info(PluginCall call) {
        final String url = call.getString("url");
        final String mode = call.getString("mode", "fast");
        final int timeoutSec = call.getInt("timeout", 60);
        if (url == null) { call.reject("Missing url"); return; }
        pool.execute(() -> {
            if (!waitReady(call)) return;
            waitUpdate();
            final String pid = "info-" + System.nanoTime();
            final java.util.concurrent.atomic.AtomicBoolean timedOut = new java.util.concurrent.atomic.AtomicBoolean(false);
            // Watchdog: really stop yt-dlp when it takes too long (otherwise it keeps running and slows the next try).
            java.util.concurrent.ScheduledFuture<?> dog = watchdog.schedule(() -> {
                timedOut.set(true);
                try { YoutubeDL.getInstance().destroyProcessById(pid); } catch (Throwable ignored) { }
            }, timeoutSec, java.util.concurrent.TimeUnit.SECONDS);
            try {
                YoutubeDLRequest req = new YoutubeDLRequest(url);
                req.addOption("--dump-single-json");
                req.addOption("--no-warnings");
                addCommon(req, mode);
                YoutubeDLResponse res = YoutubeDL.getInstance().execute(req, pid, (Function3<Float, Long, String, Unit>) null);
                String out = res.getOut();
                JSObject r = new JSObject();
                r.put("json", out);
                r.put("mode", mode);
                // Save it so the download can reuse it instead of reading the video page again.
                try {
                    File dir = new File(getContext().getCacheDir(), "info");
                    dir.mkdirs();
                    File f = new File(dir, Integer.toHexString(url.hashCode()) + "-" + mode + ".json");
                    try (OutputStream os = new java.io.FileOutputStream(f)) { os.write(out.getBytes("UTF-8")); }
                    r.put("infoPath", f.getAbsolutePath());
                } catch (Throwable ignored) { }
                call.resolve(r);
            } catch (Throwable e) {
                if (timedOut.get() || e instanceof YoutubeDL.CanceledException) call.reject("timed out", "TIMEOUT");
                else call.reject(String.valueOf(e.getMessage()), "YTDLP");
            } finally {
                dog.cancel(false);
            }
        });
    }

    private File workDir(String id) {
        File base = getContext().getExternalFilesDir(null);
        if (base == null) base = getContext().getFilesDir();
        return new File(new File(base, "work"), id);
    }

    @PluginMethod
    public void download(PluginCall call) {
        final String id = call.getString("id");
        final String url = call.getString("url");
        final String format = call.getString("format", "b");
        final String kind = call.getString("kind", "video");
        final String container = call.getString("container", "mp4");
        final String tag = call.getString("tag", "best");
        final int attempt = call.getInt("attempt", 0);
        final String infoPath = call.getString("infoPath");
        final String infoMode = call.getString("mode", "fast");
        if (id == null || url == null) { call.reject("Missing id or url"); return; }
        call.setKeepAlive(true);
        pool.execute(() -> {
            if (!waitReady(call)) return;
            waitUpdate();
            File dir = workDir(id);
            dir.mkdirs();
            try {
                File info = infoPath != null ? new File(infoPath) : null;
                boolean reuse = attempt == 0 && info != null && info.exists()
                        && System.currentTimeMillis() - info.lastModified() < 3L * 3600_000L;
                YoutubeDLRequest req = reuse ? new YoutubeDLRequest(new java.util.ArrayList<String>()) : new YoutubeDLRequest(url);
                if (reuse) req.addOption("--load-info-json", info.getAbsolutePath());
                // Last resort: a single-file format (needs no merging and is rarely blocked).
                req.addOption("-f", attempt >= 2 && !"audio".equals(kind) ? "18/b/" + format : format);
                // attempt 0: same method that read the video; 1: full (JavaScript) method; 2: other clients.
                addCommon(req, attempt == 0 ? infoMode : attempt == 1 ? ("full".equals(infoMode) ? "alt" : "full") : "alt");
                req.addOption("-o", dir.getAbsolutePath() + "/%(extractor_key)s_%(title).80B_%(id)s_" + tag + ".%(ext)s");
                req.addOption("--restrict-filenames");
                req.addOption("--no-mtime");
                req.addOption("--newline");
                req.addOption("--retries", "5");
                req.addOption("--fragment-retries", "5");
                if ("audio".equals(kind)) {
                    req.addOption("-x");
                    req.addOption("--audio-format", "mp3");
                    req.addOption("--audio-quality", "192K");
                } else {
                    req.addOption("--merge-output-format", "webm".equals(container) ? "webm" : "mp4");
                }
                Function3<Float, Long, String, Unit> cb = (progress, eta, line) -> {
                    JSObject p = new JSObject();
                    p.put("id", id);
                    p.put("progress", progress);
                    p.put("eta", eta);
                    String l = line == null ? "" : line;
                    p.put("processing", l.contains("[Merger]") || l.contains("[ExtractAudio]") || l.contains("[VideoConvertor]") || l.contains("[FixupM3u8]"));
                    p.put("line", l.length() > 300 ? l.substring(0, 300) : l);
                    notifyListeners("progress", p);
                    return Unit.INSTANCE;
                };
                YoutubeDL.getInstance().execute(req, id, cb);

                File out = pickOutput(dir);
                if (out == null) throw new Exception("No file was produced");
                JSObject r = publish(out);
                deleteRecursive(dir);
                call.resolve(r);
            } catch (YoutubeDL.CanceledException e) {
                call.reject("stopped", "CANCELED");
            } catch (Throwable e) {
                call.reject(String.valueOf(e.getMessage()), "YTDLP");
            } finally {
                call.setKeepAlive(false);
            }
        });
    }

    /** Stop a running download. keep=true leaves the partial file so it can be resumed. */
    @PluginMethod
    public void stop(PluginCall call) {
        String id = call.getString("id");
        boolean keep = Boolean.TRUE.equals(call.getBoolean("keep", false));
        if (id != null) {
            try { YoutubeDL.getInstance().destroyProcessById(id); } catch (Throwable ignored) { }
            if (!keep) deleteRecursive(workDir(id));
        }
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        pool.execute(() -> {
            if (!waitReady(call)) return;
            try {
                Object status = YoutubeDL.getInstance().updateYoutubeDL(getContext(), YoutubeDL.UpdateChannel.STABLE.INSTANCE);
                JSObject r = new JSObject();
                r.put("status", status == null ? "UNKNOWN" : status.toString());
                r.put("version", YoutubeDL.getInstance().versionName(getContext()));
                call.resolve(r);
            } catch (Throwable e) {
                call.reject(String.valueOf(e.getMessage()), "UPDATE");
            }
        });
    }

    @PluginMethod
    public void open(PluginCall call) {
        try {
            Uri uri = Uri.parse(call.getString("uri"));
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, call.getString("mime", "video/*"));
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(Intent.createChooser(i, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (Throwable e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void share(PluginCall call) {
        try {
            Uri uri = Uri.parse(call.getString("uri"));
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType(call.getString("mime", "video/*"));
            i.putExtra(Intent.EXTRA_STREAM, uri);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getContext().startActivity(Intent.createChooser(i, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (Throwable e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            Uri uri = Uri.parse(call.getString("uri"));
            if ("file".equals(uri.getScheme())) new File(uri.getPath()).delete();
            else getContext().getContentResolver().delete(uri, null, null);
        } catch (Throwable ignored) { }
        call.resolve();
    }

    // ---------- helpers ----------

    private static File pickOutput(File dir) {
        File best = null;
        File[] files = dir.listFiles();
        if (files == null) return null;
        for (File f : files) {
            String n = f.getName();
            if (!f.isFile() || n.endsWith(".part") || n.endsWith(".ytdl") || n.contains(".temp.") || n.endsWith(".json")) continue;
            if (best == null || f.length() > best.length()) best = f;
        }
        return best;
    }

    private static String mimeOf(String name) {
        String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
        String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (m != null) return m;
        if (ext.equals("mp3") || ext.equals("m4a") || ext.equals("opus")) return "audio/*";
        return "video/*";
    }

    /** Copy the finished file into the phone's public Download/VideoFlow folder (visible in Gallery / Files). */
    private JSObject publish(File src) throws Exception {
        Context ctx = getContext();
        String name = src.getName();
        String mime = mimeOf(name);
        JSObject r = new JSObject();
        r.put("name", name);
        r.put("size", src.length());
        r.put("mime", mime);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver cr = ctx.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/VideoFlow");
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new Exception("Could not create the file in Downloads");
            try (InputStream in = new FileInputStream(src); OutputStream out = cr.openOutputStream(uri)) {
                copy(in, out);
            }
            v.clear();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, v, null, null);
            r.put("uri", uri.toString());
            r.put("path", "Download/VideoFlow/" + name);
        } else {
            File destDir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "VideoFlow");
            File dest = new File(destDir, name);
            try {
                destDir.mkdirs();
                try (InputStream in = new FileInputStream(src); OutputStream out = new java.io.FileOutputStream(dest)) {
                    copy(in, out);
                }
                r.put("path", "Download/VideoFlow/" + name);
            } catch (Exception noPermission) {
                // No storage permission: keep it in the app's own folder.
                File keepDir = new File(ctx.getExternalFilesDir(null), "VideoFlow");
                keepDir.mkdirs();
                dest = new File(keepDir, name);
                try (InputStream in = new FileInputStream(src); OutputStream out = new java.io.FileOutputStream(dest)) {
                    copy(in, out);
                }
                r.put("path", dest.getAbsolutePath());
            }
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", dest);
            r.put("uri", uri.toString());
            ctx.sendBroadcast(new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.fromFile(dest)));
        }
        return r;
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursive(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
