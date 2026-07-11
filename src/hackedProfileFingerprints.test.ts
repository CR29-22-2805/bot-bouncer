import {
    buildHackedProfileFeatureBank,
    getHackedProfileFeatureKeys,
    getHackedProfileFingerprintStoreKeys,
    getHackedProfileFeatures,
    getHackedProfileSampleSizes,
    getHackedProfileSummaryMatch,
    HACKED_PROFILE_FINGERPRINT_ACTIVE_VERSION_STORE,
    parseHackedProfileFeatureBankRecord,
    publishHackedProfileFingerprintSnapshot,
} from "./hackedProfileFingerprints.js";
import type {
    HackedProfileFeatureBankRecord,
    HackedProfileFingerprintMetadata,
    HackedProfileFingerprintObservation,
} from "./hackedProfileFingerprints.js";
import { UserFlag, UserStatus } from "./dataStore.js";
import type { InitialAccountProperties } from "./dataStore.js";
import type { RedisClient, UserSocialLink } from "@devvit/public-api";

function socialLink (url: string): UserSocialLink {
    return { outboundUrl: url } as UserSocialLink;
}

function observation (
    username: string,
    outcomeClass: HackedProfileFingerprintObservation["outcomeClass"],
    profile: InitialAccountProperties,
    flags: UserFlag[] = [],
): HackedProfileFingerprintObservation {
    return {
        username,
        source: "statistics_backfill",
        observedAt: 0,
        lastUpdate: 0,
        status: outcomeClass === "organic_non_recovered" ? UserStatus.Organic : UserStatus.Banned,
        flags,
        outcomeClass,
        features: getHackedProfileFeatures(profile),
    };
}

function linkedProfile (url: string): InitialAccountProperties {
    return {
        socialLinks: [socialLink(url)],
    };
}

function recordsForFeatures (
    bank: Record<string, HackedProfileFeatureBankRecord>,
    features: HackedProfileFingerprintObservation["features"],
): HackedProfileFeatureBankRecord[] {
    return getHackedProfileFeatureKeys(features)
        .map(key => bank[key])
        .filter((record): record is HackedProfileFeatureBankRecord => Boolean(record));
}

test("hacked profile features normalize and hash public profile values", () => {
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
    expect(features.socialHandleHashes).toHaveLength(1);
    expect(features.socialHandleHashes[0]).toHaveLength(64);
    expect(features.socialLinkHashes).toHaveLength(1);
});

test("generic social domains are excluded while exact handles and links remain hashed", () => {
    const features = getHackedProfileFeatures(linkedProfile("https://www.instagram.com/Handle123"));

    expect(features.socialDomains).toEqual([]);
    expect(features.socialHandleHashes).toHaveLength(1);
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
    expect(keys.filter(key => key.startsWith("socialHandleHash:"))).toHaveLength(1);
});

test("hacked profile feature bank separates recovered accounts from comparison outcomes", () => {
    const bank = buildHackedProfileFeatureBank([
        observation("recovered1", "recovered", linkedProfile("https://example.com/user/handle1"), [UserFlag.HackedAndRecovered]),
        observation("recovered2", "recovered", linkedProfile("https://example.com/user/handle2"), [UserFlag.HackedAndRecovered]),
        observation("organic1", "organic_non_recovered", linkedProfile("https://example.com/user/handle3")),
        observation("banned1", "banned_non_recovered", linkedProfile("https://other.example/user/handle4")),
    ]);

    expect(bank["socialDomain:example.com"].recoveredUsers).toBe(2);
    expect(bank["socialDomain:example.com"].organicNonRecoveredUsers).toBe(1);
    expect(bank["socialDomain:other.example"].bannedNonRecoveredUsers).toBe(1);
});

test("summary matching excludes the account's own contribution", () => {
    const sharedProfile = linkedProfile("https://evidence.example/user/shared-handle");
    const observations = [
        observation("recovered1", "recovered", sharedProfile, [UserFlag.HackedAndRecovered]),
        observation("recovered2", "recovered", sharedProfile, [UserFlag.HackedAndRecovered]),
        observation("organic1", "organic_non_recovered", linkedProfile("https://other.example/user/other-handle")),
    ];
    const bank = buildHackedProfileFeatureBank(observations);
    const records = recordsForFeatures(bank, observations[0].features);
    const sampleSizes = getHackedProfileSampleSizes(observations);

    expect(getHackedProfileSummaryMatch(records, sampleSizes)).toBeDefined();
    expect(getHackedProfileSummaryMatch(records, sampleSizes, observations[0])).toBeUndefined();
});

