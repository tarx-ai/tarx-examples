const CONNECTOR_UID_PATTERN = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._-]*$/i;

export function requireConnectorUid(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required. Copy .env.example and set a Vercel Connect connector UID.`);
  }

  if (!CONNECTOR_UID_PATTERN.test(value)) {
    throw new Error(`${name} must look like provider/connector-name.`);
  }

  return value;
}
