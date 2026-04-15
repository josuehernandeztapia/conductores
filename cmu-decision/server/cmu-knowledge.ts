/**
 * CMU Knowledge Base — SSOT v1 (March 2026)
 * 
 * Single Source of Truth for the WhatsApp agent and PWA.
 * Content extracted from CMU_SSOT_v1.html, structured for LLM consumption.
 * Dynamic sections built from business_rules DB.
 * 
 * Sections are tagged by role: ALL, CLIENTE, PROMOTOR, RESPONSABLE, SISTEMA
 */

import type { BusinessRule } from "./business-rules";
import { ruleNum, ruleStr, ruleBool, getRulesByCategory } from "./business-rules";

type RulesMap = Map<string, BusinessRule>;

// ===== STATIC CONTENT (does not change unless SSOT version changes) =====

const SSOT_PRODUCTO = `=== PROGRAMA CONDUCTORES DEL MUNDO (CMU) — SSOT v1 ===

EMPRESA: Conductores del Mundo, S.A.P.I. de C.V.
RFC: CMU201119DD6
Domicilio: Lago de Chapultepec 6-40, Cañadas del Lago, Corregidora, Qro.
CLABE pagos: 152680120000787681 (Bancrea)
Referencia: numero de folio del taxista
Asesor(a) de campo: Promotor CMU asignado
Zona: EXCLUSIVAMENTE Aguascalientes, Mexico

--- PROPUESTA DE VALOR (PARA EL CLIENTE) ---
Renueva tu taxi. Paga con lo que ya gastas en GNV.
CMU te ofrece un vehiculo seminuevo con kit GNV instalado, sin buro, sin aval.
Tu consumo de gas natural en estaciones con convenio CMU abona automaticamente a tu cuota cada mes.
Das 8 semanas para vender tu unidad actual sin presion — ese dinero abona directo a tu credito.
Al terminar el credito en regla, recuperas hasta $20,000 de tu Fondo de Garantia.
Sin buro. Sin aval. Cuota decrece cada mes. Fondo devuelto mes 37.

--- CONTEXTO PROMOTOR ---
Programa TSR (Taxi Renewal) dirigido exclusivamente a taxistas de Aguascalientes con concesion vigente.
CMU compra vehiculos siniestrados a aseguradoras, los repara, instala kit GNV, y financia directamente al taxista.
El recaudo del sobreprecio GNV en estaciones con convenio CMU funciona como canal de cobro automatico.
Exito del promotor = folios llevados a estado FIRMADO.
El sistema valida eligibilidad automaticamente — el promotor captura documentos y acompana al cliente.`;

const SSOT_VEHICULOS = `--- VEHICULOS DISPONIBLES (Marzo 2026) ---
1. Chevrolet Aveo 2022 — Contado: $200,000 | Plazos: $270,390 | Anticipo sem.8: $50k | GNV cubre: Mes 34 | DISPONIBLE
2. Nissan March Sense 2021 — Contado: $195,000 | Plazos: $263,085 | Anticipo sem.8: $50k | GNV cubre: Mes 33 | DISPONIBLE
3. Nissan March Advance 2021 — Contado: $224,000 | Plazos: $305,453 | Anticipo sem.8: $50k | GNV cubre: NUNCA | DISPONIBLE
   ALERTA: Con 400 LEQ a $11, el recaudo GNV NUNCA cubre la cuota del March Advance. El cliente SIEMPRE pagara diferencial. Comunicar claramente.

Kit GNV: Si entregas tu tanque → precio no aumenta. Sin tanque → +$9,400 al precio (o $0 si promo activa).
Precio CMU NUNCA excede el promedio de mercado del vehiculo sin GNV.`;

const SSOT_PERFILES = `--- PERFILES DE ELEGIBILIDAD ---

REQUISITOS GENERALES (todos los perfiles):
- Titular de CONCESION DE TAXI VIGENTE en Aguascalientes
- El solicitante debe ser el TITULAR de la concesion — NO el operador
- Zona: exclusivamente Aguascalientes, Ags.
- Unidad actual operando activamente

PERFIL A — Usuario GNV Activo:
- Consumo promedio: >= 400 LEQ/mes comprobable
- Minimo 10 tickets del ultimo mes para inferir consumo
- Documento: Historial de cargas GNV

PERFIL B — Gasolina / New Entrant:
- Consumo equivalente: >= 400 litros gasolina/mes (aprox $9,600/mes a $24/L)
- Minimo 10 tickets del ultimo mes para inferir consumo mensual
- Documento: Tickets o facturas de gasolina recientes`;

