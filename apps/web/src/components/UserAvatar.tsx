"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  imageUrl?: string | null;
  initials: string;
  alt: string;
  title?: string;
  size?: number;
};

/**
 * Initials always render; the photo sits on top of them. Gravatar is asked
 * for a transparent image when an email has none (d=blank), so the initials
 * show through without a failed request. onError still covers an uploaded
 * avatar that no longer loads.
 */
export default function UserAvatar({ imageUrl, initials, alt, title, size = 40 }: Props) {
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    // An image that failed before hydration never reaches onError.
    const img = imgRef.current;
    setFailed(Boolean(img && img.complete && img.naturalWidth === 0));
  }, [imageUrl]);

  return (
    <span
      className="user-avatar relative overflow-hidden"
      role="img"
      aria-label={alt}
      title={title}
      style={{ width: `${size}px`, height: `${size}px`, fontSize: size >= 56 ? "1.1rem" : undefined }}
    >
      <span aria-hidden="true">{initials}</span>
      {imageUrl && !failed ? (
        <img
          ref={imgRef}
          src={imageUrl}
          alt=""
          width={size}
          height={size}
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full rounded-full object-cover"
        />
      ) : null}
    </span>
  );
}
