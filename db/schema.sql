-- Table: public.reservas

-- DROP TABLE IF EXISTS public.reservas;

CREATE TABLE IF NOT EXISTS public.reservas
(
    id integer NOT NULL GENERATED ALWAYS AS IDENTITY ( INCREMENT 1 START 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 ),
    nombre character varying(100) COLLATE pg_catalog."default" NOT NULL,
    telefono character varying(15) COLLATE pg_catalog."default" NOT NULL,
    fecha date NOT NULL,
    hora time without time zone NOT NULL,
    personas smallint NOT NULL,
    notas text COLLATE pg_catalog."default",
    estado character varying(20) COLLATE pg_catalog."default" NOT NULL DEFAULT 'confirmada'::character varying,
    creada_en timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT reservas_pkey PRIMARY KEY (id),
    CONSTRAINT reservas_personas_check CHECK (personas >= 1 AND personas <= 8),
    CONSTRAINT reservas_estado_check CHECK (estado::text = ANY (ARRAY['confirmada'::character varying, 'cancelada'::character varying]::text[]))
)

TABLESPACE pg_default;

-- Index: idx_reservas_fecha_hora

-- DROP INDEX IF EXISTS public.idx_reservas_fecha_hora;

CREATE INDEX IF NOT EXISTS idx_reservas_fecha_hora
    ON public.reservas USING btree
    (fecha ASC NULLS LAST, hora ASC NULLS LAST)
    WITH (fillfactor=100, deduplicate_items=True)
    TABLESPACE pg_default;
-- Index: idx_reservas_telefono_fecha

-- DROP INDEX IF EXISTS public.idx_reservas_telefono_fecha;

CREATE INDEX IF NOT EXISTS idx_reservas_telefono_fecha
    ON public.reservas USING btree
    (telefono COLLATE pg_catalog."default" ASC NULLS LAST, fecha ASC NULLS LAST)
    WITH (fillfactor=100, deduplicate_items=True)
    TABLESPACE pg_default;
-- Index: uq_reserva_telefono_dia

-- DROP INDEX IF EXISTS public.uq_reserva_telefono_dia;

CREATE UNIQUE INDEX IF NOT EXISTS uq_reserva_telefono_dia
    ON public.reservas USING btree
    (telefono COLLATE pg_catalog."default" ASC NULLS LAST, fecha ASC NULLS LAST)
    WITH (fillfactor=100, deduplicate_items=True)
    TABLESPACE pg_default
    WHERE estado::text = 'confirmada'::text;