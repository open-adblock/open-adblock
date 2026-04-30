# OpenAdBlock — Lightweight ad blocker designed to stay on

A lightweight, open-source ad blocker with breakage-free filters, built for fast and stable browsing.

This folder is an unpacked Manifest V3 Chrome extension.
Filter data lives in the monorepo at
[filters/browser](../../filters/browser). Set
`OPEN_ADBLOCK_BROWSER_FILTERS_DIR` only when testing an alternate filter source.

## Current Scope

- Static DNR network blocking seed rules
- Data-only remote filter update flow
- Dynamic DNR rules for remote network updates and per-site pause
- CSS cosmetic filtering through packaged content scripts
- In-page block element picker
- Breakage reports submitted through the filters Cloudflare Worker
- Popup and options UI in English

## Load Locally

Create the ignored local filter directory, then open `chrome://extensions`,
enable Developer mode, choose Load unpacked, and select this `mv3` folder.

```sh
npm run filters:link
```

## Validate

```sh
npm run validate
```

## Remote Filter Manifest

The default endpoint is:

```text
https://cdn.jsdelivr.net/gh/open-adblock/open-adblock@main/filters/manifest.json
```

Remote updates are filter data only. JavaScript, WebAssembly, scriptlets, and procedural logic must not be delivered through the filter endpoint.
