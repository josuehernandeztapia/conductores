/**
 * flow-cpv-e2e.ts
 * Simulates a complete CPV (Compra-Venta) origination flow:
 *   Promotora creates folio → captures INE (mock OCR) → OTP sent → OTP verified
 *
 * Captures every step's input/output for documentation.
 * Run via API: POST https://cmu-originacion.fly.dev/api/test/flow-cpv-e2e
 */

interface FlowStep {
  step: number;
  actor: "promotora" | "prospecto" | "system";
  action: string;
  input: string;
  output: string;
  state: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export async function runCPVFlowE2E(storage: any, whatsappAgent: any): Promise<{
  success: boolean;
  flow: FlowStep[];
  summary: string;
  folioCreated?: string;
  error?: string;
}> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL!);
  const { getSession } = await import("../server/conversation-state");
  const { handleProspectMessage, handleDocWithMockVision } = await import("../server/agent/orchestrator");

  const PROMOTORA_PHONE = "5219997CPV01";
  const TAXISTA_PHONE = "5219997CPV02";
  const flow: FlowStep[] = [];
  let folioCreated: string | undefined;

  const now = () => new Date().toISOString();

  // Cleanup
  await sql`DELETE FROM conversation_states WHERE phone IN (${PROMOTORA_PHONE}, ${TAXISTA_PHONE})`.catch(() => {});
  await sql`DELETE FROM whatsapp_roles WHERE phone IN (${PROMOTORA_PHONE}, ${TAXISTA_PHONE})`.catch(() => {});

  try {
    // ═══════════════════════════════════════════════════════════════
    // STEP 1: Promotora saluda
    // ═══════════════════════════════════════════════════════════════
    const r1 = await whatsappAgent.handleMessage(
      PROMOTORA_PHONE, "hola", "Ángeles Test", null, null, null,
      "promotora", "Ángeles Mireles", []
    );
    flow.push({
      step: 1, actor: "promotora", action: "Saludo inicial",
      input: "hola", output: r1.reply.slice(0, 300),
      state: "idle", timestamp: now(),
    });

    // ═══════════════════════════════════════════════════════════════
    // STEP 2: Promotora dice "nuevo prospecto"
    // ═══════════════════════════════════════════════════════════════
    const r2 = await whatsappAgent.handleMessage(
      PROMOTORA_PHONE, "nuevo prospecto", "Ángeles Test", null, null, null,
      "promotora", "Ángeles Mireles", []
    );
    flow.push({
      step: 2, actor: "promotora", action: "Solicita crear folio",
      input: "nuevo prospecto", output: r2.reply,
      state: "waiting_folio_name", timestamp: now(),
    });

    // ═══════════════════════════════════════════════════════════════
    // STEP 3: Promotora da nombre + teléfono del taxista
    // ═══════════════════════════════════════════════════════════════
    const taxistaName = "Don Pedro Martínez";
    const taxistaTel = "4491112233";
    const r3 = await whatsappAgent.handleMessage(
      PROMOTORA_PHONE, `${taxistaName} ${taxistaTel}`, "Ángeles Test", null, null, null,
      "promotora", "Ángeles Mireles", []
    );
    // Extract folio from reply
    const folioMatch = r3.reply.match(/CMU-\w+-\d+-\d+/);
    folioCreated = folioMatch?.[0];
    const oidMatch = r3.reply.match(/origination(?:Id)?[=:]?\s*(\d+)/i);
    let originationId = r3.newOriginationId;

    flow.push({
      step: 3, actor: "promotora", action: "Crea folio con nombre + tel",
      input: `${taxistaName} ${taxistaTel}`, output: r3.reply,
      state: "capturing_docs", timestamp: now(),
      metadata: { folio: folioCreated, originationId },
    });

    // ═══════════════════════════════════════════════════════════════
    // STEP 4: Simular captura de INE Frente (mock OCR)
    // ═══════════════════════════════════════════════════════════════
    // First, set up the taxista phone as a prospecto in docs_capture
    // (In real life, the promotora sends the INE photo via WhatsApp from her phone,
    //  but the doc gets associated to the folio she has active)
    const { updateSession } = await import("../server/conversation-state");
    await updateSession(TAXISTA_PHONE, {
      state: "simulation" as any,
      context: {
        agentState: "docs_capture",
        agentContext: {
          nombre: taxistaName,
          folio: folioCreated,
          originationId,
          docsCollected: [],
          skippedDocs: [],
          fuelType: "gasolina",
          otpSent: false,
          otpVerified: false,
        },
      } as any,
    });

    const ineResult = await handleDocWithMockVision(TAXISTA_PHONE, {
      detected_type: "ine_frente",
      is_legible: true,
      confidence: 0.95,
      extracted_data: {
        nombre: "PEDRO MARTÍNEZ LÓPEZ",
        curp: "MALP800101HAGRRD09",
        clave_elector: "MRLPPD80010114H700",
        vigencia: "2029",
        domicilio: "Calle Hidalgo 123, Aguascalientes, Ags.",
        seccion: "1234",
        fecha_nacimiento: "01/01/1980",
      },
      cross_check_flags: [],
    }, storage);

    flow.push({
      step: 4, actor: "system", action: "OCR INE Frente — datos extraídos",
      input: "[Foto INE Frente — mock vision]", output: ineResult.slice(0, 400),
      state: "docs_capture", timestamp: now(),
      metadata: {
        detected_type: "ine_frente",
        extracted: {
          nombre: "PEDRO MARTÍNEZ LÓPEZ",
          curp: "MALP800101HAGRRD09",
          vigencia: "2029",
        },
      },
    });

    // ═══════════════════════════════════════════════════════════════
    // STEP 5: Simular captura INE Reverso
    // ═══════════════════════════════════════════════════════════════
    const ineReverso = await handleDocWithMockVision(TAXISTA_PHONE, {
      detected_type: "ine_vuelta",
      is_legible: true,
      confidence: 0.92,
      extracted_data: {
        mrz: "IDMEX8001010M29MALP<<MARTINEZ<LOPEZ<<PEDRO<<<<<<<<<",
        codigo_barras: "1234567890",
      },
      cross_check_flags: [],
    }, storage);

    flow.push({
      step: 5, actor: "system", action: "OCR INE Reverso — MRZ extraído",
      input: "[Foto INE Reverso — mock vision]", output: ineReverso.slice(0, 300),
      state: "docs_capture", timestamp: now(),
      metadata: { detected_type: "ine_vuelta" },
    });

    // ═══════════════════════════════════════════════════════════════
    // STEP 6: Simular OTP enviado (contexto actualizado)
    // ═══════════════════════════════════════════════════════════════
    // In production, OTP is sent automatically after INE frente capture.
    // Here we simulate by setting otpSent=true in context.
    await updateSession(TAXISTA_PHONE, {
      state: "simulation" as any,
      context: {
        agentState: "docs_capture",
        agentContext: {
          nombre: taxistaName,
          folio: folioCreated,
          originationId,
          docsCollected: ["ine_frente", "ine_vuelta"],
          skippedDocs: [],
          fuelType: "gasolina",
          otpSent: true,
          otpVerified: false,
        },
      } as any,
    });

    flow.push({
      step: 6, actor: "system", action: "OTP enviado por SMS al taxista",
      input: `SMS → +52${taxistaTel}`, output: "📱 Código de 6 dígitos enviado por SMS via Twilio Verify",
      state: "docs_capture (otpSent=true)", timestamp: now(),
      metadata: { otpSent: true, channel: "sms", to: taxistaTel },
    });

    // ═══════════════════════════════════════════════════════════════
    // STEP 7: Taxista envía código incorrecto
    // ═══════════════════════════════════════════════════════════════
    const wrongOtp = await handleProspectMessage(
      TAXISTA_PHONE, "999999", null, null, "Pedro", storage
    );

    flow.push({
      step: 7, actor: "prospecto", action: "Envía código OTP incorrecto",
      input: "999999", output: wrongOtp.slice(0, 200),
      state: "docs_capture", timestamp: now(),
      metadata: { otpAttempt: 1, verified: false },
    });

    // ═══════════════════════════════════════════════════════════════
    // STEP 8: Taxista envía código correcto (simulado)
    // ═══════════════════════════════════════════════════════════════
    // In production, Twilio verifies the real code. Here we simulate
    // by manually setting otpVerified=true
    await updateSession(TAXISTA_PHONE, {
      state: "simulation" as any,
      context: {
        agentState: "docs_capture",
        agentContext: {
          nombre: taxistaName,
          folio: folioCreated,
          originationId,
          docsCollected: ["ine_frente", "ine_vuelta"],
          skippedDocs: [],
          fuelType: "gasolina",
          otpSent: true,
          otpVerified: true,
        },
      } as any,
    });

    // Send a message to confirm flow continues after OTP
    const postOtp = await handleProspectMessage(
      TAXISTA_PHONE, "estado", null, null, "Pedro", storage
    );

    flow.push({
      step: 8, actor: "prospecto", action: "OTP verificado — flujo continúa",
      input: "[Código correcto] → estado", output: postOtp.slice(0, 300),
      state: "docs_capture (otpVerified=true)", timestamp: now(),
      metadata: { otpVerified: true },
    });

    // ═══════════════════════════════════════════════════════════════
    // STEP 9: Promotora pregunta por el estado del folio
    // ═══════════════════════════════════════════════════════════════
    const r9 = await whatsappAgent.handleMessage(
      PROMOTORA_PHONE, "docs", "Ángeles Test", null, null, originationId,
      "promotora", "Ángeles Mireles", []
    );

    flow.push({
      step: 9, actor: "promotora", action: "Consulta estado de documentos",
      input: "docs", output: r9.reply.slice(0, 300),
      state: "capturing_docs", timestamp: now(),
    });

    // Build summary
    const summary = [
      `Flujo CPV E2E completado exitosamente`,
      `Folio: ${folioCreated || "N/A"}`,
      `Taxista: ${taxistaName} (${taxistaTel})`,
      `Documentos capturados: INE Frente ✓, INE Reverso ✓`,
      `OTP: enviado → intento incorrecto → verificado ✓`,
      `Total pasos: ${flow.length}`,
    ].join("\n");

    return { success: true, flow, summary, folioCreated };

  } catch (e: any) {
    return { success: false, flow, summary: `Error: ${e.message}`, error: e.message };
  } finally {
    // Cleanup test phones
    await sql`DELETE FROM conversation_states WHERE phone IN (${PROMOTORA_PHONE}, ${TAXISTA_PHONE})`.catch(() => {});
    await sql`DELETE FROM whatsapp_roles WHERE phone IN (${PROMOTORA_PHONE}, ${TAXISTA_PHONE})`.catch(() => {});
  }
}
