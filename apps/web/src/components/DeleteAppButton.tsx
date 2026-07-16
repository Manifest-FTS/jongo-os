"use client";

import { useRouter } from "next/navigation";

type Props = {
  siteId: string;
};

export default function DeleteAppButton({ siteId }: Props) {
  const router = useRouter();

  async function handleDelete() {
    const confirmed = window.confirm("Delete this app? This will soft-delete the Jongo app record.");
    if (!confirmed) {
      return;
    }

    const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}`, {
      method: "DELETE"
    });

    if (!response.ok) {
      alert("Unable to delete this app right now.");
      return;
    }

    router.refresh();
  }

  return (
    <button type="button" className="btn btn-secondary" onClick={handleDelete}>
      Remove
    </button>
  );
}