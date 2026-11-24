import { renderSVG } from "./vendor/uqr";

/** The setup QR code as an SVG string. Medium error correction, quiet border. */
export function qrSvg(text: string): string {
  return renderSVG(text, { ecc: "M", border: 2, pixelSize: 6 }) as string;
}
