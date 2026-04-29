import { describe, expect, it } from "vitest";

import {
  buildIssueBody,
  buildIssueTitle,
  createGitHubIssue,
  getAllowedCorsOrigin,
  normalizeReportPayload,
  ReportError
} from "../src/report";

describe("normalizeReportPayload", () => {
  it("normalizes a valid extension report", () => {
    const report = normalizeReportPayload(
      {
        id: "abc",
        category: "missed_ad",
        details: "Banner remains visible",
        page: {
          url: "https://example.com/path?x=1",
          hostname: "example.com"
        },
        extension: { version: "0.1.0" },
        diagnostics: { pageBlocked: 4 }
      },
      new Date("2026-04-29T12:00:00.000Z")
    );

    expect(report).toMatchObject({
      id: "abc",
      category: "missed_ad",
      hostname: "example.com",
      url: "https://example.com/path?x=1",
      extensionVersion: "0.1.0",
      reportedAt: "2026-04-29T12:00:00.000Z",
      diagnostics: { pageBlocked: 4 }
    });
  });

  it("can omit the URL while keeping the hostname", () => {
    const report = normalizeReportPayload({
      category: "breakage",
      page: { url: "https://example.com/private", hostname: "example.com" },
      privacy: { includeUrl: false }
    });

    expect(report.url).toBe("");
    expect(report.hostname).toBe("example.com");
  });

  it("rejects reports without a hostname", () => {
    expect(() => normalizeReportPayload({ page: { url: "not a url" } })).toThrow(ReportError);
  });
});

describe("createGitHubIssue", () => {
  it("posts a formatted issue to GitHub", async () => {
    const report = normalizeReportPayload({
      category: "false_positive",
      details: "Checkout is blocked",
      page: { url: "https://shop.example/checkout", hostname: "shop.example" },
      extension: { version: "0.1.0" }
    });
    const calls: Request[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return Response.json({ number: 42, html_url: "https://github.com/open-adblock/open-adblock/issues/42" });
    };

    const issue = await createGitHubIssue(
      {
        GITHUB_TOKEN: "token",
        GITHUB_REPO: "open-adblock/open-adblock",
        GITHUB_LABELS: "extension-report,needs-triage"
      },
      report,
      fetcher as typeof fetch
    );

    expect(issue.number).toBe(42);
    expect(calls[0].url).toBe("https://api.github.com/repos/open-adblock/open-adblock/issues");
    expect(await calls[0].json()).toMatchObject({
      title: "[Site incorrectly blocked] shop.example",
      labels: ["extension-report", "needs-triage"]
    });
  });
});

describe("GitHub issue formatting", () => {
  it("includes public report fields and diagnostics", () => {
    const report = normalizeReportPayload({
      category: "breakage",
      details: "Video controls disappear",
      page: { url: "https://video.example/watch", hostname: "video.example" },
      diagnostics: { pageBlocked: 9 }
    });

    expect(buildIssueTitle(report)).toBe("[Page broken] video.example");
    expect(buildIssueBody(report)).toContain("Video controls disappear");
    expect(buildIssueBody(report)).toContain('"pageBlocked": 9');
  });
});

describe("getAllowedCorsOrigin", () => {
  it("allows extension origins by wildcard", () => {
    expect(getAllowedCorsOrigin("chrome-extension://abc", "chrome-extension://*")).toBe("chrome-extension://abc");
  });

  it("rejects unlisted web origins", () => {
    expect(getAllowedCorsOrigin("https://example.com", "chrome-extension://*")).toBe("");
  });
});
