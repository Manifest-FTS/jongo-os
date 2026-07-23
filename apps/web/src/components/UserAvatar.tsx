"use client";

import { useEffect, useState } from "react";

type Props = {
  imageUrl?: string | null;
  initials: string;
  alt: string;
  title?: string;
  size?: number;
};

export default function UserAvatar({ imageUrl, initials, alt, title, size = 40 }: Props) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [imageUrl]);

  if (imageUrl && !failed) {
    return (
      <img
        src={imageUrl}
        alt={alt}
        title={title}
        width={size}
        height={size}
        onError={() => setFailed(true)}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderRadius: "999px",
          objectFit: "cover",
          display: "inline-block",
          background: "#eef3ee",
          border: "1px solid rgba(0, 0, 0, 0.06)"
        }}
      />
    );
  }

  return (
    <span
      className="user-avatar"
      aria-label={alt}
      title={title}
      style={{ width: `${size}px`, height: `${size}px`, fontSize: size >= 56 ? "1.1rem" : undefined }}
    >
      {initials}
    </span>
  );
}
