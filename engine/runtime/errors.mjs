// Error classes shared by the port and its adapters, kept apart so adapters never import runtime.mjs.
export class RuntimeError extends Error {
  constructor(message, code) { super(message); this.name = new.target.name; this.code = code; }
}
export class UnknownRuntimeError extends RuntimeError {
  constructor(requested, known = []) {
    super(`unknown runtime '${requested}'; known: ${known.join(", ")}`, "unknown_runtime");
    this.requested = requested;
    this.known = known;
  }
}
export class RuntimeRequestError extends RuntimeError {
  constructor(message, field) { super(message, "bad_request"); this.field = field; }
}
export class CapabilityError extends RuntimeError {
  constructor(runtime, capability, requested) {
    super(`runtime '${runtime}' does not support ${capability} (requested ${JSON.stringify(requested)})`, "capability_missing");
    this.runtime = runtime;
    this.capability = capability;
    this.requested = requested;
  }
}
export class RuntimeConfigError extends RuntimeError {
  constructor(message, setting) { super(message, "bad_config"); this.setting = setting; }
}
