"use client";

import { useState } from "react";

type Props = {
  src: string;
  alt?: string;
  width: number;
  height: number;
  className?: string;
  fallbackText?: string;
};

export default function BrandLogo({
  src,
  alt = "Jongo",
  width,
  height,
  className,
  fallbackText = "Jongo"
}: Props) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span className="tag" style={{ fontWeight: 700 }}>
        {fallbackText}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      onError={() => setFailed(true)}
      style={{ maxWidth: "100%", height: "auto" }}
    />
  );
}
