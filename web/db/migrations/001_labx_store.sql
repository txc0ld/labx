CREATE TABLE public.labx_store (
  key text NOT NULL,
  value text NOT NULL,
  CONSTRAINT labx_store_pkey PRIMARY KEY (key),
  CONSTRAINT labx_store_key_nonempty CHECK (length(key) > 0)
);
