import {
    Category as MonMonCategory,
    getCategories as getMonMonCategories,
} from 'moneymoney';
import type {
    APICategoryEntity,
    APICategoryGroupEntity,
} from '@actual-app/api/models';
import ActualApi from './ActualApi.js';
import { ActualBudgetConfig } from './config.js';
import Logger from './Logger.js';

type MoneyMoneyCategoryInfo = {
    uuid: string;
    name: string;
    path: string[];
    isGroup: boolean;
    indentation: number;
    isUncategorized: boolean;
};

type ActualCategoryInfo = {
    id: string;
    name: string;
    groupId: string;
    groupName?: string;
    path: string[];
};

type MappingValidation = {
    sourceRef: string;
    targetRef: string;
    status: 'valid' | 'invalid';
    reason?: string;
    sourceUuid?: string;
    targetId?: string;
    sourcePath?: string;
    targetPath?: string;
};

type MappingSuggestion = {
    sourceUuid: string;
    sourcePath: string;
    targetId: string;
    targetPath: string;
    reason: 'exact-normalized' | 'path-exact';
};

type CanonicalMappingEntry = {
    sourceUuid: string;
    targetId: string;
    sourcePath: string;
    targetPath: string;
    sourceRef: string;
    targetRef: string;
    origin: 'configured' | 'suggested';
    reason?: 'exact-normalized' | 'path-exact';
};

type CategoryMapReport = {
    configuredMappings: MappingValidation[];
    invalidMappings: MappingValidation[];
    safeSuggestions: MappingSuggestion[];
    unresolvedMoneyMoneyCategories: Array<{ uuid: string; path: string }>;
    unusedActualCategories: Array<{ id: string; path: string }>;
    planningWarnings: string[];
    ignoredMoneyMoneyCategories: Array<{
        uuid: string;
        path: string;
        ref: string;
    }>;
    invalidIgnoredRefWarnings: Array<{
        ref: string;
        reason: string;
    }>;
};

const DEFAULT_CATEGORY_PATH_SEPARATOR = ' > ';

class CategoryMap {
    private isLoaded = false;

    private monMonCategories: MonMonCategory[] = [];

    private monMonCategoryInfos = new Map<string, MoneyMoneyCategoryInfo>();

    private actualCategoryInfos = new Map<string, ActualCategoryInfo>();

    private validMappings: MappingValidation[] = [];

    private invalidMappings: MappingValidation[] = [];

    private suggestions: MappingSuggestion[] = [];

    private mappedMoneyMoneyUuids = new Set<string>();
    private mappedCategoryBySourceUuid = new Map<string, string>();
    private ignoredState: Array<{
        uuid: string;
        path: string;
        ref: string;
    }> = [];
    private invalidIgnoredRefWarnings: Array<{
        ref: string;
        reason: string;
    }> = [];

    constructor(
        private budgetConfig: ActualBudgetConfig,
        private actualApi: ActualApi,
        private logger: Logger
    ) {}

    async load() {
        if (this.isLoaded) {
            return;
        }

        const monMonCategories = await getMonMonCategories();
        const actualCategories = await this.actualApi.getCategories();
        const actualGroups = await this.actualApi.getCategoryGroups();

        this.loadFromData(monMonCategories, actualCategories, actualGroups);
    }

    loadFromData(
        monMonCategories: MonMonCategory[],
        actualCategories: APICategoryEntity[],
        actualGroups: APICategoryGroupEntity[]
    ) {
        this.resetState();
        this.isLoaded = true;
        this.monMonCategories = monMonCategories;
        this.buildMoneyMoneyCategoryInfos();
        this.buildActualCategoryInfos(actualCategories, actualGroups);
        this.evaluateConfiguredMappings();
        this.resolveIgnoredState();
        this.computeSuggestions();
    }

