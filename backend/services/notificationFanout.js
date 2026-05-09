// Notifications matrix — single fanout entrypoint per event type.
//
// Each fanout function:
//   1. Computes recipients for the event
//   2. For each recipient, reads their preference matrix
//   3. Creates an in-app notification row when in_app=true
//   4. Sends a web push when push=true
//   5. Sends email immediately when email=true && digest=instant
//      OR buffers to notification_outbox otherwise
//
// LOCKED_ON events (pending_review, follow_up) bypass the user's stored
// matrix for in_app+email and bypass the digest cadence — they always
// send an email immediately. Push remains opt-in even for locked events.
//
// Vendor outbound (sendVendorEmail) is a separate channel and stays
// outside the matrix.

const { pool } = require('../db/pool');
const { sendMail } = require('./email');
const { createNotification } = require('./notifications');
const { sendPushToUser } = require('./pushNotifications');
const { renderEventEmail } = require('./notificationEmailTemplates');
const { effectiveMatrix, digestCadence, LOCKED_ON } = require('./notificationPrefs');
const { getBranding } = require('./branding');

// ─── Recipient resolution ────────────────────────────────────────────────

// Followers (and ticket submitter) who should hear about ticket activity,
// minus the actor. Returns full user rows so the caller can read prefs
// without a second query.
async function getFollowerRecipients(client, ticketId, excludeUserId) {
  const r = await (client || pool).query(`
    SELECT DISTINCT u.id, u.email, u.display_name, u.preferences
      FROM users u
     WHERE u.status = 'active'
       AND u.id != $2
       AND (
         u.id IN (SELECT user_id FROM ticket_followers WHERE ticket_id = $1)
         OR u.id IN (SELECT submitted_by FROM tickets WHERE id = $1 AND submitted_by IS NOT NULL)
       )
  `, [ticketId, excludeUserId || 0]);
  return r.rows;
}

async function getUserById(userId) {
  const r = await pool.query(
    `SELECT id, email, display_name, preferences FROM users WHERE id = $1 AND status = 'active'`,
    [userId]
  );
  return r.rows[0] || null;
}

// ─── Outbox helpers ──────────────────────────────────────────────────────

// Compute when a buffered email should be flushed, given the user's
// cadence + resolved timezone.
function nextFlushBoundary(prefsBlob, brandingTz) {
  const cadence = digestCadence(prefsBlob);
  if (cadence === 'instant' || cadence === 'off') return null;
  const tz = (prefsBlob && prefsBlob.timezone_override) || brandingTz || 'UTC';
  const now = new Date();
  if (cadence === 'hourly') {
    // Top of next hour, UTC. Hour boundaries don't depend on local TZ.
    const d = new Date(now);
    d.setUTCMinutes(0, 0, 0);
    d.setUTCHours(d.getUTCHours() + 1);
    return d;
  }
  if (cadence === '12h') {
    // Next 00:00 or 12:00 in user-local TZ.
    return nextLocalHour(now, tz, [0, 12]);
  }
  if (cadence === 'daily') {
    // 09:00 user-local. Org-configurable hour piggybacks later if needed.
    return nextLocalHour(now, tz, [9]);
  }
  return null;
}

// Returns next instant where local hour matches one of the targets,
// minute=0, second=0. Walks forward day-by-day in the given tz.
function nextLocalHour(now, tz, targetHours) {
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    for (const h of targetHours.slice().sort((a, b) => a - b)) {
      const candidate = composeLocalInstant(now, tz, dayOffset, h);
      if (candidate && candidate > now) return candidate;
    }
  }
  // Fallback: 24h from now.
  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

// Build a Date that, when interpreted in tz, lands on (today + offsetDays)
// at hour:00. Approximation: compute the tz offset at "now+offsetDays
// noon" and apply it. Good enough for digest scheduling — daylight
// savings boundary errors at most an hour, which is fine.
function composeLocalInstant(now, tz, dayOffset, hour) {
  try {
    // Get year/month/day in target tz starting from a noon anchor
    // dayOffset days from now to avoid DST midnight gaps.
    const anchor = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(anchor).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
    // Build naive UTC instant for that day at the target hour.
    const naiveUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, 0, 0);
    // Compute tz offset by subtracting the rendered local time at that
    // instant from itself in UTC.
    const sample = new Date(naiveUTC);
    const sampleParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(sample).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
    const renderedHour = +sampleParts.hour;
    const offsetHours = renderedHour - hour;
    // If offset is positive, tz is ahead of UTC at this instant — shift
    // back. If negative, tz is behind — shift forward.
    return new Date(naiveUTC + offsetHours * 60 * 60 * 1000 * -1);
  } catch {
    return null;
  }
}

let _cachedBrandingTz = null;
let _cachedBrandingTzAt = 0;
async function getBrandingTimezone() {
  const now = Date.now();
  if (_cachedBrandingTz && now - _cachedBrandingTzAt < 60 * 1000) return _cachedBrandingTz;
  try {
    const b = await getBranding();
    _cachedBrandingTz = (b && b.default_timezone) || 'UTC';
  } catch {
    _cachedBrandingTz = 'UTC';
  }
  _cachedBrandingTzAt = now;
  return _cachedBrandingTz;
}

