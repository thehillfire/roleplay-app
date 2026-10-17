# CLAUDE.md

## API selection: check public-apis first

Before suggesting or integrating any third-party API, search the
[public-apis](https://github.com/public-apis/public-apis) directory
(`README.md`, grouped by category) for a free alternative. Only reach for a
paid/SaaS API when the user asks for one or nothing in the directory fits.

When asked "what API should I use for X?", recommend the 2-3 best entries,
ranked by:

1. Auth: none, or a simple API key (avoid OAuth for client-side use)
2. CORS: `Yes` in the table, **verified with a live request** (about half the
   entries list CORS as `Unknown`)
3. Maintenance and uptime: endpoint responds today, docs/changelog recently updated
4. Documentation quality

For each recommended API, provide:

- Endpoint URL and an example `fetch`/axios call
- Required query parameters
- Example response shape
- Error handling (status codes, timeouts) and rate-limit notes

The directory is community-maintained and contains dead or newly paid
entries. Before recommending one, hit the endpoint. If it is deprecated or no
longer free, say so and pick an alternative from the same category.

API keys never go in client bundles; proxy keyed calls through the backend.

Priority categories: Weather, Cryptocurrency/Finance, Video (movies/TV),
Science & Math (NASA/space), Sports & Fitness.
