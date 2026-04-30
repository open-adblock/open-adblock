# OpenAdBlock — Lightweight ad blocker designed to stay on

A lightweight, open-source ad blocker with breakage-free filters, built for fast and stable browsing.

## MV3 Design Plan

OpenAdBlock is built first for Manifest V3. The initial implementation lives under `mv3/`; Manifest V2 support is intentionally deferred.

## Product Decisions

- Brand: `OpenAdBlock`
- UI copy: English only
- Extension code license: GPL-3.0-only
- Target stores: Chrome Web Store first, then other Chromium-based stores
- Statistics and user-created rules: local-only, stored in `chrome.storage.local`
- Default filters: uBO filter-based network/cosmetic filtering plus an OpenAdBlock curated allowlist
- Remote filter updates: supported for data-only filter updates
- Permissions: broad host access is acceptable for the first version
- MVP filtering scope: network filtering, CSS cosmetic filtering, and block-element rules are all required
- Breakage posture: prefer fewer false positives over maximum blocking coverage

## Repository Layout

```text
mv3/
  manifest.json
  package.json
  src/
    background/
      service-worker.ts
    popup/
      PopupApp.tsx
      popup.html
    options/
      OptionsApp.tsx
      options.html
    content/
      cosmetic.ts
    shared/
      browser.ts
      storage.ts
      stats.ts
      urls.ts
    rules/
      ids.ts
      dynamic.ts
  scripts/
    link-filters.mjs
    fetch-filters.ts
    compile-dnr.ts
    compile-cosmetic.ts
    validate-rules.ts
    build-filter-attribution.ts
  tests/
    fixtures/
    unit/
    smoke/
```

Future shared code can move to a top-level `packages/` directory only after MV2 or another target actually needs it.
Filter data lives in the monorepo under `filters/browser`; local
MV3 loading may create an ignored `mv3/filters` link for packaged runtime data.

## MV3 Architecture

### Manifest

The MV3 manifest should declare:

- `manifest_version: 3`
- `background.service_worker`
- `action.default_popup`
- `options_page`
- `declarative_net_request.rule_resources`
- Permissions: `declarativeNetRequest`, `storage`, `tabs`, `alarms`, `scripting`
- Broad host access: `<all_urls>`
- Content scripts for CSS cosmetic filtering and block-element picking across supported web pages

Prefer `chrome.*` behind a tiny wrapper in `shared/browser.ts` so Edge/Brave compatibility fixes are localized.

### Background Service Worker

Responsibilities:

- Initialize default local settings on install/update
- Enable or disable bundled static rulesets
- Manage dynamic rules for per-site pause/allow
- Schedule and apply data-only remote filter updates
- Maintain local aggregate stats where supported
- Handle popup/options messages

No DOM access and no long-lived runtime assumptions. State must be persisted in storage, not module globals.

### Popup

The attached design maps to the MVP popup:

- Header with logo, name, version, settings button
- Current site bar with Protected/Paused state
- Per-site toggle
- This page stats
- Lifetime stats
- Footer actions: `Block element`, `Report breakage`

MVP behavior:

- Site toggle writes a per-site allow rule to dynamic DNR rules.
- `Report breakage` submits to the configured report endpoint without retaining a local copy.
- Stats start conservative: show browser-provided action count where available and local lifetime counters where reliable.
- `Block element` opens an in-page picker and stores the resulting cosmetic rule locally.

### Options

The attached design maps to the MVP options page:

- General: theme setting
- About: version, license, Manifest V3, links

Next settings after MVP:

- Filter list status
- Local allowlist viewer
- Local block-element rule manager
- Remote filter update status
- Import/export settings

## Filter Pipeline

OpenAdBlock should not interpret remotely downloaded logic at runtime. The extension can support remote filter updates only as data updates. All parsing, validation, compilation, and application logic must be bundled inside the extension package.

```text
uBO filter sources + OpenAdBlock allowlist
  -> fetch and pin metadata
  -> normalize
  -> compile supported network filters to DNR JSON
  -> compile supported cosmetic filters to CSS/content-script data
  -> emit unsupported filter report
  -> validate against Chrome DNR limits
  -> package into mv3 build
```

The packaged build should include a baseline static ruleset so the extension works immediately after install and remains useful if remote updates fail.

## Remote Filter Updates

Remote updates are allowed for filter data, with strict boundaries:

- Allowed: downloading signed or checksummed filter data, metadata, allowlist entries, and supported cosmetic selector data.
- Not allowed: downloading JavaScript, WebAssembly, scriptlets, procedural logic, or any text that the extension executes as code.
- Static rulesets are package assets and cannot be replaced remotely. Remote network updates must be compiled into dynamic DNR rules.
- Remote CSS filtering updates must be treated as selector data consumed by packaged content-script logic, not as executable remote code.
- Remote filter updates must be optional and failure-tolerant. The packaged static ruleset remains the fallback.

The monorepo `filters/` package should publish:

```text
manifest.json
network/
  ubo-compatible.txt
allowlist/
  network.txt
  cosmetic.txt
cosmetic/
  selectors.txt
metadata/
  attribution.json
  checksums.json
```

Suggested remote update flow:

1. `alarms` wakes the service worker on a conservative interval.
2. The service worker fetches the remote manifest from the OpenAdBlock filters endpoint.
3. The updater checks schema version, extension compatibility, hashes, and source metadata.
4. Network filters are compiled into safe dynamic DNR rules.
5. Cosmetic filters are compiled into a local selector index in `chrome.storage.local`.
6. Unsupported rules are discarded and counted.
7. The previous working remote filter snapshot is retained for rollback.

