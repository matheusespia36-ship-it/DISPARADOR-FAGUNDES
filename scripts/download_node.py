
import urllib.request
import gzip
import re
import sys

# Lista de mirrors atualizada e expandida para garantir redundância no GitHub Actions
mirrors = [
    "https://packages-cf.termux.dev/apt/termux-main/",
    "https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main/",
    "https://sustech.edu.cn",
    "https://grimler.es/termux-packages-24/"
]

pkg_path = None
base_used = ""

headers = {
    "User-Agent": "Debian APT-HTTP/1.3 (2.6.1)",
    "Accept": "*/*"
}

for base in mirrors:
    try:
        # Garante que a URL base termina com barra
        if not base.endswith("/"):
            base += "/"
            
        url = base + "dists/stable/main/binary-aarch64/Packages.gz"
        print(f"Tentando indice: {url}")
        
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = gzip.decompress(resp.read()).decode("utf-8", errors="ignore")
            
        blocks = content.split("\n\n")
        for block in blocks:
            # Captura prioritariamente o nodejs estável padrão
            if re.search(r"^Package:\s*(nodejs|nodejs-lts)$", block, re.MULTILINE):
                m = re.search(r"^Filename:\s*(.+)$", block, re.MULTILINE)
                if m:
                    pkg_path = m.group(1).strip()
                    base_used = base
                    break
        if pkg_path:
            print(f"Sucesso ao ler o indice do mirror: {base}")
            break
    except Exception as e:
        print(f"Falha no mirror {base}: {e}")

if not pkg_path:
    print("Nenhum pacote Node.js encontrado nos mirrors válidos.")
    sys.exit(1)

# Tratamento para evitar duplicar 'apt/termux-main' caso o Filename já traga o caminho completo
if pkg_path.startswith("apt/termux-main/"):
    # Remove a repetição se a base já possuir esse prefixo
    base_clean = base_used.replace("apt/termux-main/", "")
    deb_url = base_clean + pkg_path
else:
    deb_url = base_used + pkg_path

print(f"Baixando pacote oficial: {deb_url}")
try:
    req = urllib.request.Request(deb_url, headers=headers)
    with urllib.request.urlopen(req, timeout=45) as resp, open("node.deb", "wb") as f:
        f.write(resp.read())
    print("Download concluido com sucesso! Arquivo node.deb gerado.")
except Exception as e:
    print(f"Erro fatal ao descarregar o arquivo .deb: {e}")
    sys.exit(1)

