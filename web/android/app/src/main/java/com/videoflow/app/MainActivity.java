package com.videoflow.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VideoFlowNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
