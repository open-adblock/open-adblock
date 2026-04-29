# OpenAdBlock Report Worker

Cloudflare Worker endpoint for extension reports. Reports are validated and forwarded to GitHub Issues in `open-adblock/open-adblock`.

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

`GITHUB_TOKEN` should be a fine-grained GitHub token with Issues read/write access to the configured repository.

Optional environment variables:

- `GITHUB_REPO`: defaults to `open-adblock/open-adblock`
- `GITHUB_LABELS`: comma-separated issue labels
- `ALLOWED_ORIGINS`: comma-separated CORS origins, wildcard suffixes supported
