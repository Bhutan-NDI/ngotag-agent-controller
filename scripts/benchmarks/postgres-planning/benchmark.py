import importlib.util, json, subprocess, time, threading, random, re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from local_db import connect, container

root = Path(__file__).parent
s = importlib.util.spec_from_file_location("planning", root / "planning.py")
p = importlib.util.module_from_spec(s)
s.loader.exec_module(p)
queries = {
    shape: (
        re.sub(r"\$\d+", "%s", p.build(shape)),
        [int(n) - 1 for n in re.findall(r"\$(\d+)", p.build(shape))],
    )
    for shape in p.shapes
}


def query(c, shape, i, missing, cached):
    q, refs = queries[shape]
    args = p.params(shape, i, missing)
    return c.execute(q, [args[j] for j in refs], prepare=cached).fetchall()


def cpu():
    return {
        k: int(v)
        for k, v in (
            l.split()
            for l in subprocess.check_output(
                ["docker", "exec", container, "cat", "/sys/fs/cgroup/cpu.stat"],
                text=True,
            ).splitlines()
        )
    }


def pct(x, q):
    return sorted(x)[min(len(x) - 1, int(len(x) * q))]


def run(cached, cpus, repeat, rate):
    subprocess.run(
        ["docker", "update", "--cpus", str(cpus), container],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    ready = threading.Barrier(5)
    go = threading.Event()
    done = threading.Barrier(5)
    start = [0]

    def worker(w):
        rng = random.Random(100 + w)
        jobs = [(shape, j % 4 == 0) for j in range(80) for shape in p.shapes]
        rng.shuffle(jobs)
        avail = {shape: p.ids(shape) for shape in p.shapes}
        lat = []
        errors = 0
        with connect() as c:
            c.execute("SET statement_timeout=15000")
            for shape in p.shapes:
                for i in avail[shape][:10]:
                    query(c, shape, i, False, cached)
            ready.wait(timeout=60)
            assert go.wait(timeout=60), "Benchmark start timed out"
            for j, (shape, missing) in enumerate(jobs):
                scheduled = (
                    start[0] + (j * 4 + w) / rate if rate else time.perf_counter()
                )
                if rate:
                    time.sleep(max(0, scheduled - time.perf_counter()))
                i = rng.choice(avail[shape])
                t = time.perf_counter()
                rows = query(c, shape, i, missing, cached)
                end = time.perf_counter()
                errors += int([r[0] for r in rows] != ([] if missing else [i]))
                lat.append((shape, (end - t) * 1000, (end - scheduled) * 1000))
            done.wait(timeout=60)
            plans = c.execute(
                "SELECT generic_plans,custom_plans FROM pg_prepared_statements"
            ).fetchall()
        return lat, errors, plans

    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = [ex.submit(worker, w) for w in range(4)]
        ready.wait(timeout=60)
        before = cpu()
        start[0] = time.perf_counter()
        go.set()
        done.wait(timeout=60)
        wall = time.perf_counter() - start[0]
        after = cpu()
        results = [f.result() for f in futures]
    lat = [v for r in results for _, _, v in r[0]]
    service = [v for r in results for _, v, _ in r[0]]
    return {
        "cached": cached,
        "cpus": cpus,
        "repeat": repeat,
        "offered_rps": rate,
        "operations": len(lat),
        "errors": sum(r[1] for r in results),
        "wall_seconds": wall,
        "throughput": len(lat) / wall,
        "cpu_seconds": (after["usage_usec"] - before["usage_usec"]) / 1e6,
        "cpu_utilization_pct": (after["usage_usec"] - before["usage_usec"])
        / 1e6
        / wall
        / cpus
        * 100,
        "p50_ms": pct(lat, 0.5),
        "p95_ms": pct(lat, 0.95),
        "p99_ms": pct(lat, 0.99),
        "service_p95_ms": pct(service, 0.95),
        "shapes": {
            s: {
                "p50": pct(
                    [v for r in results for shape, _, v in r[0] if shape == s], 0.5
                ),
                "p95": pct(
                    [v for r in results for shape, _, v in r[0] if shape == s], 0.95
                ),
            }
            for s in p.shapes
        },
        "prepared_plans": [r[2] for r in results],
    }


out = []
for rate in [0, 150]:
    for rep in range(3):
        cases = [(True, 4), (False, 4), (False, 2)]
        if rep % 2:
            cases.reverse()
        for cached, cpus in cases:
            result = run(cached, cpus, rep, rate)
            out.append(result)
            (root / "protocol-results.json").write_text(json.dumps(out, indent=2))
            print(
                json.dumps(
                    {
                        k: v
                        for k, v in result.items()
                        if k not in ["shapes", "prepared_plans"]
                    }
                ),
                flush=True,
            )