const SSOT_DOCUMENTOS = `--- DOCUMENTOS REQUERIDOS (11) ---
01. INE Frente — Titular de la concesion, vigente
02. INE Reverso — Misma INE
03. Tarjeta de Circulacion — Unidad actual
04. Factura del Vehiculo Actual — Unidad que opera hoy
05. Constancia de Situacion Fiscal — SAT, maximo 3 meses de antiguedad
06. Comprobante de Domicilio — Maximo 3 meses de antiguedad
07. Concesion de Taxi — Vigente, Aguascalientes
08. Estado de Cuenta Bancario — Caratula con CLABE 18 digitos visible
09. Historial GNV (Perfil A) o Tickets Gasolina (Perfil B) — minimo 10 tickets del ultimo mes
10. Carta de Membresia Gremial — Agrupacion de taxistas
11. Selfie con INE — Foto en tiempo real, INE legible junto al rostro
12. CURP — descarga gratuita en gob.mx/curp
13. Acta de nacimiento
14. Fotos de la unidad actual (4 fotos: frente, trasera, laterales)

Adicional: INE y licencia del/los operador(es) + 4 fotos unidad actual (frente, trasera, laterales).
INE = FUENTE DE VERDAD para cross-check de todos los demas documentos.`;

const SSOT_FLUJO_PAGOS = `--- 8 PASOS DEL PROGRAMA (FLUJO DE PAGOS) ---
1. VALIDACION (Dia 1): CMU revisa historial GNV o tickets gasolina. Sin buro, sin aval. Resultado inmediato.
2. ENTREGA TANQUE GNV (si aplica): Si tu unidad tiene tanque, lo entregan al taller CMU. Se instala en tu vehiculo nuevo. Precio no aumenta.
3. DEPOSITO FONDO DE GARANTIA ($8,000): Deposita a CLABE 152680120000787681 (Bancrea). Al confirmar, se agenda entrega.
4. RECIBES TU VEHICULO (~Dia 25): Firmas Contrato de Compraventa + Pagare de Anticipo. Vehiculo con kit GNV instalado y calibrado.
5. MESES 1-2 (8 semanas): Tienes 8 semanas para vender tu unidad actual sin prisa. Tu recaudo GNV abona automaticamente. Diferencial via Conekta.
6. SEMANA 8 — ANTICIPO $50,000: Al vender tu unidad, depositas $50k a capital. Cuota baja significativamente desde mes 3.
7. MESES 3-36 — CUOTA DECRECIENTE: Cuota baja cada mes. Cuando GNV cubra cuota completa, pagas solo $334 del Fondo.
8. MES 37 — FONDO REGRESA: CMU transfiere automaticamente saldo remanente del FG a tu CLABE. Sin tramites. Hasta $20,000.`;

const SSOT_COBERTURA = `--- TABLA DE COBERTURA MENSUAL ---
SITUACION → QUE HACE CMU → TU PAGAS:
1. Tu GNV cubre la cuota completa → Aplica $334 al Fondo. Notifica saldo. → Solo $334/mes
2. GNV cubre + FG ya en $20,000 → FG estabilizado. Sin cobro adicional. → $0 ese mes
3. GNV no cubre + FG tiene saldo → Descuenta diferencial del FG automaticamente → $334 o $0
4. GNV no cubre + FG en $0 → Liga de pago WhatsApp. 5 dias habiles. → Diferencial + $334
5. No pagas en 5 dias habiles → Mora: $250 fijos + 2%/mes sobre saldo → Deuda + mora
6. 3 meses consecutivos sin regularizar → Rescision del contrato → CMU recupera vehiculo`;

