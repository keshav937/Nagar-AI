import crypto from 'crypto';
import { db } from './db.ts';

export interface MessagingProviderStatus {
  smsConfigured: boolean;
  whatsappConfigured: boolean;
  providerName: string;
}

export function getMessagingProviderStatus(): MessagingProviderStatus {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const twilioToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const twilioFrom = process.env.TWILIO_FROM_NUMBER?.trim();
  const twilioWa = process.env.TWILIO_WHATSAPP_FROM?.trim();
  const metaWaToken = process.env.WHATSAPP_CLOUD_TOKEN?.trim();
  const metaWaPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();

  const smsConfigured = Boolean(twilioSid && twilioToken && twilioFrom);
  const whatsappConfigured = Boolean((twilioSid && twilioToken && twilioWa) || (metaWaToken && metaWaPhoneId));

  return {
    smsConfigured,
    whatsappConfigured,
    providerName: smsConfigured
      ? 'Twilio'
      : metaWaToken && metaWaPhoneId
        ? 'Meta WhatsApp Cloud'
        : 'Not Configured (In-App Only)',
  };
}

export async function dispatchSms(toPhone: string, body: string): Promise<{ status: 'sent' | 'failed' | 'not_configured'; providerId?: string; error?: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_FROM_NUMBER?.trim();
  if (!sid || !token || !from) {
    return { status: 'not_configured', error: 'SMS provider credentials are not configured on server.' };
  }

  try {
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const params = new URLSearchParams({ To: toPhone, From: from, Body: body });
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await resp.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!resp.ok) {
      return { status: 'failed', error: data.message || `Twilio SMS HTTP ${resp.status}` };
    }
    return { status: 'sent', providerId: data.sid || '' };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : 'SMS request error' };
  }
}

export async function dispatchWhatsApp(toPhone: string, body: string): Promise<{ status: 'sent' | 'failed' | 'not_configured'; providerId?: string; error?: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const waFrom = process.env.TWILIO_WHATSAPP_FROM?.trim();

  if (sid && token && waFrom) {
    try {
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const to = toPhone.startsWith('whatsapp:') ? toPhone : `whatsapp:${toPhone}`;
      const from = waFrom.startsWith('whatsapp:') ? waFrom : `whatsapp:${waFrom}`;
      const params = new URLSearchParams({ To: to, From: from, Body: body });
      const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        signal: AbortSignal.timeout(8000),
      });
      const data = (await resp.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (!resp.ok) {
        return { status: 'failed', error: data.message || `Twilio WhatsApp HTTP ${resp.status}` };
      }
      return { status: 'sent', providerId: data.sid || '' };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : 'WhatsApp dispatch failed' };
    }
  }

  const metaToken = process.env.WHATSAPP_CLOUD_TOKEN?.trim();
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (metaToken && phoneId) {
    try {
      const cleanTo = toPhone.replace(/[^0-9]/g, '');
      const resp = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(phoneId)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${metaToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: cleanTo,
          type: 'text',
          text: { body },
        }),
        signal: AbortSignal.timeout(8000),
      });
      const data = (await resp.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { message?: string } };
      if (!resp.ok) {
        return { status: 'failed', error: data.error?.message || `WhatsApp Cloud HTTP ${resp.status}` };
      }
      return { status: 'sent', providerId: data.messages?.[0]?.id || '' };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : 'WhatsApp Cloud failed' };
    }
  }

  return { status: 'not_configured', error: 'WhatsApp Business credentials are not configured on server.' };
}

