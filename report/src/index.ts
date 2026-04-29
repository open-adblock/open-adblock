import { Hono } from "hono";
import {
  createGitHubIssue,
  getAllowedCorsOrigin,
  readReportRequest,
  ReportError,
  type Env
} from "./report";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const origin = c.req.header("Origin") || "";
  const allowedOrigin = getAllowedCorsOrigin(origin, c.env.ALLOWED_ORIGINS);

  if (allowedOrigin) {
    c.header("Access-Control-Allow-Origin", allowedOrigin);
    c.header("Access-Control-Allow-Headers", "content-type");
    c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    c.header("Access-Control-Max-Age", "86400");
    c.header("Vary", "Origin");
  }

  if (c.req.method === "OPTIONS") {
    return c.body(null, origin && !allowedOrigin ? 403 : 204);
  }

  await next();
});

app.get("/health", (c) => c.json({ ok: true }));

app.post("/api/reports", async (c) => {
  let reportId = "";
  let hostname = "";

  try {
    const report = await readReportRequest(c.req.raw);
    reportId = report.id;
    hostname = report.hostname;
    const issue = await createGitHubIssue(c.env, report);
    return c.json({ ok: true, reportId: report.id, issue }, 201);
  } catch (error) {
    if (error instanceof ReportError) {
      console.error("Report request failed", {
        code: error.code,
        status: error.status,
        reportId,
        hostname,
        message: error.message
      });
      return c.json({ ok: false, code: error.code, error: error.message }, error.status as 400 | 413 | 415 | 500 | 502);
    }

    const message = error instanceof Error ? error.message : "Unexpected report failure";
    console.error("Unexpected report request failure", {
      reportId,
      hostname,
      message
    });
    return c.json({ ok: false, code: "unexpected_error", error: message }, 500);
  }
});

app.notFound((c) => c.json({ ok: false, code: "not_found", error: "Not found" }, 404));

export default app;
