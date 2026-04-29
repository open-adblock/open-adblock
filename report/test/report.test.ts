import { describe, expect, it } from "vitest";

import {
  buildIssueBody,
  buildIssueCommentBody,
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
  it("creates a formatted issue when no domain issue exists", async () => {
    const report = normalizeReportPayload({
      category: "false_positive",
      details: "Checkout is blocked",
      page: { url: "https://shop.example/checkout", hostname: "shop.example" },
      extension: { version: "0.1.0" }
    });
    const calls: Request[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      if (calls.length === 1) {
        return Response.json({ items: [] });
      }
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
    expect(issue).toMatchObject({ created: true, commented: false, reopened: false });
    expect(calls[0].url).toContain("https://api.github.com/search/issues?");
    expect(calls[1].url).toBe("https://api.github.com/repos/open-adblock/open-adblock/issues");
    expect(await calls[1].json()).toMatchObject({
      title: "Breakage: `shop.example`",
      labels: ["extension-report", "needs-triage"]
    });
  });

  it("adds a comment when the domain issue already exists", async () => {
    const report = normalizeReportPayload({
      category: "breakage",
      details: "Video controls disappear",
      page: { url: "https://video.example/watch", hostname: "video.example" }
    });
    const calls: Request[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      if (calls.length === 1) {
        return Response.json({
          items: [
            {
              number: 17,
              title: "Breakage: `video.example`",
              html_url: "https://github.com/open-adblock/open-adblock/issues/17",
              state: "open"
            }
          ]
        });
      }
      return Response.json({ id: 100 });
    };

    const issue = await createGitHubIssue({ GITHUB_TOKEN: "token" }, report, fetcher as typeof fetch);

    expect(issue).toMatchObject({ number: 17, created: false, commented: true, reopened: false });
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://api.github.com/repos/open-adblock/open-adblock/issues/17/comments");
    expect(await calls[1].json()).toMatchObject({
      body: expect.stringContaining("## Additional report")
    });
  });

  it("reopens a closed domain issue after commenting", async () => {
    const report = normalizeReportPayload({
      category: "breakage",
      details: "The page is blank",
      page: { url: "https://news.example/", hostname: "news.example" }
    });
    const calls: Request[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      if (calls.length === 1) {
        return Response.json({
          items: [
            {
              number: 28,
              title: "Breakage: `news.example`",
              html_url: "https://github.com/open-adblock/open-adblock/issues/28",
              state: "closed"
            }
          ]
        });
      }
      return Response.json({});
    };

    const issue = await createGitHubIssue({ GITHUB_TOKEN: "token" }, report, fetcher as typeof fetch);

    expect(issue).toMatchObject({ number: 28, created: false, commented: true, reopened: true });
    expect(calls).toHaveLength(3);
    expect(calls[1].url).toBe("https://api.github.com/repos/open-adblock/open-adblock/issues/28/comments");
    expect(calls[2].url).toBe("https://api.github.com/repos/open-adblock/open-adblock/issues/28");
    expect(await calls[2].json()).toEqual({ state: "open" });
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

    expect(buildIssueTitle(report)).toBe("Breakage: `video.example`");
    expect(buildIssueBody(report)).toContain("Video controls disappear");
    expect(buildIssueBody(report)).toContain('"pageBlocked": 9');
    expect(buildIssueCommentBody(report)).toContain("## Additional report");
  });

  it("deduplicates www hostnames under the bare domain title", () => {
    const report = normalizeReportPayload({
      category: "breakage",
      page: { url: "https://www.example.com/", hostname: "www.example.com" }
    });

    expect(buildIssueTitle(report)).toBe("Breakage: `example.com`");
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
