export type ClientRecord = {
  id: string;
  name: string;
  summary: string;
  siteIds: string[];
  members: Array<{ name: string; role: string }>;
  recentActivity: string[];
};

const clients: ClientRecord[] = [
  {
    id: "acme-co",
    name: "Acme Co",
    summary: "Marketing and demand-gen operations with weekly release cadence.",
    siteIds: ["site-main"],
    members: [
      { name: "Alex Kim", role: "Owner" },
      { name: "Priya Shah", role: "Operator" }
    ],
    recentActivity: [
      "Production deployment completed",
      "Staging sync initiated",
      "Backup policy reviewed"
    ]
  },
  {
    id: "northstar-labs",
    name: "Northstar Labs",
    summary: "Client portal operations with active staging validation before promotion.",
    siteIds: ["site-client-portal"],
    members: [
      { name: "Morgan Lee", role: "Admin" },
      { name: "Sam Rivera", role: "Viewer" }
    ],
    recentActivity: [
      "Staging environment reported degraded",
      "Deploy health check completed",
      "Member role updated"
    ]
  }
];

export function getClients(): ClientRecord[] {
  return clients;
}

export function getClientById(clientId: string): ClientRecord | undefined {
  return clients.find((client) => client.id === clientId);
}

export function getClientForSite(siteId: string): ClientRecord | undefined {
  return clients.find((client) => client.siteIds.includes(siteId));
}
