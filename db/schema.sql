-- Tabla principal: una fila por reserva
CREATE TABLE
    IF NOT EXISTS reservas (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        telefono VARCHAR(15) NOT NULL,
        fecha DATE NOT NULL,
        hora TIME NOT NULL,
        personas SMALLINT NOT NULL CHECK (personas BETWEEN 1 AND 8),
        notas TEXT,
        estado VARCHAR(20) NOT NULL DEFAULT 'confirmada' CHECK (estado IN ('confirmada', 'cancelada')),
        creada_en TIMESTAMPTZ NOT NULL DEFAULT now ()
    );

-- Para localizar una reserva al cambiarla o cancelarla (buscar_reserva)
CREATE INDEX IF NOT EXISTS idx_reservas_telefono_fecha ON reservas (telefono, fecha);

-- Para calcular la disponibilidad de una fecha y hora (verificar_disponibilidad)
CREATE INDEX IF NOT EXISTS idx_reservas_fecha_hora ON reservas (fecha, hora);