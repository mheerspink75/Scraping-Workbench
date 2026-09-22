#!/usr/bin/env bash
# diagnostic-running-servers.sh
# Read-only Linux diagnostic for identifying running/listening servers.
# chmod +x diagnostic-running-servers.sh
# sudo ./diagnostic-running-servers.sh --color --verbose
# $ pkill -f "^python3 app.py" ; pkill -f "opencode serve --port" ; sleep 2; pgrep -af "app.py|opencode serve" || echo "all stopped"

set -u

USE_COLOR=0
VERBOSE=0

usage() {
  cat <<'EOF'
Usage: diagnostic-running-servers.sh [--color] [--verbose] [--help]

Options:
  --color     Enable colored status labels
  --verbose   Include extra process and firewall details
  --help      Show this help

Tip: Run with sudo to see all owning processes and firewall details.
EOF
}

while (($#)); do
  case "$1" in
    --color) USE_COLOR=1 ;;
    --verbose|-v) VERBOSE=1 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if ((USE_COLOR)) && [[ -t 1 ]]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  BLUE=$'\033[34m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; BOLD=''; RESET=''
fi

section() { printf '\n%s%s== %s ==%s\n' "$BOLD" "$BLUE" "$1" "$RESET"; }
info()    { printf '%s[INFO]%s %s\n' "$BLUE" "$RESET" "$*"; }
warn()    { printf '%s[WARN]%s %s\n' "$YELLOW" "$RESET" "$*"; }
ok()      { printf '%s[ OK ]%s %s\n' "$GREEN" "$RESET" "$*"; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

TMP_LISTENERS=$(mktemp)
trap 'rm -f "$TMP_LISTENERS"' EXIT INT TERM

section "System"
printf 'Host:       %s\n' "$(hostname 2>/dev/null || echo unknown)"
printf 'Date:       %s\n' "$(date --iso-8601=seconds 2>/dev/null || date)"
printf 'Kernel:     %s\n' "$(uname -srmo 2>/dev/null || uname -a)"
printf 'User:       %s (UID %s)\n' "${USER:-unknown}" "$(id -u)"
if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  printf 'OS:         %s\n' "${PRETTY_NAME:-unknown}"
fi
if ((EUID != 0)); then
  warn "Not running as root; some process names and firewall rules may be hidden."
fi

section "Listening network sockets"
if command_exists ss; then
  # -H: no header, -l: listening, -n: numeric, -t/u: TCP/UDP, -p: process
  ss -H -lntup 2>/dev/null | tee "$TMP_LISTENERS"
elif command_exists netstat; then
  warn "ss not found; using netstat."
  netstat -lntup 2>/dev/null | tee "$TMP_LISTENERS"
elif command_exists lsof; then
  warn "ss and netstat not found; using lsof."
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | tee "$TMP_LISTENERS"
  lsof -nP -iUDP 2>/dev/null | tee -a "$TMP_LISTENERS"
else
  warn "No socket inspection tool found. Install iproute2 (ss), net-tools, or lsof."
fi

if [[ -s "$TMP_LISTENERS" ]]; then
  LISTENER_COUNT=$(wc -l < "$TMP_LISTENERS" | tr -d ' ')
  ok "Found ${LISTENER_COUNT} listener/socket entries."
else
  info "No listeners were detected, or access was restricted."
fi

section "Public-facing listeners"
if [[ -s "$TMP_LISTENERS" ]]; then
  PUBLIC_LINES=$(grep -E '(^|[[:space:]])(0\.0\.0\.0|\*|\[?::\]?):[0-9]+' "$TMP_LISTENERS" || true)
  if [[ -n "$PUBLIC_LINES" ]]; then
    printf '%s\n' "$PUBLIC_LINES"
    warn "Wildcard-bound services may accept connections from other hosts, subject to firewall and routing rules."
  else
    ok "No obvious wildcard-bound listeners detected."
  fi
fi

section "Common server processes"
SERVER_REGEX='(nginx|apache2?|httpd|caddy|lighttpd|traefik|haproxy|node|deno|bun|python|gunicorn|uvicorn|daphne|php-fpm|java|tomcat|dotnet|ruby|puma|redis-server|redis|mongod|postgres|mysqld|mariadbd|memcached|sshd|vsftpd|named|dnsmasq|minio)'
MATCHES=$(ps -eo pid,user,stat,etimes,comm,args --sort=comm 2>/dev/null | grep -Ei "$SERVER_REGEX" | grep -Ev 'grep -E|diagnostic-running-servers' || true)
if [[ -n "$MATCHES" ]]; then
  printf '%-8s %-12s %-5s %-10s %-18s %s\n' PID USER STAT AGE_SEC COMMAND ARGS
  printf '%s\n' "$MATCHES"
else
  info "No common server process names detected."
fi

section "Active system services with server-like names"
if command_exists systemctl && systemctl list-units >/dev/null 2>&1; then
  SERVICES=$(systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null \
    | grep -Ei "$SERVER_REGEX|docker|containerd|podman" || true)
  if [[ -n "$SERVICES" ]]; then printf '%s\n' "$SERVICES"; else info "No matching active services found."; fi
else
  info "systemd is unavailable or not running."
fi

section "Containers"
if command_exists docker; then
  if docker info >/dev/null 2>&1; then
    docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
  else
    warn "Docker is installed, but its daemon is unavailable or access is denied."
  fi
else
  info "Docker CLI not installed."
fi

if command_exists podman; then
  podman ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || \
    warn "Podman is installed, but containers could not be listed."
else
  info "Podman CLI not installed."
fi

section "Firewall summary"
if command_exists ufw; then
  ufw status 2>/dev/null || warn "Could not read UFW status. Try sudo."
elif command_exists firewall-cmd; then
  firewall-cmd --state 2>/dev/null || true
  firewall-cmd --list-all 2>/dev/null || warn "Could not read firewalld rules. Try sudo."
elif command_exists nft; then
  if ((VERBOSE)); then
    nft list ruleset 2>/dev/null || warn "Could not read nftables rules. Try sudo."
  else
    info "nftables is installed. Use --verbose (and possibly sudo) to display its ruleset."
  fi
elif command_exists iptables; then
  if ((VERBOSE)); then
    iptables -S 2>/dev/null || warn "Could not read iptables rules. Try sudo."
  else
    info "iptables is installed. Use --verbose (and possibly sudo) to display rules."
  fi
else
  info "No supported firewall command detected."
fi

if ((VERBOSE)); then
  section "Top processes by CPU"
  ps -eo pid,user,%cpu,%mem,etime,comm,args --sort=-%cpu 2>/dev/null | head -n 16
fi

section "Result"
if [[ -s "$TMP_LISTENERS" ]]; then
  ok "Diagnostic completed. Review listeners, owning processes, containers, and firewall state above."
else
  warn "Diagnostic completed without confirmed listeners. Re-run with sudo for fuller visibility."
fi