export async function notifyLinkedCaregivers(params: {
  citizenId: string;
  eventType:
    | 'sos_activated'
    | 'safety_activated'
    | 'location_sharing_started'
    | 'location_sharing_stopped'
    | 'emergency_updated'
    | 'permission_revoked'
    | 'safety_status_changed';
  title: string;
  message: string;
  sosIncidentId?: string;
  onlyRelationshipId?: string;
}) {
  const rels = params.onlyRelationshipId
    ? (db
        .prepare(`SELECT * FROM caregiver_relationships WHERE id = ? AND citizen_id = ?`)
        .all(params.onlyRelationshipId, params.citizenId) as Array<Record<string, unknown>>)
    : (db
        .prepare(`SELECT * FROM caregiver_relationships WHERE citizen_id = ? AND status = 'active'`)
        .all(params.citizenId) as Array<Record<string, unknown>>);

  const dispatched: Array<Record<string, unknown>> = [];

  for (const rel of rels) {
    const phone = String(rel.caregiver_phone);
    const wantSms = Boolean(rel.notify_sms);
    const wantWa = Boolean(rel.notify_whatsapp);

    const smsRes = wantSms
      ? await dispatchSms(phone, `${params.title}: ${params.message}`)
      : { status: 'skipped' as const };
    const waRes = wantWa
      ? await dispatchWhatsApp(phone, `${params.title}: ${params.message}`)
      : { status: 'skipped' as const };

    const id = `cn-${crypto.randomUUID().slice(0, 8)}`;
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO caregiver_notifications (
        id, relationship_id, citizen_id, caregiver_phone, caregiver_user_id, event_type,
        title, message, sos_incident_id, in_app_read, sms_status, sms_provider_id, sms_error,
        whatsapp_status, whatsapp_provider_id, whatsapp_error, retry_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      id,
      String(rel.id),
      params.citizenId,
      phone,
      String(rel.caregiver_user_id || ''),
      params.eventType,
      params.title,
      params.message,
      params.sosIncidentId || '',
      smsRes.status,
      'providerId' in smsRes ? smsRes.providerId || '' : '',
      'error' in smsRes ? smsRes.error || '' : '',
      waRes.status,
      'providerId' in waRes ? waRes.providerId || '' : '',
      'error' in waRes ? waRes.error || '' : '',
      nowIso
    );

    dispatched.push({
      id,
      relationshipId: rel.id,
      caregiverPhone: phone,
      smsStatus: smsRes.status,
      whatsappStatus: waRes.status,
    });
  }

  return dispatched;
}

export async function retryCaregiverNotification(notificationId: string, citizenId: string) {
  const row = db
    .prepare(`SELECT * FROM caregiver_notifications WHERE id = ? AND citizen_id = ?`)
    .get(notificationId, citizenId) as Record<string, unknown> | undefined;

  if (!row) throw new Error('Caregiver notification not found.');

  let nextSms = String(row.sms_status);
  let nextSmsErr = String(row.sms_error || '');
  let nextSmsId = String(row.sms_provider_id || '');
  if (nextSms === 'failed' || nextSms === 'not_configured') {
    const r = await dispatchSms(String(row.caregiver_phone), `${row.title}: ${row.message}`);
    nextSms = r.status;
    nextSmsErr = r.error || '';
    nextSmsId = r.providerId || '';
  }

  let nextWa = String(row.whatsapp_status);
  let nextWaErr = String(row.whatsapp_error || '');
  let nextWaId = String(row.whatsapp_provider_id || '');
  if (nextWa === 'failed' || nextWa === 'not_configured') {
    const r = await dispatchWhatsApp(String(row.caregiver_phone), `${row.title}: ${row.message}`);
    nextWa = r.status;
    nextWaErr = r.error || '';
    nextWaId = r.providerId || '';
  }

  db.prepare(`
    UPDATE caregiver_notifications
    SET sms_status = ?, sms_provider_id = ?, sms_error = ?,
        whatsapp_status = ?, whatsapp_provider_id = ?, whatsapp_error = ?,
        retry_count = retry_count + 1
    WHERE id = ?
  `).run(nextSms, nextSmsId, nextSmsErr, nextWa, nextWaId, nextWaErr, notificationId);

  return { smsStatus: nextSms, whatsappStatus: nextWa, smsError: nextSmsErr, whatsappError: nextWaErr };
}
