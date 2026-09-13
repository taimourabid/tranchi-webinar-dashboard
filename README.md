# Tranchi Webinar Dashboard

Live per-webinar performance tracker: Calls Booked → Show Rate → Triage Rate → Qualified Rate → Closing Rate → AOV → Cash Collected.

---

## Deploy to Render

1. Push this repo to GitHub
2. In Render: **New → Blueprint** → connect this repo → Render reads `render.yaml` automatically
3. After deploy, open the Render dashboard and set these two env vars manually under **Environment**:
   - `ADMIN_PASSWORD` — any password you want for the dashboard login
   - `WEBHOOK_SECRET` — a random string (e.g. `openssl rand -hex 20`) — you'll also paste this into GHL

Your dashboard URL will be: `https://webinar-dashboard.onrender.com`

---

## GHL Webhook Setup

### 1. Booking Webhook (fires when someone books a call)

**URL:** `https://YOUR-RENDER-URL/webhooks/booking`
**Method:** POST
**Header:** `X-Webhook-Secret: YOUR_WEBHOOK_SECRET`

**Payload fields to map in GHL** (map GHL merge tags → these field names):

| Field name in payload | What to put |
|---|---|
| `webinar_name` | e.g. `"Webinar 9/13/2026"` — include this literally or use a GHL custom field |
| `contact_id` | GHL Contact ID (`{{contact.id}}`) |
| `contact_name` | Full name (`{{contact.name}}`) |
| `contact_email` | Email (`{{contact.email}}`) |
| `contact_phone` | Phone (`{{contact.phone}}`) |
| `closer_name` | Assigned closer name (`{{assigned_user.name}}` or a custom field) |
| `appointment_id` | Appointment ID (`{{appointment.id}}`) |
| `booked_at` | Appointment start time (`{{appointment.start_time}}`) |

**Example payload:**
```json
{
  "webinar_name": "Webinar 9/13/2026",
  "contact_id": "abc123",
  "contact_name": "John Smith",
  "contact_email": "john@example.com",
  "contact_phone": "+15551234567",
  "closer_name": "Amir",
  "appointment_id": "appt_xyz",
  "booked_at": "2026-09-13T19:00:00Z"
}
```

> The webinar record is auto-created on first receipt. The name must be consistent (e.g. always "Webinar 9/13/2026") so all bookings group under the same webinar.

---

### 2. Payment Webhook (fires when a payment is collected)

**URL:** `https://YOUR-RENDER-URL/webhooks/payment`
**Method:** POST
**Header:** `X-Webhook-Secret: YOUR_WEBHOOK_SECRET`

| Field name | What to put |
|---|---|
| `webinar_name` | Same name as booking (e.g. `"Webinar 9/13/2026"`) |
| `contact_id` | GHL Contact ID |
| `contact_name` | Contact full name |
| `closer_name` | Closer who closed the deal |
| `amount` | Payment amount in USD (numeric, e.g. `2000`) |
| `transaction_id` | GHL transaction/order ID (for deduplication) |
| `collected_at` | Payment timestamp |

**Example payload:**
```json
{
  "webinar_name": "Webinar 9/13/2026",
  "contact_id": "abc123",
  "contact_name": "John Smith",
  "closer_name": "Amir",
  "amount": 2000,
  "transaction_id": "txn_456",
  "collected_at": "2026-09-14T10:30:00Z"
}
```

---

## Metrics Formulas

| Metric | Formula |
|---|---|
| Show Rate | showed ÷ booked |
| Triage Rate | triaged ÷ booked |
| Qualified Rate | qualified ÷ booked |
| Closing Rate | unique paying leads ÷ qualified |
| AOV | total cash ÷ unique paying leads |
| Cash Collected | sum of all payments |

---

## VA Interface

Go to `/va` on your dashboard. Select a webinar, then check/uncheck Showed / Triaged / Qualified boxes for each lead and hit **Save** per row. Changes update the metrics instantly.

---

## Manual Entry

From the main dashboard, use the **+ Add Lead** and **+ Add Payment** buttons in the bottom action bar. Manual entries are flagged as `source: manual` in the database for audit purposes.

---

## Local Development

```bash
cp .env.example .env
# Fill in a local PostgreSQL DATABASE_URL and set ADMIN_PASSWORD, WEBHOOK_SECRET
npm run dev
```

Server starts on `http://localhost:3000`