const SSOT_FAQ = `--- FAQ CONVERSACIONAL (respuestas exactas para el agente) ---

P: Necesito tener buen historial crediticio?
R: No. CMU no consulta buro de credito. La calificacion se basa en tu historial de consumo GNV (Perfil A) o en tus tickets de gasolina del ultimo mes (Perfil B, minimo 10 tickets). Si consumes gas regularmente, eso es tu garantia.

P: Que pasa si un mes no consumo suficiente GNV?
R: CMU aplica automaticamente el diferencial de tu Fondo de Garantia. No caes en mora ni tienes que hacer nada. Solo recibes un WhatsApp con el saldo actualizado de tu Fondo.

P: Cuanto tiempo tengo para vender mi unidad actual?
R: Tienes exactamente 8 semanas (56 dias) desde que firmas el contrato. Al venderla, los $50,000 abonan directamente a tu credito.

P: Que pasa si no vendo mi unidad en la semana 8?
R: Contacta a tu promotor antes del dia 56 — existen mecanismos de prorroga caso por caso.

P: Por que la cuota baja cada mes?
R: Amortizacion alemana: el principal es fijo, pero los intereses se calculan sobre el saldo que va quedando. Saldo baja → intereses bajan → cuota baja.

P: El Fondo de Garantia es mio?
R: Si. CMU lo administra a tu nombre. Al terminar sin adeudos, te depositan automaticamente el saldo en tu cuenta mes 37.

P: El vehiculo esta a mi nombre desde el principio?
R: No. Contrato con reserva de dominio: vehiculo a nombre de CMU hasta liquidacion total. En la practica opera igual. Al pagar la ultima cuota, CMU transfiere el dominio.

P: Puedo cancelar antes de los 36 meses?
R: Si, puedes liquidar anticipadamente el saldo insoluto en cualquier momento.

P: Que pasa si el vehiculo se siniestra?
R: Es tu responsabilidad mantener seguro vehicular vigente. En caso de siniestro, el seguro cubre la unidad.

P: Que pasa si necesito reparar el vehiculo?
R: Mantenimiento ordinario corre por tu cuenta. Garantia limitada en primeros meses por la reparacion de CMU. Revista anual en agencia autorizada.`;

const SSOT_ORIGINACION = `--- FLUJO DE ORIGINACION (10 PASOS — GUIA PROMOTOR) ---
1. CREAR FOLIO (PWA): Abrir PWA, crear folio. Sistema genera ID. Estado: BORRADOR.
2. CAPTURAR INE (OCR automatico): Fotografiar INE frente y reverso. OCR extrae nombre, CURP, INE#, vigencia.
3. SELECCIONAR PERFIL: Preguntar si consume GNV (A) o gasolina (B). Capturar historial segun perfil.
4. VALIDAR ELEGIBILIDAD (Sistema): Concesion vigente, zona AGS, consumo >= 400 LEQ/mes (o equivalente gasolina). Si falla, indica motivo.
5. CAPTURAR DOCUMENTOS 3-11: OCR valida vigencias. Si calidad mala, indica recaptura.
6. SELECCIONAR VEHICULO: Mostrar disponibles con amortizacion. Verificar promo kit. Confirmar.
7. GENERAR CONTRATO (Auto): Sistema genera Compraventa + Pagare con datos del folio.
8. FIRMA DIGITAL (Mifiel): Widget en tableta. Cliente firma con INE visible.
9. ENVIAR A APROBACION: Estado → FIRMADO. Responsable CMU recibe notificacion.
10. CONFIRMAR FG Y AGENDAR: Al aprobar, coordinar deposito FG ($8k) y agendar entrega vehiculo.

ESTADOS DEL FOLIO: BORRADOR → CAPTURANDO → VALIDADO → GENERADO → FIRMADO → APROBADO (o RECHAZADO)`;

const SSOT_SCRIPTS_OBJECION = `--- SCRIPTS DE OBJECION (para el agente y promotor) ---

OBJECION: "No tengo los $50,000 para el anticipo ahora"
RESPUESTA: No lo pagas hoy. Tienes 8 semanas — es el dinero que obtendras al vender tu unidad actual. No necesitas ese dinero hoy para empezar.

OBJECION: "Y si mi taxi no se vende en 8 semanas?"
RESPUESTA: Ocho semanas es suficiente para vender a buen precio sin rematar. Si surge algo inesperado, contacta a tu promotor antes del dia 56 para prorroga.

OBJECION: "No entiendo por que baja la cuota"
RESPUESTA: Es como tu credito: cada mes que pagas, el saldo baja, los intereses son menores, y la cuota total tambien baja.

OBJECION: "Y si un mes no cargo suficiente GNV?"
RESPUESTA: Para eso esta el Fondo de Garantia. CMU lo aplica automaticamente. No caes en mora. Solo recibes aviso con saldo actualizado.

OBJECION: "No tengo tanque GNV"
RESPUESTA: [Promo activa] Incluimos kit con tanque sin costo adicional. Mismo precio. [Sin promo] +$9,400 al precio. Pero ya no tendras gasto de gasolina.

OBJECION: "Como se que el carro esta bien reparado?"
RESPUESTA: CMU repara en talleres certificados. Inspeccion antes de entrega. Garantia de la reparacion primeros meses.

OBJECION: "Y si el agente de WhatsApp no entiende?"
RESPUESTA: Puedes escribir "HABLAR CON PROMOTOR" y te conectamos con un humano.`;

