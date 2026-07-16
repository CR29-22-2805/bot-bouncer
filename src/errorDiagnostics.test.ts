import { getErrorDiagnostics } from "./errorDiagnostics.js";

test("error diagnostics retain standard and custom error properties", () => {
    const cause = new Error("Underlying Reddit API failure");
    const error = new Error("Could not retrieve user activity") as Error & {
        cause?: unknown;
        code?: string;
        status?: number;
        requestId?: string;
    };
    error.cause = cause;
    error.code = "REDDIT_API_ERROR";
    error.status = 403;
    error.requestId = "request-123";

    const diagnostics = getErrorDiagnostics(error);

    expect(diagnostics.name).toBe("Error");
    expect(diagnostics.message).toBe("Could not retrieve user activity");
    expect(diagnostics.code).toBe("REDDIT_API_ERROR");
    expect(diagnostics.status).toBe(403);
    expect(diagnostics.cause).toMatchObject({
        name: "Error",
        message: "Underlying Reddit API failure",
    });
    expect(diagnostics.properties.requestId).toBe("request-123");
    expect(diagnostics.properties.stack).toEqual(expect.any(String));
});

test("error diagnostics safely record circular properties", () => {
    const error = new Error("Circular error") as Error & { metadata?: unknown };
    error.metadata = { error };

    expect(getErrorDiagnostics(error).properties.metadata).toEqual({ error: "[Circular]" });
});

test("error diagnostics safely record properties with throwing getters", () => {
    const error = new Error("Getter error");
    Object.defineProperty(error, "response", {
        enumerable: true,
        get: () => {
            throw new Error("Response unavailable");
        },
    });

    expect(getErrorDiagnostics(error).properties.response).toBe("[Unable to read property: Response unavailable]");
});

test("error diagnostics handle non-Error thrown values", () => {
    expect(getErrorDiagnostics("Reddit request failed")).toEqual({
        name: "string",
        message: "Reddit request failed",
        code: undefined,
        status: undefined,
        cause: undefined,
        properties: {},
    });
});
