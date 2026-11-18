import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiErrorFilter } from './common/api-error.filter';
import { RateLimitGuard } from './common/rate-limit.guard';
import { AppModule } from './app.module';
import { normalizeOrigin } from './common/request-meta';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  // CORS is fail-closed: an empty CORS_ORIGIN means only APP_PUBLIC_URL is
  // allowed. It never means "allow any origin" — with credentials:true that
  // would let any site make authenticated cross-origin requests. In
  // production, having neither configured is a startup error.
  const configuredOrigins = (config.get<string>('CORS_ORIGIN') ?? '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
  const appPublicUrl = normalizeOrigin(
    config.get<string>('APP_PUBLIC_URL') ?? '',
  );
  const allowedOrigins =
    configuredOrigins.length > 0
      ? configuredOrigins
      : appPublicUrl
        ? [appPublicUrl]
        : [];
  if (
    config.get<string>('NODE_ENV') === 'production' &&
    allowedOrigins.length === 0
  ) {
    throw new Error(
      'CORS is not configured: set CORS_ORIGIN or APP_PUBLIC_URL before starting in production',
    );
  }
  const frameAncestors =
    config.get<string>('FRAME_ANCESTORS') === 'self'
      ? "'self'"
      : (config.get<string>('FRAME_ANCESTORS') ?? "'self'");
  const enableHsts = config.get<string>('ENABLE_HSTS') === 'true';

  const httpAdapter = app.getHttpAdapter().getInstance();
  httpAdapter.disable('x-powered-by');
  httpAdapter.set(
    'trust proxy',
    config.get<string>('TRUST_PROXY') ?? 'loopback, linklocal, uniquelocal',
  );

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; frame-ancestors ${frameAncestors}; base-uri 'none'; form-action 'self'`,
    );
    if (enableHsts) {
      res.setHeader(
        'Strict-Transport-Security',
        'max-age=15552000; includeSubDomains',
      );
    }
    next();
  });

  app.setGlobalPrefix('api');
  app.enableCors({
    origin(origin, callback) {
      const normalized = normalizeOrigin(origin);
      // No Origin header (same-origin / non-browser request) is fine.
      // Any other origin must be on the allowlist; an empty allowlist
      // allows nothing cross-origin.
      if (!origin || allowedOrigins.includes(normalized)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
    credentials: true,
  });
  app.useGlobalFilters(new ApiErrorFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );
  app.useGlobalGuards(new RateLimitGuard(config));

  if (config.get<string>('ENABLE_SWAGGER') === 'true') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('PicVault API')
      .setDescription('Image hosting backend API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  const port = config.get<number>('PORT') ?? 3000;
  const host = config.get<string>('HOST') ?? '127.0.0.1';

  await app.listen(port, host);
}

bootstrap();
