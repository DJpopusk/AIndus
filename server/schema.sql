-- Shared dataset: labels from users who agreed to share them.
-- No frames and no URLs here, only the CLIP B/32 embedding of the full frame (512 x float16) and the label.
CREATE TABLE IF NOT EXISTS labels (
  id      TEXT PRIMARY KEY,          -- random label id (only the extension knows it; Undo uses it)
  install TEXT NOT NULL,             -- random install id (Delete my data uses it)
  y       INTEGER NOT NULL,          -- 1: Indian, 0: not
  score   REAL,                      -- model score before the label
  site    TEXT NOT NULL,             -- instagram | youtube | other
  dtype   TEXT NOT NULL,             -- q8 | fp16 | fp32: embeddings from different weights differ slightly
  model   TEXT NOT NULL,             -- model (backbone) version
  ext     TEXT NOT NULL,             -- extension version
  day     TEXT NOT NULL,             -- YYYY-MM-DD, no time
  emb     BLOB NOT NULL              -- 1024 bytes: 512 x float16, little-endian
);
CREATE INDEX IF NOT EXISTS labels_install ON labels (install, day);
