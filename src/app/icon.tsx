// The browser-tab icon: the Lineage mark as SVG, so it stays sharp at every tab size.
import { markIconSvg } from "@/components/Mark";

export const contentType = "image/svg+xml";

export default function Icon() {
  return new Response(markIconSvg(), { headers: { "Content-Type": contentType } });
}
