/**
 * Resource Type Detection & Classification
 *
 * Classifies Coolify resources into user-friendly types based on available metadata.
 * Priority order ensures confident detection; ambiguous resources fall back to Unknown/Other.
 * Detection is read-only and non-destructive.
 */

export type ResourceType = "WordPress" | "Web App" | "Database" | "Service" | "Mobile App" | "Unknown/Other";

/**
 * Ordered list of all resource types — used for filter chip rendering.
 */
export const RESOURCE_TYPES: ResourceType[] = [
  "WordPress",
  "Web App",
  "Database",
  "Service",
  "Mobile App",
  "Unknown/Other"
];

export type ResourceTypeMetadata = {
  type: ResourceType;
  confidence: "high" | "medium" | "low";
  detectionReason?: string;
  hasDockerCompose?: boolean;
  hasGitRepository?: boolean;
  isDatabase?: boolean;
  isWordPress?: boolean;
};

/**
 * Detect resource type from Coolify resource metadata.
 *
 * Detection priority (highest confidence first):
 * 1. Resource type fields (resource_type, type, kind, service_type)
 * 2. Database type fields (database_type, engine, db_type)
 * 3. Docker image names (docker_registry_image_name, static_image)
 * 4. Deployment mechanism (docker_compose, git_repository)
 * 5. Free-text indicators (description, name)
 *
 * Returns "Unknown/Other" when detection cannot be confident.
 */
export function detectResourceType(resource: Record<string, unknown>): ResourceTypeMetadata {
  const evidence = flattenResourceEvidence(resource);
  const tokens = evidence.toLowerCase();
  const hasGitRepository = /git_repository:/.test(tokens);

  let wpScore = 0;
  let dbScore = 0;
  let serviceScore = 0;
  let webScore = 0;
  let mobileScore = 0;

  const wpStrong = [
    /\bwordpress\b/,
    /bitnami\/wordpress/,
    /wp-content/,
    /wp-admin/,
    /wp-json/,
    /WORDPRESS_DB_HOST/i,
    /WORDPRESS_CONFIG_EXTRA/i,
    /wp-config\.php/
  ];
  const wpMedium = [
    /\bwp[-_]/,
    /php.*apache|apache.*php/,
    /themes\/|plugins\//,
    /waterfallkeepers/i
  ];
  const dbStrong = [
    /\b(resource_type|type|kind|service_type)\b[^\n]*\b(database|postgres|mysql|mariadb|redis|mongodb)\b/,
    /\b(database_type|engine|db_type)\b[^\n]*\b(postgres|mysql|mariadb|redis|mongodb|sqlite|sqlserver)\b/,
    /postgres:\/\/|mysql:\/\//,
    /\b(postgres|mysql|mariadb|redis|mongodb):(\d+)?\b/
  ];
  const dbNameSignals = [
    /\bpostgresql-database-[a-z0-9-]+\b/,
    /\bpostgres(ql)?\b.*\bdatabase\b/,
    /\bmysql\b.*\bdatabase\b/,
    /\bmariadb\b.*\bdatabase\b/,
    /\bredis\b.*\bdatabase\b/,
    /\bpdb[_-][a-z0-9_-]+\b/
  ];
  const serviceSignals = [/docker_compose/, /compose:/, /traefik\./, /worker/, /cron/];
  const webSignals = [/git_repository/, /https?:\/\//, /domain/, /ssl/, /nextjs|react|vue|nuxt|svelte|laravel/];
  const mobileSignals = [/android|ios|react-native|expo|flutter|xcode|apk|ipa/];

  for (const pattern of wpStrong) {
    if (pattern.test(tokens)) wpScore += 4;
  }
  for (const pattern of wpMedium) {
    if (pattern.test(tokens)) wpScore += 2;
  }
  for (const pattern of dbStrong) {
    if (pattern.test(tokens)) dbScore += 4;
  }
  for (const pattern of dbNameSignals) {
    if (pattern.test(tokens)) dbScore += 2;
  }
  for (const pattern of serviceSignals) {
    if (pattern.test(tokens)) serviceScore += 2;
  }
  for (const pattern of webSignals) {
    if (pattern.test(tokens)) webScore += 2;
  }
  for (const pattern of mobileSignals) {
    if (pattern.test(tokens)) mobileScore += 3;
  }

  // WordPress app should win over incidental DB hints from linked services.
  if (wpScore >= 4 && wpScore >= dbScore) {
    return {
      type: "WordPress",
      confidence: wpScore >= 8 ? "high" : "medium",
      detectionReason: `WordPress evidence score ${wpScore} (db score ${dbScore})`,
      isWordPress: true,
      hasDockerCompose: /docker_compose/.test(tokens),
      hasGitRepository: /git_repository/.test(tokens)
    };
  }

  // Database classification is reserved for actual stateful DB resources.
  if (dbScore >= 6 && wpScore < 4 && !hasGitRepository) {
    return {
      type: "Database",
      confidence: dbScore >= 8 ? "high" : "medium",
      detectionReason: `Database evidence score ${dbScore}`,
      isDatabase: true
    };
  }

  if (mobileScore >= 4) {
    return {
      type: "Mobile App",
      confidence: mobileScore >= 6 ? "high" : "medium",
      detectionReason: `Mobile evidence score ${mobileScore}`
    };
  }

  if (serviceScore >= 4 && webScore < 4) {
    return {
      type: "Service",
      confidence: "medium",
      detectionReason: `Service evidence score ${serviceScore}`,
      hasDockerCompose: /docker_compose/.test(tokens)
    };
  }

  // Low-confidence unknowns should feel product-friendly: default to Web App.
  if (webScore > 0 || serviceScore > 0 || wpScore > 0 || dbScore > 0) {
    return {
      type: "Web App",
      confidence: "low",
      detectionReason: `Fallback Web App classification (wp=${wpScore}, db=${dbScore}, svc=${serviceScore}, web=${webScore})`,
      hasGitRepository: /git_repository/.test(tokens)
    };
  }

  return {
    type: "Web App",
    confidence: "low",
    detectionReason: "No confident metadata signals; defaulting to Web App"
  };
}

function flattenResourceEvidence(resource: Record<string, unknown>): string {
  const topLevelKeys = [
    "name",
    "application_name",
    "service_name",
    "description",
    "resource_type",
    "type",
    "kind",
    "service_type",
    "database_type",
    "engine",
    "db_type",
    "docker_registry_image_name",
    "static_image",
    "image",
    "docker_image",
    "git_repository",
    "domain",
    "domains",
    "fqdn",
    "container_labels",
    "custom_labels",
    "docker_compose",
    "docker_compose_raw",
    "environment_variables",
    "env",
    "environment"
  ];

  const chunks: string[] = [];
  for (const key of topLevelKeys) {
    const value = resource[key];
    if (typeof value === "string") {
      chunks.push(`${key}:${value}`);
      continue;
    }

    if (Array.isArray(value)) {
      chunks.push(`${key}:${value.map((item) => stringifyEvidenceValue(item)).join(" ")}`);
      continue;
    }

    if (value && typeof value === "object") {
      chunks.push(`${key}:${JSON.stringify(value)}`);
    }
  }

  return chunks.join("\n");
}

function stringifyEvidenceValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
}