// Single chokepoint deciding "send now" vs "buffer".
async function routeEmail({ user, eventType, payload, ticketId, projectId, bypassDigest = false }) {
  if (!user || !user.email) return;
  const cadence = bypassDigest ? 'instant' : digestCadence(user.preferences);
  if (cadence === 'off') return;
  if (cadence === 'instant') {
    try {
      const { subject, html } = await renderEventEmail(eventType, payload);
      await sendMail({ to: user.email, subject, html, projectId });
    } catch (err) {
      console.error(`fanout email (${eventType}) failed for user ${user.id}:`, err.message);
    }
    return;
  }
  const tz = await getBrandingTimezone();
  const flushAt = nextFlushBoundary(user.preferences, tz);
  if (!flushAt) return;
  try {
    await pool.query(
      `INSERT INTO notification_outbox (user_id, event_type, ticket_id, payload, scheduled_flush_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [user.id, eventType, ticketId || null, JSON.stringify(payload), flushAt]
    );
  } catch (err) {
    console.error(`outbox insert (${eventType}) failed for user ${user.id}:`, err.message);
  }
}

// In-app + push fan-out for a single recipient.
async function dispatchPerRecipient({ user, eventType, inApp, push, ticketId, ticketRef, payload }) {
  const matrix = effectiveMatrix(user.preferences, eventType);
  if (matrix.in_app && inApp) {
    try {
      await createNotification(null, {
        userId: user.id,
        type: eventType,
        title: inApp.title,
        body: inApp.body || null,
        data: { ticket_id: ticketId, ticket_ref: ticketRef, ...(inApp.extraData || {}) },
      });
    } catch (err) {
      console.error(`in-app notif (${eventType}) failed for user ${user.id}:`, err.message);
    }
  }
  if (matrix.push && push) {
    sendPushToUser(user.id, {
      title: push.title,
      body: push.body,
      url: push.url,
      tag: push.tag,
    }).catch(err => console.error(`push (${eventType}) failed for user ${user.id}:`, err.message));
  }
  return matrix;
}

// ─── Public fanout entry points ──────────────────────────────────────────

async function fanoutAssignment(_unusedPool, { ticket, assigneeId, actorId, actorName }) {
  if (!assigneeId || assigneeId === actorId) return;
  const user = await getUserById(assigneeId);
  if (!user) return;
  const ticketRef = ticket.internal_ref;
  const ticketTitle = ticket.title || '';
  const payload = {
    ticket_id: ticket.id,
    ticket_ref: ticketRef,
    ticket_title: ticketTitle,
    actor_name: actorName || 'Someone',
  };
  const matrix = await dispatchPerRecipient({
    user,
    eventType: 'assignment',
    ticketId: ticket.id,
    ticketRef,
    inApp: {
      title: `Assigned: ${ticketRef}`,
      body: `${actorName || 'Someone'} assigned this to you${ticketTitle ? ` — ${ticketTitle}` : ''}.`,
    },
    push: {
      title: `Assigned: ${ticketRef}`,
      body: `${actorName || 'Someone'} assigned this to you${ticketTitle ? ` — ${ticketTitle}` : ''}.`,
      url: `/tickets/${ticket.id}`,
      tag: `assign-${ticket.id}`,
    },
    payload,
  });
  if (matrix.email) {
    await routeEmail({ user, eventType: 'assignment', payload, ticketId: ticket.id, projectId: ticket.project_id });
  }
}

async function fanoutStatusChange(_unusedPool, { ticket, oldStatus, newStatus, actorId }) {
  const recipients = await getFollowerRecipients(null, ticket.id, actorId);
  if (!recipients.length) return;
  const ticketRef = ticket.internal_ref;
  const ticketTitle = ticket.title || '';
  const isClosed = newStatus === 'Closed';
  const payload = {
    ticket_id: ticket.id,
    ticket_ref: ticketRef,
    ticket_title: ticketTitle,
    old_status: oldStatus,
    new_status: newStatus,
    is_closed: isClosed,
  };
  for (const user of recipients) {
    const matrix = await dispatchPerRecipient({
      user,
      eventType: 'status_change',
      ticketId: ticket.id,
      ticketRef,
      inApp: {
        title: isClosed ? `Closed: ${ticketRef}` : `Status: ${ticketRef}`,
        body: isClosed
          ? `${ticketTitle ? `${ticketTitle} — ` : ''}closed`
          : `${oldStatus} → ${newStatus}${ticketTitle ? ` · ${ticketTitle}` : ''}`,
      },
      push: null,
      payload,
    });
    if (matrix.email) {
      await routeEmail({ user, eventType: 'status_change', payload, ticketId: ticket.id, projectId: ticket.project_id });
    }
  }
}

async function fanoutNewComment(_unusedPool, { ticket, comment, actorId, actorName }) {
  const recipients = await getFollowerRecipients(null, ticket.id, actorId);
  if (!recipients.length) return;
  const ticketRef = ticket.internal_ref;
  const ticketTitle = ticket.title || '';
  const preview = String(comment || '').length > 300 ? String(comment).slice(0, 300) + '…' : String(comment || '');
  const payload = {
    ticket_id: ticket.id,
    ticket_ref: ticketRef,
    ticket_title: ticketTitle,
    actor_name: actorName || 'Someone',
    comment_preview: preview,
  };
  for (const user of recipients) {
    const matrix = await dispatchPerRecipient({
      user,
      eventType: 'comment',
      ticketId: ticket.id,
      ticketRef,
      inApp: {
        title: `Comment on ${ticketRef}`,
        body: `${actorName || 'Someone'}: ${preview.length > 120 ? preview.slice(0, 120) + '…' : preview}`,
      },
      push: null,
      payload,
    });
    if (matrix.email) {
      await routeEmail({ user, eventType: 'comment', payload, ticketId: ticket.id, projectId: ticket.project_id });
    }
  }
}

async function fanoutMention(_unusedPool, { ticket, comment, commentId, mentionedUsers, actorId, actorName }) {
  if (!mentionedUsers || !mentionedUsers.length) return;
  const ticketRef = ticket.internal_ref;
  const ticketTitle = ticket.title || '';
  const preview = String(comment || '').length > 300 ? String(comment).slice(0, 300) + '…' : String(comment || '');
  // Mention implicitly subscribes the user as a follower.
  for (const m of mentionedUsers) {
    if (!m || !m.id || m.id === actorId) continue;
    try {
      await pool.query(
        `INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [ticket.id, m.id]
      );
    } catch (err) {
      console.error(`mention follower add failed for user ${m.id}:`, err.message);
    }
    const user = await getUserById(m.id);
    if (!user) continue;
    const payload = {
      ticket_id: ticket.id,
      ticket_ref: ticketRef,
      ticket_title: ticketTitle,
      actor_name: actorName || 'Someone',
      comment_preview: preview,
      comment_id: commentId,
    };
    const matrix = await dispatchPerRecipient({
      user,
      eventType: 'mention',
      ticketId: ticket.id,
      ticketRef,
      inApp: {
        title: `Mentioned on ${ticketRef}`,
        body: `${actorName || 'Someone'} mentioned you in a comment.`,
        extraData: { comment_id: commentId },
      },
      push: {
        title: `Mentioned on ${ticketRef}`,
        body: `${actorName || 'Someone'} mentioned you in a comment.`,
        url: `/tickets/${ticket.id}`,
        tag: `mention-${ticket.id}`,
      },
      payload,
    });
    if (matrix.email) {
      await routeEmail({ user, eventType: 'mention', payload, ticketId: ticket.id, projectId: ticket.project_id });
    }
  }
}

