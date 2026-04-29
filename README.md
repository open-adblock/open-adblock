# OpenAdBlock

OpenAdBlock is a monorepo for browser, DNS, shared filter, and report-worker
components.

## Components

- `chrome/` - Chrome/Chromium Manifest V3 extension.
- `dns/` - DNS-over-HTTPS worker, UDP DNS server, and shared Rust matching engine.
- `filters/` - Shared browser and DNS filter sources.
- `report/` - Cloudflare Worker that turns extension reports into GitHub issues.

## Common Commands

```sh
# Chrome extension validation and tests
cd chrome/mv3
npm run check

# DNS Rust workspace
cd dns
cargo test --workspace

# DNS DoH worker tests
cd dns/doh
deno test --allow-read --allow-net src/

# Report worker
cd report
npm ci
npm run check
```

## Remote Filter Manifest

The browser extension defaults to the monorepo-hosted filter manifest:

```text
https://cdn.jsdelivr.net/gh/open-adblock/open-adblock@main/filters/manifest.json
```

## Licensing

OpenAdBlock source code and first-party filter data are licensed under the MIT
License. Third-party filter sources keep their own licenses and attribution in
the relevant notice files.