const SSOT_OBLIGACIONES = `--- OBLIGACIONES DEL PARTICIPANTE (CMU-OBL-001) ---

LEGALES Y REGULATORIAS:
- Mantener concesion de taxi VIGENTE durante los 36 meses del credito
- Alta en SAT con actividad de transporte terrestre de pasajeros (CSF vigente)
- Licencia de conducir vigente — propia del titular, o del operador autorizado si el titular no opera
- No ceder derechos del contrato sin autorizacion escrita de CMU

DEL VEHICULO:
- Mantener seguro vehicular vigente durante los 36 meses
- Realizar revista vehicular anual en instalaciones autorizadas
- Registrar el vehiculo en la agencia autorizada por CMU
- Mantener kit GNV instalado y en operacion — no desinstalar ni modificar

GNV Y RECAUDO:
- Consumir GNV exclusivamente en estaciones con convenio CMU para efectos del recaudo
- Mantener consumo minimo recomendado de 400 LEQ/mes
- Notificar a CMU cualquier cambio en placa, concesion o datos bancarios

FINANCIERAS:
- Depositar $50,000 de anticipo a capital en la semana 8 (dia 56). Origen: venta de unidad actual.
- Mantener cuenta bancaria activa con CLABE registrada en CMU
- Pagar diferenciales no cubiertos por GNV ni FG en maximo 5 dias habiles
- No usar el vehiculo como garantia ante terceros sin autorizacion de CMU

DOCUMENTOS ADICIONALES (no numerados en los 11 principales):
- INE y licencia de conducir del/los operador(es) si el titular no opera el taxi
- 4 fotos de la unidad actual (frente, trasera, lateral izquierda, lateral derecha)`;

const SSOT_MORA = `--- MORA Y RESCISION (CMU-MORA-001) ---

TABLA DE ESCALADA:
1. GNV cubre + FG tiene saldo → Automatico: CMU descuenta del FG. $0 cargo para el cliente.
2. GNV no cubre + FG agotado → Inmediato: liga de pago WhatsApp (Conekta). Plazo: 5 dias habiles. Pago: diferencial + $334.
3. No paga en 5 dias habiles → Dia 6: mora fija $250 + 2%/mes sobre saldo pendiente.
4. Mora acumulada mes 2 → Cargos acumulativos: $250 + 2%/mes (acumulado).
5. 3 meses consecutivos sin regularizar → Rescision automatica del contrato. CMU recupera el vehiculo.

IMPORTANTE: El Fondo de Garantia se aplica ANTES de activar cualquier cobranza. Mientras el FG tenga saldo, el cliente NUNCA cae en mora.`;

const SSOT_TERMINOS = `--- TERMINOS Y CONDICIONES (CMU-TC-001) ---

FINANCIAMIENTO:
- Tasa: 29.9% anual sobre saldo insoluto
- Metodo: Amortizacion alemana — principal fijo, interes y cuota decrecen cada mes
- Plazo: 36 meses
- Reserva de dominio: el vehiculo queda a nombre de CMU hasta liquidacion total del credito. En la practica opera igual — lo usas, lo aseguras, lo operas.
- Sin buro, sin aval: calificacion basada en historial GNV o tickets de gasolina
- Registro: gratuito, sin costo para entrar a lista de espera

ANTICIPO A CAPITAL — SEMANA 8:
- Monto: $50,000
- Origen: venta de la unidad actual del taxista
- Plazo: dia 56 despues de firma del contrato
- Si necesita mas tiempo: contactar promotor ANTES del dia 56 para prorroga caso por caso
- Consecuencia de no pagar: incumplimiento contractual

LIQUIDACION ANTICIPADA:
- El cliente puede liquidar el saldo insoluto en cualquier momento
- Contactar CMU para obtener saldo de liquidacion anticipada
- Al liquidar, CMU transfiere dominio del vehiculo al cliente

TRANSFERENCIA DE DOMINIO:
- Al pagar la ultima cuota (mes 36), CMU transfiere automaticamente el dominio del vehiculo al cliente
- Sin tramites adicionales por parte del cliente`;

