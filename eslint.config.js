//  @ts-check

import { tanstackConfig } from '@tanstack/eslint-config'

export default [
  ...tanstackConfig,
  {
    ignores: [
      '**/.tanstack/**',
      '**/dist/**',
      '**/dist-ssr/**',
      'e2e/**',
      'electron/server-bundle.cjs',
      'playground-ws-worker/**',
      'eslint.config.js',
      'prettier.config.js',
      'vite.config.ts',
    ],
  },
  {
    // Block client-side imports of server-only MCP input types.
    // `src/types/mcp-input.ts` may carry secret-bearing fields and must
    // never be referenced from screens or shared components.
    files: ['src/screens/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/types/mcp-input',
              message:
                'mcp-input.ts is server-only (carries unmasked secrets). Import McpClientInput from @/types/mcp instead.',
            },
          ],
          patterns: [
            {
              group: ['**/types/mcp-input', '**/types/mcp-input.ts'],
              message:
                'mcp-input.ts is server-only (carries unmasked secrets). Import McpClientInput from @/types/mcp instead.',
            },
          ],
        },
      ],
    },
  },
]
