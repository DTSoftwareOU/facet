export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'invalid_credentials'
  | 'invalid_refresh_token'
  | 'registration_closed'
  | 'not_found'
  | 'peer_offline'
  | 'email_taken'
  | 'too_large'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'email_disabled'
  | 'internal';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const errors = {
  invalid: (message: string) => new ApiError(400, 'invalid_request', message),
  unauthorized: (message = 'Sign in again to continue.') => new ApiError(401, 'unauthorized', message),
  invalidCredentials: (message = 'Email or password is incorrect.') => new ApiError(401, 'invalid_credentials', message),
  invalidRefresh: () => new ApiError(401, 'invalid_refresh_token', 'This session has ended. Sign in again.'),
  registrationClosed: () => new ApiError(403, 'registration_closed', 'This server is not accepting new accounts.'),
  notFound: (message = 'Not found.') => new ApiError(404, 'not_found', message),
  peerOffline: () => new ApiError(404, 'peer_offline', 'That device is offline.'),
  emailTaken: () => new ApiError(409, 'email_taken', 'An account with this email already exists.'),
  tooLarge: (message = 'Request is too large.') => new ApiError(413, 'too_large', message),
  quotaExceeded: () => new ApiError(413, 'quota_exceeded', 'Storage quota exceeded.'),
  rateLimited: (retryAfterSec: number) =>
    new ApiError(429, 'rate_limited', 'Too many attempts. Try again later.', { 'Retry-After': String(retryAfterSec) }),
  emailDisabled: () => new ApiError(501, 'email_disabled', 'Email is not configured on this server.'),
};
