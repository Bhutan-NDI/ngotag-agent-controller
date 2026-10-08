from pathlib import Path
from local_db import connect

with connect("postgres") as c:
    c.execute("CREATE DATABASE synthetic_wallet")
with connect() as c:
    c.execute((Path(__file__).parent / "schema.sql").read_text())
    assert c.execute("SELECT count(*) FROM items").fetchone()[0] == 200000
    assert c.execute("SELECT count(*) FROM items_tags").fetchone()[0] == 1200000
print("Seeded synthetic fixture")