test("a social-domain match alone cannot exceed weak confidence", () => {
    const record = {
        featureKey: "socialDomain:evidence.example",
        featureType: "socialDomain" as const,
        featureValue: "evidence.example",
        recoveredUsers: 5,
        organicNonRecoveredUsers: 0,
        bannedNonRecoveredUsers: 0,
        scammedUsers: 0,
        otherUsers: 0,
        lastSeen: 0,
        exampleRecoveredUsers: [],
        exampleOrganicUsers: [],
        exampleBannedUsers: [],
        exampleScammedUsers: [],
    };

    const result = getHackedProfileSummaryMatch([record], {
        recovered: 50,
        organicNonRecovered: 50,
        bannedNonRecovered: 50,
        scammed: 50,
        other: 0,
    });

    expect(result?.confidence).toBe("weak");
});

test("strong summary confidence requires distinct non-domain feature types", () => {
    const profile = {
        bioText: "shared recovered profile",
        socialLinks: [socialLink("https://evidence.example/user/shared-handle")],
    };
    const observations = Array.from({ length: 5 }, (_, index) => (
        observation(`recovered${index}`, "recovered", profile, [UserFlag.HackedAndRecovered])
    ));
    const bank = buildHackedProfileFeatureBank(observations);
    const records = recordsForFeatures(bank, observations[0].features);

    const result = getHackedProfileSummaryMatch(records, getHackedProfileSampleSizes(observations));

    expect(result?.confidence).toBe("strong");
    expect(new Set(result?.matches.map(match => match.record.featureType)).size).toBeGreaterThanOrEqual(2);
});

test("confidence uses class prevalence rather than raw counts", () => {
    const record = {
        featureKey: "socialLinkHash:abc",
        featureType: "socialLinkHash" as const,
        featureValue: "abc",
        recoveredUsers: 5,
        organicNonRecoveredUsers: 5,
        bannedNonRecoveredUsers: 0,
        scammedUsers: 0,
        otherUsers: 0,
        lastSeen: 0,
        exampleRecoveredUsers: [],
        exampleOrganicUsers: [],
        exampleBannedUsers: [],
        exampleScammedUsers: [],
    };

    const result = getHackedProfileSummaryMatch([record], {
        recovered: 50,
        organicNonRecovered: 10,
        bannedNonRecovered: 50,
        scammed: 0,
        other: 0,
    });

    expect(result).toBeUndefined();
});

test("malformed feature bank records are rejected", () => {
    expect(parseHackedProfileFeatureBankRecord("{not-json")).toBeUndefined();
    expect(parseHackedProfileFeatureBankRecord(JSON.stringify({
        featureKey: "socialLinkHash:abc",
        featureType: "socialLinkHash",
        featureValue: "abc",
        recoveredUsers: -1,
    }))).toBeUndefined();
});

test("snapshot publication preserves the active version when replacement fails", async () => {
    const strings = new Map<string, string>();
    const hashes = new Map<string, Record<string, string>>();
    let failActiveVersionWrite = false;

    const redis = {
        get: (key: string) => Promise.resolve(strings.get(key)),
        set: (key: string, value: string) => {
            if (failActiveVersionWrite && key === HACKED_PROFILE_FINGERPRINT_ACTIVE_VERSION_STORE) {
                return Promise.reject(new Error("active-version write failed"));
            }
            strings.set(key, value);
            return Promise.resolve();
        },
        del: (...keys: string[]) => {
            for (const key of keys) {
                strings.delete(key);
                hashes.delete(key);
            }
            return Promise.resolve(keys.length);
        },
        hSet: (key: string, values: Record<string, string>) => {
            hashes.set(key, { ...(hashes.get(key) ?? {}), ...values });
            return Promise.resolve(Object.keys(values).length);
        },
    } as unknown as RedisClient;

    const observations = [
        observation("recovered1", "recovered", linkedProfile("https://evidence.example/user/shared"), [UserFlag.HackedAndRecovered]),
        observation("recovered2", "recovered", linkedProfile("https://evidence.example/user/shared"), [UserFlag.HackedAndRecovered]),
    ];
    const bank = buildHackedProfileFeatureBank(observations);
    const metadata: HackedProfileFingerprintMetadata = {
        generatedAt: 1,
        observationCount: observations.length,
        sampleSizes: getHackedProfileSampleSizes(observations),
    };

    await publishHackedProfileFingerprintSnapshot(redis, observations, bank, metadata, "v1");
    failActiveVersionWrite = true;

    await expect(publishHackedProfileFingerprintSnapshot(redis, observations, bank, metadata, "v2")).rejects.toThrow("active-version write failed");

    expect(strings.get(HACKED_PROFILE_FINGERPRINT_ACTIVE_VERSION_STORE)).toBe("v1");
    expect(hashes.has(getHackedProfileFingerprintStoreKeys("v1").featureBank)).toBe(true);
    expect(hashes.has(getHackedProfileFingerprintStoreKeys("v2").featureBank)).toBe(false);
});
