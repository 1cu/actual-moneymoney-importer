import {
    Category as MonMonCategory,
    getCategories as getMonMonCategories,
} from 'moneymoney';
import ActualApi from './ActualApi.js';
import { ActualBudgetConfig } from './config.js';
import Logger from './Logger.js';

type ActualCategoryGroup = {
    id: string;
    name: string;
    is_income: boolean;
    hidden?: boolean;
};

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
        actualCategories: Category[],
        actualGroups: ActualCategoryGroup[]
    ) {
        this.resetState();
        this.isLoaded = true;
        this.monMonCategories = monMonCategories;
        this.buildMoneyMoneyCategoryInfos();
        this.buildActualCategoryInfos(actualCategories, actualGroups);
        this.evaluateConfiguredMappings();
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
        const unresolvedMoneyMoneyCategories = this.getUnmappedCategories();
        const unusedActualCategories = this.computeUnusedActualCategories();
        const planningWarnings = this.computePlanningWarnings(
            unresolvedMoneyMoneyCategories.length,
            unusedActualCategories.length
        );

        return {
            configuredMappings: this.validMappings,
            invalidMappings: this.invalidMappings,
            safeSuggestions: this.suggestions,
            unresolvedMoneyMoneyCategories,
            unusedActualCategories,
            planningWarnings,
        };
    }

    getCanonicalMapping({
        includeSuggestions,
    }: {
        includeSuggestions: boolean;
    }) {
        return Object.fromEntries(
            this.getCanonicalMappingEntries({ includeSuggestions }).map(
                (entry) => [entry.sourceUuid, entry.targetId]
            )
        );
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
        categories: Category[],
        groups: ActualCategoryGroup[]
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
        unusedCount: number
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

        if (warnings.length > 0) {
            warnings.push('Planning is incomplete (this can be intentional).');
        }

        return warnings;
    }

    private resolveMoneyMoneyCategoryRef(ref: string): {
        info?: MoneyMoneyCategoryInfo;
        reason?: string;
    } {
        const byUuid = this.monMonCategoryInfos.get(ref);
        if (byUuid && !byUuid.isGroup) {
            return { info: byUuid };
        }

        const normalizedRef = this.normalizeCategoryName(ref);
        const leafCategories = Array.from(
            this.monMonCategoryInfos.values()
        ).filter((category) => !category.isGroup);

        const byPath = leafCategories.filter((category) => {
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

        const byName = leafCategories.filter((category) => {
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
        const byId = this.actualCategoryInfos.get(ref);
        if (byId) {
            return { info: byId };
        }

        const normalizedRef = this.normalizeCategoryName(ref);
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
    }
}

export type {
    CanonicalMappingEntry,
    CategoryMapReport,
    MappingSuggestion,
    MappingValidation,
};
export default CategoryMap;
