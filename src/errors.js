export class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class ConfigurationError extends AppError {
  constructor(message) {
    super("CONFIGURATION_ERROR", message);
  }
}

export class QueueFullError extends AppError {
  constructor() {
    super("QUEUE_FULL", "A fila atingiu o limite configurado.");
  }
}

export class OperatorInterventionError extends AppError {}

export class PromobankAutomationError extends AppError {}
