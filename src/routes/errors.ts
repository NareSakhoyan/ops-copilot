export class HttpError extends Error {
  constructor(public readonly statusCode: 400 | 403 | 404 | 409 | 410 | 422 | 503 | 504, message: string) {
    super(message);
  }
}
