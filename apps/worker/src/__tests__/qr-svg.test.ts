import { describe, expect, it } from "vitest";
import QRCode from "qrcode";

describe("bundled server-side QR SVG rendering", () => {
  it("renders valid SVG without external CDN scripts or third-party APIs", async () => {
    const svg = await QRCode.toString("2@mock-whatsapp-pairing-ref,mock-noise-key,mock-ident", {
      type: "svg",
      width: 300,
      margin: 2,
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });
});
