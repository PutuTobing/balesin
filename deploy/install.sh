#!/usr/bin/env bash
# Installer Balesin self-hosted.
#
#   curl -fsSL <URL-rilis>/install.sh | sudo bash
#   sudo bash install.sh                 (dari folder deploy/ repo atau rilis yang sudah diunduh)
#   sudo bash install.sh --ubah-jaringan (ulangi pertanyaan mode jaringan; rahasia tetap)
#
# Idempoten: aman dijalankan ulang. Rahasia yang sudah ada di /opt/balesin/.env TIDAK pernah
# ditimpa; yang belum ada dibuat acak. Semua rahasia hanya disimpan di .env (chmod 600).
#
# Tanpa pertanyaan (otomasi), isi lewat variabel lingkungan, mis.:
#   BALESIN_MODE=A BALESIN_DOMAIN=balesin.perusahaan.co.id BALESIN_UPSTREAM_PROXY=10.0.0.2 \
#   BALESIN_ASSUME_YES=1 sudo -E bash install.sh
# Variabel lain: BALESIN_HOME, BALESIN_VERSION, BALESIN_BIND_ADDRESS, BALESIN_HTTP_PORT,
# BALESIN_ACME_EMAIL, CLOUDFLARE_TUNNEL_TOKEN, BALESIN_IMAGE_PREFIX, BALESIN_RELEASE_BASE,
# BALESIN_NO_PULL=1 (pakai image lokal), BALESIN_SKIP_COSIGN=1 (jangan pasang cosign).
# Panduan: docs/DEPLOY.md.

set -Eeuo pipefail
umask 077

readonly DEFAULT_VERSION="0.1.0"
readonly DEFAULT_IMAGE_PREFIX="ghcr.io/pututobing/balesin"
# Kanal distribusi rilis ({VERSI} diganti nomor versi). Lihat docs/BUTUH-TOBING.md (repo privat).
readonly DEFAULT_RELEASE_BASE="https://github.com/PutuTobing/balesin/releases/download/v{VERSI}"
readonly DEFAULT_RELEASE_LATEST="https://github.com/PutuTobing/balesin/releases/latest/download/VERSION"
# cosign untuk verifikasi tanda tangan rilis (review Fase 7 P2-R2): versi dipin + SHA-256 resmi dari
# cosign_checksums.txt rilis Sigstore. Diperbarui sengaja (ubah versi DAN kedua checksum bersamaan).
readonly COSIGN_VERSION="v3.1.4"
readonly COSIGN_SHA256_AMD64="424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa"
readonly COSIGN_SHA256_ARM64="ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2"
readonly DEFAULT_SUBNETS=("172.31.250.0/24" "172.31.251.0/24" "10.250.250.0/24" "192.168.250.0/24")

BALESIN_HOME="${BALESIN_HOME:-/opt/balesin}"
ENV_FILE="$BALESIN_HOME/.env"
ASSUME_YES="${BALESIN_ASSUME_YES:-0}"
RECONFIGURE=0
TOTAL_STEPS=8
CURRENT_STEP=0

# Folder skrip ini (kosong bila dijalankan lewat pipa `curl | bash`).
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [[ -t 1 ]]; then
  BOLD=$'\e[1m' RED=$'\e[31m' GREEN=$'\e[32m' YELLOW=$'\e[33m' CYAN=$'\e[36m' RESET=$'\e[0m'
else
  BOLD='' RED='' GREEN='' YELLOW='' CYAN='' RESET=''
fi

