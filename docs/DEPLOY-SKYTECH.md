# Deploy Produksi Sky Tech — `balesin.skytech.net.id`

Dokumen internal **khusus instalasi Sky Tech**. Berkas rilis (`deploy/`, artefak GitHub Release)
dan panduan pelanggan (`docs/panduan/`) sengaja netral (white-label) — semua nilai khusus Sky Tech
dikumpulkan di sini. Konteks bisnis: `docs/KONTEKS-SKYTECH.md`; alasan memilih Mode A:
`docs/ARCHITECTURE.md` §5; panduan operasional generik: `docs/DEPLOY.md`.

Deploy produksi dijalankan/di-approve Tobing — antrian di `docs/BUTUH-TOBING.md` #6, #7, #18, #19.

## 1. Nilai instalasi

| Hal | Nilai Sky Tech |
|---|---|
| Domain | `balesin.skytech.net.id` |
| Mode jaringan | **A** — di belakang `vm-nginx` |
| Reverse proxy | `vm-nginx`, IP publik `198.15.25.13`; IP privat vm-nginx = **menunggu Tobing** (#19) |
| DNS | IDCloudHost, zona `skytech.net.id`: A record `balesin` → `198.15.25.13` |
| VM Balesin | Proxmox, Ubuntu 24.04 LTS, 4 vCPU, 8 GB RAM, 80 GB disk, **IP privat saja** (internet keluar lewat NAT) |
| Port gateway Balesin | `8080` (`BALESIN_HTTP_PORT`), di-bind ke IP privat VM Balesin |
| Sertifikat TLS | Let's Encrypt di vm-nginx (certbot, webroot `/var/www/certbot`) |
| SSH VM Balesin | Hanya dari jaringan manajemen (ufw) |
| Email pengirim sistem | `balesin@skytech.net.id` (email hosting IDCloudHost) — diisi lewat wizard/UI, bukan `.env` |

## 2. Langkah

Ganti `<IP-VM>` dengan IP privat VM Balesin dan `<IP-privat-vm-nginx>` dengan IP privat vm-nginx.

1. **VM Balesin**: `curl -fsSL https://github.com/PutuTobing/balesin/releases/download/v1.0.0/install.sh | sudo bash` → mode **A**, domain
   `balesin.skytech.net.id`, IP reverse proxy = `<IP-privat-vm-nginx>`, IP VM = `<IP-VM>`,
   port 8080. Installer menolak bind `0.0.0.0`/IP publik.
2. **Firewall VM Balesin**: ufw TIDAK berlaku untuk port container Docker. Pasang skrip
   `/usr/local/sbin/balesin-firewall.sh` + unit systemd `balesin-firewall` dari `docs/DEPLOY.md`
   §3.1 (sama dengan `docs/panduan/01-instalasi.md` bagian "Firewall untuk Mode A") dengan `PORT=8080` dan
   `PROXY=<IP-privat-vm-nginx>`. Uji dari host LAN lain: `curl -m 5 http://<IP-VM>:8080/health`
   harus *timeout*; dari vm-nginx harus `{"status":"ok"}`.
3. **DNS IDCloudHost**: A record `balesin` → `198.15.25.13`.
4. **vm-nginx**: salin `balesin-nginx.conf` dari rilis (sumber: `deploy/nginx/balesin.conf`) ke
   `/etc/nginx/conf.d/balesin.conf`, lalu ganti nilai contoh:
   ```bash
   sed -i -e 's/cs\.contoh\.co\.id/balesin.skytech.net.id/g' \
          -e 's/192\.0\.2\.20:8080/<IP-VM>:8080/' /etc/nginx/conf.d/balesin.conf
   grep -nE 'cs\.contoh\.co\.id|192\.0\.2\.20' /etc/nginx/conf.d/balesin.conf   # harus kosong
   ```
   Komentari blok `server { listen 443 … }` → `nginx -t && systemctl reload nginx` →
   `certbot certonly --webroot -w /var/www/certbot -d balesin.skytech.net.id --deploy-hook "systemctl reload nginx"`
   → buka komentar blok 443 → `nginx -t && systemctl reload nginx`.
5. **Periksa dari luar**:
   ```bash
   curl -sI https://balesin.skytech.net.id/ | grep -iE 'strict-transport|content-security|x-frame'
   curl -s https://balesin.skytech.net.id/ready      # {"status":"ok",...}
   ```
6. Buka `https://balesin.skytech.net.id/setup`, masukkan token (`sudo balesin setup-token`).
7. Simpan salinan `/opt/balesin/.env` di password manager Sky Tech; atur salinan harian
   `/opt/balesin/backups` ke luar VM (NAS/rsync).

## 3. Opsi masa depan

Domain produk terpisah (mis. `balesin.id`) dikelola di Cloudflare → bisa pindah ke Mode C
(Cloudflare Tunnel) tanpa membuka port di vm-nginx. Lihat `docs/ARCHITECTURE.md` §5.
