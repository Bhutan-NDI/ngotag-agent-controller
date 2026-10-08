import sys, subprocess, re, hashlib
import psycopg

container = "codex-credo-capacity-pg16"
context = subprocess.check_output(
    ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    text=True,
).strip()
if not context.startswith("unix://"):
    raise RuntimeError("Only a local Docker context is allowed")
m = subprocess.check_output(
    ["docker", "port", container, "5432/tcp"], text=True
).strip()
port = re.fullmatch(r"127\.0\.0\.1:(\d+)", m)
if not port:
    raise RuntimeError("Only the dedicated localhost Docker fixture is allowed")


def connect(database="synthetic_wallet", **kwargs):
    return psycopg.connect(
        host="127.0.0.1",
        port=int(port[1]),
        user="postgres",
        dbname=database,
        autocommit=True,
        **kwargs,
    )


def enc(value, n):
    return (hashlib.md5(value.encode()).digest() * 45)[:n]


def category(i):
    n = (i // 100) % 100
    return (
        "message"
        if n < 60
        else (
            "proof"
            if n < 80
            else "connection" if n < 90 else "did" if n == 90 else "other"
        )
    )


def profile(i):
    return 1 if i % 100 < 31 else 2 if i % 100 < 52 else 3 + i % 26


def value(i, t):
    return {
        1: f"exchange-{i}",
        2: str(i % 3),
        3: "present-proof",
        4: "2",
        5: "sender" if i % 2 == 0 else "receiver",
        6: f"thread-{i}",
    }[t]
