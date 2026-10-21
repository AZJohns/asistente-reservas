//
// SERVIDOR WEB: la "ventanilla" que recibe las peticiones de CX
// (webhook del asistente de reservas)
//

// ─────────────────────────────────────────────────────────────
// 1. IMPORTACIONES
// ─────────────────────────────────────────────────────────────

// Express: la librería que crea el servidor HTTP.
import express from 'express';

// pool: la conexión a PostgreSQL que creaste en db.js.
import { pool } from './db.js';

// ─────────────────────────────────────────────────────────────
// 2. CREAR LA APLICACIÓN
// ─────────────────────────────────────────────────────────────

// app es el servidor: aquí se registran las rutas y la configuración.
const app = express();

// Middleware: algo que se ejecuta en cada petición ANTES de tu ruta.
// express.json() convierte el cuerpo JSON de la petición en un objeto
// JavaScript, accesible en req.body. Sin esta línea, req.body sería undefined.
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// 3. CONFIGURACIÓN DEL NEGOCIO
// ─────────────────────────────────────────────────────────────

// En MAYÚSCULAS por convención: son constantes de configuración,
// valores que no cambian mientras el programa está en marcha.

// Máximo de personas que caben en el comedor a una misma hora.
const CAPACIDAD_POR_HORA = 16;

// Zona horaria del restaurante. El servidor (Cloud Run) trabaja en UTC,
// así que "hoy" y "ahora" hay que calcularlos SIEMPRE en esta zona.
const ZONA_HORARIA = 'Europe/Madrid';

// Con cuántos días de antelación como máximo se puede reservar.
// DECISIÓN PROVISIONAL: ajusta el número a lo que quiera el negocio.
const MAX_DIAS_ANTELACION = 30;

// Longitud máxima del nombre: igual que la columna varchar(100) de la tabla.
const MAX_NOMBRE = 100;

// Longitud máxima de las notas (la columna es text, sin límite propio).
const MAX_NOTAS = 500;

// Mínimo de minutos de antelación con que se puede cancelar una reserva.
const MIN_MINUTOS_CANCELACION = 30;

// ─────────────────────────────────────────────────────────────
// 4. FUNCIONES DE APOYO: formatos, fechas y plazos
// ─────────────────────────────────────────────────────────────

// CX envía la fecha como objeto:  { year: 2026, month: 10, day: 9 }
// PostgreSQL espera un texto:     '2026-10-09'
function aFechaSQL(fecha) {
    // padStart(2, '0') rellena con ceros por la izquierda: '9' → '09'.
    const mes = String(fecha.month).padStart(2, '0');
    const dia = String(fecha.day).padStart(2, '0');
    return `${fecha.year}-${mes}-${dia}`;
}

// CX envía la hora como objeto:  { hours: 21, minutes: 0 }
// PostgreSQL espera un texto:    '21:00'
function aHoraSQL(hora) {
    const horas = String(hora.hours).padStart(2, '0');

    // ?? (fusión nula): si minutes no viene (null o undefined), usa 0.
    const minutos = String(hora.minutes ?? 0).padStart(2, '0');

    return `${horas}:${minutos}`;
}

// Devuelve la fecha de HOY en Madrid como texto 'AAAA-MM-DD'.
// El idioma 'sv-SE' (sueco) formatea las fechas justo así, por eso
// se usa: no tiene nada que ver con Suecia, es un truco de formato.
function hoyEnMadrid() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: ZONA_HORARIA });
}

// Devuelve la hora ACTUAL en Madrid como texto 'HH:MM' (formato 24 h).
function horaActualEnMadrid() {
    return new Date().toLocaleTimeString('sv-SE', {
        timeZone: ZONA_HORARIA,
        hour: '2-digit',
        minute: '2-digit',
    });
}

// Suma días a una fecha en texto: sumarDias('2026-10-31', 1) → '2026-11-01'.
// Se trabaja en UTC (la 'Z' del final y los métodos getUTC/setUTC) para que
// los cambios de horario de verano no muevan el día.
function sumarDias(fechaTexto, dias) {
    const d = new Date(`${fechaTexto}T00:00:00Z`);
    // setUTCDate gestiona solo los cambios de mes y de año.
    d.setUTCDate(d.getUTCDate() + dias);
    // toISOString() da '2026-11-01T00:00:00.000Z'; nos quedamos con
    // los 10 primeros caracteres: '2026-11-01'.
    return d.toISOString().slice(0, 10);
}

