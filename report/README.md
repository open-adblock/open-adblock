# OpenAdBlock Report Worker

Cloudflare Worker endpoint for extension reports. Reports are validated and forwarded to GitHub Issues in `open-adblock/open-adblock`.

Issues are grouped by hostname with titles like:

```text
Breakage: `domain.com`
```

When an issue with the same title already exists, the report is appended as a new comment. If that issue is closed, the Worker reopens it after adding the comment.

If a report includes a screenshot, the Worker uploads it to the configured GitHub repository through the Contents API and embeds the raw GitHub URL in the issue or comment.

## Endpoints

- `GET /health`
- `POST /api/reports`

## Deploy

```sh
npm install
npm run check
wrangler secret put GITHUB_TOKEN
npm run deploy
```

`GITHUB_TOKEN` should be a fine-grained GitHub token with Issues read/write access and Contents read/write access to the configured repository.

Optional environment variables:

- `GITHUB_REPO`: defaults to `open-adblock/open-adblock`
- `GITHUB_LABELS`: comma-separated issue labels; `filter:breakage` is always included
- `GITHUB_UPLOAD_BRANCH`: branch used for screenshot files, defaults to `main`
- `ALLOWED_ORIGINS`: comma-separated CORS origins, wildcard suffixes supported
