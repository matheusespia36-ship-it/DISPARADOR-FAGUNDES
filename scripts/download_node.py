import urllib.request
import gzip
import re
import sys

mirrors = [
    "https://packages-cf.termux.dev/apt/termux-main/",
    "https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main/",
    "https://grimler.es/termux-packages-24/"
]

pkg_path = None
base_used = ""

for base in mirrors:
    try:
        url = base + "dists/stable/main/binary-aarch64/Packages.gz"
        print(f"Tentando indice: {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = gzip.decompress(resp.read()).decode("utf-8", errors="ignore")
            
        blocks = content.split("\n\n")
        for block in blocks:
            if re.search(r"^Package:\s*(nodejs|nodejs-lts)$", block, re.MULTILINE):
                m = re.search(r"^Filename:\s*(.+)$", block, re.MULTILINE)
                if m:
                    pkg_path = m.group(1).strip()
                    base_used = base
                    break
        if pkg_path:
            break
    except Exception as e:
        print(f"Falha no mirror {base}: {e}")

if not pkg_path:
    print("Nenhum pacote Node.js encontrado nos mirrors.")
    sys.exit(1)

deb_url = base_used + pkg_path
print(f"Baixando pacote oficial: {deb_url}")
req = urllib.request.Request(deb_url, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, timeout=30) as resp, open("node.deb", "wb") as f:
    f.write(resp.read())
print("Download concluido com sucesso!")
