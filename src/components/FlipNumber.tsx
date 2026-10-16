"use client";
// A number that settles like a split-flap board: each digit rattles briefly, left to right,
// then lands on its value. Under reduced motion it simply shows the value.
import { useEffect, useState } from "react";

export function FlipNumber({ value, delay = 0, className }: { value: string; delay?: number; className?: string }) {
  const [shown, setShown] = useState<string[]>(() => value.split("").map((c) => (/\d/.test(c) ? "0" : c)));
  const [rolling, setRolling] = useState<boolean[]>(() => value.split("").map(() => false));

  useEffect(() => {
    const chars = value.split("");
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(chars);
      setRolling(chars.map(() => false));
      return;
    }
    const start = performance.now() + delay;
    const settleAt = chars.map((_, i) => 380 + i * 140);
    let raf = 0;
    const tick = (now: number) => {
      const t = now - start;
      if (t < 0) {
        raf = requestAnimationFrame(tick);
        return;
      }
      setShown(chars.map((c, i) => (!/\d/.test(c) || t >= settleAt[i] ? c : String(Math.floor(Math.random() * 10)))));
      setRolling(chars.map((c, i) => /\d/.test(c) && t < settleAt[i]));
      if (t < settleAt[settleAt.length - 1]) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, delay]);

  return (
    <span className={`flip num ${className ?? ""}`} aria-label={value}>
      {shown.map((c, i) => (
        <span key={i} aria-hidden className={rolling[i] ? "rolling" : undefined}>{c}</span>
      ))}
    </span>
  );
}
