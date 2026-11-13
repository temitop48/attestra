"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function ScrollReveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.classList.add("reveal-enabled");
    if (!("IntersectionObserver" in window)) {
      element.classList.add("is-visible");
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      element.classList.add("is-visible");
      observer.disconnect();
    }, { threshold: 0.12, rootMargin: "0px 0px -40px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div ref={ref} className={`scroll-reveal ${className}`.trim()}>{children}</div>;
}