info() { printf '%s\n' "$*"; }
ok() { printf '  %s[OK]%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s[!]%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() {
  printf '\n%sInstalasi berhenti:%s %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}
step() {
  CURRENT_STEP=$((CURRENT_STEP + 1))
  printf '\n%s[%d/%d] %s%s\n' "$BOLD" "$CURRENT_STEP" "$TOTAL_STEPS" "$*" "$RESET"
}

TMP_DIR=""
cleanup() { if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then rm -rf -- "$TMP_DIR"; fi; }
trap cleanup EXIT

# Terminal untuk pertanyaan (stdin bisa berupa skrip ini sendiri saat `curl | bash`).
TTY=""
if [[ "$ASSUME_YES" != "1" ]] && { exec 3</dev/tty; } 2>/dev/null; then TTY=1; fi

# ask <variabel> <pertanyaan> <bawaan> [rahasia]
ask() {
  local __var="$1" question="$2" default="${3:-}" secret="${4:-}" answer=""
  if [[ -z "$TTY" ]]; then
    printf -v "$__var" '%s' "$default"
    return 0
  fi
  if [[ -n "$default" && -z "$secret" ]]; then
    printf '  %s %s[%s]%s: ' "$question" "$CYAN" "$default" "$RESET"
  else
    printf '  %s: ' "$question"
  fi
  if [[ -n "$secret" ]]; then
    IFS= read -rs answer <&3 || true
    echo
  else
    IFS= read -r answer <&3 || true
  fi
  printf -v "$__var" '%s' "${answer:-$default}"
}

confirm() {
  local answer
  [[ "$ASSUME_YES" == "1" ]] && return 0
  [[ -n "$TTY" ]] || return 1
  printf '  %s [y/N]: ' "$1"
  IFS= read -r answer <&3 || true
  [[ "$answer" =~ ^([yY]|[yY]a|[yY]es)$ ]]
}

env_get() {
  local key="$1" line
  [[ -f "$ENV_FILE" ]] || return 0
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  printf '%s' "${line#*=}"
}

rand_hex() { openssl rand -hex "$1"; }
rand_b64url() { openssl rand -base64 "$1" | tr '+/' '-_' | tr -d '=\n'; }

is_ipv4() {
  local ip="$1" part
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for part in "${BASH_REMATCH[@]:1}"; do ((part <= 255)) || return 1; done
}

is_ip_or_cidr() {
  local value="$1" ip prefix
  ip="${value%%/*}"
  if [[ "$value" == */* ]]; then
    prefix="${value#*/}"
    [[ "$prefix" =~ ^[0-9]{1,2}$ ]] && ((prefix >= 16 && prefix <= 32)) || return 1
  fi
  is_ipv4 "$ip"
}

# IP privat RFC 1918 / CGNAT (100.64/10) atau loopback (proxy di host yang sama).
is_private_ipv4() {
  local ip="$1" a b
  is_ipv4 "$ip" || return 1
  IFS=. read -r a b _ _ <<<"$ip"
  ((a == 10 || a == 127)) && return 0
  ((a == 172 && b >= 16 && b <= 31)) && return 0
  ((a == 192 && b == 168)) && return 0
  ((a == 100 && b >= 64 && b <= 127)) && return 0
  return 1
}

valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && (("$1" >= 1 && "$1" <= 65535)); }

valid_email() { [[ "$1" =~ ^[^@[:space:]{}\"]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$ ]]; }

# Nilai yang ditulis ke .env harus satu baris tanpa karakter kendali (cegah sisipan baris .env).
assert_env_value() {
  local name="$1" value="$2"
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* || "$value" =~ [[:cntrl:]] ]]; then
    die "Nilai $name mengandung baris baru/karakter kendali."
  fi
}

valid_ip_list() {
  local list="$1" item
  [[ -n "$list" ]] || return 1
  IFS=',' read -ra items <<<"$list"
  for item in "${items[@]}"; do is_ip_or_cidr "${item// /}" || return 1; done
}

valid_domain() {
  [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]
}

# ── 1. Prasyarat ────────────────────────────────────────────────────────────────────────────────
check_prerequisites() {
  step "Memeriksa prasyarat server"
  [[ "$(id -u)" -eq 0 ]] || die "Jalankan sebagai root: curl -fsSL … | sudo bash  (atau sudo bash install.sh)"

  local os_id="" os_version="" arch mem_mb disk_gb
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    os_id="$(. /etc/os-release && printf '%s' "${ID:-}")"
    # shellcheck disable=SC1091
    os_version="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
  fi
  case "$os_id" in
    ubuntu | debian) ok "Sistem operasi: $os_id $os_version" ;;
    *) warn "Sistem operasi ${os_id:-tidak dikenal} belum diuji (disarankan Ubuntu 24.04 LTS). Instalasi dilanjutkan." ;;
  esac

  arch="$(uname -m)"
  case "$arch" in
    x86_64 | amd64 | aarch64 | arm64) ok "Arsitektur: $arch" ;;
    *) die "Arsitektur $arch tidak didukung (butuh x86_64 atau arm64)." ;;
  esac

  mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
  if ((mem_mb > 0 && mem_mb < 1800)); then
    warn "RAM ${mem_mb} MB. Disarankan minimal 2 GB (Sky Tech: 8 GB)."
  else
    ok "RAM: ${mem_mb} MB"
  fi

  mkdir -p "$BALESIN_HOME"
  disk_gb="$(df -Pk "$BALESIN_HOME" | awk 'NR==2 {print int($4/1024/1024)}')"
  if ((disk_gb < 10)); then
    warn "Sisa disk ${disk_gb} GB di $BALESIN_HOME. Disarankan minimal 20 GB (database, media, backup)."
  else
    ok "Sisa disk: ${disk_gb} GB"
  fi

  command -v openssl >/dev/null 2>&1 || die "openssl tidak ditemukan. Pasang dulu: apt-get install -y openssl"
  command -v curl >/dev/null 2>&1 || warn "curl tidak ditemukan; hanya bisa memakai berkas rilis lokal."

  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker belum terpasang."
    if [[ "$os_id" == "ubuntu" || "$os_id" == "debian" ]] && confirm "Pasang Docker Engine resmi sekarang (skrip get.docker.com)?"; then
      curl -fsSL https://get.docker.com | sh || die "Pemasangan Docker gagal."
    else
      die "Pasang Docker Engine + plugin Compose dulu: https://docs.docker.com/engine/install/"
    fi
  fi
  docker info >/dev/null 2>&1 || die "Docker terpasang tetapi daemon tidak berjalan (systemctl start docker)."
  local compose_version
  compose_version="$(docker compose version --short 2>/dev/null || true)"
  [[ -n "$compose_version" ]] || die "Plugin Docker Compose v2 tidak ada. Pasang paket docker-compose-plugin."
  if [[ "$(printf '%s\n%s\n' "2.24.0" "${compose_version#v}" | sort -V | head -n 1)" != "2.24.0" ]]; then
    die "Docker Compose ${compose_version} terlalu lama (butuh ≥ 2.24). Perbarui docker-compose-plugin."
  fi
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null), Compose $compose_version"
}

# ── 2. Folder ───────────────────────────────────────────────────────────────────────────────────
prepare_home() {
  step "Menyiapkan folder $BALESIN_HOME"
  mkdir -p "$BALESIN_HOME/backups" "$BALESIN_HOME/logs"
  chmod 750 "$BALESIN_HOME"
  chmod 700 "$BALESIN_HOME/backups" "$BALESIN_HOME/logs"
  if [[ -f "$ENV_FILE" ]]; then
    chmod 600 "$ENV_FILE"
    ok "Instalasi lama ditemukan (versi $(env_get BALESIN_VERSION)). Konfigurasi & rahasia lama dipakai ulang."
  else
    ok "Instalasi baru"
  fi
}

# ── 3. Jaringan ─────────────────────────────────────────────────────────────────────────────────
pick_subnet() {
  local current subnet base
  current="$(env_get BALESIN_SUBNET)"
  if [[ -n "$current" ]]; then
    SUBNET="$current"
    return
  fi
  if [[ -n "${BALESIN_SUBNET:-}" ]]; then
    [[ "$BALESIN_SUBNET" =~ ^([0-9]{1,3}\.){3}0/24$ ]] || die "BALESIN_SUBNET harus CIDR /24 berakhiran .0/24, mis. 172.31.250.0/24"
    SUBNET="$BALESIN_SUBNET"
    return
  fi
  local routes used
  routes="$(ip -4 route 2>/dev/null || true)"
  used="$(docker network ls -q 2>/dev/null | xargs -r docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null || true)"
  for subnet in "${DEFAULT_SUBNETS[@]}"; do
    base="${subnet%.0/24}."
    if grep -q "^${base}" <<<"$routes"; then continue; fi
    if grep -qw -- "$subnet" <<<"$used"; then continue; fi
    SUBNET="$subnet"
    return
  done
  die "Tidak menemukan subnet Docker yang bebas. Isi BALESIN_SUBNET=<CIDR /24> di lingkungan lalu ulangi."
}

configure_network() {
  step "Mode jaringan"
  MODE="$(env_get BALESIN_NETWORK_MODE)"
  DOMAIN="$(env_get BALESIN_DOMAIN)"
  UPSTREAM="$(env_get UPSTREAM_PROXY_IPS)"
  BIND_ADDRESS="$(env_get BALESIN_BIND_ADDRESS)"
  HTTP_PORT="$(env_get BALESIN_HTTP_PORT)"
  ACME_EMAIL="$(env_get ACME_EMAIL)"
  TUNNEL_TOKEN="$(env_get CLOUDFLARE_TUNNEL_TOKEN)"
  APP_URL="$(env_get APP_URL)"

  if [[ -n "$MODE" && "$RECONFIGURE" != "1" ]]; then
    ok "Mode $MODE, domain ${DOMAIN:-?} (ubah dengan: install.sh --ubah-jaringan)"
  else
    MODE="${BALESIN_MODE:-${MODE:-A}}"
    if [[ -n "$TTY" ]]; then
      info "  A) Di belakang reverse proxy yang sudah ada (mis. nginx perusahaan) — VM cukup IP privat"
      info "  B) Caddy bawaan + IP publik — HTTPS otomatis Let's Encrypt (port 80/443 terbuka)"
      info "  C) Cloudflare Tunnel — tanpa IP publik dan tanpa port terbuka (domain di Cloudflare)"
      ask MODE "Pilih mode (A/B/C)" "$MODE"
    fi
    MODE="$(printf '%s' "$MODE" | tr '[:lower:]' '[:upper:]')"
    [[ "$MODE" =~ ^[ABC]$ ]] || die "Mode jaringan harus A, B, atau C."

    DOMAIN="${BALESIN_DOMAIN:-$DOMAIN}"
    ask DOMAIN "Domain Balesin (mis. balesin.perusahaan.co.id)" "$DOMAIN"
    DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
    valid_domain "$DOMAIN" || die "Domain tidak valid: '$DOMAIN'"

    case "$MODE" in
      A)
        UPSTREAM="${BALESIN_UPSTREAM_PROXY:-$UPSTREAM}"
        ask UPSTREAM "IP privat reverse proxy (mis. vm-nginx; beberapa dipisah koma)" "$UPSTREAM"
        UPSTREAM="${UPSTREAM// /}"
        valid_ip_list "$UPSTREAM" ||
          die "IP reverse proxy wajib diisi dan valid (IPv4, atau CIDR minimal /16 — sebaiknya IP tunggal). Tanpa itu semua pengunjung tampak ber-IP sama dan batas laju per IP salah."
        local detected
        # Bawaan: IP PRIVAT pertama VM ini (bukan IP publik, bukan 0.0.0.0).
        local candidate
        detected=""
        for candidate in $(hostname -I 2>/dev/null || true); do
          if is_private_ipv4 "$candidate" && [[ "$candidate" != 127.* ]]; then
            detected="$candidate"
            break
          fi
        done
        BIND_ADDRESS="${BALESIN_BIND_ADDRESS:-${BIND_ADDRESS:-$detected}}"
        ask BIND_ADDRESS "IP privat VM ini yang menghadap reverse proxy" "$BIND_ADDRESS"
        is_ipv4 "$BIND_ADDRESS" || die "IP tidak valid: '$BIND_ADDRESS'"
        # Review Fase 7 S3: port gateway tidak boleh didengar di semua antarmuka/IP publik.
        [[ "$BIND_ADDRESS" != "0.0.0.0" ]] ||
          die "Bind 0.0.0.0 ditolak: gateway akan terbuka di semua antarmuka (termasuk IP publik). Isi IP privat yang menghadap reverse proxy."
        is_private_ipv4 "$BIND_ADDRESS" ||
          die "$BIND_ADDRESS bukan IP privat. Di mode A gateway hanya boleh didengar di IP privat yang menghadap reverse proxy (pakai mode B untuk IP publik)."
        HTTP_PORT="${BALESIN_HTTP_PORT:-${HTTP_PORT:-8080}}"
        ask HTTP_PORT "Port HTTP Balesin untuk reverse proxy" "$HTTP_PORT"
        valid_port "$HTTP_PORT" || die "Port tidak valid: '$HTTP_PORT' (1–65535)."
        ;;
      B)
        BIND_ADDRESS="127.0.0.1"
        HTTP_PORT="${BALESIN_HTTP_PORT:-${HTTP_PORT:-8080}}"
        UPSTREAM=""
        ACME_EMAIL="${BALESIN_ACME_EMAIL:-$ACME_EMAIL}"
        ask ACME_EMAIL "Email untuk pemberitahuan Let's Encrypt (boleh kosong)" "$ACME_EMAIL"
        [[ -z "$ACME_EMAIL" ]] || valid_email "$ACME_EMAIL" || die "Email tidak valid: '$ACME_EMAIL'"
        local port
        for port in 80 443; do
          if command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
            warn "Port $port sudah dipakai program lain; Caddy butuh port 80 dan 443."
          fi
        done
        ;;
      C)
        BIND_ADDRESS="127.0.0.1"
        HTTP_PORT="${BALESIN_HTTP_PORT:-${HTTP_PORT:-8080}}"
        UPSTREAM=""
        TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-$TUNNEL_TOKEN}"
        if [[ -z "$TUNNEL_TOKEN" ]]; then
          info "  Buat tunnel di Cloudflare Zero Trust → Networks → Tunnels → Create (Cloudflared),"
          info "  salin token dari perintah instalasinya (teks panjang setelah --token)."
          ask TUNNEL_TOKEN "Token Cloudflare Tunnel (tidak ditampilkan)" "" secret
        fi
        [[ "$TUNNEL_TOKEN" =~ ^[A-Za-z0-9._=-]{40,}$ ]] || die "Token Cloudflare Tunnel tidak valid."
        ;;
    esac
    APP_URL="${BALESIN_APP_URL:-https://$DOMAIN}"
  fi
  APP_URL="${BALESIN_APP_URL:-${APP_URL:-https://$DOMAIN}}"
  [[ "$APP_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "APP_URL tidak valid: '$APP_URL'"
  if [[ "$MODE" == "A" ]]; then
    local proxy
    IFS=',' read -ra proxies <<<"$UPSTREAM"
    for proxy in "${proxies[@]}"; do
      if [[ "$proxy" == */* ]] && ((${proxy#*/} < 29)); then
        warn "IP reverse proxy '$proxy' adalah rentang lebar: setiap alamat di rentang itu dipercaya mengisi X-Forwarded-For. Sebaiknya isi IP tunggal reverse proxy."
      fi
    done
  fi

  pick_subnet
  # Alamat tetap di jaringan edge (/24): gateway .10, caddy .11, cloudflared .12; dinamis .128–.255.
  local prefix="${SUBNET%.*}"
  GATEWAY_IP="$prefix.10"
  CADDY_IP="$prefix.11"
  TUNNEL_IP="$prefix.12"
  DYNAMIC_RANGE="$prefix.128/25"
  # Yang dipercaya api hanya proxy sungguhan, bukan seluruh subnet (alamat gateway bridge Docker
  # alamat pertama rentang dinamis, .128 — tempat lalu lintas lokal host masuk — tidak ikut dipercaya).
  case "$MODE" in
    A) TRUST_PROXY="$GATEWAY_IP,$UPSTREAM" ;;
    B) TRUST_PROXY="$GATEWAY_IP,$CADDY_IP" ;;
    C) TRUST_PROXY="$GATEWAY_IP,$TUNNEL_IP" ;;
  esac
  case "$MODE" in
    B) PROFILES="caddy" ;;
    C) PROFILES="tunnel" ;;
    *) PROFILES="" ;;
  esac
  ok "Alamat aplikasi: $APP_URL"
  ok "Jaringan internal Docker: $SUBNET (gateway $GATEWAY_IP) · TRUST_PROXY: $TRUST_PROXY"
}

