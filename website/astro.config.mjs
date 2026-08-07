import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Docs site for @green-tea/core. Content lives in src/content/docs/**.
export default defineConfig({
  site: 'https://green-tea.expressive-tea.io',
  base: '/docs',
  integrations: [
    starlight({
      // GoatCounter — same site code as the marketing site, so /docs traffic lands in
      // the same dashboard and referrer paths stay comparable.
      head: [
        {
          tag: 'script',
          attrs: {
            'data-goatcounter': 'https://greentea.goatcounter.com/count',
            async: true,
            src: '//gc.zgo.at/count.js',
          },
        },
      ],
      // Let the content-backed 404.md own /404; otherwise Astro also injects a conflicting route.
      disable404Route: true,
      title: 'Green Tea.',
      description: 'A zen, opinionated, type-safe framework — your API is a graph, not a chain.',
      logo: { src: './src/assets/logo.svg', alt: 'Green Tea' },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/brand.css'],
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Introduction', link: '/' },
            { label: 'Getting started', slug: 'getting-started' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'The dependency graph', slug: 'concepts/the-graph' },
            { label: 'The typed flow core', slug: 'concepts/flow' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'The matcha CLI', slug: 'guides/cli' },
            { label: 'Routing', slug: 'guides/routing' },
            { label: 'Dependency injection', slug: 'guides/dependency-injection' },
            { label: 'Argument decorators', slug: 'guides/arguments' },
            { label: 'Validation', slug: 'guides/validation' },
            { label: 'Error handling', slug: 'guides/errors' },
            { label: 'Streaming & real-time', slug: 'guides/streaming' },
            { label: 'File uploads', slug: 'guides/uploads' },
            { label: 'HTML & views', slug: 'guides/html' },
            { label: 'Transport security', slug: 'guides/security' },
            { label: 'Plugins & observability', slug: 'guides/plugins' },
            { label: 'Graph introspection', slug: 'guides/introspection' },
            { label: 'OpenAPI', slug: 'guides/openapi' },
            { label: 'Runtimes', slug: 'guides/runtimes' },
            { label: 'Testing', slug: 'guides/testing' },
            { label: 'Mesh (alpha)', slug: 'guides/mesh', badge: { text: 'alpha', variant: 'caution' } },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Decorators', slug: 'reference/decorators' },
            { label: 'createApp options', slug: 'reference/createapp' },
          ],
        },
      ],
    }),
  ],
});
