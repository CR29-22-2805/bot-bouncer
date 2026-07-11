import { WikiPagePermissionLevel } from "@devvit/public-api";
import type { JobContext, RedisClient, TriggerContext, UserSocialLink } from "@devvit/public-api";
import { format, subDays } from "date-fns";
import json2md from "json2md";
import _ from "lodash";
import crypto from "crypto";
import { getInitialAccountProperties, getInitialAccountPropertiesForUsers, UserFlag, UserStatus } from "./dataStore.js";
import type { InitialAccountProperties, UserDetails } from "./dataStore.js";
import { domainFromUrl } from "./utility.js";
import { hSetChunked } from "./redisHelper.js";
import type { StatsUserEntry } from "./scheduler/sixHourlyJobs.js";
import { userIsBanned } from "./statistics/statsHelpers.js";

export const HACKED_PROFILE_FINGERPRINT_OBSERVATION_STORE = "HackedProfileFingerprintObservations";
export const HACKED_PROFILE_FINGERPRINT_FEATURE_BANK_STORE = "HackedProfileFingerprintFeatureBank";
export const HACKED_PROFILE_FINGERPRINT_METADATA_STORE = "HackedProfileFingerprintMetadata";
export const HACKED_PROFILE_FINGERPRINT_ACTIVE_VERSION_STORE = "HackedProfileFingerprintActiveVersion";

const LOOKBACK_DAYS = 90;
const MAX_EXAMPLE_USERS = 5;
const MAX_BACKFILL_USERS_PER_CLASS = 50;

const GENERIC_SOCIAL_DOMAINS = new Set([
    "allmylinks.com",
    "beacons.ai",
    "discord.com",
    "discord.gg",
    "facebook.com",
    "instagram.com",
    "linktr.ee",
    "reddit.com",
    "t.me",
    "telegram.me",
    "tiktok.com",
    "twitter.com",
    "x.com",
    "youtu.be",
    "youtube.com",
]);

type HackedProfileOutcomeClass = "recovered" | "organic_non_recovered" | "banned_non_recovered" | "scammed" | "other";
type HackedProfileFeatureType = "bioHash" | "displayNameHash" | "socialDomain" | "socialHandleHash" | "socialLinkHash";
type HackedProfileConfidence = "weak" | "moderate" | "strong";

const HACKED_PROFILE_OUTCOME_CLASSES = new Set<HackedProfileOutcomeClass>([
    "recovered",
    "organic_non_recovered",
    "banned_non_recovered",
    "scammed",
    "other",
]);

const HACKED_PROFILE_FEATURE_TYPES = new Set<HackedProfileFeatureType>([
    "bioHash",
    "displayNameHash",
    "socialDomain",
    "socialHandleHash",
    "socialLinkHash",
]);

export interface HackedProfileFeatures {
    bioHash?: string;
    displayNameHash?: string;
    socialDomains: string[];
    socialHandleHashes: string[];
    socialLinkHashes: string[];
}

export interface HackedProfileFingerprintObservation {
    username: string;
    source: "statistics_backfill" | "summary_lookup";
    observedAt: number;
    reportedAt?: number;
    lastUpdate: number;
    status: UserStatus;
    flags: UserFlag[];
    outcomeClass: HackedProfileOutcomeClass;
    features: HackedProfileFeatures;
}

export interface HackedProfileFeatureBankRecord {
    featureKey: string;
    featureType: HackedProfileFeatureType;
    featureValue: string;
    recoveredUsers: number;
    organicNonRecoveredUsers: number;
    bannedNonRecoveredUsers: number;
    scammedUsers: number;
    otherUsers: number;
    lastSeen: number;
    exampleRecoveredUsers: string[];
    exampleOrganicUsers: string[];
    exampleBannedUsers: string[];
    exampleScammedUsers: string[];
}

export interface HackedProfileSampleSizes {
    recovered: number;
    organicNonRecovered: number;
    bannedNonRecovered: number;
    scammed: number;
    other: number;
}

export interface HackedProfileFingerprintMetadata {
    generatedAt: number;
    observationCount: number;
    sampleSizes: HackedProfileSampleSizes;
}

export interface HackedProfileEvidenceObservation {
    username: string;
    outcomeClass: HackedProfileOutcomeClass;
    features: HackedProfileFeatures;
}

export interface FeatureMatch {
    record: HackedProfileFeatureBankRecord;
    score: number;
    confidence: HackedProfileConfidence;
}

export interface HackedProfileSummaryMatch {
    confidence: HackedProfileConfidence;
    matches: FeatureMatch[];
    sampleSizes: HackedProfileSampleSizes;
}

function sha256 (input: string): string {
    return crypto.createHash("sha256").update(input).digest("hex");
}