# ── 4. Rahasia & .env ───────────────────────────────────────────────────────────────────────────
keep_or() {
  local value
  value="$(env_get "$1")"
  if [[ -n "$value" ]]; then printf '%s' "$value"; else printf '%s' "$2"; fi
}

write_env() {
  step "Rahasia dan berkas konfigurasi (.env)"
  local generated=0 key
  for key in POSTGRES_PASSWORD APP_DB_PASSWORD REDIS_PASSWORD BALESIN_MASTER_KEY SESSION_SECRET SETUP_TOKEN BACKUP_PASSPHRASE; do
    [[ -n "$(env_get "$key")" ]] || generated=$((generated + 1))
  done

  local postgres_password app_db_password redis_password master_key session_secret setup_token backup_passphrase
  postgres_password="$(keep_or POSTGRES_PASSWORD "$(rand_hex 24)")"
  app_db_password="$(keep_or APP_DB_PASSWORD "$(rand_hex 24)")"
  redis_password="$(keep_or REDIS_PASSWORD "$(rand_hex 24)")"
  master_key="$(keep_or BALESIN_MASTER_KEY "$(openssl rand -base64 32)")"
  session_secret="$(keep_or SESSION_SECRET "$(rand_b64url 48)")"
  setup_token="$(keep_or SETUP_TOKEN "$(rand_b64url 32)")"
  backup_passphrase="$(keep_or BACKUP_PASSPHRASE "$(rand_b64url 32)")"

  VERSION="$(keep_or BALESIN_VERSION "${BALESIN_VERSION:-$RELEASE_VERSION}")"

  local managed=(COMPOSE_PROJECT_NAME COMPOSE_PROFILES BALESIN_VERSION BALESIN_IMAGE_PREFIX
    BALESIN_RELEASE_BASE BALESIN_RELEASE_LATEST BALESIN_REQUIRE_SIGNATURE BALESIN_NETWORK_MODE BALESIN_DOMAIN APP_URL API_URL
    BALESIN_BIND_ADDRESS BALESIN_HTTP_PORT BALESIN_SUBNET BALESIN_DYNAMIC_RANGE BALESIN_GATEWAY_IP
    BALESIN_CADDY_IP BALESIN_TUNNEL_IP UPSTREAM_PROXY_IPS TRUST_PROXY ACME_EMAIL
    CLOUDFLARE_TUNNEL_TOKEN POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD APP_DB_USER APP_DB_PASSWORD
    REDIS_PASSWORD BALESIN_MASTER_KEY SESSION_SECRET SETUP_TOKEN BACKUP_PASSPHRASE
    BACKUP_RETENTION_DAYS LOG_LEVEL OUTBOUND_PRIVATE_ALLOWLIST META_GRAPH_VERSION)

  local name
  for name in MODE DOMAIN APP_URL BIND_ADDRESS HTTP_PORT SUBNET UPSTREAM TRUST_PROXY ACME_EMAIL TUNNEL_TOKEN VERSION; do
    assert_env_value "$name" "${!name}"
  done
  for name in BALESIN_IMAGE_PREFIX BALESIN_RELEASE_BASE BALESIN_RELEASE_LATEST BALESIN_PROJECT_NAME; do
    assert_env_value "$name" "${!name:-}"
  done

  local tmp
  tmp="$(mktemp "$BALESIN_HOME/.env.XXXXXX")"
  chmod 600 "$tmp"
  cat >"$tmp" <<EOF
# Balesin — konfigurasi INFRASTRUKTUR + rahasia. Dibuat install.sh $(date -u +%Y-%m-%d).
# RAHASIA: jangan dibagikan, jangan di-commit, izin berkas 600 (root saja).
# Simpan salinan berkas ini di tempat aman (mis. password manager): tanpa BALESIN_MASTER_KEY
# kredensial tersimpan (token Meta, SMTP) dan backup terenkripsi tidak bisa dibuka.
# Koneksi WhatsApp/email/Telegram/dll. diatur lewat aplikasi, BUKAN di sini (docs/PENGATURAN-UI.md).

COMPOSE_PROJECT_NAME=$(keep_or COMPOSE_PROJECT_NAME "${BALESIN_PROJECT_NAME:-balesin}")
# caddy (mode B) | tunnel (mode C) | kosong (mode A)
COMPOSE_PROFILES=$PROFILES

# ── Versi & sumber rilis ──
BALESIN_VERSION=$VERSION
BALESIN_IMAGE_PREFIX=$(keep_or BALESIN_IMAGE_PREFIX "${BALESIN_IMAGE_PREFIX:-$DEFAULT_IMAGE_PREFIX}")
BALESIN_RELEASE_BASE=$(keep_or BALESIN_RELEASE_BASE "${BALESIN_RELEASE_BASE:-$DEFAULT_RELEASE_BASE}")
BALESIN_RELEASE_LATEST=$(keep_or BALESIN_RELEASE_LATEST "${BALESIN_RELEASE_LATEST:-$DEFAULT_RELEASE_LATEST}")
# 1 = tanda tangan cosign rilis WAJIB terverifikasi (pasang cosign di server).
BALESIN_REQUIRE_SIGNATURE=$(keep_or BALESIN_REQUIRE_SIGNATURE "${BALESIN_REQUIRE_SIGNATURE:-0}")

# ── Jaringan (mode A/B/C, docs/ARCHITECTURE.md §5) ──
BALESIN_NETWORK_MODE=$MODE
BALESIN_DOMAIN=$DOMAIN
APP_URL=$APP_URL
API_URL=$APP_URL
BALESIN_BIND_ADDRESS=$BIND_ADDRESS
BALESIN_HTTP_PORT=$HTTP_PORT
BALESIN_SUBNET=$SUBNET
BALESIN_DYNAMIC_RANGE=$DYNAMIC_RANGE
BALESIN_GATEWAY_IP=$GATEWAY_IP
BALESIN_CADDY_IP=$CADDY_IP
BALESIN_TUNNEL_IP=$TUNNEL_IP
# IP reverse proxy di depan Balesin (mode A). TRUST_PROXY = IP gateway (+ caddy/cloudflared) + IP ini.
UPSTREAM_PROXY_IPS=$UPSTREAM
TRUST_PROXY=$TRUST_PROXY
ACME_EMAIL=$ACME_EMAIL
CLOUDFLARE_TUNNEL_TOKEN=$TUNNEL_TOKEN

# ── Database & Redis (hanya di jaringan internal Docker) ──
POSTGRES_USER=$(keep_or POSTGRES_USER balesin)
POSTGRES_DB=$(keep_or POSTGRES_DB balesin)
POSTGRES_PASSWORD=$postgres_password
# Peran runtime api/worker: hanya baca/tulis data (bukan pemilik tabel).
APP_DB_USER=$(keep_or APP_DB_USER balesin_app)
APP_DB_PASSWORD=$app_db_password
REDIS_PASSWORD=$redis_password

# ── Rahasia aplikasi (JANGAN diganti setelah ada data) ──
BALESIN_MASTER_KEY=$master_key
SESSION_SECRET=$session_secret
# Token wizard setup Owner pertama (tidak berlaku lagi setelah Owner dibuat).
SETUP_TOKEN=$setup_token

# ── Backup ──
BACKUP_PASSPHRASE=$backup_passphrase
BACKUP_RETENTION_DAYS=$(keep_or BACKUP_RETENTION_DAYS 14)

# ── Opsional ──
LOG_LEVEL=$(keep_or LOG_LEVEL info)
OUTBOUND_PRIVATE_ALLOWLIST=$(keep_or OUTBOUND_PRIVATE_ALLOWLIST "")
META_GRAPH_VERSION=$(keep_or META_GRAPH_VERSION "")
EOF

  # Variabel tambahan yang pernah diisi admin (mis. SMTP_* cadangan) dipertahankan apa adanya.
  if [[ -f "$ENV_FILE" ]]; then
    local extra pattern
    pattern="^($(
      IFS='|'
      echo "${managed[*]}"
    ))="
    extra="$(grep -E '^[A-Z_][A-Z0-9_]*=' "$ENV_FILE" | grep -vE "$pattern" || true)"
    if [[ -n "$extra" ]]; then
      printf '\n# ── Tambahan (dipertahankan dari .env sebelumnya) ──\n%s\n' "$extra" >>"$tmp"
    fi
  fi
  mv -f "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  if ((generated > 0)); then
    ok "$generated rahasia baru dibuat acak; rahasia lama tidak diubah"
  else
    ok "Semua rahasia sudah ada; tidak ada yang diubah"
  fi
  ok "$ENV_FILE (izin 600)"
}

