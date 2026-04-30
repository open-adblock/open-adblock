# open-adblock DNS

DNS-level ad, tracker, malware, and phishing blocking. No app, no extension —
just change your DNS.

| Preset | DoH URL | Plain DNS (UDP/53) |
|--------|---------|--------------------|
| **Light** *(default)* | `https://dns.open-adblock.com/dns-query` | `dns.open-adblock.com` |
| **Pro** *(aggressive)* | `https://pro.dns.open-adblock.com/dns-query` | `pro.dns.open-adblock.com` |

---

## Use it

### iOS / iPadOS / macOS

One tap installs a system-wide DoH profile.

**On the device** (open this README in Safari):

1. Tap an install link — the system will prompt you to download the profile:
   - [**Install Light**](https://dns.open-adblock.com/light.mobileconfig) — default
   - [**Install Pro**](https://pro.dns.open-adblock.com/pro.mobileconfig) — aggressive
2. Open **Settings → General → VPN, DNS & Device Management**, tap the downloaded profile, and tap **Install**.

**On a desktop?** Scan with your phone's camera:

| Light (default) | Pro (aggressive) |
|:---:|:---:|
| <img src="docs/qr-light.svg" alt="Install Light" width="180" /> | <img src="docs/qr-pro.svg" alt="Install Pro" width="180" /> |

### Android 9+

1. Open **Settings → Network & internet → Private DNS**.
2. Choose **Private DNS provider hostname**.
3. Paste the hostname and save:

   ```
   dns.open-adblock.com
   ```

   Or for aggressive blocking:

   ```
   pro.dns.open-adblock.com
   ```

### Firefox / Chrome / Edge &nbsp;*(any OS)*

1. Open your browser's secure-DNS settings:
   - **Firefox** — Settings → Privacy & Security → **DNS over HTTPS** → *Max Protection* → Choose provider → **Custom**
   - **Chrome / Edge** — Settings → Privacy and security → Security → **Use secure DNS** → *With:* **Custom**
2. Paste the DoH URL and save:

   ```
   https://dns.open-adblock.com/dns-query
   ```

   Or:

   ```
   https://pro.dns.open-adblock.com/dns-query
   ```

### Windows 11

Windows 11's system DoH requires pairing a DoH template to a specific IP,
which doesn't work cleanly with our Cloudflare Workers backend (the IPs
aren't stable per-user). The simplest path is the **browser setup above** —
configuring Chrome, Edge, or Firefox on Windows covers most traffic, and
doesn't need admin rights.

### Router / anything with a DNS field

Any device that takes a plain IP or hostname for DNS works over UDP/53:

```
dns.open-adblock.com
pro.dns.open-adblock.com
```

These hostnames resolve to fly.io Anycast IPs and serve the same blocklists
as the DoH endpoints.

---

## Architecture

Two hosts, one Rust engine:

- **DoH (443)** — Cloudflare Workers (see [doh/](doh/) + [doh/wrangler.toml](doh/wrangler.toml)).
  Filter engine compiled to WASM, blocklist blobs bundled into the worker.
- **Plain DNS (UDP/53)** — Rust `dns-udp` server on fly.io
  (see [udp/](udp/), [udp/fly.light.toml](udp/fly.light.toml),
  [udp/fly.pro.toml](udp/fly.pro.toml), [udp/Dockerfile](udp/Dockerfile)).
  Same engine, same blobs, native build.

The filter blobs in both paths are built from [filters/dns/ruleset.json](../filters/dns/ruleset.json)
via [scripts/build-all.sh](scripts/build-all.sh). CI fetches the selected
ruleset presets and rebuilds the blobs on every deploy.

Deploy commands (maintainers):

```sh
# DoH — Cloudflare Workers Builds handles this automatically on push to main.
# See doh/wrangler.toml.

# UDP - fly.io, one app per preset. Run from the monorepo root.
flyctl deploy --config dns/udp/fly.light.toml
flyctl deploy --config dns/udp/fly.pro.toml
```
