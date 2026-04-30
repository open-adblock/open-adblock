# OpenAdBlock Report Worker

Cloudflare Worker endpoint for extension reports. Reports are validated and forwarded to GitHub Issues in `open-adblock/open-adblock`.

Issues are grouped by hostname with titles like:

```text
filter: `domain.com`
```

When an open issue with the same title already exists, the report is appended as a new comment. Closed issues are left closed, and a new report opens a fresh issue instead. Reports also get an issue type label: `issue:breakage`, `issue:missed-ad`, `issue:false-positive`, or `issue:other`.

If a report includes a screenshot, the Worker uploads it to the configured GitHub repository through the Contents API and embeds the raw GitHub URL in the issue or comment.

## Endpoints

- `GET /health`
- `POST /api/reports`

## Deploy

```sh
npm install
npm run check
wrangler secret put GH_TOKEN
npm run deploy
```

`GH_TOKEN` should be a fine-grained GitHub token with Issues read/write access and Contents read/write access to the configured repository.

Optional environment variables:

- `GITHUB_REPO`: defaults to `open-adblock/open-adblock`
- `GITHUB_LABELS`: comma-separated base issue labels; the reported issue type label is always included
- `GITHUB_UPLOAD_BRANCH`: branch used for screenshot files, defaults to `report-screenshots`; the Worker recreates it from the repository default branch if it is missing
- `ALLOWED_ORIGINS`: comma-separated CORS origins, wildcard suffixes supported