const SSOT_FIRMA_MIFIEL = `--- FIRMA DE CONTRATOS — MIFIEL (CMU-OPS-FIRMA-001) ---

QUE ES: Mifiel es el servicio de firma electronica que usa CMU. El taxista firma el Contrato de Compraventa y el Pagare de Anticipo de forma digital, sin papel. La firma tiene validez legal completa.

TIPO DE FIRMA: Firma Electronica Simple con Consentimiento Verificable (FESCV). NO requiere e.firma del SAT ni archivos .cer/.key. Verificacion biometrica: foto INE frente/reverso + selfie (prueba de vida). Mifiel valida identidad automaticamente.

DOCUMENTOS QUE SE FIRMAN:
1. Contrato de Compraventa a Plazos con Reserva de Dominio
2. Pagare de Anticipo a Capital ($50,000)
Ambos se firman en una sola sesion.

FLUJO PRINCIPAL — WIDGET EN TABLETA DEL PROMOTOR:
1. El promotor abre el folio en la PWA (estado GENERADO = contratos listos)
2. Click en "Firmar contrato"
3. Se abre la pantalla de verificacion de Mifiel dentro de la PWA
4. El taxista sube foto de INE (frente y reverso)
5. El taxista se toma una selfie (prueba de vida)
6. Mifiel valida identidad biometrica y sella el documento con fecha, hora y evidencia
7. El folio pasa automaticamente a estado FIRMADO
8. El promotor y el taxista reciben confirmacion

FLUJO ALTERNATIVO — LINK POR WHATSAPP:
Cuando el promotor no esta fisicamente con el taxista:
1. El sistema genera un link de firma de Mifiel
2. Se envia por WhatsApp al numero del taxista
3. El taxista abre el link en su celular
4. Sube foto de INE, se toma selfie, Mifiel valida y firma
5. El folio pasa a FIRMADO automaticamente
NOTA: Este link tambien se puede enviar al promotor para que el lo comparta.

CORREO ELECTRONICO:
- Si el taxista tiene correo: se usa su correo
- Si NO tiene correo (caso comun): se usa el correo del promotor para recibir el PDF firmado
- El PDF firmado tambien queda guardado en el sistema de CMU

QUE RECIBE EL TAXISTA DESPUES DE FIRMAR:
- Confirmacion por WhatsApp: "Tu contrato ha sido firmado exitosamente"
- PDF del contrato firmado (si tiene correo, le llega ahi tambien)

PARA EL PROMOTOR — PUNTOS DE CONTROL:
- Verificar que los datos del contrato sean correctos ANTES de pedir la firma
- Verificar que la INE del taxista este visible durante la firma (evidencia)
- Si hay error en los datos, NO firmar — regresar al paso de generacion
- Despues de firma exitosa, verificar en la PWA que el folio este en estado FIRMADO`;

