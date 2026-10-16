import pg from 'pg';

const { Pool, types } = pg;

// 1082 es el código interno del tipo DATE: lo dejamos como texto 'AAAA-MM-DD'
types.setTypeParser(1082, (valor) => valor);

export const pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
});