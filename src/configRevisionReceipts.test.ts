import { getChangedVariableKeys } from "./configRevisionReceipts.js";

test("getChangedVariableKeys reports added, changed, and removed variables", () => {
    const existingVariables = {
        "biotext:unchanged": JSON.stringify(["same"]),
        "definedhandles:changed": JSON.stringify(["old"]),
        "sociallinks:removed": JSON.stringify(["removed"]),
    };

    const nextVariables = {
        "biotext:unchanged": JSON.stringify(["same"]),
        "definedhandles:changed": JSON.stringify(["new"]),
        "badusername:added": JSON.stringify(["added"]),
    };

    const result = getChangedVariableKeys(existingVariables, nextVariables);

    expect(result).toEqual([
        "badusername:added",
        "definedhandles:changed",
        "sociallinks:removed",
    ]);
});

test("getChangedVariableKeys returns no keys when variables are unchanged", () => {
    const variables = {
        "biotext:example": JSON.stringify(["same"]),
    };

    expect(getChangedVariableKeys(variables, { ...variables })).toEqual([]);
});
