package com.videoflow.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Opens the website's own sign-in page (Instagram, Facebook, X…) inside the app.
 * The user types their password into the website itself; VideoFlow never sees or stores it.
 * When the site's session cookie appears, the activity closes and the plugin saves the cookies
 * so yt-dlp can open videos that are only visible to signed-in users (age-restricted reels etc.).
 */
public class LoginActivity extends Activity {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_HOME = "home";
    public static final String EXTRA_COOKIE = "cookie";
    public static final String EXTRA_TITLE = "title";

    private WebView web;
    private String home, cookie;
    private boolean done = false;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String url = getIntent().getStringExtra(EXTRA_URL);
        home = getIntent().getStringExtra(EXTRA_HOME);
        cookie = getIntent().getStringExtra(EXTRA_COOKIE);
        String title = getIntent().getStringExtra(EXTRA_TITLE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int p = (int) (12 * getResources().getDisplayMetrics().density);
        bar.setPadding(p, p / 2, p / 2, p / 2);
        bar.setBackgroundColor(Color.rgb(6, 21, 44));
        TextView t = new TextView(this);
        t.setText(title != null ? title : "Sign in");
        t.setTextColor(Color.WHITE);
        t.setTextSize(16);
        bar.addView(t, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button close = new Button(this);
        close.setText("Done");
        close.setOnClickListener(v -> finishWithResult());
        bar.addView(close);
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // Look like the normal mobile browser (some sites refuse sign-in from an embedded "wv" browser).
        s.setUserAgentString(s.getUserAgentString().replace("; wv", ""));
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String u) {
                if (signedIn()) finishWithResult();
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);
        web.loadUrl(url);
    }

    private boolean signedIn() {
        if (home == null || cookie == null) return false;
        String c = CookieManager.getInstance().getCookie(home);
        return c != null && (c.contains(cookie + "=") && !c.contains(cookie + "=;") && !c.contains(cookie + "=\"\""));
    }

    private void finishWithResult() {
        if (done) return;
        done = true;
        CookieManager.getInstance().flush();
        Intent r = new Intent();
        r.putExtra("signedIn", signedIn());
        setResult(RESULT_OK, r);
        finish();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else finishWithResult();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
