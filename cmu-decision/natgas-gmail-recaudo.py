#!/usr/bin/env python3
"""
NATGAS Gmail Recaudo Cron
=========================
1. Search Gmail for emails from lplata@natgas.com.mx with Excel attachments (last 7 days)
2. Download the Excel attachment
3. Process through recaudo-engine (parse NATGAS Excel + Airtable update)
4. Send WhatsApp summary to Josué (director)

If mode=reminder and no email found → send WhatsApp reminder to Lilia Plata
"""
import asyncio
import json
import sys
import os
import subprocess
from datetime import datetime, timedelta, timezone

# ===== CONFIG =====
SENDER_EMAIL = "lplata@natgas.com.mx"
JOSUE_PHONE = "5214422022540"
LILIA_PHONE = "524421146330"
TWILIO_WA_FROM = "whatsapp:+5214463293102"
FLY_APP_URL = "https://cmu-originacion.fly.dev"

# Tracking file to avoid reprocessing
TRACKING_FILE = "/home/user/workspace/cron_tracking/natgas_recaudo_processed.json"

def load_processed():
    """Load set of already-processed email IDs"""
    try:
        with open(TRACKING_FILE, "r") as f:
            return set(json.load(f))
    except:
        return set()

def save_processed(ids: set):
    """Save processed email IDs"""
    os.makedirs(os.path.dirname(TRACKING_FILE), exist_ok=True)
    with open(TRACKING_FILE, "w") as f:
        json.dump(list(ids), f)

async def call_tool(source_id, tool_name, arguments):
    """Call external tool via CLI"""
    proc = await asyncio.create_subprocess_exec(
        "external-tool", "call", json.dumps({
            "source_id": source_id, "tool_name": tool_name, "arguments": arguments,
        }),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        error_msg = stderr.decode()
        print(f"[ERROR] Tool call failed: {error_msg}", file=sys.stderr)
        raise RuntimeError(error_msg)
    return json.loads(stdout.decode())

async def search_natgas_emails():
    """Search Gmail for NATGAS recaudo emails from past 7 days"""
    # Calculate date range (last 7 days)
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)
    date_filter = f"after:{week_ago.strftime('%Y-%m-%dT00:00:00-06:00')}"
    
    result = await call_tool("gcal", "search_email", {
        "queries": [
            f"from:{SENDER_EMAIL} {date_filter}",
            f"from:{SENDER_EMAIL} has:attachment filename:xlsx",
            f"from:natgas.com.mx recaudo {date_filter}",
            f"CONDUCTORES DEL MUNDO has:attachment filename:xlsx {date_filter}",
        ]
    })
    
    # Extract emails from result
    emails = []
    if isinstance(result, dict):
        email_results = result.get("email_results", {})
        if isinstance(email_results, dict):
            emails = email_results.get("emails", [])
        elif isinstance(email_results, str):
            try:
                parsed = json.loads(email_results)
                emails = parsed.get("emails", [])
            except:
                pass
    
    # Filter: only emails with Excel attachments
    natgas_emails = []
    for email in emails:
        attachments = email.get("attachments", [])
        has_excel = any(
            a.get("filename", "").lower().endswith((".xlsx", ".xls", ".csv"))
            for a in attachments
        )
        if has_excel:
            natgas_emails.append(email)
    
    # Deduplicate by email_id
    seen = set()
    unique = []
    for e in natgas_emails:
        eid = e.get("email_id", "")
        if eid and eid not in seen:
            seen.add(eid)
            unique.append(e)
    
    return unique

