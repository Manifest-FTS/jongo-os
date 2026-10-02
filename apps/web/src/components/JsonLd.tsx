/**
 * Structured data for search engines and AI assistants.
 *
 * "<" is escaped so content can never close the script tag early (a plan
 * description or FAQ answer containing "</script>" would otherwise break out).
 */
export default function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}