    getMappedActualCategoryId(categoryUuid: string): {
        actualCategoryId?: string;
        isUncategorized: boolean;
        isMapped: boolean;
        categoryPath?: string;
    } {
        const sourceCategory = this.monMonCategoryInfos.get(categoryUuid);

        if (!sourceCategory) {
            return {
                isUncategorized: false,
                isMapped: false,
            };
        }

        if (sourceCategory.isUncategorized) {
            return {
                isUncategorized: true,
                isMapped: false,
                categoryPath: sourceCategory.path.join(
                    DEFAULT_CATEGORY_PATH_SEPARATOR
                ),
            };
        }

        const targetCategoryId =
            this.mappedCategoryBySourceUuid.get(categoryUuid);

        const result: {
            actualCategoryId?: string;
            isUncategorized: boolean;
            isMapped: boolean;
            categoryPath?: string;
        } = {
            isUncategorized: false,
            isMapped: targetCategoryId !== undefined,
            categoryPath: sourceCategory.path.join(
                DEFAULT_CATEGORY_PATH_SEPARATOR
            ),
        };

        if (targetCategoryId) {
            result.actualCategoryId = targetCategoryId;
        }

        return result;
    }

    getCategoryPath(categoryUuid: string): string {
        const category = this.monMonCategoryInfos.get(categoryUuid);

        if (!category) {
            return categoryUuid;
        }

        return category.path.join(DEFAULT_CATEGORY_PATH_SEPARATOR);
    }

    getActualCategoryPath(categoryId: string): string {
        const category = this.actualCategoryInfos.get(categoryId);

        if (!category) {
            return categoryId;
        }

        return category.path.join(DEFAULT_CATEGORY_PATH_SEPARATOR);
    }

    resolveMoneyMoneyCategoryRefs(refs: string[]): {
        resolvedUuids: Set<string>;
        invalidRefs: Array<{ ref: string; reason: string }>;
    } {
        const resolvedUuids = new Set<string>();
        const invalidRefs: Array<{ ref: string; reason: string }> = [];

        for (const ref of refs) {
            const resolution = this.resolveMoneyMoneyCategoryRef(ref);
            if (!resolution.info) {
                invalidRefs.push({
                    ref,
                    reason:
                        resolution.reason ??
                        `MoneyMoney category ref '${ref}' not found.`,
                });
                continue;
            }

            if (resolution.info.isGroup) {
                invalidRefs.push({
                    ref,
                    reason: `MoneyMoney category ref '${ref}' resolved to a category group. Use a leaf category instead.`,
                });
                continue;
            }

            resolvedUuids.add(resolution.info.uuid);
        }

        return {
            resolvedUuids,
            invalidRefs,
        };
    }

    getReport(): CategoryMapReport {
        const ignoredMoneyMoneyCategories = this.ignoredState;
        const unresolvedMoneyMoneyCategories = this.getUnmappedCategories();
        const unusedActualCategories = this.computeUnusedActualCategories();
        const planningWarnings = this.computePlanningWarnings(
            unresolvedMoneyMoneyCategories.length,
            unusedActualCategories.length,
            this.invalidIgnoredRefWarnings.length
        );

        return {
            configuredMappings: this.validMappings,
            invalidMappings: this.invalidMappings,
            safeSuggestions: this.suggestions,
            unresolvedMoneyMoneyCategories,
            unusedActualCategories,
            planningWarnings,
            ignoredMoneyMoneyCategories,
            invalidIgnoredRefWarnings: this.invalidIgnoredRefWarnings,
        };
    }

    getCanonicalMapping({
        includeSuggestions,
    }: {
        includeSuggestions: boolean;
    }) {
        return Object.fromEntries(
            this.getCanonicalMappingEntries({ includeSuggestions }).map(
                (entry) => {
                    const sourceRef = this.canonicalSourceRef(
                        entry.sourceUuid,
                        entry.sourcePath
                    );
                    const targetRef = this.canonicalTargetRef(
                        entry.targetId,
                        entry.targetPath
                    );
                    return [sourceRef, targetRef];
                }
            )
        );
    }

    /**
     * Choose the best ref for a MoneyMoney category in canonical output.
     *
     * Prefers "path:" when the path resolves uniquely back to the same UUID.
     * Falls back to "uuid:" when paths collide (e.g., after normalization).
     */
    private canonicalSourceRef(uuid: string, path: string): string {
        const resolved = this.resolveMoneyMoneyCategoryRef(path);
        if (resolved.info?.uuid === uuid) {
            return `path:${path}`;
        }
        return `uuid:${uuid}`;
    }