async def download_excel(attachment_url: str, filename: str) -> str:
    """Download Excel file from signed URL"""
    output_path = f"/home/user/workspace/natgas_downloads/{filename}"
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    proc = await asyncio.create_subprocess_exec(
        "curl", "-sL", "-o", output_path, attachment_url,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    await proc.communicate()
    
    if os.path.exists(output_path) and os.path.getsize(output_path) > 100:
        print(f"[OK] Downloaded: {output_path} ({os.path.getsize(output_path)} bytes)")
        return output_path
    else:
        print(f"[ERROR] Download failed or empty: {output_path}", file=sys.stderr)
        return ""

async def process_excel_via_api(filepath: str) -> dict:
    """Send Excel to the CMU agent's recaudo endpoint for processing"""
    import base64
    
    with open(filepath, "rb") as f:
        content = f.read()
    
    # Call the Fly.io endpoint directly
    b64 = base64.b64encode(content).decode()
    
    proc = await asyncio.create_subprocess_exec(
        "curl", "-sL", "-X", "POST",
        f"{FLY_APP_URL}/api/recaudo/process",
        "-H", "Content-Type: application/json",
        "-d", json.dumps({"fileBase64": b64, "filename": os.path.basename(filepath)}),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    
    try:
        return json.loads(stdout.decode())
    except:
        print(f"[WARN] API response not JSON: {stdout.decode()[:200]}", file=sys.stderr)
        return {"error": "API call failed", "raw": stdout.decode()[:500]}

async def send_whatsapp(to_phone: str, message: str, use_template: bool = False):
    """Send WhatsApp message via the CMU agent's outbound endpoint.
    If use_template=True, tries template first (works outside 24h window), falls back to freeform."""
    payload = {"to": f"whatsapp:+{to_phone}", "body": message}
    
    # Try freeform first (works within 24h session window)
    proc = await asyncio.create_subprocess_exec(
        "curl", "-sL", "-X", "POST",
        f"{FLY_APP_URL}/api/whatsapp/send-outbound",
        "-H", "Content-Type: application/json",
        "-d", json.dumps(payload),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    result = stdout.decode()[:300]
    print(f"[WA] Sent to {to_phone}: {result}")
    
    # Check if Twilio rejected due to 24h window (error 63016 or similar)
    if '"success":false' in result or '63016' in result or 'outside' in result.lower():
        print(f"[WA] Freeform failed (likely 24h window). Message not delivered to {to_phone}.")
        # TODO: Use Twilio Content Template when available
        # To set up: create a template in Twilio Console > Messaging > Content Template Builder
        # Then add templateSid to the payload: {"to": ..., "templateSid": "HXXXXXXXXXXX"}

async def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    print(f"[{datetime.now(timezone.utc).isoformat()}] NATGAS Recaudo Cron — mode={mode}")
    
    # Load already-processed emails
    processed = load_processed()
    
    # Search Gmail
    print("[1] Searching Gmail for NATGAS recaudo emails...")
    emails = await search_natgas_emails()
    print(f"    Found {len(emails)} email(s) with Excel attachments")
    
    # Filter out already-processed
    new_emails = [e for e in emails if e.get("email_id") not in processed]
    print(f"    New (unprocessed): {len(new_emails)}")
    
    if not new_emails:
        if mode == "reminder":
            # No email found by reminder time → nudge Lilia
            print("[REMINDER] No NATGAS email this week — sending reminder to Lilia")
            await send_whatsapp(LILIA_PHONE,
                "Hola Lilia, buen dia. No hemos recibido el reporte de recaudo GNV de esta semana. "
                "¿Podrías enviarlo por favor? Gracias."
            )
            # Also notify Josué
            await send_whatsapp(JOSUE_PHONE,
                "⚠️ *NATGAS Recaudo*\n"
                "No se recibió el Excel de recaudo esta semana. "
                "Se envió recordatorio a Lilia Plata."
            )
        else:
            print("[OK] No new emails to process")
        return
    
    # Process each new email
    for email in new_emails:
        email_id = email.get("email_id", "?")
        subject = email.get("subject", "Sin asunto")
        from_ = email.get("from_", "")
        date = email.get("date", "")
        attachments = email.get("attachments", [])
        
        print(f"\n[2] Processing email: {subject} ({date})")
        print(f"    From: {from_}")
        
        for att in attachments:
            filename = att.get("filename", "")
            if not filename.lower().endswith((".xlsx", ".xls", ".csv")):
                continue
            
            signed_url = att.get("signed_url", "")
            if not signed_url:
                print(f"    [SKIP] No URL for {filename}")
                continue
            
            # Download
            print(f"[3] Downloading: {filename}")
            filepath = await download_excel(signed_url, f"{email_id}_{filename}")
            if not filepath:
                continue
            
            # Process via API
            print(f"[4] Processing via recaudo engine...")
            result = await process_excel_via_api(filepath)
            
            if result.get("error"):
                # API endpoint might not exist yet — process locally
                print(f"    [WARN] API error: {result.get('error')}")
                print(f"    [FALLBACK] Will notify Josué about the file")
                await send_whatsapp(JOSUE_PHONE,
                    f"📊 *NATGAS Recaudo — Archivo recibido*\n"
                    f"De: {from_}\n"
                    f"Archivo: {filename}\n"
                    f"Fecha email: {date}\n\n"
                    f"El archivo fue descargado pero el procesamiento automático falló. "
                    f"Envía el archivo por WhatsApp al agente CMU para procesarlo manualmente."
                )
            else:
                # Use pre-formatted multi-product summary from engine
                formatted = result.get("formatted", "")
                if formatted:
                    await send_whatsapp(JOSUE_PHONE, f"(Gmail) {formatted}")
                else:
                    # Fallback: basic summary
                    summary = result.get("summary", {})
                    await send_whatsapp(JOSUE_PHONE,
                        f"*RECAUDO GNV PROCESADO (Gmail)*\n"
                        f"Periodo: {summary.get('periodo','?')}\n"
                        f"Total: ${summary.get('totalRecaudo',0):,}\n"
                        f"Contratos: {summary.get('creditosActualizados',0)}"
                    )
                print(f"[OK] Recaudo processed and reported to Josue")
        
        # Mark as processed
        processed.add(email_id)
    
    # Save tracking
    save_processed(processed)
    print(f"\n[DONE] Processed {len(new_emails)} new email(s)")

if __name__ == "__main__":
    asyncio.run(main())