// ¿Existe de verdad esta fecha? El 30 de febrero, no.
// Truco: JavaScript no da error con fechas imposibles, las "desborda"
// (30 de febrero → 2 de marzo). Si el día o el mes cambian al crearla,
// es que la fecha no existía.
function esFechaReal(fecha) {
    // Primero, que los tres datos sean números enteros.
    if (!Number.isInteger(fecha.year) ||
        !Number.isInteger(fecha.month) ||
        !Number.isInteger(fecha.day)) {
        return false;
    }

    // En JavaScript los meses van de 0 a 11: por eso month - 1.
    const d = new Date(Date.UTC(fecha.year, fecha.month - 1, fecha.day));

    // Las tres comparaciones dan true o false; && exige que sean las tres true.
    return d.getUTCFullYear() === fecha.year &&
        d.getUTCMonth() === fecha.month - 1 &&
        d.getUTCDate() === fecha.day;
}

// Pasa una hora en texto a minutos desde medianoche, para poder restar horas.
// '20:30' → 1230. También vale '20:30:00' (formato de PostgreSQL):
// split(':') da ['20', '30', '00'] y solo se usan las dos primeras partes.
function aMinutos(textoHora) {
    const [horas, minutos] = textoHora.split(':');
    return Number(horas) * 60 + Number(minutos);
}

// ¿Se puede cancelar todavía una reserva? Solo si faltan al menos
// MIN_MINUTOS_CANCELACION minutos para su hora.
// fecha: texto 'AAAA-MM-DD' (de aFechaSQL). hora: texto 'HH:MM' o 'HH:MM:SS'.
function sePuedeCancelar(fecha, hora) {
    const hoy = hoyEnMadrid();

    // Dos fechas 'AAAA-MM-DD' se comparan bien como texto.
    if (fecha > hoy) {
        return true;
    }
    if (fecha < hoy) {
        return false;
    }

    // La reserva es hoy: ¿cuántos minutos faltan? Si su hora ya pasó,
    // el resultado es negativo y tampoco se puede cancelar.
    const horaActual = horaActualEnMadrid();
    const minutosFaltantes = aMinutos(hora) - aMinutos(horaActual);

    // >= : con justo 30 minutos de antelación todavía se puede.
    return minutosFaltantes >= MIN_MINUTOS_CANCELACION;
}

// ─────────────────────────────────────────────────────────────
// 5. VALIDACIÓN
// ─────────────────────────────────────────────────────────────

// El código es para CX (que decide qué frase decir), no para el cliente.
// Orden: primero lo que impide seguir comprobando, después el resto.

// Valida fecha, hora y personas. Devuelve { error } o null si todo es correcto.
function validarReserva(params) {
    // 1) ¿Están los tres datos?
    // En personas se usa == null (cierto con null y con undefined) y no
    // !params.personas, porque ! también sería cierto con el número 0,
    // y un 0 no es un dato que falta: es un dato fuera de rango.
    if (!params.fecha || !params.hora || params.personas == null) {
        return { error: 'faltan_datos' };
    }

    // Una hora sin "hours" no se puede interpretar: es un dato que falta.
    // Sin esta comprobación, aHoraSQL produciría 'undefined:00'.
    if (!Number.isInteger(params.hora.hours)) {
        return { error: 'faltan_datos' };
    }

    // 2) Personas: número entero entre 1 y 8.
    if (!Number.isInteger(params.personas) || params.personas < 1 || params.personas > 8) {
        return { error: 'personas_fuera_de_rango' };
    }

    // 3) La fecha tiene que existir. Va antes que las demás comprobaciones
    // de fecha, porque comparar una fecha imposible no tiene sentido.
    if (!esFechaReal(params.fecha)) {
        return { error: 'fecha_invalida' };
    }

    // Ya sabemos que es real: la pasamos a texto 'AAAA-MM-DD'.
    // Dos textos con ese formato se comparan bien con < y >, igual que
    // las horas 'HH:MM': mismo número de cifras, de mayor a menor peso.
    const fecha = aFechaSQL(params.fecha);
    const hoy = hoyEnMadrid();

    // 4) Ni en el pasado...
    if (fecha < hoy) {
        return { error: 'fecha_pasada' };
    }

    // 5) ...ni demasiado lejos en el futuro.
    if (fecha > sumarDias(hoy, MAX_DIAS_ANTELACION)) {
        return { error: 'fecha_demasiado_lejana' };
    }

    // 6) La hora tiene que estar dentro de un turno.
    const hora = aHoraSQL(params.hora);

    // >= y <= incluyen el extremo: las 13:00 y las 15:30 son válidas.
    const enComidas = hora >= '13:00' && hora <= '15:30';
    const enCenas = hora >= '20:00' && hora <= '22:30';

    // Hay error si NO está en comidas Y TAMPOCO en cenas.
    if (!enComidas && !enCenas) {
        return { error: 'hora_fuera_de_horario' };
    }

    // 7) Solo a en punto o a y media. slice(-2) de '21:15' devuelve '15'.
    const minutos = hora.slice(-2);
    if (minutos !== '00' && minutos !== '30') {
        return { error: 'hora_fuera_de_horario' };
    }

    // 8) Si la reserva es para hoy, la hora no puede haber pasado ya.
    // Ejemplo: son las 18:00 y piden hoy a las 13:00 → error.
    if (fecha === hoy && hora <= horaActualEnMadrid()) {
        return { error: 'hora_pasada' };
    }

    // Si ha llegado hasta aquí, ningún if ha encontrado un problema.
    return null;
}

