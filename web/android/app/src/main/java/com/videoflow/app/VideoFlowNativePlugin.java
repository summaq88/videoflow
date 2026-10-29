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
import com.getcapacitor.annotation.CapacitorPlugin;
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
    private volatile boolean ready = false;
    private volatile String initError = null;

    @Override
    public void load() {
        pool.execute(() -> {
            try {
                YoutubeDL.getInstance().init(getContext());
                FFmpeg.getInstance().init(getContext());
                ready = true;
            } catch (Throwable e) {
                initError = String.valueOf(e.getMessage());
            }
        });
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
            try { r.put("version", YoutubeDL.getInstance().versionName(getContext())); } catch (Throwable e) { r.put("version", ""); }
            call.resolve(r);
        });
    }

    @PluginMethod
    public void info(PluginCall call) {
        final String url = call.getString("url");
        if (url == null) { call.reject("Missing url"); return; }
        pool.execute(() -> {
            if (!waitReady(call)) return;
            try {
                YoutubeDLRequest req = new YoutubeDLRequest(url);
                req.addOption("--dump-single-json");
                req.addOption("--no-playlist");
                req.addOption("--no-warnings");
                YoutubeDLResponse res = YoutubeDL.getInstance().execute(req, null, (Function3<Float, Long, String, Unit>) null);
                JSObject r = new JSObject();
                r.put("json", res.getOut());
                call.resolve(r);
            } catch (Throwable e) {
                call.reject(String.valueOf(e.getMessage()), "YTDLP");
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
        if (id == null || url == null) { call.reject("Missing id or url"); return; }
        call.setKeepAlive(true);
        pool.execute(() -> {
            if (!waitReady(call)) return;
            File dir = workDir(id);
            dir.mkdirs();
            try {
                YoutubeDLRequest req = new YoutubeDLRequest(url);
                req.addOption("-f", format);
                req.addOption("-o", dir.getAbsolutePath() + "/%(extractor_key)s_%(title).80B_%(id)s_" + tag + ".%(ext)s");
                req.addOption("--restrict-filenames");
                req.addOption("--no-playlist");
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
