import { pool } from './db.js';

const fecha = '2026-10-09';
const hora = '21:00';

const resultado = await pool.query(
    `SELECT COALESCE(SUM(personas), 0) AS total_personas
   FROM reservas
   WHERE estado = 'confirmada' AND fecha = $1 AND hora = $2`,
    [fecha, hora]
);

console.log('Personas a esa hora:', resultado.rows[0].total_personas);


const resultado2 = await pool.query(
    `SELECT id, nombre, fecha, hora, personas, notas
   FROM reservas
   WHERE telefono = $1 AND fecha = $2 AND estado = 'confirmada'`,
    ['612345678', '2026-10-09']
);

const reserva = resultado2.rows[0];

if (reserva) {
    console.log('Encontrada:', reserva);
} else {
    console.log('No hay ninguna reserva con esos datos');
}

await pool.end();