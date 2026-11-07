# 619 ERP Backend — Deployment Checklist

The deploy workflow (`.github/workflows/deploy.yml`) runs migrations before it
replaces the container. Migrations are forward-only: rolling the code back does
not roll the schema back.

## Fresh environment (first deploy, new database)

1. Supply environment variables from the deployment secret store. Never commit
   them; `AI_API_KEY` (or `OPENROUTER_API_KEY`) is required for any AI route —
   without it those routes answer `501 NOT_CONFIGURED`.
2. Run migrations (`npm run migrate`) and confirm they applied.
3. Verify backup and restore **before** any production migration
   (`docs/DISASTER-RECOVERY.md`); a green backup run is not a tested restore.
4. **Curate the shared MPTS knowledge corpus.** Grounded generation — workout,
   diet, progress analysis, fitness-testing analysis — fails closed while no
   approved corpus exists:
   - Platform console → Knowledge: upload the methodology documents.
     Platform uploads start as `pending` (unlike studio uploads, which default
     to `approved`), so approve each one and wait for ingestion to finish.
   - The document becomes an active generation source only when ingestion is
     `ready` **and** approval is `approved`.
   - Until then the four generators answer
     `422 INSUFFICIENT_EVIDENCE` — *"requires approved methodology documents …
     nothing was generated"*.
5. Smoke test: `GET /api/health` → 200; generate one workout for a seeded
   client; `GET /api/ai/health` → at least one model `ok` (this call performs
   three real completions, so use it once, not on a poll).
