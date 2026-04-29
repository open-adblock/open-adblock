export type Env = {
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  GITHUB_LABELS?: string;
  ALLOWED_ORIGINS?: string;
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
};

export type GitHubIssue = {
  number: number;
  url: string;
};

export type Fetcher = typeof fetch;

type ReportCategory = "breakage" | "missed_ad" | "false_positive" | "other";

const DEFAULT_REPO = "open-adblock/open-adblock";
const DEFAULT_LABELS = ["extension-report", "needs-triage"];
const MAX_BODY_BYTES = 16 * 1024;
const MAX_DETAILS_LENGTH = 2000;
const MAX_URL_LENGTH = 2000;
const MAX_DIAGNOSTICS_BYTES = 6000;

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
    diagnostics: normalizeDiagnostics(payload.diagnostics)
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
  const response = await fetcher(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "openadblock-report-worker",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({
      title: buildIssueTitle(report),
      body: buildIssueBody(report),
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

  return { number, url };
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
  return truncate(`[${CATEGORY_LABELS[report.category]}] ${report.hostname}`, 120);
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
  const labels = value
    .split(",")
    .map((label) => sanitizeText(label, 50))
    .filter(Boolean);
  return (labels.length > 0 ? labels : DEFAULT_LABELS).slice(0, 10);
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