    /**
     * Choose the best ref for an Actual category in canonical output.
     *
     * Prefers "path:" when the path resolves uniquely back to the same id.
     * Falls back to "id:" when paths collide or resolution is ambiguous.
     */
    private canonicalTargetRef(id: string, path: string): string {
        const resolved = this.resolveActualCategoryRef(path);
        if (resolved.info?.id === id) {
            return `path:${path}`;
        }
        return `id:${id}`;
    }

    getCanonicalMappingEntries({
        includeSuggestions,
    }: {
        includeSuggestions: boolean;
    }): CanonicalMappingEntry[] {
        const canonicalMapping = new Map<string, string>();
        const entries: CanonicalMappingEntry[] = [];

        for (const mapping of this.validMappings) {
            if (
                mapping.sourceUuid &&
                mapping.targetId &&
                mapping.sourcePath &&
                mapping.targetPath
            ) {
                canonicalMapping.set(mapping.sourceUuid, mapping.targetId);
                entries.push({
                    sourceUuid: mapping.sourceUuid,
                    targetId: mapping.targetId,
                    sourcePath: mapping.sourcePath,
                    targetPath: mapping.targetPath,
                    sourceRef: this.canonicalSourceRef(
                        mapping.sourceUuid,
                        mapping.sourcePath
                    ),
                    targetRef: this.canonicalTargetRef(
                        mapping.targetId,
                        mapping.targetPath
                    ),
                    origin: 'configured',
                });
            }
        }

        if (includeSuggestions) {
            for (const suggestion of this.suggestions) {
                if (!canonicalMapping.has(suggestion.sourceUuid)) {
                    canonicalMapping.set(
                        suggestion.sourceUuid,
                        suggestion.targetId
                    );
                    entries.push({
                        sourceUuid: suggestion.sourceUuid,
                        targetId: suggestion.targetId,
                        sourcePath: suggestion.sourcePath,
                        targetPath: suggestion.targetPath,
                        sourceRef: this.canonicalSourceRef(
                            suggestion.sourceUuid,
                            suggestion.sourcePath
                        ),
                        targetRef: this.canonicalTargetRef(
                            suggestion.targetId,
                            suggestion.targetPath
                        ),
                        origin: 'suggested',
                        reason: suggestion.reason,
                    });
                }
            }
        }

        return entries.sort(
            (a, b) =>
                a.sourcePath.localeCompare(b.sourcePath) ||
                a.sourceUuid.localeCompare(b.sourceUuid)
        );
    }

    private buildMoneyMoneyCategoryInfos() {
        const pathStack: string[] = [];

        for (const category of this.monMonCategories) {
            while (pathStack.length > category.indentation) {
                pathStack.pop();
            }

            const path = [...pathStack, category.name];
            const isUncategorized = category.default === true;

            const info: MoneyMoneyCategoryInfo = {
                uuid: category.uuid,
                name: category.name,
                path,
                isGroup: category.group,
                indentation: category.indentation,
                isUncategorized,
            };

            this.monMonCategoryInfos.set(category.uuid, info);

            if (category.group) {
                pathStack.push(category.name);
            }
        }

        this.logger.debug(
            `Loaded ${this.monMonCategories.length} categories from MoneyMoney.`
        );
    }

    private buildActualCategoryInfos(
        categories: APICategoryEntity[],
        groups: APICategoryGroupEntity[]
    ) {
        const groupNames = new Map(
            groups.map((group) => [group.id, group.name])
        );

        for (const category of categories) {
            const groupName = groupNames.get(category.group_id);
            const info: ActualCategoryInfo = {
                id: category.id,
                name: category.name,
                groupId: category.group_id,
                path: groupName ? [groupName, category.name] : [category.name],
            };
            if (groupName) {
                info.groupName = groupName;
            }

            this.actualCategoryInfos.set(category.id, info);
        }

        this.logger.debug(
            `Loaded ${categories.length} categories and ${groups.length} category groups from Actual.`
        );
    }

