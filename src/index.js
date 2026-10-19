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

// app es tu servidor: aquí se registran las rutas y la configuración.
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

// Máximo de minutos de antelación para cancelar una reserva.
const MIN_MINUTOS_CANCELACION = 30;
// ─────────────────────────────────────────────────────────────
// 4. FUNCIONES DE APOYO: formatos y fechas
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
    // Sustituye al if (!hora.minutes) anterior con el mismo resultado
    // y en una sola línea.
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

function aMinutos(hora) {
    const [horaText, minutosText] = hora.split(':');
    return Number(horaText) * 60 + Number(minutosText);
}

// funcion de cancelacio

function sePuedeCancelar(fecha, hora) {

    const hoyMadrid = hoyEnMadrid();

    const horaMadrid = horaActualEnMadrid();


    if (fecha > hoyMadrid) {
        return true;
    }
    if (fecha < hoyMadrid) {
        return false;
    }

    const minutosFaltantes = aMinutos(hora) - aMinutos(horaMadrid);

    if (minutosFaltantes >= MIN_MINUTOS_CANCELACION) {
        return true;
    }
    return false;
}


// ─────────────────────────────────────────────────────────────
// 5. VALIDACIÓN
// ─────────────────────────────────────────────────────────────

// Devuelve { error: 'codigo' } si algún dato no vale, o null si todo está bien.
// El código es para CX (que decide qué frase decir), no para el cliente.
// Orden: primero lo que impide seguir comprobando, después el resto.


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
// Devuelve { error: 'codigo' } si algo no vale, o
// { datos: { nombre, telefono, notas } } con los datos ya limpios.
function validarDatosClientes(params) {
    // 1) Presencia de los obligatorios. (Tu código, sin cambios.)
    if (!params.nombre || !params.telefono) {
        return { error: 'faltan_datos' };
    }

    // ── NOMBRE ──────────────────────────────────────────────

    // CAMBIO: typeof sobre params.nombre (lo que llega), no sobre la
    // variable nombre, que aún no existe → antes daba ReferenceError.
    // CAMBIO: código con guion bajo, como los demás errores.
    if (typeof params.nombre !== 'string') {
        return { error: 'nombre_invalido' };
    }

    // CAMBIO: guardamos el nombre YA recortado. Antes se comprobaba
    // el recortado pero se guardaba el original con espacios.
    const nombre = params.nombre.trim();

    // CAMBIO: una sola condición para vacío y para demasiado largo,
    // con la constante MAX_NOMBRE en vez de 50 escrito a mano.
    if (nombre === '' || nombre.length > MAX_NOMBRE) {
        return { error: 'nombre_invalido' };
    }

    // ── TELÉFONO ────────────────────────────────────────────

    const resultadoTelefono = validarTelefono(params.telefono);
    if (resultadoTelefono.error) {
        return { error: resultadoTelefono.error };
    }
    const telefono = resultadoTelefono.telefono;

    // ── NOTAS (opcional) ────────────────────────────────────

    // CAMBIO: empieza en null. Si no hay notas válidas, se queda así.
    let notas = null;

    // CAMBIO: typeof sobre params.notas, no sobre notas (que es null
    // y siempre daba false). Todo lo demás va DENTRO de este if, así
    // nunca se hace .trim() sobre undefined o null (antes: TypeError).
    if (typeof params.notas === 'string') {
        const notasLimpias = params.notas.trim();

        // CAMBIO: constante MAX_NOTAS y código con guion bajo.
        if (notasLimpias.length > MAX_NOTAS) {
            return { error: 'notas_demasiado_largas' };
        }

        // CAMBIO: unas notas vacías NO son un error (son opcionales):
        // simplemente no las guardamos y notas sigue siendo null.
        if (notasLimpias !== '') {
            notas = notasLimpias;
        }
    }

    // CAMBIO (nuevo): faltaba el return con los datos limpios.
    // { nombre, telefono, notas } es abreviatura de
    // { nombre: nombre, telefono: telefono, notas: notas }.
    return { datos: { nombre, telefono, notas } };
}


// validar solo el telefono como objecto no como params
function validarTelefono(telefono) {
    if (!telefono) {
        return { error: 'faltan_datos' };
    }
    if (typeof telefono !== 'string') {
        return { error: 'telefono_invalido' };
    }
    if (telefono.trim() === "") {
        return { error: 'faltan_datos' };
    }

    telefono = telefono.replace(/[\s\-.()]/g, '');

    if (telefono.startsWith('+34')) {
        telefono = telefono.slice(3);
    }
    if (!/^[6789]\d{8}$/.test(telefono)) {
        return { error: 'telefono_invalido' };
    }

    return { telefono };
}






// ─────────────────────────────────────────────────────────────
// 6. LÓGICA DE CADA ETIQUETA
// ─────────────────────────────────────────────────────────────+
async function plazasOcupadas(db, fecha, hora) {
    const resultado = await db.query(
        `SELECT COALESCE(SUM(personas), 0) AS total_personas
         FROM reservas
         WHERE estado = 'confirmada' AND fecha = $1 AND hora = $2`,
        [fecha, hora]
    );
    return Number(resultado.rows[0].total_personas);

}


// IMPORTANTE (formato de respuesta): CX FUSIONA los parámetros que le
// devolvemos con los que ya tenía la sesión; no los sustituye.
// Por eso esta función devuelve SIEMPRE las dos claves, error y disponible,
// poniendo null en la que no aplica. En CX, enviar null borra el parámetro.
// Así nunca queda un "error" viejo de un intento anterior.

