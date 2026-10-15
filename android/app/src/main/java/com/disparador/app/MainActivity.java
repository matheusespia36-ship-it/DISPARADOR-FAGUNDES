
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

                // Caminho do binário executável libnode.so concedido pelo Android OS
                String nodeBinary = context.getApplicationInfo().nativeLibraryDir + "/libnode.so";
                File serverFile = new File(nodeDir, "server.js");

                // CORREÇÃO 2: Extrai o arquivo server.js dos assets para a pasta interna
                copiarAssetParaApp(context, "server.js", serverFile);
                // Extrai recursos da interface
                copiarAssetParaApp(context, "public/index.html", new File(nodeDir, "public/index.html"));

                if (new File(nodeBinary).exists()) {
                    ProcessBuilder pb = new ProcessBuilder(nodeBinary, serverFile.getAbsolutePath());
                    pb.directory(nodeDir);
                    
                    // Configuração de variáveis de ambiente
                    pb.environment().put("PORT", "3000");
                    pb.environment().put("HOME", filesDir.getAbsolutePath());
                    // CORREÇÃO 1: Envia o caminho do diretório seguro para o Node.js reconhecer
                    pb.environment().put("ANDROID_FILES_DIR", nodeDir.getAbsolutePath());
                    
                    // CORREÇÃO 3: Redireciona erros do Node.js para o Logcat do Android Studio
                    pb.redirectErrorStream(true);
                    
                    Process process = pb.start();
                    
                    // Opcional: Ler a saída do Node para ver os logs do WhatsApp no Logcat
                    BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
                    String line;
                    while ((line = reader.readLine()) != null) {
                        android.util.Log.d("NODEJS-SERVER", line);
                    }
                } else {
                    android.util.Log.e("NODEJS-SERVER", "Erro: libnode.so não encontrada no diretório nativo.");
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }).start();
    }

    private void copiarAssetParaApp(Context context, String assetPath, File destFile) {
        try {
            // Garante que as pastas pai existem (ex: public/)
            if (destFile.getParentFile() != null && !destFile.getParentFile().exists()) {
                destFile.getParentFile().mkdirs();
            }
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

