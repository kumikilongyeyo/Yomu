export {};

declare global {
  interface Request {
    /** Cloudflare's current types return unknown; route handlers validate/cast the payload immediately. */
    json<T = any>(): Promise<T>;
  }
}
