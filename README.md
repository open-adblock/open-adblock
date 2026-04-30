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

## Browser Rulesets

The browser extension reads `filters/browser/ruleset.json`, then fetches and compiles the enabled rulesets into MV3 dynamic DNR rules and cosmetic selector data.

## DNS Rulesets

DNS builds read `filters/dns/ruleset.json`, fetch the selected preset sources, and compile `light` and `pro` filter blobs from that catalog.

## Licensing

OpenAdBlock source code and first-party filter data are licensed under the
GNU General Public License version 3. Third-party filter sources keep their own
licenses and attribution in the relevant notice files.
