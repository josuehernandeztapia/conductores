# Menús por Rol — Especificación Definitiva CMU

## PROSPECTO (taxista, sin PIN)

**Trigger:** Cualquier mensaje nuevo desde número no registrado

**Saludo:**
```
Buenos días 👋

Soy el asistente de CMU (Conductores del Mundo). 
Te ayudo con un taxi seminuevo con kit de gas natural 
a 36 meses con cuota decreciente.

¿Cómo te llamas?
```

**En cualquier punto del flujo puede:**
- Preguntar dudas → RAG responde + mantiene estado
- Escribir "promotor" → escalación con contexto completo
- Escribir "saltar" → salta documento actual

**Footer en cada mensaje:**
- En docs: `Escribe *saltar* si no lo tienes, o *promotor* si necesitas ayuda.`
- En otros pasos: `¿Necesitas ayuda? Escribe *promotor* y te contactamos.`

---

## PROMOTORA (Ángeles, PIN 123456)

**Trigger:** Escribe "hola" o cualquier saludo

**Saludo:**
```
Buenos días 👋

📋 *2 trámites activos:*
• Pedro López (5d): 8/14 docs
• María Torres (1d): 0/14 docs

¿Qué necesitas?
1️⃣ Dudas del programa
2️⃣ Nuevo prospecto
3️⃣ Evaluar oportunidad
4️⃣ Ver inventario
```

**Opciones numeradas:**
| # | Comando | Acción |
|---|---------|--------|
| 1 | Dudas | Lista de temas FAQ con keywords |
| 2 | Nuevo prospecto | Pide nombre + teléfono → crea folio |
| 3 | Evaluar | Instrucciones de eval rápida |
| 4 | Inventario | Vehículos de la DB con precios CMU |

**Comandos de texto:**
| Comando | Acción |
|---------|--------|
| pendientes | Reporte de folios activos con estado |
| auditar | Auditoría cruzada de expediente |
| [nombre/folio] | Busca y abre expediente |
| [foto de doc] | Captura documento del prospecto activo |

**También puede:**
- Preguntar cualquier FAQ → RAG responde
- Escribir modelo+precio → evaluación rápida

---

## DIRECTOR (Josué, PIN 654321)

**Trigger:** Escribe "hola" o cualquier saludo

**Saludo:**
```
Buenos días Josué 👋

📋 *2 trámites activos:*
• Pedro López (5d): 8/14 docs
• María Torres (1d): 0/14 docs

¿Qué necesitas?
1️⃣ Dudas del programa
2️⃣ Nuevo prospecto
3️⃣ Evaluar oportunidad
4️⃣ Ver inventario

📊 *Director:*
• *números* — dashboard KPIs
• *cartera* — créditos y mora
• *mercado [modelo año]* — precios
• *cierre* — cierre mensual
• *auditar* — auditar expediente
```

**Opciones numeradas (idénticas a promotora):**
| # | Comando | Acción |
|---|---------|--------|
| 1 | Dudas | Lista de temas FAQ |
| 2 | Nuevo prospecto | Pide nombre + teléfono |
| 3 | Evaluar | Instrucciones eval rápida |
| 4 | Inventario | Vehículos con precios |

**Comandos exclusivos director:**
| Comando | Acción |
|---------|--------|
| números | Dashboard KPIs (pipeline, cartera, recaudo) |
| cartera | Estado de créditos + mora |
| mercado [marca modelo año] | Precios de mercado multi-fuente |
| [modelo] [precio]k rep [rep]k | Evaluación rápida con motor CMU |
| corrida [modelo] | Simulación financiera completa |
| cierre | Ejecutar cierre mensual |
| auditar | Auditoría cruzada de expediente |
| pendientes | Reporte de folios activos |
| [nombre/folio] | Busca expediente |
| Enviar CSV/Excel | Procesar recaudo NATGAS |

**También puede:**
- Todo lo que puede hacer la promotora
- Análisis conversacional (LLM) sobre evaluaciones previas

---

## PROVEEDOR (Lilia, PIN 000000)

**Saludo:**
```
Buenos días. Portal de proveedores CMU.
Envía tu archivo Excel de recaudo o escribe tu consulta.
```

**Puede:**
| Comando | Acción |
|---------|--------|
| Enviar Excel | Procesar recaudo |
| estado | Estado de recaudo actual |

---

## DEV (PIN 111111)

**Saludo:**
```
Dev mode. Sandbox activo.
```

**Puede:**
- Todo lo del director
- Sandbox de pruebas
- Test endpoints
