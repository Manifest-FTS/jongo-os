"use client";

import { useRouter } from "next/navigation";

type Props = {
  organizationId: string;
};

export default function DeleteClientButton({ organizationId }: Props) {
  const router = useRouter();

  async function handleDelete() {
    const confirmed = window.confirm("Delete this client workspace? This will soft-delete the client and its apps.");
    if (!confirmed) {
      return;
    }

    const response = await fetch(`/api/organizations/${encodeURIComponent(organizationId)}`, {
      method: "DELETE"
    });

    if (!response.ok) {
      alert("Unable to delete this client right now.");
      return;
    }

    router.push("/clients");
    router.refresh();
  }

  return (
    <button type="button" className="btn btn-secondary" onClick={handleDelete}>
      Delete client
    </button>
  );
}