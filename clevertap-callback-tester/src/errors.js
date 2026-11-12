'use strict';

/**
 * Error with a stable machine-readable code and an HTTP status for the API layer.
 * Optional extras (for example the request that was about to be sent) are copied onto the instance.
 */
class AppError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

module.exports = { AppError };
