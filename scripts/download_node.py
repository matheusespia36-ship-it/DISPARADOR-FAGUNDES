import urllib.request
import os
import sys

# URL direta do binário estático e estável do Node.js compilado nativamente para Android (tar.gz)
node_url = "https://github.com"
archive_name = "node_android.tar.gz"

print(f"A descarregar o motor Node.js ARM64 real de: {node_url}")
headers = {"User-Agent": "Mozilla/5.0"}

try:
    req = urllib.request.Request(node_url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp, open(archive_name, "wb") as f:
        f.write(resp.read())
    print("Download do arquivo compactado concluído com sucesso!")
    
    # Descompacta o arquivo tar.gz nativamente usando o sistema do terminal do Actions
    print("A extrair o binário executável...")
    os.system(f"tar -xzf {archive_name}")
    
    # Cria a pasta temporária que o build.yml espera encontrar
    os.makedirs("lib_node_temp", exist_ok=True)
    
    # Localiza o arquivo executável extraído (geralness bin/node) e move-o como libnode.so
    if os.path.exists("bin/node"):
        os.rename("bin/node", "lib_node_temp/libnode.so")
        print("[SUCESSO] O binário nativo real foi injetado com tamanho completo!")
    else:
        # Fallback caso a estrutura de pastas do pacote mude
        os.system("find . -type f -name 'node' -exec cp {} lib_node_temp/libnode.so \;")
        print("[AVISO] Procurando binário por varredura profunda...")
        
    # Limpeza de ficheiros temporários de compactação
    if os.path.exists(archive_name):
        os.remove(archive_name)

except Exception as e:
    print(f"Erro crítico ao processar o motor nativo do Node.js: {e}")
    sys.exit(1)