// async: la función consulta la base de datos (tarda) y devuelve una promesa.
async function verificarDisponibilidad(params) {
    // Antes de nada, comprobamos los datos. Si hay un problema, no
    // llegamos a consultar la base de datos.
    const problema = validarReserva(params);
    if (problema) {
        return { disponible: null, error: problema.error };
    }

    // Traducimos los datos de CX al formato de la base de datos.
    const fecha = aFechaSQL(params.fecha);
    const hora = aHoraSQL(params.hora);

    // await: espera a que PostgreSQL responda antes de seguir.
    // $1 y $2 se rellenan con [fecha, hora] de forma segura
    // (consulta parametrizada: evita la inyección SQL).
    // Consultamos la base de datos.

    const ocupadas = await plazasOcupadas(pool, fecha, hora);

    // Hay sitio si las ocupadas más las nuevas no superan la capacidad.
    const disponible = ocupadas + params.personas <= CAPACIDAD_POR_HORA;


    // error: null borra en CX cualquier error de un intento anterior.
    return { disponible, error: null };

}

async function crearReserva(params) {

    // Antes de nada, comprobamos los datos.
    const validarRes = validarReserva(params);
    if (validarRes) {
        return { reserva_creada: false, id_reserva: null, error: validarRes.error };
    }

    // Comprobamos los datos de los clientes.
    const validarClientes = validarDatosClientes(params);
    // Si hay error, no llegamos a consultar la base de datos.
    if (validarClientes.error) {
        return {
            reserva_creada: false,
            id_reserva: null,
            error: validarClientes.error
        };
    }

    // Traducimos los datos de CX al formato de la base de datos.
    const fecha = aFechaSQL(params.fecha);
    const hora = aHoraSQL(params.hora);
    const { nombre, telefono, notas } = validarClientes.datos;

    // Conexión propia: una transacción solo existe dentro de UNA conexión.
    // Fuera del try: si falla, no hay cliente que liberar y el error sube tal cual (500).
    const client = await pool.connect();
    let conexionRota = false; // si el ROLLBACK falla, no devolvemos esta conexión al pool

    // await: espera a que PostgreSQL responda antes de seguir.
    // $1 y $2 se rellenan con [fecha, hora] de forma segura
    // (consulta parametrizada: evita la inyección SQL).
    try {
        await client.query('BEGIN');

        // Bloqueo de la franja: otra petición para la misma fecha+hora espera aquí
        // hasta que esta transacción haga COMMIT o ROLLBACK (se libera solo).
        await client.query('SELECT pg_advisory_xaclt_lock(hashtext($1))', [`${fecha} ${hora}`]);

        // Con el bloqueo ya tomado, este conteo no puede quedarse desfasado
        const ocupadas = await plazasOcupadas(client, fecha, hora);

        // Hay sitio si las ocupadas más las nuevas no superan la capacidad.
        // Si no, ROLLBACK y no creamos la reserva.
        // client y no pool: la transacción es exclusiva de esta conexión.
        if (ocupadas + params.personas > CAPACIDAD_POR_HORA) {
            await client.query('ROLLBACK'); // nunca salir del try con la transacción abierta
            return { reserva_creada: false, id_reserva: null, error: 'sin_disponibilidad' };
        }
        const resultado = await client.query(
            `INSEERT INTO reservas (fecha, hora, personas, estado, nombre, telefono, notas)
             VALUES ($1, $2, $3, 'confirmada', $4, $5, $6)
             RETURNING id`,
            [fecha, hora, params.personas, nombre, telefono, notas]
        );

        await client.query('COMMIT');
        return { reserva_creada: true, id_reserva: resultado.rows[0].id, error: null };

    } catch (error) {
        // ROLLBACK protegido: si falla, no debe tapar el error original
        try {
            await client.query('ROLLBACK');
        } catch (errorRollback) {
            console.error('Fallo en ROLLBACK:', errorRollback);
            conexionRota = true;
        }

        // Duplicado (mismo teléfono y día): es un error de datos, no de servidor → no 500
        if (error.code === '23505' && error.constraint === 'uq_reserva_telefono_dia') {
            return { reserva_creada: false, id_reserva: null, error: 'reserva_duplicada' };
        }
        throw error; // cualquier otra cosa sí es fallo de servidor → 500 → CX pasa a una persona

    } finally {
        // Se ejecuta siempre, también tras un return. Con true, pg destruye la conexión en vez de reutilizarla.
        client.release(conexionRota);
    }
}



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

    if (!params.fecha) {
        return {
            reserva_encontrada: false,
            reserva_hora: null,
            reserva_personas: null,
            error: 'faltan_datos'
        };
    }

    const fechaValida = esFechaReal(params.fecha);



    if (!fechaValida) {
        return {
            reserva_encontrada: false,
            reserva_hora: null,
            reserva_personas: null,
            error: 'fecha_invalida'
        };
    }



    const fecha = aFechaSQL(params.fecha);

    if (fecha < hoyEnMadrid()) {
        return {
            reserva_encontrada: false,
            reserva_hora: null,
            reserva_personas: null,
            error: 'fecha_pasada'
        };
    }

// ___________________________
// Busca la reserva
//____________________________
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
    if (!sePuedeCancelar(fecha, fila.hora.slice(0, 5))) {
        return {
          
            reserva_encontrada: false,
            reserva_hora: null,
            reserva_personas: null,
            error: 'cancelacion_fuera_de_plazo'
        };
    }

    return {
        reserva_encontrada: true,
        reserva_hora: fila.hora.slice(0, 5),
        reserva_personas: fila.personas,
        error: null
    };




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

        // Cada etiqueta del documento de la Fase 1 será un case.
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
        // ($session.params.disponible, $session.params.error).
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