import React from "react";
import { parseRichMessage } from "@/lib/rich-message";

export default function RichNotificationMessage({ text }: { text: string }) {
  return (
    <>
      {parseRichMessage(text).map((block, blockIndex) => (
        <p key={blockIndex} style={{ margin: blockIndex === 0 ? 0 : "0.55rem 0 0" }}>
          {block.map((part, partIndex) => {
            if (part.type === "link") return <a key={partIndex} href={part.href} target="_blank" rel="noreferrer">{part.value}</a>;
            if (part.type === "strong") return <strong key={partIndex}>{part.value}</strong>;
            if (part.type === "emphasis") return <em key={partIndex}>{part.value}</em>;
            return part.value.split("\n").flatMap((line, lineIndex) => [
              ...(lineIndex ? [<br key={`br-${partIndex}-${lineIndex}`} />] : []),
              line
            ]);
          })}
        </p>
      ))}
    </>
  );
}