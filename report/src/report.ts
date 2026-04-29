export type Env = {
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  GITHUB_LABELS?: string;
  ALLOWED_ORIGINS?: string;
  SCREENSHOT_BUCKET?: R2Bucket;
  SCREENSHOT_PUBLIC_BASE_URL?: string;
};

export type NormalizedReport = {
  id: string;
  category: ReportCategory;
  details: string;
  hostname: string;
  url: string;
  extensionVersion: string;
  userAgent: string;
  reportedAt: string;
  diagnostics: Record<string, unknown>;
  screenshot: ReportScreenshot | null;
  screenshotUrl?: string;
};

export type GitHubIssue = {
  number: number;
  url: string;
  created: boolean;
  commented: boolean;
  reopened: boolean;
  screenshotUrl?: string;
};

export type Fetcher = typeof fetch;

type ReportCategory = "breakage" | "missed_ad" | "false_positive" | "other";
type ReportScreenshot = {
  data: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  extension: "jpg" | "png" | "webp";
  sizeBytes: number;
};
type ExistingGitHubIssue = {
  number: number;
  title: string;
  url: string;
  state: string;
};

const DEFAULT_REPO = "open-adblock/open-adblock";
const REQUIRED_LABELS = ["filter:breakage"];
const DEFAULT_LABELS = ["filter:breakage", "extension-report", "needs-triage"];
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_DETAILS_LENGTH = 2000;
const MAX_URL_LENGTH = 2000;
const MAX_DIAGNOSTICS_BYTES = 6000;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

const CATEGORY_LABELS: Record<ReportCategory, string> = {
  breakage: "Page broken",
  missed_ad: "Missed ad",
  false_positive: "Site incorrectly blocked",
  other: "Other"
};

export class ReportError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readReportRequest(request: Request): Promise<NormalizedReport> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ReportError(415, "unsupported_content_type", "Report requests must be JSON");
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new ReportError(413, "payload_too_large", "Report payload is too large");
  }

  try {
    return normalizeReportPayload(JSON.parse(raw));
  } catch (error) {
    if (error instanceof ReportError) throw error;
    throw new ReportError(400, "invalid_json", "Report payload is not valid JSON");
  }
}

export function normalizeReportPayload(payload: unknown, now = new Date()): NormalizedReport {
  if (!isRecord(payload)) {
    throw new ReportError(400, "invalid_payload", "Report payload must be an object");
  }

  const page = isRecord(payload.page) ? payload.page : {};
  const extension = isRecord(payload.extension) ? payload.extension : {};
  const privacy = isRecord(payload.privacy) ? payload.privacy : {};
  const includeUrl = privacy.includeUrl !== false;
  const url = includeUrl ? sanitizeUrl(asString(page.url)) : "";
  const hostname = normalizeHostname(asString(page.hostname) || hostnameFromUrl(url));

  if (!hostname) {
    throw new ReportError(400, "missing_hostname", "A valid hostname is required");
  }

  return {
    id: sanitizeText(asString(payload.id), 100) || crypto.randomUUID(),
    category: normalizeCategory(asString(payload.category)),
    details: sanitizeText(asString(payload.details), MAX_DETAILS_LENGTH),
    hostname,
    url,
    extensionVersion: sanitizeText(asString(extension.version), 40) || "unknown",
    userAgent: sanitizeText(asString(payload.userAgent), 200),
    reportedAt: now.toISOString(),
    diagnostics: normalizeDiagnostics(payload.diagnostics),
    screenshot: normalizeScreenshot(payload.screenshot)
  };
}

