#!/usr/bin/env -S deno run --allow-net --allow-write=docs
// Generate install-link QR codes as static SVGs for README embedding.
// Run once; commit the output. Re-run if the install URLs change.

import QRCode from "qrcode";

const TARGETS = [
  { out: "docs/qr-light.svg", url: "https://dns.open-adblock.com/light.mobileconfig" },
  { out: "docs/qr-pro.svg", url: "https://pro.dns.open-adblock.com/pro.mobileconfig" },
];

await Deno.mkdir("docs", { recursive: true });
for (const { out, url } of TARGETS) {
  const svg = await QRCode.toString(url, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320,
  });
  await Deno.writeTextFile(out, svg);
  console.log(`wrote ${out}`);
}