    private evaluateConfiguredMappings() {
        const configuredMapping = this.budgetConfig.categoryMapping ?? {};

        for (const [sourceRef, targetRef] of Object.entries(
            configuredMapping
        )) {
            const sourceResolution =
                this.resolveMoneyMoneyCategoryRef(sourceRef);
            const targetResolution = this.resolveActualCategoryRef(targetRef);

            if (!sourceResolution.info) {
                this.invalidMappings.push({
                    sourceRef,
                    targetRef,
                    status: 'invalid',
                    reason:
                        sourceResolution.reason ??
                        `MoneyMoney category ref '${sourceRef}' not found.`,
                });
                continue;
            }

            if (sourceResolution.info.isUncategorized) {
                this.invalidMappings.push({
                    sourceRef,
                    targetRef,
                    status: 'invalid',
                    reason: 'MoneyMoney uncategorized default category cannot be mapped',
                    sourceUuid: sourceResolution.info.uuid,
                    sourcePath: sourceResolution.info.path.join(
                        DEFAULT_CATEGORY_PATH_SEPARATOR
                    ),
                });
                continue;
            }

            if (sourceResolution.info.isGroup) {
                this.invalidMappings.push({
                    sourceRef,
                    targetRef,
                    status: 'invalid',
                    reason: 'MoneyMoney category groups cannot be mapped; use a leaf category instead',
                    sourceUuid: sourceResolution.info.uuid,
                    sourcePath: sourceResolution.info.path.join(
                        DEFAULT_CATEGORY_PATH_SEPARATOR
                    ),
                });
                continue;
            }

            if (!targetResolution.info) {
                this.invalidMappings.push({
                    sourceRef,
                    targetRef,
                    status: 'invalid',
                    reason:
                        targetResolution.reason ??
                        `Actual category ref '${targetRef}' not found.`,
                    sourceUuid: sourceResolution.info.uuid,
                    sourcePath: sourceResolution.info.path.join(
                        DEFAULT_CATEGORY_PATH_SEPARATOR
                    ),
                });
                continue;
            }

            const validation: MappingValidation = {
                sourceRef,
                targetRef,
                status: 'valid',
                sourceUuid: sourceResolution.info.uuid,
                targetId: targetResolution.info.id,
                sourcePath: sourceResolution.info.path.join(
                    DEFAULT_CATEGORY_PATH_SEPARATOR
                ),
                targetPath: targetResolution.info.path.join(
                    DEFAULT_CATEGORY_PATH_SEPARATOR
                ),
            };

            this.validMappings.push(validation);
            this.mappedMoneyMoneyUuids.add(sourceResolution.info.uuid);
            this.mappedCategoryBySourceUuid.set(
                sourceResolution.info.uuid,
                targetResolution.info.id
            );
        }
    }

    private computeSuggestions() {
        const unmappedCategories = this.getUnmappedCategories();

        for (const unmapped of unmappedCategories) {
            const sourceInfo = this.monMonCategoryInfos.get(unmapped.uuid);
            if (!sourceInfo) {
                continue;
            }

            const normalizedSourceName = this.normalizeCategoryName(
                sourceInfo.name
            );
            const exactNameCandidates = Array.from(
                this.actualCategoryInfos.values()
            ).filter(
                (actualCategory) =>
                    this.normalizeCategoryName(actualCategory.name) ===
                    normalizedSourceName
            );

            if (exactNameCandidates.length === 1) {
                const target = exactNameCandidates[0];
                if (target) {
                    this.suggestions.push({
                        sourceUuid: sourceInfo.uuid,
                        sourcePath: sourceInfo.path.join(
                            DEFAULT_CATEGORY_PATH_SEPARATOR
                        ),
                        targetId: target.id,
                        targetPath: target.path.join(
                            DEFAULT_CATEGORY_PATH_SEPARATOR
                        ),
                        reason: 'exact-normalized',
                    });
                    this.mappedMoneyMoneyUuids.add(sourceInfo.uuid);
                    continue;
                }
            }

            const sourcePath = sourceInfo.path.join(
                DEFAULT_CATEGORY_PATH_SEPARATOR
            );
            const pathCandidates = Array.from(
                this.actualCategoryInfos.values()
            ).filter(
                (actualCategory) =>
                    actualCategory.path.join(
                        DEFAULT_CATEGORY_PATH_SEPARATOR
                    ) === sourcePath
            );

            if (pathCandidates.length === 1) {
                const target = pathCandidates[0];
                if (target) {
                    this.suggestions.push({
                        sourceUuid: sourceInfo.uuid,
                        sourcePath,
                        targetId: target.id,
                        targetPath: target.path.join(
                            DEFAULT_CATEGORY_PATH_SEPARATOR
                        ),
                        reason: 'path-exact',
                    });
                    this.mappedMoneyMoneyUuids.add(sourceInfo.uuid);
                }
            }
        }
    }

