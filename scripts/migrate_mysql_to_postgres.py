"""
Copy existing NAP-IQ data from the old MySQL database into Supabase (Postgres).

Only needed if you have REAL data you want to keep (users, subscribers,
payments, tickets...). For a fresh start just run database/schema_postgres.sql
(+ optionally database/seed_postgres.sql) in Supabase's SQL Editor instead.

Prerequisites
  1. database/schema_postgres.sql has already been run on the Supabase DB
     (the tables must exist and be empty).
  2. The old MySQL data is reachable from this computer. Either
       - the Railway MySQL is still reachable (use its *public* URL from the
         Railway dashboard -> MySQL -> Connect), or
       - you restored your mysqldump into any MySQL you can reach
         (e.g. a local MySQL: mysql -u root -p nap_iq < dump.sql).

Usage (from the project root; pick the Supabase "Session pooler" or "Direct"
connection string here -- not needed to be the transaction pooler):

    pip install -r requirements.txt
    python scripts/migrate_mysql_to_postgres.py \\
        --source "mysql://root:PASSWORD@HOST:PORT/DBNAME" \\
        --target "postgresql://postgres.xxxx:PASSWORD@aws-0-xx.pooler.supabase.com:5432/postgres"

Add --dry-run to only print row counts. The script never modifies the source
database. It refuses to run if any target table already has rows.

What it handles
  * table order (foreign keys), and technical_issues.parent_issue_id (a
    self-reference) -- it is filled in after all rows exist
  * MySQL TINYINT(1) 0/1 -> Postgres boolean
  * columns that exist only on one side (e.g. the old geomap_default_* columns
    in the MySQL schema) are skipped
  * Postgres id sequences are reset afterwards so new rows don't collide
"""

import argparse
import os
import sys

# Allow "python scripts/migrate_mysql_to_postgres.py" from the project root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SECRET_KEY", "migration-script")

from sqlalchemy import Boolean, MetaData, create_engine, func, insert, select, text, update  # noqa: E402

from app.extensions import db  # noqa: E402
import app.models  # noqa: E402,F401  (registers every table on db.metadata)

BATCH = 500


def _source_url(url: str) -> str:
    for prefix in ("mysql://", "mysql+pymysql://"):
        if url.startswith(prefix):
            return "mysql+pymysql://" + url[len(prefix):]
    return url  # any other SQLAlchemy URL (e.g. sqlite:///file.db) works too


def _target_url(url: str) -> str:
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+psycopg2://" + url[len(prefix):]
            break
    if url.startswith("postgresql") and "sslmode=" not in url and "localhost" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    return url


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", required=True, help="old MySQL URL")
    ap.add_argument("--target", required=True, help="Supabase Postgres URL")
    ap.add_argument("--dry-run", action="store_true", help="only print row counts")
    args = ap.parse_args()

    src = create_engine(_source_url(args.source))
    dst = create_engine(_target_url(args.target))

    src_meta = MetaData()
    src_meta.reflect(bind=src)

    tables = list(db.metadata.sorted_tables)  # parents before children
    plan = []
    for t in tables:
        if t.name not in src_meta.tables:
            print(f"  skip {t.name}: not present in source")
            continue
        s = src_meta.tables[t.name]
        cols = [c.name for c in t.columns if c.name in s.columns]
        with src.connect() as sc:
            n = sc.execute(select(func.count()).select_from(s)).scalar()
        plan.append((t, s, cols, n))
        print(f"  {t.name:22s} {n:>7} rows, {len(cols)} columns")

    if args.dry_run:
        return 0

    with dst.connect() as dc:
        for t, _s, _cols, _n in plan:
            existing = dc.execute(select(func.count()).select_from(t)).scalar()
            # app_settings gets one default row from schema_postgres.sql; replace it.
            if t.name == "app_settings" and existing:
                continue
            if existing:
                print(f"ERROR: target table {t.name} already has {existing} rows. "
                      f"Migrate into an empty schema.")
                return 1

    with dst.begin() as dc:
        dc.execute(text("DELETE FROM app_settings"))
        for t, s, cols, n in plan:
            bool_cols = {c.name for c in t.columns if isinstance(c.type, Boolean)}
            self_fk = [fk.parent.name for fk in t.foreign_keys if fk.column.table is t]
            pk = [c.name for c in t.primary_key.columns]
            deferred = []  # (pk values, {self_fk_col: value}) applied after the inserts

            with src.connect() as sc:
                result = sc.execute(select(*[s.c[c] for c in cols]).order_by(*[s.c[c] for c in pk]))
                batch = []
                total = 0

                def flush():
                    nonlocal batch, total
                    if batch:
                        dc.execute(insert(t), batch)
                        total += len(batch)
                        batch = []

                for row in result.mappings():
                    rec = dict(row)
                    for c in bool_cols:
                        if rec.get(c) is not None:
                            rec[c] = bool(rec[c])
                    if self_fk:
                        later = {c: rec[c] for c in self_fk if rec.get(c) is not None}
                        if later:
                            deferred.append(([rec[k] for k in pk], later))
                            for c in later:
                                rec[c] = None
                    batch.append(rec)
                    if len(batch) >= BATCH:
                        flush()
                flush()

            for pk_vals, later in deferred:
                dc.execute(update(t).where(*[t.c[k] == v for k, v in zip(pk, pk_vals)]).values(**later))
            print(f"  copied {t.name}: {total} rows" + (f" (+{len(deferred)} self-references)" if deferred else ""))

        # Reset serial sequences so the next INSERT gets MAX(id)+1.
        for t, _s, _cols, _n in plan:
            if "id" in t.c and t.c.id.primary_key:
                dc.execute(text(
                    "SELECT setval(pg_get_serial_sequence(:tbl, 'id'), "
                    f"COALESCE((SELECT MAX(id) FROM {t.name}), 1), "
                    f"(SELECT COUNT(*) > 0 FROM {t.name}))"
                ), {"tbl": t.name})
        print("  sequences reset")

    # Final verification: row counts must match.
    ok = True
    with dst.connect() as dc:
        for t, _s, _cols, n in plan:
            got = dc.execute(select(func.count()).select_from(t)).scalar()
            flag = "OK " if got == n else "MISMATCH"
            ok &= got == n
            print(f"  verify {t.name:22s} source={n:<7} target={got:<7} {flag}")
    print("DONE - all counts match." if ok else "DONE - but some counts differ, check above.")
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
