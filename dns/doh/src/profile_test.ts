import { assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import { buildMobileConfig } from "./profile.ts";
import handler, { Env } from "./index.ts";

Deno.test("buildMobileConfig: light points at dns.open-adblock.com", () => {
  const xml = buildMobileConfig("light");
  assertStringIncludes(xml, "https://dns.open-adblock.com/dns-query");
  assertStringIncludes(xml, "com.apple.dnsSettings.managed");
  assertStringIncludes(xml, "<string>HTTPS</string>");
});

Deno.test("buildMobileConfig: pro points at pro.dns.open-adblock.com", () => {
  const xml = buildMobileConfig("pro");
  assertStringIncludes(xml, "https://pro.dns.open-adblock.com/dns-query");
});

Deno.test("buildMobileConfig: UUIDs are stable across calls", () => {
  assertEquals(buildMobileConfig("light"), buildMobileConfig("light"));
  assertEquals(buildMobileConfig("pro"), buildMobileConfig("pro"));
});

Deno.test("buildMobileConfig: light and pro differ in UUID and URL", () => {
  const light = buildMobileConfig("light");
  const pro = buildMobileConfig("pro");
  assertEquals(light === pro, false);
});

Deno.test("fetch: /light.mobileconfig serves profile", async () => {
  const env = {
    LIGHT_BIN: new Uint8Array(),
    PRO_BIN: new Uint8Array(),
  } as Env;
  const req = new Request("https://dns.open-adblock.com/light.mobileconfig");
  const resp = await handler.fetch(req, env);
  assertEquals(resp.status, 200);
  assertEquals(resp.headers.get("content-type"), "application/x-apple-aspen-config");
  assertStringIncludes(
    resp.headers.get("content-disposition") ?? "",
    "open-adblock-light.mobileconfig",
  );
  const body = await resp.text();
  assertStringIncludes(body, "https://dns.open-adblock.com/dns-query");
});

Deno.test("fetch: /pro.mobileconfig serves profile", async () => {
  const env = {
    LIGHT_BIN: new Uint8Array(),
    PRO_BIN: new Uint8Array(),
  } as Env;
  const req = new Request("https://dns.open-adblock.com/pro.mobileconfig");
  const resp = await handler.fetch(req, env);
  assertEquals(resp.status, 200);
  const body = await resp.text();
  assertStringIncludes(body, "https://pro.dns.open-adblock.com/dns-query");
});
