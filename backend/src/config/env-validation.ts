/**
 * Startup environment validation (fail fast).
 *
 * Runs via `ConfigModule.forRoot({ validate })` in AppModule, so a bad or
 * placeholder configuration aborts boot with a clear message instead of
 * silently running insecure. Only the values that are security-relevant are
 * checked here; feature defaults keep working when a variable is absent.
 */

const PLACEHOLDER_PASSWORDS = new Set([
  'change-this-postgres-password',
  'change-this-password',
  'changeme',
  'change-me',
  'change_me',
  'password',
  'password123',
  '123456',
  'admin',
  'picvault',
]);

const PLACEHOLDER_PATTERNS = [
  /change-this/i,
  /change-me/i,
  /changeme/i,
  /replace-with-/i,
  /your-.*-here/i,
  /example\.com/i,
];

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_PASSWORDS.has(trimmed.toLowerCase())) return true;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function assertHttpUrl(value: string, key: string, errors: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    errors.push(`${key} must be a valid URL (got "${value}")`);
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    errors.push(`${key} must use http:// or https:// (got "${value}")`);
  }
}

function assertPort(value: string, key: string, errors: string[]): void {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(
      `${key} must be a TCP port between 1 and 65535 (got "${value}")`,
    );
  }
}

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = [];
  const get = (key: string): string | undefined => {
    const value = config[key];
    return typeof value === 'string' ? value.trim() : undefined;
  };
  const nodeEnv = get('NODE_ENV') ?? 'development';
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  // --- Database: required, and never a placeholder password. ---
  const databaseUrl = get('DATABASE_URL');
  if (!databaseUrl) {
    if (!isTest) errors.push('DATABASE_URL is required');
  } else {
    let parsed: URL | undefined;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      errors.push('DATABASE_URL must be a valid URL');
    }
    if (parsed) {
      if (
        parsed.protocol !== 'postgres:' &&
        parsed.protocol !== 'postgresql:'
      ) {
        errors.push(
          `DATABASE_URL must use the postgres:// scheme (got "${parsed.protocol}")`,
        );
      }
      const password = decodeURIComponent(parsed.password ?? '');
      if (!password) {
        errors.push('DATABASE_URL must include a password');
      } else if (isPlaceholder(password)) {
        errors.push(
          'DATABASE_URL uses a placeholder/default password; set a strong, unique POSTGRES_PASSWORD',
        );
      }
    }
  }

  const postgresPassword = get('POSTGRES_PASSWORD');
  if (postgresPassword && isPlaceholder(postgresPassword)) {
    errors.push(
      'POSTGRES_PASSWORD is a placeholder/default value; set a strong, unique password',
    );
  }

  // --- Stored secrets: reject the documented example placeholders. ---
  for (const key of [
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'SMTP_PASSWORD',
    'TELEGRAM_BOT_TOKEN',
  ]) {
    const value = get(key);
    if (value && isPlaceholder(value)) {
      errors.push(
        `${key} is a placeholder value; set the real credential or leave it empty`,
      );
    }
  }

  // --- Public URL: required in production, valid URL everywhere it is set. ---
  const appPublicUrl = get('APP_PUBLIC_URL');
  if (isProduction && !appPublicUrl) {
    errors.push(
      'APP_PUBLIC_URL is required in production (password-reset links and CORS fall back to it)',
    );
  }
  if (appPublicUrl) {
    assertHttpUrl(appPublicUrl, 'APP_PUBLIC_URL', errors);
    if (isProduction) {
      try {
        const parsed = new URL(appPublicUrl);
        // Domain names must use https in production (password-reset links
        // and cookies must not travel in cleartext). IP literals and
        // localhost are exempt: a fresh VPS install has no domain or TLS
        // yet, and install.sh detects an http://<IP> URL for it. Using
        // https there would only pretend to be secure. Operators should
        // still put a reverse proxy with TLS in front (see ops/) as soon
        // as they have a domain.
        const host = parsed.hostname;
        const isIpLiteral =
          /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
          host === 'localhost' ||
          host === '[::1]' ||
          host === '::1' ||
          host.includes(':');
        if (parsed.protocol !== 'https:' && !isIpLiteral) {
          errors.push('APP_PUBLIC_URL must use https:// in production');
        }
      } catch {
        // Already reported by assertHttpUrl.
      }
    }
  }

  // --- CORS origins must be valid http(s) origins. ---
  const corsOrigin = get('CORS_ORIGIN');
  if (corsOrigin) {
    for (const origin of corsOrigin.split(',')) {
      const trimmed = origin.trim();
      if (trimmed) assertHttpUrl(trimmed, 'CORS_ORIGIN', errors);
    }
  }

  // --- Numeric / format checks. ---
  const port = get('PORT');
  if (port) assertPort(port, 'PORT', errors);
  const redisPort = get('REDIS_PORT');
  if (redisPort) assertPort(redisPort, 'REDIS_PORT', errors);
  const tokenExpiresIn = get('TOKEN_EXPIRES_IN');
  if (tokenExpiresIn && !/^\d+[smhd]$/.test(tokenExpiresIn)) {
    errors.push(
      `TOKEN_EXPIRES_IN must look like "7d", "12h" or "30m" (got "${tokenExpiresIn}")`,
    );
  }
  const host = get('HOST');
  if (host !== undefined && !host) {
    errors.push('HOST must not be empty when set');
  }

  if (errors.length) {
    throw new Error(
      `Invalid environment configuration:\n- ${errors.join('\n- ')}`,
    );
  }

  return config;
}
