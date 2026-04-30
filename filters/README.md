# OpenAdBlock Filters

Shared filter data for the OpenAdBlock projects lives here.

- `dns/ruleset.json`: DNS preset catalog used to fetch upstream lists for compiled DNS blobs.
- `browser/ruleset.json`: browser ruleset catalog used by the MV3 extension to fetch and compile selected filter lists.

Consumer projects read filter data directly from this monorepo:

- `dns` reads `../filters/dns/ruleset.json` for DNS blob builds.
- `chrome/mv3` reads `../../filters/browser` for browser client validation and can create an ignored local runtime copy when loading the MV3 extension unpacked.

Edit filter data in this repo so each project consumes the same source of truth.
