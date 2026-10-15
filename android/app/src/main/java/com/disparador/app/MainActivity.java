package com.disparador.app;

import android.os.Bundle;
import android.content.Context;
import com.getcapacitor.BridgeActivity;
import java.io.*;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        iniciarNodeJSInternal();
    }

    private void iniciarNodeJSInternal() {
        new Thread(() -> {
            try {
                Context context = getApplicationContext();
                File filesDir = context.getFilesDir();
                File nodeDir = new File(filesDir, "nodejs-project");

                if (!nodeDir.exists()) {
                    nodeDir.mkdirs();
                }

                // Caminho do binario executavel libnode.so concedido pelo Android OS
                String nodeBinary = context.getApplicationInfo().nativeLibraryDir + "/libnode.so";
                File serverFile = new File(nodeDir, "server.js");

                // Extrai recursos se necessario
                copiarAssetParaApp(context, "public/index.html", new File(nodeDir, "public/index.html"));

                if (new File(nodeBinary).exists()) {
                    ProcessBuilder pb = new ProcessBuilder(nodeBinary, serverFile.getAbsolutePath());
                    pb.directory(nodeDir);
                    pb.environment().put("PORT", "3000");
                    pb.environment().put("HOME", filesDir.getAbsolutePath());
                    pb.start();
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }).start();
    }

    private void copiarAssetParaApp(Context context, String assetPath, File destFile) {
        try {
            destFile.getParentFile().mkdirs();
            InputStream in = context.getAssets().open(assetPath);
            OutputStream out = new FileOutputStream(destFile);
            byte[] buffer = new byte[1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            in.close();
            out.flush();
            out.close();
        } catch (Exception ignored) {}
    }
}