Remote DNR updates must respect Chrome dynamic rule quotas. If the remote rules exceed quota, priority order is:

1. OpenAdBlock allowlist and user pause rules
2. High-confidence network block rules
3. Lower-confidence or broad cosmetic/network rules

For MVP, remote updates should use only OpenAdBlock-controlled endpoints. Third-party filter URLs can be fetched by the filter build pipeline, then republished through `open-adblock/open-adblock` with attribution.

### Rule Strategy

- Static rulesets:
  - `ruleset-main`: uBO-based block rules
  - `ruleset-allowlist`: OpenAdBlock allow/allowAllRequests rules with higher priority
- Dynamic rules:
  - User/site-specific pause rules
  - Remote network filter updates
  - User block/allow entries
- Session rules:
  - Reserved for temporary workflows such as element picker preview
- Local cosmetic rules:
  - Stored in `chrome.storage.local`
  - Applied by packaged content scripts as selector-based CSS hiding rules

### Supported Filter Scope For MVP

Supported:

- Network block filters that translate cleanly to DNR
- Network allow filters that translate cleanly to DNR
- Basic cosmetic hiding selectors that can be applied by content scripts
- User-created block-element selectors
- Remote data updates for supported network and cosmetic rules

Deferred:

- Full uBO scriptlet support
- Complex procedural cosmetic filters
- Advanced dynamic filtering modes
- Per-request debug logs in production

Unsupported filters must be reported into `filters/browser/generated/unsupported.json` during build, with counts by reason.

## Licensing Boundary

The extension source code is GPL-3.0-only. uBO filter assets and related third-party lists must be treated as third-party data with their own licenses and attribution.

Implementation requirements:

- Keep filter source metadata in `filters/browser/sources/ubo.json`
- Generate `filters/browser/generated/attribution.json`
- Include third-party notices in the packaged extension
- Include third-party notices for remote filter snapshots
- Do not imply uBO endorsement
- Make it clear that OpenAdBlock is uBO filter-based, not a uBlock Origin fork

If filter assets are bundled into the extension package, release artifacts must preserve required notices. Runtime filter updates must also preserve attribution metadata and remain data-only.

## Local-Only Data Model

Use `chrome.storage.local` for:

- Theme
- Enabled/paused site map
- Lifetime counters
- Local block-element rules
- Filter build/version metadata
- Remote filter update metadata

No account, telemetry, remote analytics, or extension-side report retention. Report upload happens only after explicit user action.

Suggested keys:

```ts
type OpenAdBlockStorage = {
  settings: {
    theme: "system" | "light" | "dark";
  };
  siteState: Record<string, {
    paused: boolean;
    updatedAt: number;
  }>;
  stats: {
    lifetimeBlocked: number;
    pagesSeen: number;
    bandwidthSavedBytesEstimate: number;
    startedAt: number;
  };
  userCosmeticRules: Array<{
    id: string;
    hostname: string;
    selector: string;
    source: "block-element";
    createdAt: number;
  }>;
  filters: {
    buildId: string;
    builtAt: string;
    remoteVersion?: string;
    remoteUpdatedAt?: number;
    remoteLastError?: string;
    sourceSummary: Array<{
      name: string;
      url: string;
      license: string;
      revision?: string;
    }>;
  };
};
```

## Build And Validation

Recommended toolchain:

- TypeScript
- Vite or tsup for extension pages and service worker bundling
- React for popup/options
- Vitest for unit tests
- Playwright or Chrome extension smoke tests for unpacked builds

Validation gates:

- `npm run typecheck`
- `npm run test`
- `npm run filters:build`
- `npm run filters:validate`
- Remote filter manifest schema validation
- Remote update rollback test
- Load unpacked extension smoke test
- DNR rule count and regex limit report
- Packaged artifact check for remote code references
- Packaged artifact check for third-party notices and filter attribution

## Milestones

### M0 - Scaffold

- Create `mv3/` package and manifest
- Port design tokens and UI shell from attached design
- Build popup/options locally
- Add service worker message plumbing

### M1 - Blocking MVP

- Add static generated DNR ruleset fixture
- Implement filter compiler for supported network rules
- Add OpenAdBlock allowlist ruleset
- Implement CSS cosmetic selector pipeline
- Validate extension loads unpacked and blocks fixture requests

### M2 - Site Controls

- Implement current-site detection
- Implement per-site pause via dynamic allow rules
- Persist site state
- Reflect Protected/Paused in popup

### M3 - Block Element And Cosmetic Controls

- Implement in-page element picker
- Generate user cosmetic selectors
- Store block-element rules locally
- Apply local and remote cosmetic rules through content scripts
- Add options management for local blocked elements

### M4 - Remote Filter Updates

- Define `filters/` manifest schema
- Add data-only remote update scheduler
- Compile remote network filters into dynamic DNR rules
- Compile remote cosmetic filters into local selector indexes
- Add checksum validation and rollback

### M5 - Local Stats

- Add conservative local stats

### M6 - Store Readiness

- Add third-party notices
- Add privacy policy text: local-only data, no telemetry
- Add Chrome Web Store screenshots from actual UI
- Test Chrome, Edge, Brave
- Produce release ZIP

## Remaining Decisions

1. Remote update endpoint: jsDelivr manifest URL and release format for `open-adblock/open-adblock`.
2. Filter signing: checksums only for MVP, or signed manifests before public release.
3. Allowlist ownership: who approves additions, and what regression test set must pass before release?
4. Remote update cadence: daily, weekly, or adaptive based on filter manifest TTL.
5. Store policy copy: exact disclosure wording for broad host permissions and data-only remote filter updates.
