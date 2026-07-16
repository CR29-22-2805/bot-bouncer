export interface ErrorDiagnostics {
    name: unknown;
    message: unknown;
    code: unknown;
    status: unknown;
    cause: unknown;
    properties: Record<string, unknown>;
}

const PRIMARY_ERROR_PROPERTIES = new Set<PropertyKey>(["name", "message", "code", "status", "cause"]);

function propertyReadFailure (error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return `[Unable to read property: ${message}]`;
}

function readProperty (value: object, property: PropertyKey): unknown {
    try {
        return Reflect.get(value, property);
    } catch (error) {
        return propertyReadFailure(error);
    }
}

function propertyNameForLog (property: PropertyKey): string {
    return String(property);
}

function sanitizeForLogging (value: unknown, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined) {
        return value;
    }

    if (typeof value === "bigint") {
        return value.toString();
    }

    if (typeof value === "symbol" || typeof value === "function") {
        return String(value);
    }

    if (typeof value !== "object") {
        return value;
    }

    if (seen.has(value)) {
        return "[Circular]";
    }
    seen.add(value);

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
    }

    if (value instanceof Error) {
        return buildErrorDiagnostics(value, seen);
    }

    if (Array.isArray(value)) {
        return value.map(item => sanitizeForLogging(item, seen));
    }

    const sanitized: Record<string, unknown> = {};
    for (const property of Reflect.ownKeys(value)) {
        sanitized[propertyNameForLog(property)] = sanitizeForLogging(readProperty(value, property), seen);
    }
    return sanitized;
}

function buildErrorDiagnostics (error: object, seen: WeakSet<object>): ErrorDiagnostics {
    const properties: Record<string, unknown> = {};

    for (const property of Reflect.ownKeys(error)) {
        if (PRIMARY_ERROR_PROPERTIES.has(property)) {
            continue;
        }
        properties[propertyNameForLog(property)] = sanitizeForLogging(readProperty(error, property), seen);
    }

    return {
        name: sanitizeForLogging(readProperty(error, "name"), seen),
        message: sanitizeForLogging(readProperty(error, "message"), seen),
        code: sanitizeForLogging(readProperty(error, "code"), seen),
        status: sanitizeForLogging(readProperty(error, "status"), seen),
        cause: sanitizeForLogging(readProperty(error, "cause"), seen),
        properties,
    };
}

export function getErrorDiagnostics (error: unknown): ErrorDiagnostics {
    if (typeof error === "object" && error !== null) {
        const seen = new WeakSet();
        seen.add(error);
        return buildErrorDiagnostics(error, seen);
    }

    return {
        name: typeof error,
        message: String(error),
        code: undefined,
        status: undefined,
        cause: undefined,
        properties: {},
    };
}