# Memasang cosign ke /usr/local/bin bila belum ada versi yang sama. Gagal unduh/checksum: ditolak bila
# BALESIN_REQUIRE_SIGNATURE=1, selain itu peringatan (verifikasi tanda tangan dilewati).
install_cosign() {
  local arch expected tmp current require
  require="${BALESIN_REQUIRE_SIGNATURE:-$(env_get BALESIN_REQUIRE_SIGNATURE)}"
  if [[ "${BALESIN_SKIP_COSIGN:-0}" == "1" ]]; then
    return 0
  fi
  current="$(cosign version 2>/dev/null | awk '/GitVersion/ {print $2}' || true)"
  if [[ "$current" == "$COSIGN_VERSION" ]]; then
    ok "cosign $COSIGN_VERSION sudah terpasang"
    return 0
  fi
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 expected="$COSIGN_SHA256_AMD64" ;;
    aarch64 | arm64) arch=arm64 expected="$COSIGN_SHA256_ARM64" ;;
    *) arch="" expected="" ;;
  esac
  tmp="$(mktemp)"
  if [[ -n "$arch" ]] && command -v curl >/dev/null 2>&1 &&
    curl -fsSL --proto '=https' --tlsv1.2 --max-time 120 \
      "https://github.com/sigstore/cosign/releases/download/$COSIGN_VERSION/cosign-linux-$arch" -o "$tmp" &&
    [[ "$(sha256sum "$tmp" | awk '{print $1}')" == "$expected" ]]; then
    install -m 755 "$tmp" /usr/local/bin/cosign
    rm -f "$tmp"
    ok "cosign $COSIGN_VERSION terpasang (checksum cocok) untuk verifikasi tanda tangan rilis"
    return 0
  fi
  rm -f "$tmp"
  [[ "$require" == "1" ]] && die "cosign $COSIGN_VERSION gagal dipasang (unduhan/checksum), padahal tanda tangan rilis diwajibkan."
  warn "cosign gagal dipasang (unduhan/checksum); tanda tangan rilis tidak akan diverifikasi."
}

