import path from 'node:path';
import { fileURLToPath } from 'node:url';
import eslint from '@eslint/js';
import globals from 'globals';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

const { config: defineConfig, configs: tsConfigs } = tseslint;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const eslintProject = path.resolve(__dirname, 'tsconfig.eslint.json');

const sharedRules = {
    'max-len': ['error', { code: 120, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true }],
    complexity: ['error', 15],
    'sonarjs/cognitive-complexity': ['error', 20],
    '@typescript-eslint/no-unused-vars': [
        'error',
        {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
        },
    ],
    '@typescript-eslint/explicit-member-accessibility': [
        'error',
        {
            accessibility: 'explicit',
            overrides: {
                accessors: 'explicit',
                constructors: 'explicit',
                methods: 'explicit',
                properties: 'explicit',
                parameterProperties: 'explicit',
            },
        },
    ],
    'no-unreachable': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',
    '@typescript-eslint/no-unsafe-argument': 'error',
};

export default defineConfig(
    {
        ignores: [
            'dist/**',
            'node_modules/**',
            'coverage/**',
            '**/*.js',
            '**/*.mjs',
            '__pycache__/**',
            '.mypy_cache/**',
            '**/*.pyc',
            '**/*.pyo',
            '**/*.pyd',
            '.Python',
            'env/**',
            'venv/**',
            '.venv/**',
            'ENV/**',
            'env.bak/**',
            'venv.bak/**',
        ],
    },
    eslint.configs.recommended,
    tsConfigs.recommended,
    defineConfig({
        files: ['src/**/*.ts', 'scripts/**/*.ts', '*.config.ts', 'vitest.config.ts'],
        languageOptions: {
            globals: globals.node,
            parserOptions: {
                project: eslintProject,
                tsconfigRootDir: __dirname,
            },
        },
        plugins: {
            sonarjs,
        },
        rules: {
            ...sharedRules,
            // Source files: 400 lines max (utility files, commands)
            'max-lines': ['error', 400],
        },
    }),
    defineConfig({
        files: ['src/index.ts', 'src/commands/**/*.ts'],
        rules: {
            // Entry points and commands: 300 lines max (should be focused)
            'max-lines': ['error', 300],
            ...sharedRules,
        },
    }),
    defineConfig({
        files: ['src/utils/config.ts'],
        rules: {
            // Configuration files: 200 lines max (should be simple)
            'max-lines': ['error', 200],
            '@typescript-eslint/no-unnecessary-condition': ['error', { allowConstantLoopConditions: false }],
            '@typescript-eslint/strict-boolean-expressions': [
                'warn',
                {
                    allowString: false,
                    allowNumber: false,
                    allowNullableObject: false,
                    allowNullableBoolean: false,
                    allowNullableString: false,
                    allowNullableNumber: false,
                    allowAny: false,
                },
            ],
        },
    }),
    defineConfig({
        files: ['tests/**/*.ts'],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.vitest,
            },
            parserOptions: {
                project: eslintProject,
                tsconfigRootDir: __dirname,
            },
        },
        plugins: {
            sonarjs,
        },
        rules: {
            ...sharedRules,
            // Test files: 500 lines max (more lenient for test fixtures)
            'max-lines': ['error', 500],
            // Keep some safety rules for tests to catch import/type errors
            '@typescript-eslint/no-unsafe-member-access': 'warn',
            '@typescript-eslint/no-unsafe-call': 'warn',
            '@typescript-eslint/no-unsafe-assignment': 'warn',
            '@typescript-eslint/no-unsafe-return': 'warn',
            '@typescript-eslint/no-unsafe-argument': 'warn',
            // Add rules to catch import/export issues
            '@typescript-eslint/consistent-type-imports': 'error',
            '@typescript-eslint/no-import-type-side-effects': 'error',
        },
    })
);
