export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code: string, message?: string, details?: Record<string, unknown>) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Forbidden') => new AppError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message?: string, details?: Record<string, unknown>) => new AppError(409, code, message, details);
/** 402 with an upgrade hint — the spec's "Payment Required" response. */
export const paymentRequired = (code: string, message: string, details?: Record<string, unknown>) => new AppError(402, code, message, details);