# Tanda tangan cosign keyless atas SHA256SUMS (workflow rilis.yml, review Fase 7 S4). Diverifikasi
# bila cosign terpasang; BALESIN_REQUIRE_SIGNATURE=1 di .env/lingkungan = wajib (tanpa cosign/tanda
# tangan → gagal).
readonly DEFAULT_SIGNER_IDENTITY='^https://github\.com/PutuTobing/balesin/\.github/workflows/rilis\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$'
verify_release_signature() {
  local dir="$1" identity require
  identity="${BALESIN_SIGNER_IDENTITY:-$(env_get BALESIN_SIGNER_IDENTITY)}"
  identity="${identity:-$DEFAULT_SIGNER_IDENTITY}"
  require="${BALESIN_REQUIRE_SIGNATURE:-$(env_get BALESIN_REQUIRE_SIGNATURE)}"
  if [[ ! -s "$dir/SHA256SUMS.sigstore.json" ]]; then
    [[ "$require" == "1" ]] && die "Rilis tanpa tanda tangan (SHA256SUMS.sigstore.json) ditolak."
    warn "Rilis tanpa tanda tangan cosign; hanya checksum yang diperiksa."
    return 0
  fi
  if ! command -v cosign >/dev/null 2>&1; then
    [[ "$require" == "1" ]] && die "cosign tidak terpasang, tanda tangan rilis tidak bisa diverifikasi."
    warn "cosign tidak terpasang: tanda tangan rilis tidak diverifikasi (disarankan memasang cosign)."
    return 0
  fi
  cosign verify-blob --bundle "$dir/SHA256SUMS.sigstore.json" \
    --certificate-identity-regexp "$identity" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "$dir/SHA256SUMS" >/dev/null 2>&1 ||
    die "Tanda tangan rilis TIDAK valid — berkas bukan dari workflow rilis resmi. Dibatalkan."
  ok "Tanda tangan rilis terverifikasi (cosign)"
}