function checkDatabaseType(resource: Record<string, unknown>): ResourceTypeMetadata | null {
  const dbTypePattern = /database|postgres|mysql|mariadb|redis|mongodb|elasticsearch|cassandra|couchdb|sql|sqlite|oracle|sqlserver|snowflake|bigquery/i;

  // Check explicit database type fields
  for (const field of ["database_type", "engine", "db_type", "database_engine"]) {
    const value = stringValue(resource, [field]);
    if (value && dbTypePattern.test(value)) {
      return {
        type: "Database",
        confidence: "high",
        detectionReason: `Database type detected in ${field}: ${value}`,
        isDatabase: true
      };
    }
  }

  // Check resource type fields for database indicators
  for (const field of ["resource_type", "type", "kind", "service_type"]) {
    const value = stringValue(resource, [field]);
    if (value && dbTypePattern.test(value)) {
      return {
        type: "Database",
        confidence: "high",
        detectionReason: `Database resource type detected: ${value}`,
        isDatabase: true
      };
    }
  }

  return null;
}

function checkWordPressImage(resource: Record<string, unknown>): ResourceTypeMetadata | null {
  const wpPattern = /wordpress|bitnami\/wordpress/i;

  // Check Docker image names (highest priority for WordPress)
  for (const field of ["docker_registry_image_name", "static_image", "image", "docker_image"]) {
    const value = stringValue(resource, [field]);
    if (value && wpPattern.test(value)) {
      return {
        type: "WordPress",
        confidence: "high",
        detectionReason: `WordPress image detected: ${value}`,
        isWordPress: true
      };
    }
  }

  // Check git repository URL
  const gitRepo = stringValue(resource, ["git_repository"]);
  if (gitRepo && wpPattern.test(gitRepo)) {
    return {
      type: "WordPress",
      confidence: "medium",
      detectionReason: `WordPress repository detected: ${gitRepo}`,
      isWordPress: true,
      hasGitRepository: true
    };
  }

  return null;
}

function checkDeploymentMechanism(resource: Record<string, unknown>): ResourceTypeMetadata | null {
  const hasDockerCompose = Boolean(
    stringValue(resource, ["docker_compose"]) || stringValue(resource, ["docker_compose_raw"])
  );
  const hasGitRepository = Boolean(stringValue(resource, ["git_repository"]));
  const isService = isServiceResource(resource);

  // Service (Docker Compose) + no Git = Service type
  if (hasDockerCompose && !hasGitRepository && !isService) {
    return {
      type: "Service",
      confidence: "medium",
      detectionReason: "Docker Compose service without Git repository",
      hasDockerCompose: true
    };
  }

  // Has Git repository but not a database = likely Web App
  if (hasGitRepository) {
    return {
      type: "Web App",
      confidence: "high",
      detectionReason: "Git repository detected",
      hasGitRepository: true
    };
  }

  return null;
}