const SSOT_PAGOS_CONEKTA = `--- COBRO Y PAGOS — CONEKTA (CMU-OPS-PAGOS-001) ---

QUE ES: Conekta es el servicio de cobro que usa CMU. Genera ligas de pago que el taxista puede pagar en OXXO, por transferencia SPEI, o con tarjeta. CMU absorbe la comision de Conekta (el taxista paga el monto exacto).

QUE SE COBRA POR CONEKTA:
1. Fondo de Garantia inicial ($8,000) — al momento de agendar entrega
2. Diferencial mensual — cuando el recaudo GNV no cubre la cuota Y el FG esta en $0
3. Anticipo a capital ($50,000) — opcionalmente, si el taxista prefiere pagar por liga en vez de deposito directo

METODOS DE PAGO DISPONIBLES:
- OXXO: el taxista va a cualquier OXXO con el numero de referencia y paga en efectivo. Nota: OXXO cobra comision adicional al cliente (~$10-15 MXN en caja).
- Transferencia SPEI: desde la app del banco del taxista
- Tarjeta de debito/credito: en la liga de pago
- Deposito/transferencia directa: a la CLABE de CMU (152680120000787681 Bancrea) — sin usar Conekta

FLUJO DE COBRO AUTOMATICO (diferencial mensual):
1. Cierre mensual: el sistema calcula si el recaudo GNV cubrio la cuota
2. Si GNV no cubrio Y el FG esta en $0 → el sistema genera liga de pago Conekta
3. La liga se envia AUTOMATICAMENTE por WhatsApp al taxista
4. Al mismo tiempo, se notifica al promotor para que le recuerde al cliente
5. Mensaje al taxista: "Hola [nombre]. Tu recaudo GNV de este mes no cubrio la cuota completa. Diferencial: $[monto]. Paga aqui: [liga]. Tienes 5 dias habiles."
6. El taxista paga por el metodo que prefiera
7. Conekta notifica a CMU automaticamente cuando se recibe el pago
8. CMU actualiza el estado del pago en el sistema

FLUJO DE COBRO FG INICIAL ($8,000):
1. Folio aprobado → promotor genera liga de pago por $8,000
2. Liga se envia por WhatsApp al taxista
3. Taxista paga (OXXO, SPEI, tarjeta, o deposito directo a CLABE CMU)
4. Al confirmar pago → se agenda entrega del vehiculo

ALTERNATIVA SIN CONEKTA:
El taxista siempre puede pagar por deposito o transferencia directa a:
- CLABE: 152680120000787681 (Bancrea)
- Referencia: numero de folio del taxista
- En ese caso, el promotor o el responsable CMU confirma manualmente el deposito

PARA EL TAXISTA — COMO PAGAR:
Opcion 1 (OXXO): "Ve a cualquier OXXO. Dile al cajero que quieres pagar con referencia. Dale este numero: [referencia]. Paga $[monto]. Guarda tu ticket."
Opcion 2 (SPEI): "Abre tu app del banco. Haz una transferencia a la CLABE que aparece en la liga. El monto exacto es $[monto]."
Opcion 3 (Deposito directo): "Deposita $[monto] a CLABE 152680120000787681 en Bancrea. Pon como referencia tu numero de folio."

TIEMPOS:
- Liga de pago activa: 5 dias habiles
- Si no paga en 5 dias: se activa mora ($250 + 2%/mes)
- Pago en OXXO se refleja en 24-48 horas
- Pago SPEI se refleja en minutos
- Deposito bancario puede tardar 24 horas en conciliar

PARA EL PROMOTOR — PUNTOS DE CONTROL:
- Verificar que la liga se envio correctamente por WhatsApp
- Si el taxista dice "ya pague" pero el sistema no lo muestra: esperar 24-48h si fue OXXO/deposito
- Si la liga expiro: generar nueva liga desde la PWA
- Recordar al taxista antes del dia 5 si no ha pagado`;

const SSOT_MOTOR = `--- MOTOR FINANCIERO (uso interno — director/responsable) ---

4 METRICAS:
- %CMU = (costo_aseg + rep + kit) / precio_venta. Filtro rapido. <80% Excelente, 80-90% OK, >90% No.
- TIR Base = IRR todo costo t=0, con anticipo, sin FG en CFs. Piso minimo: 29.9% (tu propia tasa).
- TIR Real = IRR con Amex difiere aseg ~50d, con anticipo, sin FG. Minimo: 60%.
- MOIC = (total_cuotas + anticipo) / costo_total. Minimo: 1.4x.

REGLA: FG NO entra en flujos de caja del calculo de TIR. Es pasivo de CMU. Incluirlo inflaria TIR ~20-30pp.

REGLAS DE COMPRA:
- %CMU maximo: < 90%. Sobre 90%: NO COMPRAR.
- Reparacion maxima: <= 25% del costo_aseguradora.
- TIR Base minima: > 29.9%.
- TIR Real objetivo: > 60%.
- % compra aseguradora: <= 65% valor ML usado.`;

// ===== DYNAMIC SECTIONS (from business_rules DB) =====

