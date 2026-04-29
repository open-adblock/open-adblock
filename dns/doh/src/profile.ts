/**
 * Apple Configuration Profile (.mobileconfig) generator for iOS 14+ / macOS 11+.
 *
 * Each preset yields a single-payload profile that sets system-wide DoH.
 * UUIDs are pinned so re-installing the same preset updates the existing
 * profile instead of creating a duplicate.
 */

import type { Preset } from "./index.ts";

interface ProfileSpec {
  configUuid: string;
  dnsUuid: string;
  displayName: string;
  identifier: string;
  dnsIdentifier: string;
  serverUrl: string;
}

const SPECS: Record<Preset, ProfileSpec> = {
  light: {
    configUuid: "8D5A9B6F-2E7C-4A1D-B8F3-1C4E9A2B5D07",
    dnsUuid: "C7F2E4A8-3B9D-4E5F-A1C2-6B8D9E0F3A17",
    displayName: "open-adblock DNS (Light)",
    identifier: "com.open-adblock.dns.light",
    dnsIdentifier: "com.open-adblock.dns.light.dnssettings",
    serverUrl: "https://dns.open-adblock.com/dns-query",
  },
  pro: {
    configUuid: "4F8E3A1C-7B2D-4E9F-A5C3-8D1E2B7F6A04",
    dnsUuid: "2B6E9D4A-8C1F-4A5D-B3E7-9F2C1D8E7A06",
    displayName: "open-adblock DNS (Pro)",
    identifier: "com.open-adblock.dns.pro",
    dnsIdentifier: "com.open-adblock.dns.pro.dnssettings",
    serverUrl: "https://pro.dns.open-adblock.com/dns-query",
  },
};

const DESCRIPTION = "Blocks ads, trackers, malware, and phishing at the DNS level.";

export function buildMobileConfig(preset: Preset): string {
  const s = SPECS[preset];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>DNSSettings</key>
            <dict>
                <key>DNSProtocol</key>
                <string>HTTPS</string>
                <key>ServerURL</key>
                <string>${s.serverUrl}</string>
            </dict>
            <key>PayloadDescription</key>
            <string>Configures DNS over HTTPS.</string>
            <key>PayloadDisplayName</key>
            <string>${s.displayName}</string>
            <key>PayloadIdentifier</key>
            <string>${s.dnsIdentifier}</string>
            <key>PayloadType</key>
            <string>com.apple.dnsSettings.managed</string>
            <key>PayloadUUID</key>
            <string>${s.dnsUuid}</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
        </dict>
    </array>
    <key>PayloadDescription</key>
    <string>${DESCRIPTION}</string>
    <key>PayloadDisplayName</key>
    <string>${s.displayName}</string>
    <key>PayloadIdentifier</key>
    <string>${s.identifier}</string>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>${s.configUuid}</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>
`;
}

export function mobileConfigResponse(preset: Preset): Response {
  return new Response(buildMobileConfig(preset), {
    status: 200,
    headers: {
      "content-type": "application/x-apple-aspen-config",
      "content-disposition": `attachment; filename="open-adblock-${preset}.mobileconfig"`,
      "cache-control": "public, max-age=3600",
    },
  });
}
