import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RateLimitGuard } from './rate-limit.guard';

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const RedisMock = Redis as unknown as jest.Mock;


function context() {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        ip: '203.0.113.9',
        method: 'GET',
        path: '/api/images',
        route: { path: '/images' },
        headers: {},
      }),
    }),
  } as never;
}

describe('RateLimitGuard', () => {
  const evalMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    RedisMock.mockImplementation(
      () =>
        ({
          status: 'ready',
          eval: evalMock,
        }) as unknown as Redis,
    );
  });

  it('allows a request below the configured limit', async () => {
    evalMock.mockResolvedValue(2);
    const config = {
      get: jest.fn((key: string) =>
        key === 'RATE_LIMIT_MAX' ? 3 : key === 'REDIS_PORT' ? 6379 : undefined,
      ),
    } as unknown as ConfigService;
    const guard = new RateLimitGuard(config);

    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(evalMock).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'rate-limit:203.0.113.9:GET:/images',
      '60000',
    );
  });

  it('rejects a request above the configured limit', async () => {
    evalMock.mockResolvedValue(4);
    const config = {
      get: jest.fn((key: string) =>
        key === 'RATE_LIMIT_MAX' ? 3 : key === 'REDIS_PORT' ? 6379 : undefined,
      ),
    } as unknown as ConfigService;
    const guard = new RateLimitGuard(config);

    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});