export async function createGitHubIssue(
  env: Env,
  report: NormalizedReport,
  fetcher: Fetcher = fetch
): Promise<GitHubIssue> {
  const token = env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new ReportError(500, "missing_github_token", "GITHUB_TOKEN is not configured");
  }

  const repo = normalizeRepo(env.GITHUB_REPO || DEFAULT_REPO);
  const tokenHeaders = buildGitHubHeaders(token);
  const title = buildIssueTitle(report);
  const screenshotUrl = await storeReportScreenshot(env, report);
  const reportWithScreenshot = {
    ...report,
    screenshotUrl
  };
  const existingIssue = await findExistingIssue(repo, tokenHeaders, report, fetcher);

  if (existingIssue) {
    await addGitHubIssueComment(repo, tokenHeaders, existingIssue.number, reportWithScreenshot, fetcher);
    await addGitHubIssueLabels(repo, tokenHeaders, existingIssue.number, parseLabels(env.GITHUB_LABELS), fetcher);
    let reopened = false;

    if (existingIssue.state === "closed") {
      await reopenGitHubIssue(repo, tokenHeaders, existingIssue.number, fetcher);
      reopened = true;
    }

    return {
      number: existingIssue.number,
      url: existingIssue.url,
      created: false,
      commented: true,
      reopened,
      screenshotUrl
    };
  }

  const response = await fetcher(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: tokenHeaders,
    body: JSON.stringify({
      title,
      body: buildIssueBody(reportWithScreenshot),
      labels: parseLabels(env.GITHUB_LABELS)
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ReportError(
      502,
      "github_issue_failed",
      `GitHub issue creation failed with ${response.status}: ${body.slice(0, 300)}`
    );
  }

  const issue = (await response.json()) as { number?: unknown; html_url?: unknown };
  const number = Number(issue.number);
  const url = asString(issue.html_url);

  if (!Number.isInteger(number) || !url) {
    throw new ReportError(502, "github_issue_invalid", "GitHub returned an invalid issue response");
  }

  return { number, url, created: true, commented: false, reopened: false, screenshotUrl };
}

export function getAllowedCorsOrigin(origin: string, allowedOrigins = ""): string {
  const cleanOrigin = origin.trim();
  if (!cleanOrigin) return "";

  const rules = allowedOrigins
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean);
  const effectiveRules = rules.length > 0 ? rules : ["chrome-extension://*", "moz-extension://*"];

  for (const rule of effectiveRules) {
    if (rule === "*") return "*";
    if (rule.endsWith("*") && cleanOrigin.startsWith(rule.slice(0, -1))) return cleanOrigin;
    if (rule === cleanOrigin) return cleanOrigin;
  }

  return "";
}

export function buildIssueTitle(report: NormalizedReport): string {
  return truncate(`Breakage: \`${getReportDomain(report)}\``, 120);
}

export function buildIssueBody(report: NormalizedReport): string {
  const lines = [
    "## Report",
    `- Category: ${CATEGORY_LABELS[report.category]}`,
    `- Hostname: ${report.hostname}`,
    `- URL: ${report.url || "Not included"}`,
    `- Extension version: ${report.extensionVersion}`,
    `- Reported at: ${report.reportedAt}`,
    "",
    "## Screenshot",
    report.screenshotUrl ? `![Screenshot](${report.screenshotUrl})` : screenshotFallbackText(report),
    "",
    "## Details",
    report.details || "No additional details provided.",
    "",
    "## Diagnostics",
    "```json",
    JSON.stringify(report.diagnostics, null, 2),
    "```"
  ];

  if (report.userAgent) {
    lines.splice(5, 0, `- User agent: ${report.userAgent}`);
  }

  return lines.join("\n");
}

export function buildIssueCommentBody(report: NormalizedReport): string {
  return ["## Additional report", buildIssueBody(report)].join("\n\n");
}

