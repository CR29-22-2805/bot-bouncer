import { buildHackedProfileFeatureBank, getHackedProfileFeatureKeys, getHackedProfileFeatures, HackedProfileFingerprintObservation } from "./hackedProfileFingerprints.js";
import { UserFlag, UserStatus } from "./dataStore.js";
import type { UserSocialLink } from "@devvit/public-api";

function socialLink (url: string): UserSocialLink {
    return { outboundUrl: url } as UserSocialLink;
}

function observation (username: string, outcomeClass: HackedProfileFingerprintObservation["outcomeClass"], socialUrl: string, flags: UserFlag[] = []): HackedProfileFingerprintObservation {
    return {
        username,
        source: "statistics_backfill",
        observedAt: 0,
        lastUpdate: 0,
        status: outcomeClass === "organic_non_recovered" ? UserStatus.Organic : UserStatus.Banned,
        flags,
        outcomeClass,
        features: getHackedProfileFeatures({
            socialLinks: [socialLink(socialUrl)],
        }),
    };
}

test("hacked profile features normalize profile links into domains, handles, and hashes", () => {
    const features = getHackedProfileFeatures({
        bioText: "  Repeated public bio text  ",
        displayName: " Display Name ",
        socialLinks: [
            socialLink("https://www.example.com/add/Handle123?share=true"),
        ],
    });

    expect(features.bioHash).toHaveLength(64);
    expect(features.displayNameHash).toHaveLength(64);
    expect(features.socialDomains).toEqual(["example.com"]);
    expect(features.socialHandles).toEqual(["handle123"]);
    expect(features.socialLinkHashes).toHaveLength(1);
});

test("hacked profile feature keys are stable and unique", () => {
    const features = getHackedProfileFeatures({
        socialLinks: [
            socialLink("https://www.example.com/user/Handle123?share=true"),
            socialLink("https://example.com/user/Handle123"),
        ],
    });

    const keys = getHackedProfileFeatureKeys(features);

    expect(keys.filter(key => key === "socialDomain:example.com")).toHaveLength(1);
    expect(keys.filter(key => key === "socialHandle:handle123")).toHaveLength(1);
});

test("hacked profile feature bank separates recovered accounts from comparison outcomes", () => {
    const bank = buildHackedProfileFeatureBank([
        observation("recovered1", "recovered", "https://example.com/user/handle1", [UserFlag.HackedAndRecovered]),
        observation("recovered2", "recovered", "https://example.com/user/handle2", [UserFlag.HackedAndRecovered]),
        observation("organic1", "organic_non_recovered", "https://example.com/user/handle3"),
        observation("banned1", "banned_non_recovered", "https://other.example/user/handle4"),
    ]);

    expect(bank["socialDomain:example.com"].recoveredUsers).toBe(2);
    expect(bank["socialDomain:example.com"].organicNonRecoveredUsers).toBe(1);
    expect(bank["socialDomain:other.example"].bannedNonRecoveredUsers).toBe(1);
});
