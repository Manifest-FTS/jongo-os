"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

type Props = {
  intervalMs?: number;
};

export default function PageAutoRefresh({ intervalMs = 15000 }: Props) {
  const router = useRouter();

  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }

      router.refresh();
    };

    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, router]);

  return null;
}