function normalizeText (input: string): string {
    return input.trim().toLowerCase().replace(/\s+/gu, " ");
}

function normalizeUrl (input: string): string | undefined {
    try {
        const url = new URL(input);
        const hostname = url.hostname.startsWith("www.") ? url.hostname.substring(4) : url.hostname;
        const path = url.pathname.replace(/\/+$/u, "");
        return `${url.protocol}//${hostname.toLowerCase()}${path.toLowerCase()}`;
    } catch {
        return undefined;
    }
}

function extractHandleFromUrl (input: string): string | undefined {
    const normalizedUrl = normalizeUrl(input);
    if (!normalizedUrl) {
        return;
    }

    const url = new URL(normalizedUrl);
    const pathSegments = url.pathname.split("/").map(segment => segment.trim()).filter(Boolean);
    const lastSegment = pathSegments[pathSegments.length - 1]?.replace(/^@/u, "");
    if (!lastSegment) {
        return;
    }

    if (!/^[\w.-]{3,40}$/u.test(lastSegment) || !/[a-z]/iu.test(lastSegment)) {
        return;
    }

    const commonSegments = new Set(["add", "profile", "user", "users", "share", "invite", "trial", "action"]);
    if (commonSegments.has(lastSegment.toLowerCase())) {
        return;
    }

    return lastSegment.toLowerCase();
}

function socialLinkUrls (socialLinks: UserSocialLink[]): string[] {
    return _.compact(socialLinks.map(link => link.outboundUrl));
}

export function getHackedProfileFeatures (profile: InitialAccountProperties): HackedProfileFeatures {
    const normalizedBio = profile.bioText ? normalizeText(profile.bioText) : undefined;
    const normalizedDisplayName = profile.displayName ? normalizeText(profile.displayName) : undefined;
    const urls = socialLinkUrls(profile.socialLinks);
    const socialDomains = _.uniq(urls
        .map(domainFromUrl)
        .filter((domain): domain is string => Boolean(domain))
        .map(domain => domain.toLowerCase()))
        .filter(domain => !GENERIC_SOCIAL_DOMAINS.has(domain))
        .sort();
    const socialHandleHashes = _.uniq(urls
        .map(extractHandleFromUrl)
        .filter((handle): handle is string => Boolean(handle))
        .map(sha256)).sort();

    return {
        bioHash: normalizedBio && normalizedBio.length >= 4 ? sha256(normalizedBio) : undefined,
        displayNameHash: normalizedDisplayName && normalizedDisplayName.length >= 3 ? sha256(normalizedDisplayName) : undefined,
        socialDomains,
        socialHandleHashes,
        socialLinkHashes: _.uniq(_.compact(urls.map(normalizeUrl)).map(sha256)).sort(),
    };
}

function featureKey (featureType: HackedProfileFeatureType, featureValue: string): string {
    return `${featureType}:${featureValue}`;
}

export function getHackedProfileFeatureKeys (features: HackedProfileFeatures): string[] {
    const keys: string[] = [];
    if (features.bioHash) {
        keys.push(featureKey("bioHash", features.bioHash));
    }
    if (features.displayNameHash) {
        keys.push(featureKey("displayNameHash", features.displayNameHash));
    }
    keys.push(...features.socialDomains.map(domain => featureKey("socialDomain", domain)));
    keys.push(...features.socialHandleHashes.map(hash => featureKey("socialHandleHash", hash)));
    keys.push(...features.socialLinkHashes.map(hash => featureKey("socialLinkHash", hash)));

    return _.uniq(keys);
}

function parseFeatureKey (key: string): { featureType: HackedProfileFeatureType; featureValue: string } {
    const index = key.indexOf(":");
    const featureType = key.substring(0, index) as HackedProfileFeatureType;
    const featureValue = key.substring(index + 1);

    return { featureType, featureValue };
}

function getOutcomeClass (details: UserDetails): HackedProfileOutcomeClass {
    if (details.flags?.includes(UserFlag.HackedAndRecovered)) {
        return "recovered";
    }
    if (details.flags?.includes(UserFlag.Scammed)) {
        return "scammed";
    }
    if (details.userStatus === UserStatus.Organic) {
        return "organic_non_recovered";
    }
    if (userIsBanned(details)) {
        return "banned_non_recovered";
    }

    return "other";
}

function appendExampleUser (users: string[], username: string): string[] {
    if (users.includes(username)) {
        return users;
    }

    return [...users, username].slice(-MAX_EXAMPLE_USERS);
}

function hasAnyFeatures (features: HackedProfileFeatures): boolean {
    return getHackedProfileFeatureKeys(features).length > 0;
}