function checkResourceTypeFields(resource: Record<string, unknown>): ResourceTypeMetadata | null {
  const servicePattern = /service/i;
  const appPattern = /application|app|web/i;

  for (const field of ["resource_type", "type", "kind", "service_type"]) {
    const value = stringValue(resource, [field]);
    if (!value) continue;

    if (servicePattern.test(value)) {
      return {
        type: "Service",
        confidence: "medium",
        detectionReason: `Service type detected: ${value}`
      };
    }

    if (appPattern.test(value)) {
      return {
        type: "Web App",
        confidence: "medium",
        detectionReason: `Application type detected: ${value}`
      };
    }
  }

  return null;
}

function checkFreeTextIndicators(resource: Record<string, unknown>): ResourceTypeMetadata | null {
  const wpPattern = /wordpress|wp[-_ ]|[-_ ]wp\b/i;
  const dbPattern = /database|postgres|mysql|redis|mongo/i;
  const servicePattern = /service|compose|docker/i;

  // Check description
  const description = stringValue(resource, ["description"]);
  if (description) {
    if (wpPattern.test(description)) {
      return {
        type: "WordPress",
        confidence: "low",
        detectionReason: "WordPress mentioned in description"
      };
    }
    if (dbPattern.test(description)) {
      return {
        type: "Database",
        confidence: "low",
        detectionReason: "Database mentioned in description"
      };
    }
    if (servicePattern.test(description)) {
      return {
        type: "Service",
        confidence: "low",
        detectionReason: "Service mentioned in description"
      };
    }
  }

  // Check name (least reliable)
  const name = stringValue(resource, ["name", "application_name", "service_name"]);
  if (name) {
    if (wpPattern.test(name)) {
      return {
        type: "WordPress",
        confidence: "low",
        detectionReason: "WordPress pattern in name"
      };
    }
    if (dbPattern.test(name)) {
      return {
        type: "Database",
        confidence: "low",
        detectionReason: "Database pattern in name"
      };
    }
  }

  return null;
}

/**
 * Determine if a resource is a Docker Compose service (vs a standalone application).
 * Services often have docker_compose content and may contain nested applications/databases.
 */
function isServiceResource(resource: Record<string, unknown>): boolean {
  const hasCompose = Boolean(
    stringValue(resource, ["docker_compose"]) || stringValue(resource, ["docker_compose_raw"])
  );
  const hasChildren = Boolean(
    Array.isArray(resource.applications) || Array.isArray(resource.databases)
  );
  const isComposable = stringValue(resource, ["type", "resource_type", "service_type"]).toLowerCase().includes("service");

  return hasCompose || hasChildren || isComposable;
}

/**
 * Extract string value from resource metadata, supporting multiple field names
 * and type coercion.
 */
function stringValue(obj: Record<string, unknown>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return fallback;
}

/**
 * Get display name and icon for resource type.
 */
export function getResourceTypeDisplay(type: ResourceType): {
  label: string;
  icon: string;
  color: string;
  description: string;
} {
  const displays: Record<ResourceType, ReturnType<typeof getResourceTypeDisplay>> = {
    WordPress: {
      label: "WordPress",
      icon: "🔤", // WordPress logo-ish
      color: "bg-blue-100 text-blue-900",
      description: "WordPress site"
    },
    "Web App": {
      label: "Web App",
      icon: "🌐",
      color: "bg-purple-100 text-purple-900",
      description: "Web application"
    },
    Database: {
      label: "Database",
      icon: "🗄️",
      color: "bg-orange-100 text-orange-900",
      description: "Database service"
    },
    Service: {
      label: "Service",
      icon: "⚙️",
      color: "bg-gray-100 text-gray-900",
      description: "Auxiliary service"
    },
    "Mobile App": {
      label: "Mobile App",
      icon: "📱",
      color: "bg-green-100 text-green-900",
      description: "Mobile application"
    },
    "Unknown/Other": {
      label: "Unknown",
      icon: "❓",
      color: "bg-slate-100 text-slate-900",
      description: "Unknown resource type"
    }
  };

  return displays[type];
}

/**
 * Get CSS class for type filter chip button.
 */
export function getResourceTypeFilterClass(
  type: ResourceType,
  isActive: boolean
): string {
  const display = getResourceTypeDisplay(type);
  const base = "inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium transition-colors";
  const active = `${display.color} ring-2 ring-offset-1`;
  const inactive = "bg-gray-50 text-gray-700 hover:bg-gray-100";

  return `${base} ${isActive ? active : inactive}`;
}