async function findExistingIssue(
  repo: string,
  headers: HeadersInit,
  report: NormalizedReport,
  fetcher: Fetcher
): Promise<ExistingGitHubIssue | null> {
  const title = buildIssueTitle(report);
  const domain = getReportDomain(report);
  const params = new URLSearchParams({
    q: `repo:${repo} is:issue in:title ${domain}`,
    per_page: "20"
  });
  const response = await fetcher(`https://api.github.com/search/issues?${params}`, {
    headers
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ReportError(
      502,
      "github_issue_search_failed",
      `GitHub issue search failed with ${response.status}: ${body.slice(0, 300)}`
    );
  }

  const result = (await response.json()) as {
    items?: Array<{ number?: unknown; title?: unknown; html_url?: unknown; state?: unknown }>;
  };
  const issue = (result.items || []).find((item) => asString(item.title) === title);
  if (!issue) return null;

  const number = Number(issue.number);
  const url = asString(issue.html_url);
  const state = asString(issue.state);

  if (!Number.isInteger(number) || !url) return null;

  return {
    number,
    title,
    url,
    state
  };
}

async function addGitHubIssueComment(
  repo: string,
  headers: HeadersInit,
  issueNumber: number,
  report: NormalizedReport,
  fetcher: Fetcher
): Promise<void> {
  const response = await fetcher(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      body: buildIssueCommentBody(report)
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ReportError(
      502,
      "github_issue_comment_failed",
      `GitHub issue comment failed with ${response.status}: ${body.slice(0, 300)}`
    );
  }
}

async function addGitHubIssueLabels(
  repo: string,
  headers: HeadersInit,
  issueNumber: number,
  labels: string[],
  fetcher: Fetcher
): Promise<void> {
  const response = await fetcher(`https://api.github.com/repos/${repo}/issues/${issueNumber}/labels`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      labels
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ReportError(
      502,
      "github_issue_label_failed",
      `GitHub issue label update failed with ${response.status}: ${body.slice(0, 300)}`
    );
  }
}

async function reopenGitHubIssue(
  repo: string,
  headers: HeadersInit,
  issueNumber: number,
  fetcher: Fetcher
): Promise<void> {
  const response = await fetcher(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      state: "open"
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ReportError(
      502,
      "github_issue_reopen_failed",
      `GitHub issue reopen failed with ${response.status}: ${body.slice(0, 300)}`
    );
  }
}

function buildGitHubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "openadblock-report-worker",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

async function storeReportScreenshot(env: Env, report: NormalizedReport): Promise<string> {
  if (!report.screenshot) return "";

  const bucket = env.SCREENSHOT_BUCKET;
  const publicBaseUrl = env.SCREENSHOT_PUBLIC_BASE_URL?.trim().replace(/\/+$/g, "");
  if (!bucket || !publicBaseUrl) {
    throw new ReportError(
      500,
      "missing_screenshot_storage",
      "Screenshot storage requires SCREENSHOT_BUCKET and SCREENSHOT_PUBLIC_BASE_URL"
    );
  }

  const key = [
    "screenshots",
    report.reportedAt.slice(0, 10),
    getReportDomain(report),
    `${sanitizeKeyPart(report.id)}.${report.screenshot.extension}`
  ].join("/");
  await bucket.put(key, report.screenshot.data, {
    httpMetadata: {
      contentType: report.screenshot.mimeType
    },
    customMetadata: {
      reportId: report.id,
      hostname: report.hostname
    }
  });

  return `${publicBaseUrl}/${key}`;
}

function getReportDomain(report: NormalizedReport): string {
  return report.hostname.replace(/^www\./, "");
}

function sanitizeKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 120) || crypto.randomUUID();
}

function normalizeCategory(value: string): ReportCategory {
  if (value === "missed_ad" || value === "false_positive" || value === "other") return value;
  return "breakage";
}

function normalizeRepo(value: string): string {
  const repo = value.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new ReportError(500, "invalid_github_repo", "GITHUB_REPO must be owner/repo");
  }
  return repo;
}

function parseLabels(value = ""): string[] {
  const configuredLabels = value
    .split(",")
    .map((label) => sanitizeText(label, 50))
    .filter(Boolean);
  const labels = configuredLabels.length > 0 ? configuredLabels : DEFAULT_LABELS;
  return [...new Set([...REQUIRED_LABELS, ...labels])].slice(0, 10);
}

function normalizeDiagnostics(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};

  try {
    const json = JSON.stringify(value);
    if (new TextEncoder().encode(json).byteLength <= MAX_DIAGNOSTICS_BYTES) {
      return JSON.parse(json) as Record<string, unknown>;
    }
  } catch {
    return {};
  }

  return { truncated: true };
}

function normalizeScreenshot(value: unknown): ReportScreenshot | null {
  if (!isRecord(value)) return null;

  const dataUrl = asString(value.dataUrl);
  if (!dataUrl) return null;

  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) {
    throw new ReportError(400, "invalid_screenshot", "Screenshot must be a JPEG, PNG, or WebP data URL");
  }

  const [, mimeType, base64] = match;
  const sizeBytes = estimateBase64Bytes(base64);
  if (sizeBytes > MAX_SCREENSHOT_BYTES) {
    throw new ReportError(413, "screenshot_too_large", "Screenshot payload is too large");
  }

  return {
    data: decodeBase64(base64),
    mimeType: mimeType as ReportScreenshot["mimeType"],
    extension: screenshotExtension(mimeType),
    sizeBytes
  };
}

function screenshotFallbackText(report: NormalizedReport): string {
  return report.screenshot ? "Screenshot was captured but not uploaded." : "Not included.";
}

function screenshotExtension(mimeType: string): ReportScreenshot["extension"] {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function estimateBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeHostname(value: string): string {
  const hostname = value
    .trim()
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/^\.+|\.+$/g, "")
    .replace(/[^a-z0-9.-]/g, "");
  if (!hostname || hostname.length > 253 || !hostname.includes(".")) return "";
  return hostname;
}

function hostnameFromUrl(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function sanitizeUrl(value: string): string {
  if (!value) return "";
  const trimmed = value.trim().slice(0, MAX_URL_LENGTH);
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function sanitizeText(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
