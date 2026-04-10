/**
 * generate-test-docs.js
 * Generates synthetic test document images (PNG via SVG→PNG) for cross-check regression tests.
 *
 * Test scenario:
 *   - INE Frente: PEDRO RAMÍREZ LUNA, CURP: RALP800101HAGMNR09
 *   - CSF: "PEDRO ROBLES MARTÍNEZ" (nombre DIFERENTE — debe disparar nombre_mismatch)
 *   - Estado de cuenta: "PEDRO ALEJANDRO GÓMEZ" (nombre DIFERENTE — debe disparar nombre_mismatch)
 *
 * Expected flags:
 *   - CSF → nombre_mismatch (PEDRO ROBLES MARTÍNEZ ≠ PEDRO RAMÍREZ LUNA)
 *   - Estado de cuenta → nombre_mismatch (PEDRO ALEJANDRO GÓMEZ ≠ PEDRO RAMÍREZ LUNA)
 *   - Estado de cuenta → curp_mismatch si incluimos CURP diferente
 */

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'fixtures/cross-check');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── Shared test data ────────────────────────────────────────────────────────
const GROUND_TRUTH = {
  nombre: 'PEDRO RAMÍREZ LUNA',
  curp: 'RALP800101HAGMNR09',
  domicilio: 'CALLE HIDALGO 123, COL. CENTRO, AGUASCALIENTES, AGS.',
  fecha_nacimiento: '01/01/1980',
  vigencia: '2030',
};

const CSF_NOMBRE = 'PEDRO ROBLES MARTÍNEZ';       // WRONG — triggers nombre_mismatch
const EDO_CTA_NOMBRE = 'PEDRO ALEJANDRO GÓMEZ';   // WRONG — triggers nombre_mismatch
const EDO_CTA_CLABE = '012345678901234567';         // 18 digits — VALID CLABE
const EDO_CTA_BANCO = 'BBVA BANCOMER';