// Valida y limpia los datos del cliente. Solo la usa crear_reserva.
// Devuelve SIEMPRE un objeto: { error } o { datos: { nombre, telefono, notas } }.
function validarDatosCliente(params) {
    if (!params.nombre || !params.telefono) {
        return { error: 'faltan_datos' };
    }

    // ── NOMBRE ──────────────────────────────────────────────

    // Tiene que ser texto: un número o un objeto no es un nombre.
    if (typeof params.nombre !== 'string') {
        return { error: 'nombre_invalido' };
    }

    // Se guarda sin espacios al principio ni al final.
    const nombre = params.nombre.trim();

    // Ni vacío (solo espacios) ni más largo que la columna de la tabla.
    if (nombre === '' || nombre.length > MAX_NOMBRE) {
        return { error: 'nombre_invalido' };
    }

    // ── TELÉFONO ────────────────────────────────────────────

    // validarTelefono decide el error; aquí solo se transmite tal cual.
    const resultadoTelefono = validarTelefono(params.telefono);
    if (resultadoTelefono.error) {
        return { error: resultadoTelefono.error };
    }
    const telefono = resultadoTelefono.telefono;

    // ── NOTAS (opcional) ────────────────────────────────────

    // Si no llegan notas válidas, se guarda null.
    let notas = null;

    // Solo se procesan si son texto; cualquier otra cosa se ignora.
    if (typeof params.notas === 'string') {
        const notasLimpias = params.notas.trim();

        if (notasLimpias.length > MAX_NOTAS) {
            return { error: 'notas_demasiado_largas' };
        }

        // Las notas son opcionales: si llegan vacías no es un error,
        // simplemente no se guardan y notas sigue siendo null.
        if (notasLimpias !== '') {
            notas = notasLimpias;
        }
    }

    // { nombre, telefono, notas } es abreviatura de
    // { nombre: nombre, telefono: telefono, notas: notas }.
    return { datos: { nombre, telefono, notas } };
}

// Valida y normaliza un teléfono español.
// Devuelve SIEMPRE un objeto: { telefono } ya limpio (p. ej. '612345678') o { error }.
// La usan crear_reserva (al guardar) y buscar/cancelar (al buscar): así el
// teléfono se normaliza exactamente igual en los dos casos y siempre coincide.
function validarTelefono(telefono) {
    // No ha llegado (undefined, null o texto vacío).
    if (!telefono) {
        return { error: 'faltan_datos' };
    }

    // Tiene que ser texto: un número, un objeto o un array no son válidos.
    if (typeof telefono !== 'string') {
        return { error: 'telefono_invalido' };
    }

    // Solo espacios: también es un dato que falta.
    if (telefono.trim() === '') {
        return { error: 'faltan_datos' };
    }

    // Quita espacios, guiones, puntos y paréntesis:
    // '+34 600-12-34-56' → '+34600123456'.
    telefono = telefono.replace(/[\s\-.()]/g, '');

    // Quita el prefijo +34 solo si está al principio:
    // '+34600123456' → '600123456'.
    if (telefono.startsWith('+34')) {
        telefono = telefono.slice(3);
    }

    // Se valida el valor YA limpio: 9 cifras empezando por 6, 7, 8 o 9.
    // ^ y $ = el patrón ocupa todo el texto; \d{8} = exactamente 8 cifras más.
    if (!/^[6789]\d{8}$/.test(telefono)) {
        return { error: 'telefono_invalido' };
    }

    return { telefono };
}