async function fanoutPendingReview(_unusedPool, { ticket, actorId }) {
  // Recipients = all active Admins minus the actor.
  const r = await pool.query(
    `SELECT id, email, display_name, preferences FROM users
      WHERE role = 'Admin' AND status = 'active' AND id != $1
        AND email IS NOT NULL AND email <> ''`,
    [actorId || 0]
  );
  const ticketRef = ticket.internal_ref;
  const ticketTitle = ticket.title || '';
  const payload = {
    ticket_id: ticket.id,
    ticket_ref: ticketRef,
    ticket_title: ticketTitle,
  };
  for (const user of r.rows) {
    await dispatchPerRecipient({
      user,
      eventType: 'pending_review',
      ticketId: ticket.id,
      ticketRef,
      inApp: {
        title: `Needs review: ${ticketRef}`,
        body: ticketTitle || 'Flagged for admin review.',
      },
      push: null,
      payload,
    });
    // LOCKED_ON: bypass digest, send email immediately.
    await routeEmail({
      user, eventType: 'pending_review', payload,
      ticketId: ticket.id, projectId: ticket.project_id,
      bypassDigest: true,
    });
  }
}

async function fanoutFollowUp(_unusedPool, { ticket, schedulerUserId, schedulerEmail, schedulerName }) {
  if (!schedulerUserId) return;
  const user = await getUserById(schedulerUserId);
  if (!user) return;
  const ticketRef = ticket.internal_ref;
  const ticketTitle = ticket.title || '';
  const payload = {
    ticket_id: ticket.id,
    ticket_ref: ticketRef,
    ticket_title: ticketTitle,
    internal_status: ticket.internal_status || '',
    recipient_name: schedulerName || user.display_name || '',
  };
  await dispatchPerRecipient({
    user,
    eventType: 'follow_up',
    ticketId: ticket.id,
    ticketRef,
    inApp: {
      title: `Follow-up: ${ticketRef}`,
      body: 'Scheduled follow-up reminder. Verify the issue stays resolved.',
    },
    push: null,
    payload,
  });
  // LOCKED_ON: bypass digest.
  await routeEmail({
    user, eventType: 'follow_up', payload,
    ticketId: ticket.id, projectId: null,
    bypassDigest: true,
  });
}

module.exports = {
  fanoutAssignment,
  fanoutStatusChange,
  fanoutNewComment,
  fanoutMention,
  fanoutPendingReview,
  fanoutFollowUp,
  // Exported for tests / outbox flusher
  getFollowerRecipients,
  nextFlushBoundary,
};