// ─── Helper: write PDF ────────────────────────────────────────────────────────
function makePDF(filename, drawFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const out = fs.createWriteStream(path.join(OUT_DIR, filename));
    doc.pipe(out);
    drawFn(doc);
    doc.end();
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

// ─── 1. INE Frente (GROUND TRUTH — correct name) ─────────────────────────────
async function makeINEFrente() {
  await makePDF('ine-frente-pedro-ramirez.pdf', (doc) => {
    // Header
    doc.rect(0, 0, 595, 60).fill('#8B0000');
    doc.fontSize(14).fillColor('white').font('Helvetica-Bold')
      .text('INSTITUTO NACIONAL ELECTORAL', 40, 15)
      .fontSize(10).text('CREDENCIAL PARA VOTAR', 40, 35);

    doc.fillColor('black');
    doc.rect(40, 70, 100, 130).stroke(); // photo placeholder
    doc.fontSize(8).text('FOTO', 75, 128);

    doc.fontSize(9).font('Helvetica-Bold').text('NOMBRE:', 160, 75);
    doc.font('Helvetica').text(GROUND_TRUTH.nombre, 160, 87);

    doc.font('Helvetica-Bold').text('DOMICILIO:', 160, 105);
    doc.font('Helvetica').fontSize(8)
      .text(GROUND_TRUTH.domicilio, 160, 117, { width: 380 });

    doc.font('Helvetica-Bold').fontSize(9).text('FECHA DE NACIMIENTO:', 160, 145);
    doc.font('Helvetica').text(GROUND_TRUTH.fecha_nacimiento, 160, 157);

    doc.font('Helvetica-Bold').text('CURP:', 160, 175);
    doc.font('Helvetica').text(GROUND_TRUTH.curp, 160, 187);

    doc.font('Helvetica-Bold').text('VIGENCIA:', 160, 205);
    doc.font('Helvetica').text(GROUND_TRUTH.vigencia, 160, 217);

    doc.rect(40, 220, 515, 1).stroke();
    doc.fontSize(7).fillColor('#666')
      .text('CLAVE DE ELECTOR: RMLNPE80010101M000  SECCIÓN: 1234  FOLIO: 0001234567', 40, 225);

    doc.fontSize(8).fillColor('#8B0000').font('Helvetica-Bold')
      .text('AGUASCALIENTES', 40, 240);
  });
  console.log('✓ INE Frente generada');
}

// ─── 2. CSF con nombre INCORRECTO ────────────────────────────────────────────
async function makeCSF() {
  await makePDF('csf-pedro-robles-WRONG.pdf', (doc) => {
    // SAT header
    doc.rect(0, 0, 595, 50).fill('#006633');
    doc.fontSize(12).fillColor('white').font('Helvetica-Bold')
      .text('SERVICIO DE ADMINISTRACIÓN TRIBUTARIA', 40, 10)
      .fontSize(9).text('CONSTANCIA DE SITUACIÓN FISCAL', 40, 28);

    doc.fillColor('black');

    // DELIBERATE INCONSISTENCY — nombre diferente al INE
    doc.fontSize(9).font('Helvetica-Bold').text('DATOS DEL CONTRIBUYENTE', 40, 65);
    doc.rect(40, 73, 515, 1).stroke();

    doc.fontSize(9).font('Helvetica-Bold').text('NOMBRE O RAZÓN SOCIAL:', 40, 82);
    doc.font('Helvetica').fillColor('#CC0000')  // red to make inconsistency obvious in test
      .text(CSF_NOMBRE, 40, 94);
    doc.fillColor('black');

    doc.font('Helvetica-Bold').text('RFC:', 40, 112);
    doc.font('Helvetica').text('ROMP800101ABC', 40, 124);  // RFC matches WRONG name

    doc.font('Helvetica-Bold').text('CURP:', 40, 142);
    doc.font('Helvetica').text('ROMP800101HAGBNR05', 40, 154);  // WRONG CURP too

    doc.font('Helvetica-Bold').text('RÉGIMEN FISCAL:', 40, 172);
    doc.font('Helvetica').text('612 - Personas Físicas con Actividades Empresariales', 40, 184);

    doc.font('Helvetica-Bold').text('FECHA DE EMISIÓN:', 40, 202);
    doc.font('Helvetica').text('09/04/2026', 40, 214);  // Today — NOT vencida

    doc.fontSize(7).fillColor('#666')
      .text('Documento generado para pruebas de regresión CMU — nombre deliberadamente inconsistente con INE', 40, 750);
  });
  console.log('✓ CSF con nombre incorrecto generada');
}

// ─── 3. Estado de cuenta con nombre INCORRECTO ───────────────────────────────
async function makeEstadoCuenta() {
  await makePDF('estado-cuenta-pedro-gomez-WRONG.pdf', (doc) => {
    // Bank header
    doc.rect(0, 0, 595, 55).fill('#004A8F');
    doc.fontSize(16).fillColor('white').font('Helvetica-Bold')
      .text(EDO_CTA_BANCO, 40, 12);
    doc.fontSize(9).text('Estado de Cuenta — Cuenta de Cheques', 40, 35);

    doc.fillColor('black');

    doc.fontSize(9).font('Helvetica-Bold').text('TITULAR DE LA CUENTA:', 40, 75);
    doc.font('Helvetica').fillColor('#CC0000')  // red — inconsistency
      .text(EDO_CTA_NOMBRE, 40, 87);
    doc.fillColor('black');

    doc.font('Helvetica-Bold').text('NÚMERO DE CUENTA:', 40, 105);
    doc.font('Helvetica').text('1234-5678-9012', 40, 117);

    doc.font('Helvetica-Bold').text('CLABE INTERBANCARIA:', 40, 135);
    doc.font('Helvetica').text(EDO_CTA_CLABE, 40, 147);

    doc.font('Helvetica-Bold').text('SUCURSAL:', 40, 165);
    doc.font('Helvetica').text('AGUASCALIENTES CENTRO', 40, 177);

    doc.font('Helvetica-Bold').text('DIRECCIÓN DEL CUENTAHABIENTE:', 40, 195);
    doc.font('Helvetica').fontSize(8)
      .text('AV. LÓPEZ MATEOS 456, COL. BOSQUES DEL PRADO, AGUASCALIENTES, AGS.', 40, 207);
      // ALSO WRONG — domicilio diferente al INE

    doc.font('Helvetica-Bold').fontSize(9).text('PERÍODO:', 40, 230);
    doc.font('Helvetica').text('01/03/2026 — 31/03/2026', 40, 242);

    doc.font('Helvetica-Bold').text('SALDO FINAL:', 40, 260);
    doc.font('Helvetica').text('$12,450.00 MXN', 40, 272);

    doc.fontSize(7).fillColor('#666')
      .text('Documento generado para pruebas de regresión CMU — nombre Y domicilio deliberadamente inconsistentes con INE', 40, 750);
  });
  console.log('✓ Estado de cuenta con nombre incorrecto generado');
}

// ─── Run all ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('Generando documentos de prueba en:', OUT_DIR);
  await makeINEFrente();
  await makeCSF();
  await makeEstadoCuenta();

  // Save expected cross-check results
  const expected = {
    description: "E2E cross-check test — nombre inconsistente deliberado",
    ground_truth: GROUND_TRUTH,
    test_cases: [
      {
        file: "ine-frente-pedro-ramirez.pdf",
        doc_type: "ine_frente",
        role: "ground_truth",
        expected_flags: [],
        expected_extracted: {
          nombre: GROUND_TRUTH.nombre,
          curp: GROUND_TRUTH.curp,
        },
      },
      {
        file: "csf-pedro-robles-WRONG.pdf",
        doc_type: "csf",
        existingData: { ine_frente: { nombre: GROUND_TRUTH.nombre, curp: GROUND_TRUTH.curp } },
        expected_flags: ["nombre_mismatch"],
        notes: `CSF nombre='${CSF_NOMBRE}' ≠ INE nombre='${GROUND_TRUTH.nombre}'`,
      },
      {
        file: "estado-cuenta-pedro-gomez-WRONG.pdf",
        doc_type: "estado_cuenta",
        existingData: {
          ine_frente: {
            nombre: GROUND_TRUTH.nombre,
            curp: GROUND_TRUTH.curp,
            domicilio: GROUND_TRUTH.domicilio,
          }
        },
        expected_flags: ["nombre_mismatch", "domicilio_mismatch"],
        notes: `Cuenta nombre='${EDO_CTA_NOMBRE}' ≠ INE. Domicilio también diferente.`,
      },
    ],
  };

  fs.writeFileSync(
    path.join(OUT_DIR, 'expected.json'),
    JSON.stringify(expected, null, 2),
    'utf-8'
  );
  console.log('✓ expected.json guardado');
  console.log('\nDocumentos listos en:', OUT_DIR);
}

main().catch(console.error);
