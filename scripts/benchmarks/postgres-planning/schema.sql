CREATE EXTENSION pg_stat_statements;
CREATE FUNCTION synthetic_bytes(t text, n integer) RETURNS bytea LANGUAGE SQL IMMUTABLE STRICT AS $$SELECT substr(decode(repeat(md5(t), 45),'hex'),1,n)$$;
CREATE TABLE items(id bigint PRIMARY KEY, profile_id bigint NOT NULL, kind smallint NOT NULL, category bytea NOT NULL, name bytea NOT NULL, value bytea NOT NULL, expiry timestamp);
CREATE UNIQUE INDEX ix_items_uniq ON items(profile_id,kind,category,name);
CREATE INDEX ix_items_expiry ON items(profile_id,kind,category,name,expiry);
CREATE INDEX ix_items_name ON items(name);
CREATE TABLE items_tags(id bigserial PRIMARY KEY,item_id bigint NOT NULL REFERENCES items(id),name bytea NOT NULL,value bytea NOT NULL,plaintext smallint NOT NULL);
CREATE INDEX ix_items_tags_item_id ON items_tags(item_id);
CREATE INDEX ix_items_tags_name_enc ON items_tags(name,substr(value,1,12)) INCLUDE(item_id) WHERE plaintext=0;
CREATE INDEX ix_items_tags_name_plain ON items_tags(name,value) INCLUDE(item_id) WHERE plaintext=1;
INSERT INTO items
SELECT id, profile_id, (CASE WHEN id%15=0 THEN 2 ELSE 1 END)::smallint,
synthetic_bytes('category-'||profile_id||'-'||category,44),synthetic_bytes('name-'||id,65),synthetic_bytes('payload-'||id,703),NULL
FROM (SELECT id,CASE WHEN id%100<31 THEN 1 WHEN id%100<52 THEN 2 ELSE 3+id%26 END profile_id,
CASE WHEN (id/100)%100<60 THEN 'message' WHEN (id/100)%100<80 THEN 'proof' WHEN (id/100)%100<90 THEN 'connection' WHEN (id/100)%100=90 THEN 'did' ELSE 'other' END category
FROM generate_series(1,200000) id) r;
INSERT INTO items_tags(item_id,name,value,plaintext)
SELECT id,synthetic_bytes('profile-'||profile_id||'-tag-'||tag,43),synthetic_bytes('profile-'||profile_id||'-value-'||v,52),0
FROM items CROSS JOIN LATERAL (VALUES (1,'exchange-'||id),(2,(id%3)::text),(3,'present-proof'),(4,'2'),(5,CASE WHEN id%2=0 THEN 'sender' ELSE 'receiver' END),(6,'thread-'||id)) tags(tag,v)
ORDER BY id,tag;
ANALYZE;
