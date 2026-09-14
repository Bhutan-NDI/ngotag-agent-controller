import sys, json, time, random, statistics
from pathlib import Path
from local_db import connect, enc, category, profile, value

root = Path(__file__).parent
base = "SELECT id, kind, category, name, value, (SELECT ARRAY_TO_STRING(ARRAY_AGG(it.plaintext || ':' || ENCODE(it.name,'hex') || ':' || ENCODE(it.value,'hex')),',') FROM items_tags it WHERE it.item_id=i.id) tags FROM items i WHERE profile_id=$1 AND (kind=$2 OR $2 IS NULL) AND (category=$3 OR $3 IS NULL) AND (expiry IS NULL OR expiry>CURRENT_TIMESTAMP) AND "
shapes = {
    "and5": ("message", [1, 2, 3, 4, 5]),
    "and4": ("message", [1, 2, 3, 4]),
    "and2": ("proof", [5, 6]),
    "or2": ("connection", [6, 1]),
    "or3and2": ("did", [6, 5, 1, 2, 6, 3]),
    "and3": ("message", [1, 3, 5]),
}


def build(shape):
    cat, tags = shapes[shape]
    n = len(tags)
    terms = [
        f"i.id IN (SELECT item_id FROM items_tags WHERE name=${4+3*j} AND value=${5+3*j} AND SUBSTR(value,1,12)=${6+3*j} AND plaintext=0)"
        for j in range(n)
    ]
    exp = (
        " OR ".join(f"({terms[j]} AND {terms[j+1]})" for j in [0, 2, 4])
        if shape == "or3and2"
        else (" OR " if shape == "or2" else " AND ").join(terms)
    )
    return base + "(" + exp + f") LIMIT ${4+3*n} OFFSET ${5+3*n}"


def params(shape, i, missing=False):
    p = profile(i)
    a = [p, 1, enc(f"category-{p}-{category(i)}", 44)]
    for t in shapes[shape][1]:
        v = value(i, t)
        if missing and t in [1, 6]:
            v += "-missing"
        v = enc(f"profile-{p}-value-{v}", 52)
        a.extend([enc(f"profile-{p}-tag-{t}", 43), v, v[:12]])
    return a + [2, 0]


def literal(v):
    if isinstance(v, bytes):
        return "'\\x" + v.hex() + "'::bytea"
    return str(v)


def execute(shape, i, missing=False):
    return (
        "EXECUTE "
        + shape
        + "("
        + ",".join(map(literal, params(shape, i, missing)))
        + ")"
    )


def prep(c, mode):
    c.execute("SET statement_timeout=15000")
    c.execute("SET plan_cache_mode=" + mode)
    for s in shapes:
        n = len(shapes[s][1])
        types = (
            ["bigint", "smallint", "bytea"] + ["bytea"] * (3 * n) + ["bigint", "bigint"]
        )
        c.execute("PREPARE " + s + "(" + ",".join(types) + ") AS " + build(s))


def ids(shape):
    return [
        i
        for i in range(1, 200001)
        if category(i) == shapes[shape][0] and i % 15 != 0 and profile(i) == 1
    ]


def main():
    out = []
    for mode in ["force_generic_plan", "force_custom_plan", "auto"]:
        with connect() as c:
            prep(c, mode)
            for s in shapes:
                lat = []
                correct = True
                for j, i in enumerate(ids(s)[:24]):
                    missing = j % 4 == 0
                    t = time.perf_counter()
                    rows = c.execute(execute(s, i, missing)).fetchall()
                    lat.append((time.perf_counter() - t) * 1000)
                    correct &= [r[0] for r in rows] == ([] if missing else [i])
                i = ids(s)[1]
                plan = c.execute(
                    "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + execute(s, i)
                ).fetchone()[0][0]
                result = {
                    "mode": mode,
                    "shape": s,
                    "correct": correct,
                    "mean_ms": statistics.mean(lat),
                    "p95_ms": sorted(lat)[int(len(lat) * 0.95)],
                    "plan": plan,
                }
                out.append(result)
                print(
                    json.dumps({k: v for k, v in result.items() if k != "plan"}),
                    flush=True,
                )
            print(
                c.execute(
                    "SELECT name,generic_plans,custom_plans FROM pg_prepared_statements ORDER BY name"
                ).fetchall(),
                flush=True,
            )
    (root / "local-planning-results.json").write_text(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