    private getUnmappedCategories() {
        return Array.from(this.monMonCategoryInfos.values())
            .filter(
                (category) => !category.isGroup && !category.isUncategorized
            )
            .filter(
                (category) => !this.mappedMoneyMoneyUuids.has(category.uuid)
            )
            .map((category) => ({
                uuid: category.uuid,
                path: category.path.join(DEFAULT_CATEGORY_PATH_SEPARATOR),
            }));
    }

    private resolveIgnoredState() {
        const refs = this.budgetConfig.ignoredMoneyMoneyCategoryRefs ?? [];
        const { resolvedUuids, invalidRefs } =
            this.resolveMoneyMoneyCategoryRefs(refs);

        const ignored: Array<{
            uuid: string;
            path: string;
            ref: string;
        }> = [];

        for (const uuid of resolvedUuids) {
            const info = this.monMonCategoryInfos.get(uuid);
            if (!info) continue;

            // Detect mapped+ignored conflicts: an ignored category that is
            // also explicitly mapped is ambiguous user intent. Flag the mapping
            // as invalid and skip adding to mappedMoneyMoneyUuids so the
            // category still appears as unresolved (alerting the user).
            const conflictingMapping = this.validMappings.find(
                (m) => m.sourceUuid === uuid
            );
            if (conflictingMapping) {
                this.validMappings = this.validMappings.filter(
                    (m) => m !== conflictingMapping
                );
                this.mappedMoneyMoneyUuids.delete(uuid);
                this.mappedCategoryBySourceUuid.delete(uuid);
                const mappedReason =
                    'Mapped category is also listed in ignoredMoneyMoneyCategoryRefs. Remove one.';
                this.invalidMappings.push({
                    ...conflictingMapping,
                    reason: conflictingMapping.reason
                        ? `${conflictingMapping.reason}; ${mappedReason}`
                        : mappedReason,
                });
                continue;
            }

            this.mappedMoneyMoneyUuids.add(uuid);
            const ref = refs.find((r) => {
                const res = this.resolveMoneyMoneyCategoryRef(r);
                return res.info?.uuid === uuid;
            });
            ignored.push({
                uuid: info.uuid,
                path: info.path.join(DEFAULT_CATEGORY_PATH_SEPARATOR),
                ref: ref ?? uuid,
            });
        }

        for (const invalid of invalidRefs) {
            this.invalidIgnoredRefWarnings.push(invalid);
        }

        this.ignoredState = ignored;
    }