// ─────────────────────────────────────────────────────────────
// 6. LÓGICA DE CADA ETIQUETA
// ─────────────────────────────────────────────────────────────

// IMPORTANTE (formato de respuesta): CX FUSIONA los parámetros que le
// devolvemos con los que ya tenía la sesión; no los sustituye.
// Por eso cada función devuelve SIEMPRE las mismas claves, poniendo null
// en las que no aplican. En CX, enviar null borra el parámetro: así nunca
// queda un dato o un error viejo de un intento anterior.

// Suma las personas de las reservas confirmadas en una franja (fecha + hora).
// db: pool para una lectura suelta, o client si se llama dentro de una
// transacción (así la consulta va por la misma conexión).
async function plazasOcupadas(db, fecha, hora) {
    // $1 y $2 se rellenan con [fecha, hora] de forma segura
    // (consulta parametrizada: evita la inyección SQL).
    // COALESCE: si no hay reservas, SUM da null y lo cambiamos por 0.
    const resultado = await db.query(
        `SELECT COALESCE(SUM(personas), 0) AS total_personas
         FROM reservas
         WHERE estado = 'confirmada' AND fecha = $1 AND hora = $2`,
        [fecha, hora]
    );

    // pg devuelve la suma como texto (es un bigint): Number() la pasa a número.
    return Number(resultado.rows[0].total_personas);
}

// verificar_disponibilidad → { disponible, error }
// Comprueba si caben las personas en la franja pedida. No guarda nada.
// async: consulta la base de datos (tarda) y devuelve una promesa.
async function verificarDisponibilidad(params) {
    // Primero los datos: si hay un problema, no se consulta la base de datos.
    const problema = validarReserva(params);
    if (problema) {
        return { disponible: null, error: problema.error };
    }

    // Traducimos los datos de CX al formato de la base de datos.
    const fecha = aFechaSQL(params.fecha);
    const hora = aHoraSQL(params.hora);

    // await: espera a que PostgreSQL responda antes de seguir.
    const ocupadas = await plazasOcupadas(pool, fecha, hora);

    // Hay sitio si las ocupadas más las nuevas no superan la capacidad.
    const disponible = ocupadas + params.personas <= CAPACIDAD_POR_HORA;

    // error: null borra en CX cualquier error de un intento anterior.
    return { disponible, error: null };
}

