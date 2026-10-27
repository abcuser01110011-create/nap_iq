# Deploying NAP-IQ on Vercel + Supabase

The app is Flask + SQLAlchemy. Supabase is PostgreSQL, Vercel runs Flask as a serverless function.
Everything below was tested against a real PostgreSQL 16 database.

## 1. Supabase (database)

1. Create a project at supabase.com. Save the **database password**.
2. Dashboard -> **SQL Editor** -> New query -> paste all of `database/schema_postgres.sql` -> **Run**.
   (Run it once, on an empty database.)
3. *(Optional, demo data only)* run `database/seed_postgres.sql` the same way.
   It creates demo logins with public passwords (`admin1 / Admin@12345` ...) - delete them before real use.
4. Dashboard -> **Connect** (or Project Settings -> Database) -> copy the **Transaction pooler** string
   (host `...pooler.supabase.com`, port `6543`). This is your `DATABASE_URL`.
   If the password contains `@ : / # ? %`, URL-encode it (`@` -> `%40`).

### Keeping your existing data (optional)
If you have real data in the old MySQL (Railway or a dump restored to any reachable MySQL):

```bash
pip install -r requirements.txt
python scripts/migrate_mysql_to_postgres.py --dry-run \
  --source "mysql://USER:PASS@HOST:PORT/DBNAME" \
  --target "postgresql://postgres.xxxx:PASS@aws-0-xx.pooler.supabase.com:5432/postgres"
# looks right? run again without --dry-run
```
Use the Supabase **Session pooler** (port 5432) or direct string for this one-time copy. It needs the
schema from step 2 already in place, refuses to run on non-empty tables, never touches the source,
and prints a per-table row-count check at the end.

## 2. Vercel (app)

1. Push the project to GitHub (these new files included) and **Import** it in Vercel. Framework preset
   is detected as Flask; no build command is needed. `.python-version` pins Python 3.12.
   (CLI alternative: `npm i -g vercel && vercel --prod` from the project root.)
2. Project -> Settings -> **Environment Variables** - see `.env.example`. Minimum:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Transaction-pooler string from step 1.4 |
| `SECRET_KEY`, `JWT_SECRET_KEY` | two different long random strings |
| `FLASK_DEBUG` | `False` |
| `SESSION_COOKIE_SECURE` | `True` |
| `TRUST_X_FORWARDED_PROTO` | `True` |
| `CLOUDINARY_URL` | `cloudinary://KEY:SECRET@CLOUD_NAME` (same as Railway) |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | same as Railway |

3. Deploy. Then log in as an administrator and open `/database-test` to confirm the DB connection.
4. **Mobile app:** change `extra.apiBaseUrl` in `mobile/apps/app/app.json` from the old
   `https://pgnetworks.up.railway.app` to your new Vercel URL, then rebuild / republish the app.

## What changed in the code

| File | Change |
|---|---|
| `app/config.py` | Uses `DATABASE_URL` (Postgres) when set; falls back to the old `MYSQL_*` values otherwise. Auto-adds `sslmode=require`; disables client-side pooling on Vercel. |
| `requirements.txt` | + `psycopg2-binary`, + `redis` (only used if you set `RATELIMIT_STORAGE_URI`). |
| `index.py` | Vercel entrypoint (re-exports `app` from `run.py`). |
| `.python-version`, `.vercelignore`, `.env.example` | Deployment support files. |
| `database/schema_postgres.sql`, `seed_postgres.sql` | Postgres versions of `schema.sql` / `seed.sql`. Tables have Row Level Security enabled so Supabase's public REST API can't expose your data (Flask connects as `postgres`, which bypasses RLS). |
| `scripts/migrate_mysql_to_postgres.py` | One-time data copy (optional). |
| `app/query_utils.py` + `routes/{naps,payments,service_requests,subscribers,users}.py` | **Postgres fix:** a junk `?status=` / `?role=` in the URL used to just show an empty list on MySQL but crashes on Postgres. Same empty-list behaviour restored. |
| `app/issue_utils.py` | **Postgres fix:** the customer "open issue" lookup filtered tickets by status `accepted`, which isn't a ticket status (MySQL ignored it, Postgres errors) - it 500'd the customer portal home page. |
| `app/routes/auth.py`, `api_v1/auth.py`, `api_v1/customer.py`, `forms.py` | Username/email matching is now case-insensitive again (MySQL was; Postgres isn't) so e.g. a phone that capitalises "Tech1" can still log in and duplicates are still caught. |

## Things to know on Vercel
* **Rate limiting** (login/register) is counted per serverless instance with the default in-memory store, so it is
  a soft limit. For a hard limit use a free Upstash Redis and set `RATELIMIT_STORAGE_URI` (see `.env.example`).
* **No local file storage:** uploads already go to Cloudinary, so nothing else is needed. Nothing may be written
  to disk at runtime.
* The first request after idle time is a cold start (a second or two); static files are served by Flask.
* Changing `SECRET_KEY` later logs everyone out.