    private computeUnusedActualCategories() {
        const usedActualIds = new Set<string>();

        for (const mapping of this.validMappings) {
            if (mapping.targetId) {
                usedActualIds.add(mapping.targetId);
            }
        }

        for (const suggestion of this.suggestions) {
            usedActualIds.add(suggestion.targetId);
        }

        return Array.from(this.actualCategoryInfos.entries())
            .filter(([id]) => !usedActualIds.has(id))
            .map(([id, info]) => ({
                id,
                path: info.path.join(DEFAULT_CATEGORY_PATH_SEPARATOR),
            }))
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    private computePlanningWarnings(
        unresolvedCount: number,
        unusedCount: number,
        invalidIgnoredRefCount: number
    ) {
        const warnings: string[] = [];

        if (unresolvedCount > 0) {
            warnings.push(
                `Unresolved MoneyMoney categories: ${unresolvedCount}`
            );
        }

        if (unusedCount > 0) {
            warnings.push(`Unused Actual categories: ${unusedCount}`);
        }

        if (invalidIgnoredRefCount > 0) {
            warnings.push(
                `Invalid ignored category refs: ${invalidIgnoredRefCount}`
            );
        }

        if (warnings.length > 0) {
            warnings.push('Planning is incomplete (this can be intentional).');
        }

        return warnings;
    }

    private resolveMoneyMoneyCategoryRef(ref: string): {
        info?: MoneyMoneyCategoryInfo;
        reason?: string;
    } {
        // Handle "uuid:" prefix — explicit MoneyMoney category UUID lookup only.
        if (ref.startsWith('uuid:')) {
            const uuid = ref.slice(5);
            const byUuid = this.monMonCategoryInfos.get(uuid);
            if (byUuid) {
                return { info: byUuid };
            }
            return {
                reason: `MoneyMoney category uuid '${uuid}' not found.`,
            };
        }

        // Strip optional "path:" prefix for human-readable refs.
        const actualRef = ref.startsWith('path:') ? ref.slice(5) : ref;

        const byUuid = this.monMonCategoryInfos.get(actualRef);
        if (byUuid) {
            return { info: byUuid };
        }

        const normalizedRef = this.normalizeCategoryName(actualRef);
        const categories = Array.from(this.monMonCategoryInfos.values());

        const byPath = categories.filter((category) => {
            const normalizedPath = this.normalizeCategoryName(
                category.path.join(DEFAULT_CATEGORY_PATH_SEPARATOR)
            );

            return normalizedPath === normalizedRef;
        });

        if (byPath.length === 1) {
            const category = byPath[0];
            if (category) {
                return { info: category };
            }
        }

        if (byPath.length > 1) {
            return {
                reason: `Ambiguous MoneyMoney category ref '${ref}' (path match).`,
            };
        }

        const byName = categories.filter((category) => {
            return this.normalizeCategoryName(category.name) === normalizedRef;
        });

        if (byName.length === 1) {
            const category = byName[0];
            if (category) {
                return { info: category };
            }
        }

        if (byName.length > 1) {
            return {
                reason: `Ambiguous MoneyMoney category ref '${ref}' (name match).`,
            };
        }

        return { reason: `MoneyMoney category ref '${ref}' not found.` };
    }

    private resolveActualCategoryRef(ref: string): {
        info?: ActualCategoryInfo;
        reason?: string;
    } {
        // Handle "id:" prefix — explicit Actual category ID lookup only.
        if (ref.startsWith('id:')) {
            const id = ref.slice(3);
            const byId = this.actualCategoryInfos.get(id);
            if (byId) {
                return { info: byId };
            }
            return { reason: `Actual category id '${id}' not found.` };
        }

        // Strip optional "path:" prefix for human-readable refs.
        const actualRef = ref.startsWith('path:') ? ref.slice(5) : ref;

        const byId = this.actualCategoryInfos.get(actualRef);
        if (byId) {
            return { info: byId };
        }

        const normalizedRef = this.normalizeCategoryName(actualRef);
        const categories = Array.from(this.actualCategoryInfos.values());

        const byPath = categories.filter((category) => {
            const normalizedPath = this.normalizeCategoryName(
                category.path.join(DEFAULT_CATEGORY_PATH_SEPARATOR)
            );

            return normalizedPath === normalizedRef;
        });

        if (byPath.length === 1) {
            const category = byPath[0];
            if (category) {
                return { info: category };
            }
        }

        if (byPath.length > 1) {
            return {
                reason: `Ambiguous Actual category ref '${ref}' (path match).`,
            };
        }

        const byName = categories.filter((category) => {
            return this.normalizeCategoryName(category.name) === normalizedRef;
        });

        if (byName.length === 1) {
            const category = byName[0];
            if (category) {
                return { info: category };
            }
        }

        if (byName.length > 1) {
            return {
                reason: `Ambiguous Actual category ref '${ref}' (name match).`,
            };
        }

        return { reason: `Actual category ref '${ref}' not found.` };
    }

    private normalizeCategoryName(name: string) {
        // Normalize cosmetic prefixes/suffixes (emoji, punctuation) while preserving meaningful words.
        return name
            .normalize('NFKC')
            .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    private resetState() {
        this.monMonCategories = [];
        this.monMonCategoryInfos.clear();
        this.actualCategoryInfos.clear();
        this.validMappings = [];
        this.invalidMappings = [];
        this.suggestions = [];
        this.mappedMoneyMoneyUuids.clear();
        this.mappedCategoryBySourceUuid.clear();
        this.ignoredState = [];
        this.invalidIgnoredRefWarnings = [];
    }
}

export type {
    CanonicalMappingEntry,
    CategoryMapReport,
    MappingSuggestion,
    MappingValidation,
};
export default CategoryMap;