// crear_reserva → { reserva_creada, id_reserva, error }
// Guarda la reserva si los datos son válidos y queda sitio en la franja.
// Usa una transacción con bloqueo para que dos peticiones simultáneas
// no puedan superar entre las dos la capacidad.
async function crearReserva(params) {
    // Antes de nada, los datos de la reserva (fecha, hora, personas).
    const problema = validarReserva(params);
    if (problema) {
        return { reserva_creada: false, id_reserva: null, error: problema.error };
    }

    // Después, los datos del cliente. Si hay error, no se toca la base de datos.
    const resultadoCliente = validarDatosCliente(params);
    if (resultadoCliente.error) {
        return { reserva_creada: false, id_reserva: null, error: resultadoCliente.error };
    }

    // Valores normalizados: se usan iguales en el bloqueo, el conteo y el INSERT.
    const fecha = aFechaSQL(params.fecha);
    const hora = aHoraSQL(params.hora);
    const { nombre, telefono, notas } = resultadoCliente.datos;

    // Conexión propia: una transacción solo existe dentro de UNA conexión.
    // Fuera del try: si falla, no hay cliente que liberar y el error sube tal cual (500).
    const client = await pool.connect();
    let conexionRota = false; // si el ROLLBACK falla, no devolvemos esta conexión al pool

    try {
        await client.query('BEGIN');

        // Bloqueo de la franja: otra petición para la misma fecha+hora espera aquí
        // hasta que esta transacción haga COMMIT o ROLLBACK (se libera solo).
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${fecha} ${hora}`]);

        // Con el bloqueo ya tomado, este conteo no puede quedarse desfasado.
        // client y no pool: la consulta tiene que ir por la conexión de la transacción.
        const ocupadas = await plazasOcupadas(client, fecha, hora);

        // Si no cabe: ROLLBACK y no se crea.
        // Nunca salir del try con la transacción abierta.
        if (ocupadas + params.personas > CAPACIDAD_POR_HORA) {
            await client.query('ROLLBACK');
            return { reserva_creada: false, id_reserva: null, error: 'sin_disponibilidad' };
        }

        // Consulta parametrizada: los valores van aparte ($1…$6), nunca dentro del texto.
        // RETURNING id: PostgreSQL devuelve el id de la fila recién creada.
        const resultado = await client.query(
            `INSERT INTO reservas (fecha, hora, personas, estado, nombre, telefono, notas)
             VALUES ($1, $2, $3, 'confirmada', $4, $5, $6)
             RETURNING id`,
            [fecha, hora, params.personas, nombre, telefono, notas]
        );

        await client.query('COMMIT');
        return { reserva_creada: true, id_reserva: resultado.rows[0].id, error: null };

    } catch (error) {
        // ROLLBACK protegido: si falla, no debe tapar el error original.
        try {
            await client.query('ROLLBACK');
        } catch (errorRollback) {
            console.error('Fallo en ROLLBACK:', errorRollback);
            conexionRota = true;
        }

        // Duplicado (mismo teléfono y día): es un error de datos, no de servidor → no 500.
        if (error.code === '23505' && error.constraint === 'uq_reserva_telefono_dia') {
            return { reserva_creada: false, id_reserva: null, error: 'reserva_duplicada' };
        }
        throw error; // cualquier otra cosa sí es fallo de servidor → 500 → CX pasa a una persona

    } finally {
        // Se ejecuta siempre, también tras un return.
        // Con true, pg destruye la conexión en vez de reutilizarla.
        client.release(conexionRota);
    }
}

// buscar_reserva → { reserva_encontrada, reserva_hora, reserva_personas, error }
// Primer paso de la cancelación: localiza la reserva confirmada de un teléfono
// en una fecha y comprueba que todavía se puede cancelar.
// Por privacidad solo devuelve hora y personas, nunca nombre ni notas.
async function buscarReserva(params) {
    // Valida y normaliza el teléfono. Devuelve { error } o { telefono }.
    const resultadoTelefono = validarTelefono(params.telefono);
    if (resultadoTelefono.error) {
        return {
            reserva_encontrada: false,
            reserva_hora: null,
            reserva_personas: null,
            error: resultadoTelefono.error // el código que decidió validarTelefono
        };
    }

    // A partir de aquí, el teléfono ya limpio (por ejemplo, '612345678').
    const telefono = resultadoTelefono.telefono;

    // La fecha, en este orden. Primero, que haya llegado: esFechaReal lee
    // fecha.year, y con undefined lanzaría un TypeError (500).
    if (!params.fecha) {
        return {
            reserva_encontrada: false,
            reserva_hora: null,
            reserva_personas: null,
            error: 'faltan_datos'
        };
    }

    // Después, que exista de verdad. esFechaReal necesita el objeto de CX,
    // no el texto: por eso va antes de normalizar.
    const fechaValida = esFechaReal(params.fecha);
    if (!fechaValida) {
        return {
            reserva_encontrada: false,
            reserva_hora: null,
            reserva_personas: null,
            error: 'fecha_invalida'
        };
    }

    // Por último, ya normalizada a 'AAAA-MM-DD', que no sea pasada.
    const fecha = aFechaSQL(params.fecha);
    if (fecha < hoyEnMadrid()) {
        return {
            reserva_encontrada: false,
            reserva_hora: null,
            reserva_personas: null,
            error: 'fecha_pasada'
        };
    }

    // Busca la reserva confirmada. El índice único (una confirmada por
    // teléfono y día) garantiza que como mucho hay una fila.
    const queryBuscarReserva = `SELECT hora, personas FROM reservas WHERE telefono = $1 AND fecha = $2 AND estado = 'confirmada'`;
    const resultado = await pool.query(queryBuscarReserva, [telefono, fecha]);
    const fila = resultado.rows[0];

    if (resultado.rows.length === 0) {
        return {
            reserva_encontrada: false,
            reserva_hora: null,
            reserva_personas: null,
            error: 'reserva_no_encontrada'
        };
    }

    // Fuera de plazo: no se dan datos de una reserva que no se puede cancelar.
    if (!sePuedeCancelar(fecha, fila.hora.slice(0, 5))) {
        return {
            reserva_encontrada: false,
            reserva_hora: null,
            reserva_personas: null,
            error: 'cancelacion_fuera_de_plazo'
        };
    }

    // pg devuelve la hora como '20:30:00': se recorta a '20:30' para CX.
    return {
        reserva_encontrada: true,
        reserva_hora: fila.hora.slice(0, 5),
        reserva_personas: fila.personas,
        error: null
    };
}

// cancelar_reserva → { reserva_cancelada, error }
// Segundo paso de la cancelación, cuando el cliente ya ha confirmado.
async function cancelarReserva(params) {
    // Reutiliza buscarReserva: valida los datos, comprueba que la reserva
    // existe y que está en plazo. Si hay error, se transmite tal cual.
    const resultadoBusqueda = await buscarReserva(params);
    if (resultadoBusqueda.error) {
        return { reserva_cancelada: false, error: resultadoBusqueda.error };
    }

    // Los datos ya están validados por buscarReserva: aquí solo se
    // normalizan para el UPDATE, sin volver a comprobar errores.
    const resultadoTelefono = validarTelefono(params.telefono);
    const fecha = aFechaSQL(params.fecha);

    // estado = 'confirmada' evita tocar reservas que ya estaban canceladas.
    const queryCancelarReserva = `UPDATE reservas SET estado = 'cancelada' WHERE telefono = $1 AND fecha = $2 AND estado = 'confirmada'`;
    const resultado = await pool.query(queryCancelarReserva, [resultadoTelefono.telefono, fecha]);

    // rowCount = filas modificadas. 0 significa que otra petición la canceló
    // justo entre la búsqueda y este UPDATE.
    if (resultado.rowCount === 0) {
        return { reserva_cancelada: false, error: 'reserva_no_encontrada' };
    }

    return { reserva_cancelada: true, error: null };
}

// ─────────────────────────────────────────────────────────────
// 7. LA RUTA: la "ventanilla" que recibe las peticiones de CX
// ─────────────────────────────────────────────────────────────

// Cuando llegue un POST a /webhook, Express ejecuta esta función.
// req (request) = lo que llega. res (response) = lo que vas a responder.
app.post('/webhook', async (req, res) => {
    // ?. (encadenamiento opcional): si fulfillmentInfo no existe,
    // devuelve undefined en vez de romper el programa.
    const etiqueta = req.body.fulfillmentInfo?.tag;

    // ?? (fusión nula): si no hay parámetros, usa un objeto vacío.
    const params = req.body.sessionInfo?.parameters ?? {};

    // try/catch: si algo falla dentro de try (por ejemplo, la base de
    // datos está apagada), salta al catch en vez de caerse el servidor.
    try {
        let respuesta;

        // Cada etiqueta del documento de la Fase 1 es un case.
        switch (etiqueta) {
            case 'verificar_disponibilidad':
                respuesta = await verificarDisponibilidad(params);
                break; // sin break seguiría al siguiente case

            case 'crear_reserva':
                respuesta = await crearReserva(params);
                break;

            case 'buscar_reserva':
                respuesta = await buscarReserva(params);
                break;

            case 'cancelar_reserva':
                respuesta = await cancelarReserva(params);
                break;

            // Cualquier etiqueta que no esté en la lista.
            // 400 = "Bad Request": el error es de quien envía la petición.
            // return corta aquí la función para no responder dos veces.
            default:
                return res.status(400).json({ error: `Etiqueta desconocida: ${etiqueta}` });
        }

        // Formato que espera Dialogflow CX: los datos van dentro de
        // sessionInfo.parameters y CX los guarda como parámetros de sesión
        // ($session.params.disponible, $session.params.error…).
        res.json({ sessionInfo: { parameters: respuesta } });
    } catch (error) {
        // Error completo en tu terminal, para depurar.
        console.error(error);

        // 500 = "Internal Server Error". Al cliente no le damos detalles
        // internos (buena práctica de seguridad). En CX esto dispara el
        // evento de error de webhook: el camino "pasar a una persona".
        res.status(500).json({ error: 'Error interno' });
    }
});

// ─────────────────────────────────────────────────────────────
// 8. ARRANCAR EL SERVIDOR
// ─────────────────────────────────────────────────────────────

// Cloud Run indica el puerto en la variable PORT. En local no existe,
// así que || usa 8080 como valor por defecto.
const PORT = process.env.PORT || 8080;

// A partir de aquí el programa no termina: se queda esperando peticiones.
app.listen(PORT, () => {
    console.log(`Webhook escuchando en http://localhost:${PORT}`);
});