# ── 5. Berkas rilis ─────────────────────────────────────────────────────────────────────────────
release_files() {
  step "Berkas Balesin (docker-compose.yml, Caddyfile, CLI balesin)"
  TMP_DIR="$(mktemp -d)"
  local file base src
  if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/docker-compose.yml" && -f "$SCRIPT_DIR/balesin" && -z "${BALESIN_RELEASE_BASE:-}" ]]; then
    for file in docker-compose.yml Caddyfile balesin; do cp "$SCRIPT_DIR/$file" "$TMP_DIR/$file"; done
    ok "Memakai berkas lokal dari $SCRIPT_DIR"
  else
    install_cosign
    base="${BALESIN_RELEASE_BASE:-$(env_get BALESIN_RELEASE_BASE)}"
    base="${base:-$DEFAULT_RELEASE_BASE}"
    src="${base//\{VERSI\}/$VERSION}"
    for file in docker-compose.yml Caddyfile balesin SHA256SUMS; do
      if [[ "$src" == http*://* ]]; then
        curl -fsSL --proto '=https' --tlsv1.2 --max-time 60 "$src/$file" -o "$TMP_DIR/$file" ||
          die "Gagal mengunduh $src/$file"
      else
        cp "$src/$file" "$TMP_DIR/$file" || die "Berkas $src/$file tidak ada"
      fi
    done
    if [[ "$src" == http*://* ]]; then
      curl -fsSL --proto '=https' --tlsv1.2 --max-time 60 "$src/SHA256SUMS.sigstore.json" \
        -o "$TMP_DIR/SHA256SUMS.sigstore.json" 2>/dev/null || rm -f "$TMP_DIR/SHA256SUMS.sigstore.json"
    else
      cp "$src/SHA256SUMS.sigstore.json" "$TMP_DIR/" 2>/dev/null || true
    fi
    verify_release_signature "$TMP_DIR"
    (cd "$TMP_DIR" && grep -E ' (docker-compose\.yml|Caddyfile|balesin)$' SHA256SUMS | sha256sum -c --quiet -) ||
      die "Checksum berkas rilis tidak cocok — unduhan rusak atau diubah."
    ok "Berkas rilis $VERSION diunduh dan checksum cocok"
  fi
  install -m 600 "$TMP_DIR/docker-compose.yml" "$BALESIN_HOME/docker-compose.yml"
  install -m 600 "$TMP_DIR/Caddyfile" "$BALESIN_HOME/Caddyfile"
  install -m 755 "$TMP_DIR/balesin" "$BALESIN_HOME/balesin"
  if [[ -d /usr/local/bin && "${BALESIN_SKIP_LINK:-0}" != "1" ]]; then
    ln -sfn "$BALESIN_HOME/balesin" /usr/local/bin/balesin
    ok "Perintah 'balesin' terpasang di /usr/local/bin"
  fi
  docker compose --project-directory "$BALESIN_HOME" -f "$BALESIN_HOME/docker-compose.yml" \
    --env-file "$ENV_FILE" config -q || die "docker-compose.yml tidak valid dengan .env ini."
  ok "Konfigurasi compose valid"
}

# ── 6–7. Image & layanan ────────────────────────────────────────────────────────────────────────
pull_images() {
  step "Mengunduh image Balesin $VERSION"
  if [[ "${BALESIN_NO_PULL:-0}" == "1" ]]; then
    ok "Dilewati (BALESIN_NO_PULL=1, memakai image lokal)"
    return
  fi
  docker compose --project-directory "$BALESIN_HOME" -f "$BALESIN_HOME/docker-compose.yml" \
    --env-file "$ENV_FILE" pull --quiet ||
    die "Gagal mengunduh image. Periksa koneksi internet/akses registry ($(env_get BALESIN_IMAGE_PREFIX))."
  ok "Image siap"
}

start_services() {
  step "Menyalakan Balesin (migrasi database otomatis)"
  local cli="$BALESIN_HOME/balesin"
  BALESIN_HOME="$BALESIN_HOME" "$cli" start ||
    die "Layanan belum sehat. Lihat log: sudo balesin logs"
}

# ── 8. Backup harian ────────────────────────────────────────────────────────────────────────────
install_cron() {
  step "Backup harian otomatis"
  if [[ -d /etc/cron.d ]]; then
    cat >/etc/cron.d/balesin <<EOF
# Backup harian Balesin (dibuat install.sh). Retensi: BACKUP_RETENTION_DAYS di $ENV_FILE.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 2 * * * root BALESIN_HOME=$BALESIN_HOME $BALESIN_HOME/balesin backup --auto >>$BALESIN_HOME/logs/backup.log 2>&1
EOF
    chmod 644 /etc/cron.d/balesin
    ok "Setiap hari 02:30 (waktu server) → $BALESIN_HOME/backups"
  else
    warn "Folder /etc/cron.d tidak ada; jadwalkan sendiri: balesin backup --auto (harian)."
  fi
}

finish() {
  local setup_status
  setup_status="$(docker compose --project-directory "$BALESIN_HOME" -f "$BALESIN_HOME/docker-compose.yml" \
    --env-file "$ENV_FILE" exec -T web wget -q -O - http://127.0.0.1:8080/api/v1/setup/status 2>/dev/null || true)"

  printf '\n%sBalesin %s terpasang.%s\n\n' "$BOLD$GREEN" "$VERSION" "$RESET"
  case "$MODE" in
    A)
      info "Langkah berikutnya (mode A — reverse proxy):"
      info "  1. DNS: A record $DOMAIN → IP publik reverse proxy."
      info "  2. Di reverse proxy, pasang contoh nginx/balesin.conf (lihat docs/DEPLOY.md),"
      info "     arahkan ke http://$BIND_ADDRESS:$HTTP_PORT lalu buat sertifikat (certbot)."
      info "  3. Firewall: Docker MELEWATI ufw untuk port container. Batasi port $HTTP_PORT lewat rantai"
      info "     DOCKER-USER supaya hanya $UPSTREAM yang bisa menjangkau (docs/DEPLOY.md §3.1), mis.:"
      info "       iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport $HTTP_PORT --ctdir ORIGINAL -j DROP"
      local proxy_ip
      IFS=',' read -ra proxies <<<"$UPSTREAM"
      for proxy_ip in "${proxies[@]}"; do
        info "       iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport $HTTP_PORT --ctdir ORIGINAL -s $proxy_ip -j RETURN"
      done
      ;;
    B)
      info "Langkah berikutnya (mode B — Caddy):"
      info "  1. DNS: A record $DOMAIN → IP publik server ini; buka port 80 dan 443."
      info "  2. Sertifikat HTTPS dibuat otomatis saat domain sudah mengarah ke server."
      ;;
    C)
      info "Langkah berikutnya (mode C — Cloudflare Tunnel):"
      info "  1. Di Cloudflare Zero Trust → Tunnels → tunnel ini → Public Hostname:"
      info "     $DOMAIN → Service HTTP → web:8080"
      ;;
  esac
  echo
  if [[ "$setup_status" == *'"needsSetup":true'* ]]; then
    info "${BOLD}Buat akun Owner lewat wizard setup:${RESET}"
    info "  URL  : $APP_URL/setup"
    info "  Token: $(env_get SETUP_TOKEN)"
    info "  (Tampilkan lagi kapan saja: sudo balesin setup-token)"
  else
    info "Wizard setup sudah selesai sebelumnya. Masuk di $APP_URL"
  fi
  echo
  info "Perintah penting: sudo balesin status | logs | backup | update | reset-owner-password"
  warn "Simpan salinan $ENV_FILE di tempat aman (BALESIN_MASTER_KEY + BACKUP_PASSPHRASE)."
}

main() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --ubah-jaringan | --reconfigure) RECONFIGURE=1 ;;
      --yes | -y) ASSUME_YES=1 ;;
      -h | --help)
        sed -n '2,17p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null | sed 's/^# \{0,1\}//'
        exit 0
        ;;
      *) die "Opsi tidak dikenal: $arg" ;;
    esac
  done

  RELEASE_VERSION="${BALESIN_VERSION:-$DEFAULT_VERSION}"
  if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/VERSION" ]]; then
    RELEASE_VERSION="${BALESIN_VERSION:-$(tr -d '[:space:]' <"$SCRIPT_DIR/VERSION")}"
  fi

  printf '%sInstaller Balesin%s — inbox tim omnichannel (self-hosted)\n' "$BOLD" "$RESET"
  check_prerequisites
  prepare_home
  configure_network
  write_env
  release_files
  pull_images
  start_services
  install_cron
  finish
}

main "$@"
