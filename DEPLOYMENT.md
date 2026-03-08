# Deployment Guide

This guide covers running PostGIS Studio automatically as a systemd user
service and accessing it at `http://postgis.local` instead of
`http://localhost:8001`.

---

## 1. systemd user service

### Create the unit file

```bash
mkdir -p ~/.config/systemd/user
```

Create `~/.config/systemd/user/postgisstudio.service`:

```ini
[Unit]
Description=PostGIS Studio
After=network.target

[Service]
WorkingDirectory=/home/michael/2_responsibilities/postgisstudio
ExecStart=/home/michael/.local/bin/uv run python main.py serve
Restart=on-failure

[Install]
WantedBy=default.target
```

> **Find the full path to `uv`:** run `which uv` and substitute the result for
> `/home/michael/.local/bin/uv` if it differs.

### Enable and start

```bash
systemctl --user daemon-reload
systemctl --user enable postgisstudio   # start automatically on login
systemctl --user start  postgisstudio   # start now
```

### Useful commands

| Action | Command |
|---|---|
| Check status | `systemctl --user status postgisstudio` |
| Stop | `systemctl --user stop postgisstudio` |
| Restart | `systemctl --user restart postgisstudio` |
| Follow logs | `journalctl --user -u postgisstudio -f` |

### Start at boot (without logging in)

By default, user services only run while you are logged in. To start the
service at boot even when no session is open:

```bash
loginctl enable-linger $USER
```

---

## 2. `postgis.local` hostname

### Option A — `/etc/hosts` (simplest, local machine only)

Add one line to `/etc/hosts`:

```
127.0.0.1  postgis.local
```

```bash
echo '127.0.0.1  postgis.local' | sudo tee -a /etc/hosts
```

This works in every browser and tool immediately. Although `.local` is
conventionally reserved for mDNS/Bonjour, the `files` source in
`/etc/nsswitch.conf` takes precedence over `mdns` on most Linux distributions,
so the hosts-file entry wins.

### Option B — Avahi/mDNS (optional, for LAN access)

If you want **other machines on the same network** to reach the service by
name, Avahi can advertise it via mDNS. Install `avahi-daemon`, publish a
service record, and ensure your router/clients resolve `.local` names. This is
more involved and unnecessary for single-machine use.

---

## 3. Accessing without a port number (optional)

Without a reverse proxy the URL is `http://postgis.local:8001`. To reach
`http://postgis.local` (port 80) you need a proxy, because binding directly to
port 80 requires root or the `CAP_NET_BIND_SERVICE` capability.

### nginx

> **Arch Linux note:** Arch's nginx package does not use the
> `sites-available`/`sites-enabled` pattern (that's a Debian/Ubuntu
> convention). Use `/etc/nginx/conf.d/` instead, but first verify that
> `/etc/nginx/nginx.conf` actually includes it — the default Arch config may
> not. Inside the `http {}` block, ensure this line is present:
>
> ```nginx
> include /etc/nginx/conf.d/*.conf;
> ```
>
> Also note that `modules.d/` is for loading nginx modules, not server blocks —
> don't put virtual host configs there.

Install nginx (`sudo pacman -S nginx`), then create
`/etc/nginx/conf.d/postgis.local.conf`:

```nginx
server {
    listen 80;
    server_name postgis.local;

    location / {
        proxy_pass http://127.0.0.1:8001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
sudo systemctl enable --now nginx
sudo nginx -t                  # verify config parses cleanly
sudo systemctl reload nginx
```

### Caddy (alternative one-liner config)

```
postgis.local {
    reverse_proxy localhost:8001
}
```

Run with `caddy run` or add it as its own systemd service.

---

## 4. Quick-start summary

Copy-paste sequence for the common case (hosts-file entry, no proxy):

```bash
# 1. Create unit file
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/postgisstudio.service << 'EOF'
[Unit]
Description=PostGIS Studio
After=network.target

[Service]
WorkingDirectory=/home/michael/2_responsibilities/postgisstudio
ExecStart=/home/michael/.local/bin/uv run python main.py serve
Restart=on-failure

[Install]
WantedBy=default.target
EOF

# 2. Enable and start the service
systemctl --user daemon-reload
systemctl --user enable --now postgisstudio

# 3. (Optional) start at boot without login
loginctl enable-linger $USER

# 4. Add hostname alias
echo '127.0.0.1  postgis.local' | sudo tee -a /etc/hosts

# 5. Verify
systemctl --user status postgisstudio
curl -s http://postgis.local:8001 | head -5
```

After these steps:

- `systemctl --user status postgisstudio` shows `active (running)`
- `http://postgis.local:8001` loads the UI
- The service restarts automatically after a crash and (with linger enabled)
  survives reboots