function buildObservation (username: string, details: UserDetails, profile: InitialAccountProperties, source: HackedProfileFingerprintObservation["source"]): HackedProfileFingerprintObservation | undefined {
    const features = getHackedProfileFeatures(profile);
    if (!hasAnyFeatures(features)) {
        return;
    }

    return {
        username,
        source,
        observedAt: new Date().getTime(),
        reportedAt: details.reportedAt,
        lastUpdate: details.lastUpdate,
        status: details.userStatus,
        flags: details.flags ?? [],
        outcomeClass: getOutcomeClass(details),
        features,
    };
}

function lastProfileObservationTime (entry: StatsUserEntry): number {
    return entry.data.reportedAt ?? entry.data.lastUpdate;
}

function newestEntries (entries: StatsUserEntry[], limit: number): StatsUserEntry[] {
    return [...entries]
        .sort((a, b) => lastProfileObservationTime(b) - lastProfileObservationTime(a))
        .slice(0, limit);
}

function selectHackedProfileFingerprintBackfillEntries (recentEntries: StatsUserEntry[]): StatsUserEntry[] {
    const isRecovered = (entry: StatsUserEntry) => entry.data.flags?.includes(UserFlag.HackedAndRecovered) ?? false;
    const isScammed = (entry: StatsUserEntry) => entry.data.flags?.includes(UserFlag.Scammed) ?? false;

    const recoveredEntries = recentEntries.filter(isRecovered);
    const scammedEntries = recentEntries.filter(entry => !isRecovered(entry) && isScammed(entry));
    const organicEntries = recentEntries.filter(entry => (
        entry.data.userStatus === UserStatus.Organic
        && !isRecovered(entry)
        && !isScammed(entry)
    ));
    const bannedEntries = recentEntries.filter(entry => (
        userIsBanned(entry.data)
        && !isRecovered(entry)
        && !isScammed(entry)
    ));

    return _.uniqBy([
        ...newestEntries(recoveredEntries, MAX_BACKFILL_USERS_PER_CLASS),
        ...newestEntries(scammedEntries, MAX_BACKFILL_USERS_PER_CLASS),
        ...newestEntries(organicEntries, MAX_BACKFILL_USERS_PER_CLASS),
        ...newestEntries(bannedEntries, MAX_BACKFILL_USERS_PER_CLASS),
    ], entry => entry.username);
}