function buildDynamicSections(rules: RulesMap): string {
  const fgInicial = ruleNum(rules, "fg_inicial", 8000);
  const fgMensual = ruleNum(rules, "fg_mensual", 334);
  const fgTecho = ruleNum(rules, "fg_techo", 20000);
  const fgDevoluible = ruleBool(rules, "fg_devoluible", true);
  const moraFee = ruleNum(rules, "mora_fee", 250);
  const mesesRescision = ruleNum(rules, "meses_rescision", 3);
  const leqBase = ruleNum(rules, "leq_base", 400);
  const leqMinimo = ruleNum(rules, "leq_minimo", 300);
  const leqRango = ruleStr(rules, "leq_rango_real", "300-500");
  const tasaAnual = ruleNum(rules, "tasa_anual", 0.299);
  const plazoMeses = ruleNum(rules, "plazo_meses", 36);

  const sections = [];

  sections.push(`
--- PARAMETROS FINANCIEROS (de DB, actualizados) ---
- Tasa: ${(tasaAnual * 100).toFixed(1)}% anual (${(tasaAnual / 12 * 100).toFixed(3)}% mensual) sobre saldo insoluto
- Plazo: ${plazoMeses} meses. Amortizacion alemana (principal fijo, cuota decreciente).
- Anticipo a capital: $50,000 en dia 56 (semana 8). Origen: venta de unidad actual.
- Fondo de Garantia: $${fgInicial.toLocaleString()} inicial + $${fgMensual}/mes. Techo $${fgTecho.toLocaleString()} (deja de cobrarse al llegar). Devoluible mes ${plazoMeses + 1}.
- Mora: $${moraFee} + 2%/mes sobre saldo. ${mesesRescision} meses consecutivos = rescision.
- Recaudo base: ${leqBase} LEQ/mes × tarifa GNV. Rango real: ${leqRango} LEQ/mes. Minimo: ${leqMinimo} LEQ.`);

  // Legal rules
  const legalRules = getRulesByCategory(rules, "legal");
  if (legalRules.length > 0) {
    sections.push(`\n--- OBLIGACIONES LEGALES ---`);
    for (const r of legalRules) {
      sections.push(`- ${r.description || r.key}: ${r.value}`);
    }
  }

  // Agent behavior rules
  const agentRules = getRulesByCategory(rules, "agente");
  if (agentRules.length > 0) {
    sections.push(`\n--- REGLAS DEL AGENTE ---`);
    for (const r of agentRules) {
      sections.push(`- ${r.value}`);
    }
  }

  return sections.join("\n");
}

/**
 * Build complete knowledge base using SSOT v1 + business_rules from DB.
 * This is injected into the LLM system prompt.
 */
export function buildKnowledgeBase(rules: RulesMap): string {
  return [
    SSOT_PRODUCTO,
    SSOT_VEHICULOS,
    SSOT_PERFILES,
    SSOT_DOCUMENTOS,
    SSOT_FLUJO_PAGOS,
    SSOT_COBERTURA,
    SSOT_OBLIGACIONES,
    SSOT_MORA,
    SSOT_TERMINOS,
    SSOT_FIRMA_MIFIEL,
    SSOT_PAGOS_CONEKTA,
    SSOT_FAQ,
    SSOT_ORIGINACION,
    SSOT_SCRIPTS_OBJECION,
    SSOT_MOTOR,
    buildDynamicSections(rules),
  ].join("\n\n");
}

/**
 * Build a shorter knowledge base for Canal A/B (taxista/promotora).
 * Excludes motor financiero and internal metrics.
 */
export function buildClientKnowledge(rules: RulesMap): string {
  return [
    SSOT_PRODUCTO,
    SSOT_VEHICULOS,
    SSOT_PERFILES,
    SSOT_DOCUMENTOS,
    SSOT_FLUJO_PAGOS,
    SSOT_COBERTURA,
    SSOT_OBLIGACIONES,
    SSOT_MORA,
    SSOT_TERMINOS,
    SSOT_FIRMA_MIFIEL,
    SSOT_PAGOS_CONEKTA,
    SSOT_FAQ,
    SSOT_SCRIPTS_OBJECION,
    buildDynamicSections(rules),
  ].join("\n\n");
}

/** Legacy export for backward compat */
export const CMU_KNOWLEDGE = SSOT_PRODUCTO + "\n" + SSOT_VEHICULOS + "\n" + SSOT_PERFILES + "\n" + SSOT_DOCUMENTOS;
