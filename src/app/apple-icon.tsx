// The home-screen / bookmark icon for Apple devices, which need a PNG: the same mark, rasterised.
import { ImageResponse } from "next/og";
import { markIconSvg } from "@/components/Mark";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  const src = `data:image/svg+xml;base64,${Buffer.from(markIconSvg()).toString("base64")}`;
  return new ImageResponse(<img src={src} width={size.width} height={size.height} alt="" />, size);
}