export function buildHackedProfileFeatureBank (observations: HackedProfileFingerprintObservation[]): Record<string, HackedProfileFeatureBankRecord> {
    const records: Record<string, HackedProfileFeatureBankRecord> = {};

    for (const observation of observations) {
        const keys = getHackedProfileFeatureKeys(observation.features);
        for (const key of keys) {
            const parsedKey = parseFeatureKey(key);
            const existingRecord = records[key] ?? {
                featureKey: key,
                featureType: parsedKey.featureType,
                featureValue: parsedKey.featureValue,
                recoveredUsers: 0,
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

            if (observation.outcomeClass === "recovered") {
                existingRecord.recoveredUsers += 1;
                existingRecord.exampleRecoveredUsers = appendExampleUser(existingRecord.exampleRecoveredUsers, observation.username);
            } else if (observation.outcomeClass === "organic_non_recovered") {
                existingRecord.organicNonRecoveredUsers += 1;
                existingRecord.exampleOrganicUsers = appendExampleUser(existingRecord.exampleOrganicUsers, observation.username);
            } else if (observation.outcomeClass === "banned_non_recovered") {
                existingRecord.bannedNonRecoveredUsers += 1;
                existingRecord.exampleBannedUsers = appendExampleUser(existingRecord.exampleBannedUsers, observation.username);
            } else if (observation.outcomeClass === "scammed") {
                existingRecord.scammedUsers += 1;
                existingRecord.exampleScammedUsers = appendExampleUser(existingRecord.exampleScammedUsers, observation.username);
            } else {
                existingRecord.otherUsers += 1;
            }

            existingRecord.lastSeen = Math.max(existingRecord.lastSeen, observation.reportedAt ?? observation.lastUpdate);
            records[key] = existingRecord;
        }
    }

    return records;
}

export function getHackedProfileSampleSizes (observations: HackedProfileFingerprintObservation[]): HackedProfileSampleSizes {
    const outcomeCounts: Partial<Record<HackedProfileOutcomeClass, number>> = _.countBy(observations.map(observation => observation.outcomeClass));

    return {
        recovered: outcomeCounts.recovered ?? 0,
        organicNonRecovered: outcomeCounts.organic_non_recovered ?? 0,
        bannedNonRecovered: outcomeCounts.banned_non_recovered ?? 0,
        scammed: outcomeCounts.scammed ?? 0,
        other: outcomeCounts.other ?? 0,
    };
}

function isPlainObject (value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger (value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringArray (value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isHackedProfileFeatures (value: unknown): value is HackedProfileFeatures {
    if (!isPlainObject(value)) {
        return false;
    }

    return (
        (value.bioHash === undefined || typeof value.bioHash === "string")
        && (value.displayNameHash === undefined || typeof value.displayNameHash === "string")
        && isStringArray(value.socialDomains)
        && isStringArray(value.socialHandleHashes)
        && isStringArray(value.socialLinkHashes)
    );
}

export function parseHackedProfileFeatureBankRecord (rawRecord: string | null | undefined): HackedProfileFeatureBankRecord | undefined {
    if (!rawRecord) {
        return;
    }

    try {
        const value: unknown = JSON.parse(rawRecord);
        if (!isPlainObject(value)) {
            return;
        }

        const featureType = value.featureType as HackedProfileFeatureType;
        if (
            typeof value.featureKey !== "string"
            || !HACKED_PROFILE_FEATURE_TYPES.has(featureType)
            || typeof value.featureValue !== "string"
            || value.featureKey !== featureKey(featureType, value.featureValue)
            || !isNonNegativeInteger(value.recoveredUsers)
            || !isNonNegativeInteger(value.organicNonRecoveredUsers)
            || !isNonNegativeInteger(value.bannedNonRecoveredUsers)
            || !isNonNegativeInteger(value.scammedUsers)
            || !isNonNegativeInteger(value.otherUsers)
            || typeof value.lastSeen !== "number"
            || !Number.isFinite(value.lastSeen)
            || !isStringArray(value.exampleRecoveredUsers)
            || !isStringArray(value.exampleOrganicUsers)
            || !isStringArray(value.exampleBannedUsers)
            || !isStringArray(value.exampleScammedUsers)
        ) {
            return;
        }

        return value as unknown as HackedProfileFeatureBankRecord;
    } catch {
        return;
    }
}

function parseHackedProfileFingerprintMetadata (rawMetadata: string | undefined): HackedProfileFingerprintMetadata | undefined {
    if (!rawMetadata) {
        return;
    }

    try {
        const value: unknown = JSON.parse(rawMetadata);
        if (!isPlainObject(value) || !isPlainObject(value.sampleSizes)) {
            return;
        }

        const sampleSizes = value.sampleSizes;
        if (
            typeof value.generatedAt !== "number"
            || !Number.isFinite(value.generatedAt)
            || !isNonNegativeInteger(value.observationCount)
            || !isNonNegativeInteger(sampleSizes.recovered)
            || !isNonNegativeInteger(sampleSizes.organicNonRecovered)
            || !isNonNegativeInteger(sampleSizes.bannedNonRecovered)
            || !isNonNegativeInteger(sampleSizes.scammed)
            || !isNonNegativeInteger(sampleSizes.other)
        ) {
            return;
        }

        return value as unknown as HackedProfileFingerprintMetadata;
    } catch {
        return;
    }
}

function parseHackedProfileEvidenceObservation (rawObservation: string | undefined): HackedProfileEvidenceObservation | undefined {
    if (!rawObservation) {
        return;
    }

    try {
        const value: unknown = JSON.parse(rawObservation);
        if (!isPlainObject(value)) {
            return;
        }

        const outcomeClass = value.outcomeClass as HackedProfileOutcomeClass;
        if (
            typeof value.username !== "string"
            || !HACKED_PROFILE_OUTCOME_CLASSES.has(outcomeClass)
            || !isHackedProfileFeatures(value.features)
        ) {
            return;
        }

        return {
            username: value.username,
            outcomeClass,
            features: value.features,
        };
    } catch {
        return;
    }
}

function versionedStoreKey (baseKey: string, version: string): string {
    return `${baseKey}:${version}`;
}

export function getHackedProfileFingerprintStoreKeys (version: string) {
    return {
        observations: versionedStoreKey(HACKED_PROFILE_FINGERPRINT_OBSERVATION_STORE, version),
        featureBank: versionedStoreKey(HACKED_PROFILE_FINGERPRINT_FEATURE_BANK_STORE, version),
        metadata: versionedStoreKey(HACKED_PROFILE_FINGERPRINT_METADATA_STORE, version),
    };
}

async function deleteHackedProfileFingerprintSnapshot (redis: RedisClient, version: string): Promise<void> {
    const keys = getHackedProfileFingerprintStoreKeys(version);
    await redis.del(keys.observations, keys.featureBank, keys.metadata);
}

export async function publishHackedProfileFingerprintSnapshot (
    redis: RedisClient,
    observations: HackedProfileFingerprintObservation[],
    bank: Record<string, HackedProfileFeatureBankRecord>,
    metadata: HackedProfileFingerprintMetadata,
    version = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
): Promise<string> {
    const previousVersion = await redis.get(HACKED_PROFILE_FINGERPRINT_ACTIVE_VERSION_STORE);
    const keys = getHackedProfileFingerprintStoreKeys(version);
    const observationData = Object.fromEntries(observations.map(observation => [observation.username, JSON.stringify(observation)]));
    const bankData = Object.fromEntries(Object.entries(bank).map(([key, record]) => [key, JSON.stringify(record)]));

    try {
        if (Object.keys(observationData).length > 0) {
            await hSetChunked(redis, keys.observations, observationData);
        }
        if (Object.keys(bankData).length > 0) {
            await hSetChunked(redis, keys.featureBank, bankData);
        }
        await redis.set(keys.metadata, JSON.stringify(metadata));
        await redis.set(HACKED_PROFILE_FINGERPRINT_ACTIVE_VERSION_STORE, version);
    } catch (error) {
        try {
            await deleteHackedProfileFingerprintSnapshot(redis, version);
        } catch (cleanupError) {
            console.warn(`Hacked Profile Fingerprints: Failed to clean incomplete snapshot ${version}.`, cleanupError);
        }
        throw error;
    }

    if (previousVersion && previousVersion !== version) {
        try {
            await deleteHackedProfileFingerprintSnapshot(redis, previousVersion);
        } catch (error) {
            console.warn(`Hacked Profile Fingerprints: Failed to remove previous snapshot ${previousVersion}.`, error);
        }
    }

    return version;
}

function readableFeatureName (record: Pick<HackedProfileFeatureBankRecord, "featureType" | "featureValue">): string {
    if (record.featureType === "bioHash") {
        return `bio hash ${record.featureValue.substring(0, 12)}`;
    }
    if (record.featureType === "displayNameHash") {
        return `display-name hash ${record.featureValue.substring(0, 12)}`;
    }
    if (record.featureType === "socialDomain") {
        return `social domain ${record.featureValue}`;
    }
    if (record.featureType === "socialHandleHash") {
        return `social-handle hash ${record.featureValue.substring(0, 12)}`;
    }

    return `social-link hash ${record.featureValue.substring(0, 12)}`;
}

function rate (count: number, sampleSize: number): number {
    return sampleSize > 0 ? count / sampleSize : 0;
}

function featureScore (record: HackedProfileFeatureBankRecord, sampleSizes: HackedProfileSampleSizes): number {
    const recoveredRate = rate(record.recoveredUsers, sampleSizes.recovered);
    const comparisonUsers = record.organicNonRecoveredUsers + record.scammedUsers;
    const comparisonSampleSize = sampleSizes.organicNonRecovered + sampleSizes.scammed;
    const comparisonRate = rate(comparisonUsers, comparisonSampleSize);
    const bannedRate = rate(record.bannedNonRecoveredUsers, sampleSizes.bannedNonRecovered);

    let score = (recoveredRate - comparisonRate) * 1000;
    score += record.recoveredUsers * 3;
    score -= bannedRate * 100;

    if (record.featureType === "socialLinkHash") {
        score += 30;
    } else if (record.featureType === "socialHandleHash") {
        score += 25;
    } else if (record.featureType === "bioHash") {
        score += 20;
    } else if (record.featureType === "displayNameHash") {
        score += 15;
    } else {
        score -= 20;
    }

    return score;
}

function candidateConfidence (record: HackedProfileFeatureBankRecord, sampleSizes: HackedProfileSampleSizes): HackedProfileConfidence | undefined {
    const recoveredRate = rate(record.recoveredUsers, sampleSizes.recovered);
    const comparisonUsers = record.organicNonRecoveredUsers + record.scammedUsers;
    const comparisonSampleSize = sampleSizes.organicNonRecovered + sampleSizes.scammed;
    const comparisonRate = rate(comparisonUsers, comparisonSampleSize);
    const rateRatio = comparisonRate === 0 ? Number.POSITIVE_INFINITY : recoveredRate / comparisonRate;

    let confidence: HackedProfileConfidence | undefined;
    if (
        record.recoveredUsers >= 5
        && recoveredRate >= 0.05
        && comparisonUsers === 0
    ) {
        confidence = "strong";
    } else if (
        record.recoveredUsers >= 3
        && recoveredRate >= 0.03
        && rateRatio >= 3
    ) {
        confidence = "moderate";
    } else if (
        record.recoveredUsers >= 2
        && recoveredRate >= 0.02
        && rateRatio >= 2
    ) {
        confidence = "weak";
    }

    if (record.featureType === "socialDomain" && confidence) {
        return "weak";
    }

    return confidence;
}

function decrementSampleSize (sampleSizes: HackedProfileSampleSizes, outcomeClass: HackedProfileOutcomeClass): void {
    if (outcomeClass === "recovered") {
        sampleSizes.recovered = Math.max(0, sampleSizes.recovered - 1);
    } else if (outcomeClass === "organic_non_recovered") {
        sampleSizes.organicNonRecovered = Math.max(0, sampleSizes.organicNonRecovered - 1);
    } else if (outcomeClass === "banned_non_recovered") {
        sampleSizes.bannedNonRecovered = Math.max(0, sampleSizes.bannedNonRecovered - 1);
    } else if (outcomeClass === "scammed") {
        sampleSizes.scammed = Math.max(0, sampleSizes.scammed - 1);
    } else {
        sampleSizes.other = Math.max(0, sampleSizes.other - 1);
    }
}

function withoutObservationContribution (
    record: HackedProfileFeatureBankRecord,
    observation: HackedProfileEvidenceObservation,
): HackedProfileFeatureBankRecord {
    if (!getHackedProfileFeatureKeys(observation.features).includes(record.featureKey)) {
        return record;
    }

    const adjustedRecord: HackedProfileFeatureBankRecord = {
        ...record,
        exampleRecoveredUsers: record.exampleRecoveredUsers.filter(username => username.toLowerCase() !== observation.username.toLowerCase()),
        exampleOrganicUsers: record.exampleOrganicUsers.filter(username => username.toLowerCase() !== observation.username.toLowerCase()),
        exampleBannedUsers: record.exampleBannedUsers.filter(username => username.toLowerCase() !== observation.username.toLowerCase()),
        exampleScammedUsers: record.exampleScammedUsers.filter(username => username.toLowerCase() !== observation.username.toLowerCase()),
    };

    if (observation.outcomeClass === "recovered") {
        adjustedRecord.recoveredUsers = Math.max(0, adjustedRecord.recoveredUsers - 1);
    } else if (observation.outcomeClass === "organic_non_recovered") {
        adjustedRecord.organicNonRecoveredUsers = Math.max(0, adjustedRecord.organicNonRecoveredUsers - 1);
    } else if (observation.outcomeClass === "banned_non_recovered") {
        adjustedRecord.bannedNonRecoveredUsers = Math.max(0, adjustedRecord.bannedNonRecoveredUsers - 1);
    } else if (observation.outcomeClass === "scammed") {
        adjustedRecord.scammedUsers = Math.max(0, adjustedRecord.scammedUsers - 1);
    } else {
        adjustedRecord.otherUsers = Math.max(0, adjustedRecord.otherUsers - 1);
    }

    return adjustedRecord;
}

export function getHackedProfileSummaryMatch (
    records: HackedProfileFeatureBankRecord[],
    sampleSizes: HackedProfileSampleSizes,
    currentObservation?: HackedProfileEvidenceObservation,
): HackedProfileSummaryMatch | undefined {
    const adjustedSampleSizes = { ...sampleSizes };
    const adjustedRecords = currentObservation
        ? records.map(record => withoutObservationContribution(record, currentObservation))
        : records;

    if (currentObservation) {
        decrementSampleSize(adjustedSampleSizes, currentObservation.outcomeClass);
    }

    const matches = _.compact(adjustedRecords.map((record) => {
        const confidence = candidateConfidence(record, adjustedSampleSizes);
        if (!confidence) {
            return;
        }

        return {
            record,
            confidence,
            score: featureScore(record, adjustedSampleSizes),
        };
    })).sort((a, b) => b.score - a.score);

    if (matches.length === 0) {
        return;
    }

    const nonDomainMatches = matches.filter(match => match.record.featureType !== "socialDomain");
    const moderateOrStrongMatches = nonDomainMatches.filter(match => match.confidence !== "weak");
    const distinctModerateOrStrongTypes = new Set(moderateOrStrongMatches.map(match => match.record.featureType));
    const distinctNonDomainTypes = new Set(nonDomainMatches.map(match => match.record.featureType));

    let confidence: HackedProfileConfidence = "weak";
    if (
        distinctModerateOrStrongTypes.size >= 2
        && (
            moderateOrStrongMatches.some(match => match.confidence === "strong")
            || moderateOrStrongMatches.length >= 2
        )
    ) {
        confidence = "strong";
    } else if (
        moderateOrStrongMatches.length > 0
        || distinctNonDomainTypes.size >= 2
    ) {
        confidence = "moderate";
    }

    return {
        confidence,
        matches: matches.slice(0, 5),
        sampleSizes: adjustedSampleSizes,
    };
}

function formatExampleUsers (users: string[]): string {
    return users.map(username => `/u/${username}`).join(", ");
}

function formatPrevalence (count: number, sampleSize: number): string {
    const percentage = sampleSize > 0 ? count / sampleSize : 0;
    return `${count.toLocaleString()} / ${sampleSize.toLocaleString()} (${(percentage * 100).toFixed(1)}%)`;
}

function reportRows (
    records: HackedProfileFeatureBankRecord[],
    sampleSizes: HackedProfileSampleSizes,
    minimumConfidence: "moderate" | "strong",
): string[][] {
    return records
        .filter(record => candidateConfidence(record, sampleSizes) === minimumConfidence)
        .sort((a, b) => featureScore(b, sampleSizes) - featureScore(a, sampleSizes))
        .slice(0, 50)
        .map(record => [
            readableFeatureName(record),
            formatPrevalence(record.recoveredUsers, sampleSizes.recovered),
            formatPrevalence(record.organicNonRecoveredUsers, sampleSizes.organicNonRecovered),
            formatPrevalence(record.bannedNonRecoveredUsers, sampleSizes.bannedNonRecovered),
            formatPrevalence(record.scammedUsers, sampleSizes.scammed),
            record.lastSeen ? format(record.lastSeen, "MMM dd") : "",
            formatExampleUsers(record.exampleRecoveredUsers),
        ]);
}

function buildReport (
    observations: HackedProfileFingerprintObservation[],
    bank: Record<string, HackedProfileFeatureBankRecord>,
    metadata: HackedProfileFingerprintMetadata,
): json2md.DataObject[] {
    const records = Object.values(bank);
    const strongRows = reportRows(records, metadata.sampleSizes, "strong");
    const moderateRows = reportRows(records, metadata.sampleSizes, "moderate");
    const headers = ["Feature", "Recovered prevalence", "Organic prevalence", "Banned prevalence", "Scammed prevalence", "Last seen", "Recovered examples"];

    const content: json2md.DataObject[] = [
        { h1: "Hacked Profile Fingerprints" },
        { p: `This page is generated from an equally capped sample of stored public profile data for accounts reported in the last ${LOOKBACK_DAYS} days. It is intended for moderator review and appeal triage only.` },
        { p: "The page compares class-specific prevalence rather than raw counts. Bio, display-name, social-handle, and full-link values are represented by hashes. Common social and link-aggregation domains are excluded." },
        { h2: "Backfill status" },
        {
            ul: [
                `Users with profile features processed: ${observations.length.toLocaleString()}`,
                `Recovered accounts: ${metadata.sampleSizes.recovered.toLocaleString()}`,
                `Organic non-recovered accounts: ${metadata.sampleSizes.organicNonRecovered.toLocaleString()}`,
                `Banned non-recovered accounts: ${metadata.sampleSizes.bannedNonRecovered.toLocaleString()}`,
                `Scammed accounts: ${metadata.sampleSizes.scammed.toLocaleString()}`,
                `Other accounts: ${metadata.sampleSizes.other.toLocaleString()}`,
                `Generated: ${new Date(metadata.generatedAt).toUTCString()}`,
            ],
        },
        { h2: "Strong candidate features" },
    ];

    if (strongRows.length > 0) {
        content.push({ table: { headers, rows: strongRows } });
    } else {
        content.push({ p: "None found." });
    }

    content.push({ h2: "Moderate candidate features" });
    if (moderateRows.length > 0) {
        content.push({ table: { headers, rows: moderateRows } });
    } else {
        content.push({ p: "None found." });
    }

    content.push(
        { h2: "Use guidance" },
        {
            ul: [
                "Treat these matches as supporting evidence only.",
                "Do not automatically grant or deny an appeal based on this page.",
                "A social-domain match alone is capped at weak confidence.",
                "Keep scammed/promotion-stopped accounts separate from recovered accounts when reviewing candidates.",
                "Inspect recovered examples before adding any pattern to appeal config.",
            ],
        },
    );

    return content;
}

async function updateHackedProfileFingerprintWiki (
    observations: HackedProfileFingerprintObservation[],
    bank: Record<string, HackedProfileFeatureBankRecord>,
    metadata: HackedProfileFingerprintMetadata,
    context: JobContext,
): Promise<void> {
    const page = "statistics/hacked-profile-fingerprints";
    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    const content = json2md(buildReport(observations, bank, metadata));

    let existingContent: string | undefined;
    try {
        existingContent = (await context.reddit.getWikiPage(subredditName, page)).content;
    } catch {
        // The page may not exist yet.
    }

    if (content.trim() !== existingContent?.trim()) {
        await context.reddit.updateWikiPage({
            subredditName,
            page,
            content,
        });
    }

    await context.reddit.updateWikiPageSettings({
        subredditName,
        page,
        listed: true,
        permLevel: WikiPagePermissionLevel.MODS_ONLY,
    });
}

export async function updateHackedProfileFingerprintStatistics (allEntries: StatsUserEntry[], context: JobContext) {
    const since = subDays(new Date(), LOOKBACK_DAYS).getTime();
    const recentEligibleEntries = allEntries
        .filter(entry => lastProfileObservationTime(entry) >= since)
        .filter(entry => [UserStatus.Banned, UserStatus.Organic, UserStatus.Purged, UserStatus.Retired, UserStatus.Inactive].includes(entry.data.userStatus));
    const recentEntries = selectHackedProfileFingerprintBackfillEntries(recentEligibleEntries);

    console.log(`Hacked Profile Fingerprints: Processing ${recentEntries.length} capped users from ${recentEligibleEntries.length} recent eligible users for profile features.`);

    const observations: HackedProfileFingerprintObservation[] = [];
    for (const chunk of _.chunk(recentEntries, 250)) {
        const profiles = await getInitialAccountPropertiesForUsers(chunk.map(entry => entry.username), context);
        for (const entry of chunk) {
            const profile = profiles[entry.username];
            const observation = buildObservation(entry.username, entry.data, profile, "statistics_backfill");
            if (observation) {
                observations.push(observation);
            }
        }
    }

    const bank = buildHackedProfileFeatureBank(observations);
    const metadata: HackedProfileFingerprintMetadata = {
        generatedAt: new Date().getTime(),
        observationCount: observations.length,
        sampleSizes: getHackedProfileSampleSizes(observations),
    };
    const version = await publishHackedProfileFingerprintSnapshot(context.redis, observations, bank, metadata);

    await updateHackedProfileFingerprintWiki(observations, bank, metadata, context);

    console.log(`Hacked Profile Fingerprints: Published snapshot ${version} with ${observations.length} observations and ${Object.keys(bank).length} feature records.`);
}

export async function getHackedProfileFingerprintSummary (username: string, userStatus: UserDetails | undefined, context: TriggerContext): Promise<json2md.DataObject[]> {
    if (!userStatus) {
        return [];
    }

    const activeVersion = await context.redis.get(HACKED_PROFILE_FINGERPRINT_ACTIVE_VERSION_STORE);
    if (!activeVersion) {
        return [];
    }

    const profile = await getInitialAccountProperties(username, context);
    const features = getHackedProfileFeatures(profile);
    const keys = getHackedProfileFeatureKeys(features);
    if (keys.length === 0) {
        return [];
    }

    const storeKeys = getHackedProfileFingerprintStoreKeys(activeVersion);
    const [rawRecords, rawMetadata, rawObservation] = await Promise.all([
        context.redis.hMGet(storeKeys.featureBank, keys),
        context.redis.get(storeKeys.metadata),
        context.redis.hGet(storeKeys.observations, username),
    ]);

    const metadata = parseHackedProfileFingerprintMetadata(rawMetadata);
    if (!metadata) {
        console.warn(`Hacked Profile Fingerprints: Snapshot ${activeVersion} has missing or malformed metadata.`);
        return [];
    }

    let malformedRecords = 0;
    const records = _.compact(rawRecords.map((rawRecord) => {
        const record = parseHackedProfileFeatureBankRecord(rawRecord);
        if (rawRecord && !record) {
            malformedRecords += 1;
        }
        return record;
    }));

    if (malformedRecords > 0) {
        console.warn(`Hacked Profile Fingerprints: Ignored ${malformedRecords} malformed feature bank record(s) in snapshot ${activeVersion}.`);
    }

    let currentObservation: HackedProfileEvidenceObservation | undefined;
    if (rawObservation) {
        currentObservation = parseHackedProfileEvidenceObservation(rawObservation);
        if (currentObservation?.username.toLowerCase() !== username.toLowerCase()) {
            console.warn(`Hacked Profile Fingerprints: Ignored malformed self-observation for ${username} in snapshot ${activeVersion}.`);
            return [];
        }
    }

    const summaryMatch = getHackedProfileSummaryMatch(records, metadata.sampleSizes, currentObservation);
    if (!summaryMatch) {
        return [];
    }

    const bullets = summaryMatch.matches.map((match) => {
        const record = match.record;
        return `${readableFeatureName(record)} — recovered: ${formatPrevalence(record.recoveredUsers, summaryMatch.sampleSizes.recovered)}, organic: ${formatPrevalence(record.organicNonRecoveredUsers, summaryMatch.sampleSizes.organicNonRecovered)}, banned non-recovered: ${formatPrevalence(record.bannedNonRecoveredUsers, summaryMatch.sampleSizes.bannedNonRecovered)}, scammed: ${formatPrevalence(record.scammedUsers, summaryMatch.sampleSizes.scammed)}`;
    });

    return [
        { h2: "Hacked-account fingerprint" },
        { p: `${_.capitalize(summaryMatch.confidence)} match after excluding this account's own contribution. The stored original public profile matches feature(s) disproportionately associated with accounts marked recovered.` },
        { ul: bullets },
        { p: "Interpretation: supporting evidence only. This does not prove the account was hacked; review the appeal and recent activity before granting or denying the appeal." },
    ];
}
